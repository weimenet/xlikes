// Xlikes 浏览服务：零依赖 Node 内置模块实现（HTTPS + 用户登录）
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const scanner = require('./lib/scanner');
const store = require('./lib/store');
const { fetchText, fetchUserMeta } = require('./lib/fetcher');
const thumbs = require('./lib/thumbs');
const { Auth } = require('./lib/auth');

const ROOT = process.env.XLIKES_MEDIA_ROOT || path.join(__dirname, 'media');
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const LIMIT = Number(process.env.XLIKES_MEDIA_LIMIT || 0); // 0 = 全部
const RESCAN_MS = Number(process.env.RESCAN_MS || 10 * 60 * 1000);
const PUBLIC_HTTPS_PORT = Number(process.env.PUBLIC_HTTPS_PORT || 5287); // HTTP 跳转时对外的 HTTPS 端口
const RETRY_MS = 60 * 1000; // 文案抓取失败后的重试间隔
const FETCH_INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS || 5000); // 文案抓取限速（防封）
const MAX_AUTO_RETRY = 3; // 失败自动重试次数上限
const AUTO_RETRY_DELAY_MS = 10 * 60 * 1000; // 失败后自动重试间隔

let index = store.loadIndex(DATA_DIR);
let posts = store.loadPosts(DATA_DIR);
let userMeta = store.loadUserMeta(DATA_DIR);
const auth = new Auth(DATA_DIR);
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
let scanning = false;
const fetchQueue = new Set();

// 无需登录即可访问的路径
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/app.js', '/style.css']);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `xlikes_token=${token}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax; Secure`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'xlikes_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// ---------- 索引 ----------
// 计算 addedAt（添加时间）：已有值保留；旧数据（索引里有但无值）用文件 mtime 补齐；全新文件用首次发现时间
function stampAddedAt(media, prevMedia, discoveredAt) {
  const prev = new Map((prevMedia || []).map((m) => [m.rel, m.addedAt]));
  for (const m of media) {
    const known = prev.get(m.rel);
    if (known) m.addedAt = known;
    else if (prev.has(m.rel)) m.addedAt = m.mtimeMs || discoveredAt;
    else m.addedAt = discoveredAt;
  }
}

async function scanAndSave(trigger = 'auto') {
  if (scanning) return;
  scanning = true;
  try {
    console.log(`[scan] 开始扫描 ${ROOT} ...`);
    const t0 = Date.now();
    const { media, users } = await scanner.scanRoot(ROOT, LIMIT);
    stampAddedAt(media, index.media, Date.now());
    index.media = scanner.sortByTimeDesc(media);
    index.users = users;
    index.lastScan = { at: Date.now(), type: trigger };
    store.saveIndex(DATA_DIR, index);
    syncNewPosts();
    console.log(`[scan] 完成，共 ${media.length} 条媒体，耗时 ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[scan] 失败:', err.message);
  } finally {
    scanning = false;
  }
}

async function incrementalScan() {
  if (scanning) return;
  if (!index.users) {
    scanAndSave(); // 索引异常/为空时退化为全量扫描
    return;
  }
  scanning = true;
  try {
    // 对比整个媒体目录树：新增用户、删除用户、已有用户内容变化
    let currentDirs;
    try {
      currentDirs = await scanner.listDirs(ROOT);
    } catch {
      return;
    }
    const currentUsers = new Set(currentDirs.map((d) => path.basename(d)));
    const knownUsers = Object.keys(index.users);
    const added = currentDirs
      .map((d) => path.basename(d))
      .filter((u) => index.users[u] === undefined);
    const removed = knownUsers.filter((u) => !currentUsers.has(u));
    const changed = [];
    for (const dir of currentDirs) {
      const user = path.basename(dir);
      if (index.users[user] === undefined) continue; // 新增用户单独处理
      let m;
      try {
        m = (await fsp.stat(dir)).mtimeMs;
      } catch {
        continue;
      }
      if (m !== index.users[user]) changed.push(user);
    }
    if (!added.length && !removed.length && !changed.length) {
      // 目录无变化也记录扫描检查时间，供扫描页展示
      index.lastScan = { at: Date.now(), type: 'auto' };
      store.saveIndex(DATA_DIR, index);
      return;
    }
    console.log(`[scan] 检测到目录变化：新增 ${added.length}，删除 ${removed.length}，变更 ${changed.length}`);

    // 新发现/变更文件的 addedAt：旧索引有值就保留；否则旧数据用 mtime、全新文件用首次发现时间
    const prevAdded = new Map((index.media || []).map((m) => [m.rel, m.addedAt]));
    const discoveredAt = Date.now();
    const stampOne = (m) => {
      const known = prevAdded.get(m.rel);
      if (known) return known;
      if (prevAdded.has(m.rel)) return m.mtimeMs || discoveredAt;
      return discoveredAt;
    };

    let media = index.media.filter((x) => !removed.includes(x.user));
    for (const user of added) {
      const dir = path.join(ROOT, user);
      try {
        index.users[user] = (await fsp.stat(dir)).mtimeMs;
        const items = await scanner.scanUserDir(dir, ROOT);
        for (const m of items) m.addedAt = stampOne(m);
        media.push(...items);
      } catch {}
    }
    for (const user of changed) {
      const dir = path.join(ROOT, user);
      try {
        index.users[user] = (await fsp.stat(dir)).mtimeMs;
        media = media.filter((x) => x.user !== user);
        const items = await scanner.scanUserDir(dir, ROOT);
        for (const m of items) m.addedAt = stampOne(m);
        media.push(...items);
      } catch {}
    }
    for (const user of removed) delete index.users[user];
    index.media = scanner.sortByTimeDesc(media);
    index.lastScan = { at: Date.now(), type: 'auto' };
    store.saveIndex(DATA_DIR, index);
    syncNewPosts();
  } catch (err) {
    console.error('[scan] 增量扫描失败:', err.message);
  } finally {
    scanning = false;
  }
}

setInterval(async () => {
  const id = fetchQueue.values().next().value;
  if (!id) return;
  if (metaJob.running) return; // gallery-dl 补抓进行中时先不让多源抓取并发请求（降低风控风险）
  fetchQueue.delete(id);
  const post = posts[id];
  if (!post || post.status === 'ok' || post.status === 'not_found') return;
  const user = post.user;
  console.log(`[fetch] 抓取文案 ${user}/${id}`);
  const r = await fetchText(id, user);
  const retryCount = r.status === 'failed' ? (post.retryCount || 0) + 1 : 0;
  const meta = userMeta[user] || {};
  let name = r.displayName || '';
  let avatar = r.avatarUrl || '';
  // 帖子拿不到用户信息（已删/失败）时，回退查用户端点（同一 ID 每天最多一次）：
  // 账号还在就能同步新名字/新头像；账号不存在则保持最后抓到的值
  if (!name && !avatar && Date.now() - (meta.userCheckedAt || 0) > 24 * 3600 * 1000) {
    meta.userCheckedAt = Date.now();
    let um = null;
    try {
      um = await fetchUserMeta(user);
    } catch {}
    if (um) {
      name = um.displayName;
      avatar = um.avatarUrl;
    }
  }
  if (name) meta.displayName = name; // 名字有变化就覆盖；拿不到则保持旧值
  if (avatar && avatar !== meta.avatarUrl) {
    meta.avatarUrl = avatar;
    downloadAvatar(user, avatar, true); // 头像有变化才替换
  }
  if (name || avatar || meta.userCheckedAt) {
    userMeta[user] = meta;
    store.saveUserMeta(DATA_DIR, userMeta);
  }
  posts[id] = {
    ...post,
    text: r.text,
    source: r.source,
    status: r.status,
    displayName: r.displayName || meta.displayName || undefined,
    avatarUrl: r.avatarUrl || meta.avatarUrl || undefined,
    retryCount,
    error: r.status === 'not_found' ? 'not_found' : r.status === 'failed' ? 'fetch_failed' : undefined,
    fetchedAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.savePosts(DATA_DIR, posts);
  console.log(`[fetch] ${id} -> ${r.status}`);
  if (r.status === 'failed' && retryCount < MAX_AUTO_RETRY) {
    setTimeout(() => {
      if (posts[id] && posts[id].status === 'failed') fetchQueue.add(id);
    }, AUTO_RETRY_DELAY_MS);
  }
}, FETCH_INTERVAL_MS);

// 新媒体/未抓取项自动入队（后台静默抓取）
function syncNewPosts() {
  let added = 0;
  for (const m of index.media) {
    const p = posts[m.tweetId];
    if (!p) {
      posts[m.tweetId] = { user: m.user, date: m.date, status: 'pending', updatedAt: Date.now() };
      added++;
    }
    if (p && (p.status === 'pending' || p.status === 'failed')) fetchQueue.add(m.tweetId);
  }
  if (added) {
    store.savePosts(DATA_DIR, posts);
    console.log(`[fetch] 新增 ${added} 条待抓取文案`);
  }
}

function textStatus(tweetId) {
  const p = posts[tweetId];
  if (!p) return 'pending';
  if (p.status === 'ok') return 'ok';
  if (Date.now() - (p.updatedAt || 0) > RETRY_MS) return 'retry';
  return p.status;
}

function ensureTextJob(tweetId) {
  const p = posts[tweetId];
  if (p && (p.status === 'ok' || p.status === 'not_found')) return;
  if (p && Date.now() - (p.updatedAt || 0) <= RETRY_MS) return;
  const item = index.media.find((m) => m.tweetId === tweetId);
  posts[tweetId] = {
    ...(p || {}),
    status: 'pending',
    retryCount: 0,
    user: item ? item.user : p ? p.user : null,
    updatedAt: Date.now(),
  };
  fetchQueue.add(tweetId);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

function mediaUrl(item) {
  return `/media/${encodeURIComponent(item.rel)}`;
}

function thumbUrl(item) {
  // 带版本号（缩略图文件 mtime）：重新生成时 mtime 变 → URL 变 → 浏览器拉新图；未变则长缓存命中
  let v = 0;
  try {
    v = Math.floor(fs.statSync(thumbs.thumbFile(DATA_DIR, item.rel)).mtimeMs);
  } catch {}
  return `/thumb/${encodeURIComponent(item.rel)}${v ? `?v=${v}` : ''}`;
}

// 头像文件名索引（encodeURIComponent(用户名) → 文件名）：只在启动/头像变更时读一次目录
// ponytail: 原来每个帖子都 readdirSync 上千项，是全量聚合耗时的主要来源
let avatarIndex = null;
function refreshAvatarIndex() {
  try {
    avatarIndex = new Map();
    for (const f of fs.readdirSync(AVATAR_DIR)) {
      const i = f.lastIndexOf('.');
      if (i > 0) avatarIndex.set(f.slice(0, i), f);
    }
  } catch {
    avatarIndex = new Map();
  }
}

function findAvatarFile(user) {
  if (!avatarIndex) refreshAvatarIndex();
  const name = avatarIndex.get(encodeURIComponent(user));
  return name ? path.join(AVATAR_DIR, name) : null;
}

// 返回用户显示信息：显示名 + 是否有本地头像缓存
function userInfo(user) {
  const meta = userMeta[user] || {};
  return { displayName: meta.displayName || '', avatar: !!findAvatarFile(user) };
}

// 下载头像到本地缓存（同一用户每天最多一次，失败静默）
function downloadAvatar(user, url, force = false) {
  if (!url || !/^https?:/i.test(url)) return;
  const meta = userMeta[user] || {};
  if (!force && Date.now() - (meta.avatarAt || 0) < 24 * 3600 * 1000) return;
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const mod = url.startsWith('https:') ? https : http;
  const req = mod.get(url, { headers: { 'user-agent': 'Xlikes/1.0' } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return;
    }
    let ext;
    try {
      ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
    } catch {
      ext = '.jpg';
    }
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) ext = '.jpg';
    const file = path.join(AVATAR_DIR, `${encodeURIComponent(user)}${ext}`);
    // 头像变化时先删旧文件（扩展名可能不同），避免同一个 ID 留两份
    const old = findAvatarFile(user);
    if (old && old !== file) {
      try { fs.unlinkSync(old); } catch {}
    }
    const ws = fs.createWriteStream(file);
    res.pipe(ws);
    ws.on('finish', () => {
      userMeta[user] = { ...(userMeta[user] || {}), avatarAt: Date.now() };
      store.saveUserMeta(DATA_DIR, userMeta);
      refreshAvatarIndex(); // 头像换了，索引同步一下
    });
    ws.on('error', () => {
      try {
        fs.unlinkSync(file);
      } catch {}
    });
  });
  req.setTimeout(15000, () => req.destroy());
  req.on('error', () => {});
}

// 将媒体项按帖子聚合（同一 tweetId 合并）并排序；图片 URL / 文案 / 头像交给 decoratePosts 按页补齐
function groupPosts(list, sort) {
  const map = new Map();
  for (const m of list) {
    let p = map.get(m.tweetId);
    if (!p) {
      p = { tweetId: m.tweetId, user: m.user, date: m.date, time: m.time, addedAt: m.addedAt || 0, media: [] };
      map.set(m.tweetId, p);
    } else if (m.addedAt && m.addedAt > p.addedAt) {
      p.addedAt = m.addedAt; // 同帖取最晚添加的媒体时间
    }
    p.media.push(m);
  }
  return [...map.values()].sort((a, b) => {
    if (sort === 'old') return a.time - b.time;
    if (sort === 'added-asc') return (a.addedAt || 0) - (b.addedAt || 0);
    if (sort === 'added-desc') return (b.addedAt || 0) - (a.addedAt || 0);
    return b.time - a.time;
  });
}

// 只对要返回的那一页补齐图片 URL / 文案 / 头像：全量做会触发上万次磁盘调用（页面慢的根因）
function decoratePosts(page) {
  for (const p of page) {
    const t = posts[p.tweetId];
    p.text = t && t.status === 'ok' ? t.text : null;
    const ui = userInfo(p.user);
    p.displayName = ui.displayName;
    p.avatar = ui.avatar;
    p.media = p.media
      .sort((a, b) => a.mediaIndex - b.mediaIndex)
      .map((m) => ({
        mediaIndex: m.mediaIndex,
        mediaId: m.mediaId,
        ext: m.ext,
        url: mediaUrl(m),
        thumbUrl: thumbUrl(m),
      }));
  }
  return page;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(req, res, filePath, cacheOverride) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const ext = path.extname(filePath).toLowerCase();
    // HTML 永不缓存；JS/CSS 短缓存（版本号兜底）；媒体与缩略图长缓存
    const cacheControl =
      cacheOverride ||
      (['.html'].includes(ext)
        ? 'no-store'
        : ['.js', '.css'].includes(ext)
          ? 'no-cache'
          : 'public, max-age=86400');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ---------- API ----------
// ---------- gallery-dl 下载队列（粘贴 X 链接 → 抓取 → 按 Xlikes 规则入库） ----------
const GALLERY_DL_CONFIG = path.join(__dirname, 'gallery-dl.toml');
const downloadQueue = []; // 待执行任务
const downloads = new Map(); // id -> job
let downloading = false;
let downloadSeq = 0;

// 任务保留 7 天：重启不丢，7 天后自动清理
const DOWNLOAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_MAX = 500; // 落盘条数上限，防止文件无限增长

function isActiveJob(job) {
  return job.status === 'running' || job.status === 'pending';
}

// 一个任务「最后活动」的时间：结束 > 开始 > 加入
function jobStamp(job) {
  return job.finishedAt || job.startedAt || job.addedAt || 0;
}

function persistDownloads() {
  const all = [...downloads.values()].sort((a, b) => jobStamp(b) - jobStamp(a));
  const active = all.filter(isActiveJob);
  const history = all.filter((j) => !isActiveJob(j)).slice(0, DOWNLOAD_MAX);
  store.saveDownloads(DATA_DIR, { seq: downloadSeq, jobs: [...active, ...history] });
}

// 清掉超过保留期的已结束任务
function pruneDownloads() {
  const now = Date.now();
  let removed = 0;
  for (const [id, job] of downloads) {
    if (isActiveJob(job)) continue;
    if (now - jobStamp(job) > DOWNLOAD_KEEP_MS) {
      downloads.delete(id);
      removed++;
    }
  }
  if (removed) persistDownloads();
  return removed;
}

// 启动时恢复队列：中断的任务标记失败（可重试），排队中的继续排
(function restoreDownloads() {
  const saved = store.loadDownloads(DATA_DIR);
  const jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
  let requeued = 0;
  let interrupted = 0;
  for (const job of jobs) {
    if (!job || !job.id || !job.url) continue;
    downloadSeq = Math.max(downloadSeq, Number(job.id) || 0);
    if (job.status === 'running') {
      // 上一次运行被重启打断，标为失败让用户重试（文件可能已下载完）
      job.status = 'failed';
      job.error = '服务重启，任务中断（可重试）';
      job.finishedAt = job.finishedAt || Date.now();
      interrupted++;
    }
    downloads.set(String(job.id), job);
    if (job.status === 'pending') {
      downloadQueue.push(job);
      requeued++;
    }
  }
  downloadSeq = Math.max(downloadSeq, Number(saved.seq) || 0);
  downloadQueue.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  pruneDownloads();
  if (downloads.size) {
    console.log(`[download] 恢复队列 ${downloads.size} 条（重新排队 ${requeued}，中断转失败 ${interrupted}）`);
  }
})();

setInterval(pruneDownloads, 60 * 60 * 1000); // 每小时清理过期任务

const X_HOSTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];

// 把各种 X/Twitter 分享链接规范化成 gallery-dl 认的 /<user>/status/<id>
// 兼容：/<user>/status/<id>、/<user>/i/<id>（新版分享）、/i/status/<id>、/i/web/status/<id>、twitter.com 域名
// 不是 X 链接返回 null
function normalizeXUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (!X_HOSTS.includes(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const idIdx = parts.findIndex((p) => /^\d{10,}$/.test(p)); // 帖子 ID 是长数字
  if (idIdx < 0) return null;
  const id = parts[idIdx];
  // 往前找用户名（跳过 i / web / status / statuses 这些中转段）
  let user = '';
  for (let i = idIdx - 1; i >= 0; i--) {
    const p = parts[i].toLowerCase();
    if (['i', 'web', 'status', 'statuses', 'c'].includes(p)) continue;
    user = parts[i];
    break;
  }
  return user ? `https://x.com/${user}/status/${id}` : `https://x.com${url.pathname}`;
}

// 按 http(s):// 切分多个链接：兼容换行、空格、以及直接相连（…ahttps://…b）的输入
function splitUrls(text) {
  return String(text || '')
    .split(/(?=https?:\/\/)/i)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

function startDownload(url, user = '') {
  const tweetId = (url.match(/\/(\d{10,})/) || [])[1] || '';
  // 提交时预检：这条帖子的媒体已经在库里，就标记为「已存在」，不重复下载
  const existing = tweetId ? index.media.filter((m) => m.tweetId === tweetId).length : 0;
  const job = {
    id: String(++downloadSeq),
    url,
    user, // 记下提交者：超级用户后台可以按用户查看抓取记录
    tweetId,
    existing,
    status: existing ? 'exists' : 'pending',
    addedAt: Date.now(),
  };
  downloads.set(job.id, job);
  if (!existing) downloadQueue.push(job);
  persistDownloads();
  return job;
}

// 从（已规范化的）链接里取用户名：https://x.com/<user>/status/<id>
function userFromUrl(u) {
  try {
    const first = new URL(u).pathname.split('/').filter(Boolean)[0] || '';
    return ['i', 'web', 'status', 'statuses'].includes(first.toLowerCase()) ? '' : first;
  } catch {
    return '';
  }
}

// 下载完直接把该用户目录扫一遍、新文件入索引。
// 不走全量/增量扫描：增量扫描靠「用户目录 mtime」判断变化，下载进已存在的日期目录时检测不到，会漏掉新文件。
async function indexDownloadedUser(user) {
  if (!user) return 0;
  const dir = path.join(ROOT, user);
  let items;
  try {
    items = await scanner.scanUserDir(dir, ROOT);
  } catch {
    return 0;
  }
  const known = new Set((index.media || []).filter((m) => m.user === user).map((m) => m.rel));
  const fresh = items.filter((m) => !known.has(m.rel));
  if (!fresh.length) return 0;
  const at = Date.now();
  // 下载来的文件用「首次发现时间」：gallery-dl 会把 mtime 设成推文发布日期，用 mtime 会排到很久以前
  for (const m of fresh) m.addedAt = at;
  index.media.push(...fresh);
  index.media = scanner.sortByTimeDesc(index.media);
  try {
    index.users[user] = (await fsp.stat(dir)).mtimeMs;
  } catch {}
  store.saveIndex(DATA_DIR, index);
  syncNewPosts(); // 新内容自动进文案抓取队列
  console.log(`[download] ${user} 新增 ${fresh.length} 条媒体入库`);
  return fresh.length;
}

// 跑 gallery-dl（execFile + 数组参数：URL 不会被 shell 解释，防注入）
// 抓媒体时顺带把文案与作者信息打到 stdout（metadata 后处理器 print 模式）：
// 媒体仍按原规则落盘，媒体目录里不多任何文件；字段用不可见分隔符包裹，便于解析
const GD_META_OPT =
  'postprocessors=' +
  JSON.stringify([
    {
      name: 'metadata',
      mode: 'print',
      event: 'prepare', // 用 prepare 而不是 file：文件已存在被跳过时也能拿到文案
      'content-format':
        '\u001e{tweet_id}\u001f{content}\u001f{author[name]}\u001f{author[nick]}\u001f{author[profile_image]}\u001d',
    },
  ]);
const GD_META_RE =
  /\u001e([^\u001f]*)\u001f([^\u001f]*)\u001f([^\u001f]*)\u001f([^\u001f]*)\u001f([^\u001d]*)\u001d/g;

// 解析 stdout：同一帖每个媒体一条记录，内容重复，按 tweetId 去重
function parseGalleryMeta(stdout) {
  const out = new Map();
  for (const m of String(stdout).matchAll(GD_META_RE)) {
    const [, tweetId, text, user, nick, avatar] = m;
    if (!tweetId) continue;
    const prev = out.get(tweetId);
    out.set(tweetId, {
      text: text.trim() || (prev && prev.text) || '',
      user: user || (prev && prev.user) || '',
      displayName: nick && nick !== user ? nick : (prev && prev.displayName) || '',
      avatarUrl: avatar || (prev && prev.avatarUrl) || '',
    });
  }
  return out;
}

function runGalleryDl(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'gallery-dl',
      ['--config-toml', GALLERY_DL_CONFIG, '-o', GD_META_OPT, url],
      { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || '').trim().slice(-300)));
        resolve(parseGalleryMeta(stdout));
      }
    );
  });
}

// 把抓到的文案写进文案缓存（与 fetcher 共用同一份 posts.json 结构）
// submittedBy：是谁通过顶部抓取栏提交的这个链接（超级用户后台会显示）
function applyGalleryMeta(meta, fallbackUser, submittedBy) {
  const now = Date.now();
  let n = 0;
  for (const [tweetId, info] of meta) {
    if (!info.text && !info.displayName && !info.avatarUrl) continue;
    const prev = posts[tweetId] || {};
    const user = info.user || fallbackUser || prev.user;
    const avatarUrl = info.avatarUrl || prev.avatarUrl;
    posts[tweetId] = {
      ...prev,
      user,
      submittedBy: submittedBy || prev.submittedBy,
      text: info.text || prev.text,
      source: 'gallery-dl',
      status: info.text ? 'ok' : prev.status || 'pending',
      displayName: info.displayName || prev.displayName,
      avatarUrl,
      retryCount: 0,
      error: undefined,
      fetchedAt: now,
      updatedAt: now,
    };
    if (user && avatarUrl && avatarUrl !== (userMeta[user] || {}).avatarUrl) {
      userMeta[user] = { ...(userMeta[user] || {}), avatarUrl };
      downloadAvatar(user, avatarUrl, true); // 头像变了才替换
    }
    n++;
  }
  if (n) store.savePosts(DATA_DIR, posts);
  return n;
}

async function runDownloadQueue() {
  if (downloading) return;
  const job = downloadQueue.shift();
  if (!job) return;
  downloading = true;
  job.status = 'running';
  job.startedAt = Date.now();
  console.log(`[download] 开始抓取 ${job.url}`);
  try {
    const meta = await runGalleryDl(job.url);
    job.status = 'done';
    // 直接按用户入库（精确、不依赖目录 mtime）；取不到用户名时退回增量扫描兜底
    const user = userFromUrl(job.url);
    const added = await indexDownloadedUser(user);
    job.added = added;
    job.texts = applyGalleryMeta(meta, user, job.user); // 抓媒体时顺带入库的文案条数
    if (!added) incrementalScan();
    console.log(`[download] 完成 ${job.url}（新入库 ${added} 条，文案 ${job.texts} 条）`);
  } catch (err) {
    job.status = 'failed';
    job.error = String(err.message || err).slice(0, 300);
    console.error(`[download] 失败 ${job.url}：${job.error}`);
  } finally {
    job.finishedAt = Date.now();
    downloading = false;
    persistDownloads();
  }
}

setInterval(runDownloadQueue, 2000);

// ---------- gallery-dl 元数据补抓队列（只取文案等非媒体内容，不下载媒体）----------
// 风险控制：串行 + 随机间隔 + 周期性长停顿 + 连续无收获自动停止 + 单次批量上限
const META_MIN_MS = Number(process.env.META_MIN_MS || 2000); // 每条之间随机间隔下限
const META_MAX_MS = Number(process.env.META_MAX_MS || 5000); // 上限（随机取值，不固定节奏）
const META_BREAK_EVERY = Number(process.env.META_BREAK_EVERY || 30); // 每处理多少条来一次长停顿
const META_BREAK_MS = Number(process.env.META_BREAK_MS || 30000); // 长停顿基准时长（再乘 0.6~1.4 随机）
const META_MAX_STREAK = Number(process.env.META_MAX_STREAK || 15); // 连续无收获这么多条就停（防封号）
const META_MAX_BATCH = Number(process.env.META_MAX_BATCH || 300); // 单次最多处理多少条

const metaJob = {
  running: false,
  queue: [],
  total: 0,
  done: 0,
  ok: 0,
  miss: 0,
  error: 0,
  stopped: '',
  startedAt: 0,
  current: '',
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 只取元数据：--simulate 不落任何文件，-j 输出 JSON
function fetchMetaViaGalleryDl(user, tweetId) {
  return new Promise((resolve) => {
    const url = `https://x.com/${user}/status/${tweetId}`;
    execFile(
      'gallery-dl',
      ['--config-toml', GALLERY_DL_CONFIG, '--simulate', '-j', url],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const s = String(stdout || '');
        const a = s.indexOf('[');
        const b = s.lastIndexOf(']');
        if (b <= a) return resolve({ kind: 'error' });
        let data;
        try {
          data = JSON.parse(s.slice(a, b + 1));
        } catch {
          return resolve({ kind: 'error' });
        }
        for (const item of Array.isArray(data) ? data : []) {
          const m = Array.isArray(item) ? item[1] : item;
          if (m && m.author) {
            return resolve({
              kind: 'ok',
              text: String(m.content || '').trim(),
              user: m.author.name || user,
              displayName: m.author.nick || '',
              avatarUrl: m.author.profile_image || '',
            });
          }
        }
        resolve({ kind: 'deleted' }); // 帖子确实不存在 / 已删 / 账号受保护
      }
    );
  });
}

// 「没有标记」= 索引里有媒体但文案表里没记录，或记录还停在 pending / 没有状态
function pickUnmarkedTargets() {
  const seen = new Set();
  const out = [];
  const push = (tweetId, user) => {
    if (!tweetId || !user || seen.has(tweetId)) return;
    seen.add(tweetId);
    out.push({ tweetId, user });
  };
  for (const m of index.media) {
    const p = posts[m.tweetId];
    if (!p || p.status === 'pending' || !p.status) push(m.tweetId, m.user);
  }
  for (const [id, p] of Object.entries(posts)) {
    if (p && (p.status === 'pending' || !p.status)) push(id, p.user);
  }
  return out;
}

function pickFailedTargets() {
  return Object.entries(posts)
    .filter(([, p]) => p && p.status === 'failed' && p.user)
    .map(([tweetId, p]) => ({ tweetId, user: p.user }));
}

async function metaLoop() {
  if (metaJob.running || !metaJob.queue.length) return;
  metaJob.running = true;
  let streak = 0;
  while (metaJob.queue.length && metaJob.done < META_MAX_BATCH) {
    const { tweetId, user } = metaJob.queue.shift();
    metaJob.current = `@${user}`;
    const r = await fetchMetaViaGalleryDl(user, tweetId);
    metaJob.done++;
    if (r.kind === 'ok') {
      const prev = posts[tweetId] || {};
      const nick = r.displayName;
      const avatar = r.avatarUrl;
      posts[tweetId] = {
        ...prev,
        user: r.user || user,
        text: r.text || prev.text,
        source: 'gallery-dl',
        status: r.text ? 'ok' : prev.status || 'ok',
        displayName: nick || prev.displayName,
        avatarUrl: avatar || prev.avatarUrl,
        retryCount: 0,
        error: undefined,
        fetchedAt: Date.now(),
        updatedAt: Date.now(),
      };
      const u = r.user || user;
      if (avatar && avatar !== (userMeta[u] || {}).avatarUrl) {
        userMeta[u] = { ...(userMeta[u] || {}), avatarUrl: avatar };
        downloadAvatar(u, avatar, true);
      }
      metaJob.ok++;
      streak = 0;
    } else if (r.kind === 'deleted') {
      const prev = posts[tweetId] || {};
      posts[tweetId] = { ...prev, user, status: 'not_found', error: 'not_found', retryCount: 0, updatedAt: Date.now() };
      metaJob.miss++;
      streak++;
    } else {
      metaJob.error++;
      streak++;
    }
    if (metaJob.done % 10 === 0) store.savePosts(DATA_DIR, posts);
    if (streak >= META_MAX_STREAK) {
      metaJob.stopped = `连续 ${streak} 条无收获，已自动停止（防封号）`;
      console.error(`[meta] ${metaJob.stopped}`);
      break;
    }
    // 不固定节奏：随机间隔 + 每若干条一次长停顿
    let wait = META_MIN_MS + Math.random() * (META_MAX_MS - META_MIN_MS);
    if (metaJob.done % META_BREAK_EVERY === 0) wait += META_BREAK_MS * (0.6 + Math.random() * 0.8);
    await sleepMs(wait);
  }
  if (!metaJob.stopped && (!metaJob.queue.length || metaJob.done >= META_MAX_BATCH)) {
    metaJob.stopped = metaJob.queue.length ? `已达单次上限 ${META_MAX_BATCH} 条，剩余下次再跑` : '';
  }
  store.savePosts(DATA_DIR, posts);
  metaJob.running = false;
  metaJob.current = '';
  console.log(`[meta] 结束：处理 ${metaJob.done} 条，成功 ${metaJob.ok}，无收获 ${metaJob.miss + metaJob.error}`);
}

// ---------- gallery-dl 版本检查与容器内更新（仅超级用户）----------
// 注意：pip 升级写进容器可写层，重建容器后会回到镜像里的版本
const GDL = {
  current: '',
  latest: '',
  hasUpdate: false,
  checkedAt: 0,
  error: '',
  updateResult: '',
  updating: false,
};
const GDL_CACHE_MS = 5 * 60 * 1000;

function runCmd(cmd, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), errOut: String(stderr || '') });
    });
  });
}

async function gdlVersion() {
  const r = await runCmd('gallery-dl', ['--version'], 30000);
  if (!r.ok) return '';
  return (r.out || r.errOut).trim().split(/\s+/).pop() || '';
}

async function gdlLatest() {
  const res = await fetch('https://pypi.org/pypi/gallery-dl/json', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`PyPI 返回 ${res.status}`);
  const d = await res.json();
  if (!d.info || !d.info.version) throw new Error('PyPI 返回缺少版本号');
  return d.info.version;
}

// 升级后的兼容性自检：确认我们依赖的 CLI 选项与模块都还在
async function gdlSelfCheck() {
  const help = await runCmd('gallery-dl', ['--help'], 30000);
  if (!help.ok) return 'gallery-dl --help 执行失败';
  const text = help.out + help.errOut;
  if (!text.includes('--simulate')) return '缺少 --simulate 选项';
  if (!text.includes('--dump-json')) return '缺少 --dump-json 选项';
  const mods = await runCmd(
    'python3',
    ['-c', 'import gallery_dl.postprocessor.metadata, gallery_dl.extractor.twitter'],
    30000
  );
  if (!mods.ok) return '模块导入失败：' + (mods.errOut || '').trim().slice(-120);
  return '';
}

// pip 参数固定，不接受任何外部输入拼接
const pipArgs = (spec) => ['-m', 'pip', 'install', '--break-system-packages', '--no-cache-dir', '--upgrade', spec];

async function gdlUpdate() {
  const before = await gdlVersion();
  const r = await runCmd('python3', pipArgs('gallery-dl'), 300000);
  if (!r.ok) return { ok: false, error: '安装失败：' + (r.errOut || r.out).trim().slice(-300) };
  const problem = await gdlSelfCheck();
  if (problem) {
    let rollback = '未回滚';
    if (before) {
      const rb = await runCmd('python3', pipArgs(`gallery-dl==${before}`), 300000);
      rollback = rb.ok ? `已回滚到 v${before}` : '回滚也失败，请在 NAS 上手动处理';
    }
    return { ok: false, error: `新版本自检未通过（${problem}），${rollback}` };
  }
  const after = await gdlVersion();
  return { ok: true, from: before || '未知', to: after || '未知' };
}

async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/download' && req.method === 'POST') {
    const body = await readBody(req);
    const urls = splitUrls(body.url);
    if (!urls.length) return sendJson(res, 400, { error: '请粘贴 X 链接' });
    const normalized = [];
    const bad = [];
    for (const u of urls) {
      const n = normalizeXUrl(u);
      if (n) normalized.push(n);
      else bad.push(u);
    }
    if (bad.length) return sendJson(res, 400, { error: '无法识别的链接：' + bad[0].slice(0, 60) });
    const jobs = normalized.map((u) => startDownload(u, req.authUser));
    const exists = jobs.filter((j) => j.status === 'exists').length;
    return sendJson(res, 202, {
      ok: true,
      ids: jobs.map((j) => j.id),
      count: jobs.length,
      exists, // 其中有多少条是「已在库中、未重复下载」
    });
  }
  if (pathname === '/api/download/retry' && req.method === 'POST') {
    const body = await readBody(req);
    const job = downloads.get(String(body.id || ''));
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    // 只能重试自己提交的任务（超级用户不限）
    if (!auth.isSuperUser(req.authUser) && job.user !== req.authUser) {
      return sendJson(res, 403, { error: '无权限' });
    }
    if (job.status === 'running' || job.status === 'pending') {
      return sendJson(res, 409, { error: '任务已在队列中' });
    }
    job.status = 'pending';
    job.error = undefined;
    job.retryCount = (job.retryCount || 0) + 1;
    downloadQueue.push(job);
    persistDownloads();
    return sendJson(res, 200, { ok: true, id: job.id });
  }
  if (pathname === '/api/downloads') {
    const pruned = pruneDownloads();
    const order = { running: 0, pending: 1, failed: 2, done: 3 };
    // 超级用户看全部账号的抓取记录；普通用户只看自己提交的
    const superUser = auth.isSuperUser(req.authUser);
    let all = [...downloads.values()];
    if (!superUser) all = all.filter((j) => j.user === req.authUser);
    const items = all
      .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.addedAt - b.addedAt)
      .slice(0, 300);
    return sendJson(res, 200, {
      items,
      running: downloading,
      queued: downloadQueue.length,
      keepDays: DOWNLOAD_KEEP_MS / 24 / 3600 / 1000,
      pruned,
      superUser,
    });
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    auth.reload(); // 外部脚本可能刚写入新用户/新密码
    const body = await readBody(req);
    const username = String(body.username || '');
    const password = String(body.password || '');
    const ip = clientIp(req);
    const ua = req.headers['user-agent'] || '';
    if (!username || !password) {
      auth.logLogin(username || '?', ip, ua, 'missing_fields');
      return sendJson(res, 400, { error: '缺少用户名或密码' });
    }
    if (!auth.users[username]) {
      auth.logLogin(username, ip, ua, 'unknown_user');
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    if (!auth.verify(username, password)) {
      auth.logLogin(username, ip, ua, 'bad_password');
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const { token } = auth.createSession(username, { ip, ua });
    auth.logLogin(username, ip, ua, 'ok');
    setSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, username });
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie).xlikes_token;
    if (token) auth.logout(token);
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/me') {
    return sendJson(res, 200, { username: req.authUser, superUser: auth.isSuperUser(req.authUser) });
  }
  if (pathname === '/api/change-password' && req.method === 'POST') {
    const body = await readBody(req);
    const username = req.authUser;
    const oldP = String(body.oldPassword || '');
    const newP = String(body.newPassword || '');
    if (newP.length < 8) return sendJson(res, 400, { error: '新密码至少 8 位' });
    if (!auth.verify(username, oldP)) return sendJson(res, 401, { error: '旧密码错误' });
    auth.setPassword(username, newP); // 改密后所有已登录会话失效
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const username = req.authUser;
    const current = auth.findSession(parseCookies(req.headers.cookie).xlikes_token);
    const items = auth.listSessions(username).map((s) => ({
      ...s,
      current: !!(current && current.sessionId === s.id),
    }));
    return sendJson(res, 200, { items, superUser: auth.isSuperUser(username) });
  }
  if (pathname === '/api/sessions/all' && req.method === 'GET') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    return sendJson(res, 200, { items: auth.listAllSessions() });
  }
  if (pathname === '/api/sessions/revoke' && req.method === 'POST') {
    const body = await readBody(req);
    const sessionId = String(body.sessionId || '');
    const username = String(body.username || req.authUser);
    if (!sessionId) return sendJson(res, 400, { error: '缺少会话 ID' });
    if (username !== req.authUser && !auth.isSuperUser(req.authUser)) {
      return sendJson(res, 403, { error: '无权限' });
    }
    const ok = auth.revokeSession(username, sessionId);
    return sendJson(res, 200, { ok, error: ok ? null : '会话不存在' });
  }
  if (pathname === '/api/login-log') {
    const limit = Math.min(Number(query.get('limit') || 50), 200);
    const username = req.authUser;
    const items = [];
    if (auth.isSuperUser(username)) {
      // 超级用户：可看所有账号的登录日志
      for (const [uname, list] of Object.entries(auth.logs)) {
        for (const e of list) items.push({ username: uname, ...e });
      }
    } else {
      // 普通用户：只返回自己的登录日志
      for (const e of auth.logs[username] || []) {
        items.push({ username, ...e });
      }
    }
    items.sort((a, b) => b.time - a.time);
    return sendJson(res, 200, { items: items.slice(0, limit) });
  }
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      media: index.media.length,
      posts: Object.keys(posts).length,
      thumbs: thumbs.ffmpegAvailable(),
    });
  }
  if (pathname === '/api/feed') {
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 48), 200);
    const sort = query.get('sort') || 'new';
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    let items = index.media;
    if (from) items = items.filter((m) => m.date >= from);
    if (to) items = items.filter((m) => m.date <= to);
    const postsArr = groupPosts(items, sort);
    const page = decoratePosts(postsArr.slice(offset, offset + limit));
    return sendJson(res, 200, { items: page, total: postsArr.length });
  }
  if (pathname === '/api/users') {
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 100), 2000);
    const q = (query.get('q') || '').trim().toLowerCase();
    const byUser = new Map();
    for (const m of index.media) {
      const u = byUser.get(m.user);
      if (u) {
        u.count++;
        if (m.date < u.first) u.first = m.date;
        if (m.date > u.last) u.last = m.date;
      } else {
        byUser.set(m.user, { user: m.user, count: 1, first: m.date, last: m.date });
      }
    }
    const users = [...byUser.values()]
      .filter((u) => !q || u.user.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count);
    for (const u of users) {
      const ui = userInfo(u.user);
      u.displayName = ui.displayName;
      u.avatar = ui.avatar;
    }
    return sendJson(res, 200, { items: users.slice(offset, offset + limit), total: users.length });
  }
  if (pathname === '/api/search') {
    const q = (query.get('q') || '').trim().toLowerCase();
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 48), 200);
    const sort = query.get('sort') || 'new';
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    if (!q) return sendJson(res, 200, { items: [], total: 0 });
    const seen = new Set();
    const out = [];
    // 1) 按用户 ID 模糊匹配
    for (const m of index.media) {
      if (m.user.toLowerCase().includes(q)) {
        if (!seen.has(m.rel)) {
          seen.add(m.rel);
          out.push(m);
        }
      }
    }
    // 2) 按已抓取文案内容模糊匹配
    for (const [id, p] of Object.entries(posts)) {
      if (p.status === 'ok' && p.text && p.text.toLowerCase().includes(q)) {
        for (const m of index.media) {
          if (m.tweetId === id && !seen.has(m.rel)) {
            seen.add(m.rel);
            out.push(m);
          }
        }
      }
    }
    let list = out;
    if (from) list = list.filter((m) => m.date >= from);
    if (to) list = list.filter((m) => m.date <= to);
    const postsArr = groupPosts(list, sort);
    const page = decoratePosts(postsArr.slice(offset, offset + limit));
    return sendJson(res, 200, { items: page, total: postsArr.length });
  }
  let m = pathname.match(/^\/api\/user\/([^/]+)$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 48), 200);
    const items = index.media.filter((x) => x.user === user);
    const postsArr = groupPosts(items, 'new');
    const page = decoratePosts(postsArr.slice(offset, offset + limit));
    const ui = userInfo(user);
    return sendJson(res, 200, {
      user,
      displayName: ui.displayName,
      avatar: ui.avatar,
      items: page,
      total: postsArr.length,
    });
  }
  m = pathname.match(/^\/api\/user-meta\/([^/]+)$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    return sendJson(res, 200, { user, ...userInfo(user) });
  }
  m = pathname.match(/^\/api\/post\/(\d+)$/);
  if (m) {
    const tweetId = m[1];
    const media = index.media.filter((x) => x.tweetId === tweetId);
    if (!media.length) return sendJson(res, 404, { error: '帖子不存在' });
    const item = media[0];
    const p = posts[tweetId];
    ensureTextJob(tweetId);
    const ui = userInfo(item.user);
    return sendJson(res, 200, {
      tweetId,
      user: item.user,
      displayName: ui.displayName,
      avatar: ui.avatar,
      date: item.date,
      time: item.time,
      media: media.map((x) => ({ ...x, url: mediaUrl(x), thumbUrl: thumbUrl(x) })),
      text: p && p.status === 'ok' ? p.text : null,
      textStatus: textStatus(tweetId),
      postUrl: `https://x.com/${item.user}/status/${tweetId}`,
    });
  }
  m = pathname.match(/^\/api\/text\/(\d+)$/);
  if (m) {
    const tweetId = m[1];
    ensureTextJob(tweetId);
    const p = posts[tweetId] || {};
    return sendJson(res, 200, {
      tweetId,
      text: p.status === 'ok' ? p.text : null,
      textStatus: textStatus(tweetId),
    });
  }
  if (pathname === '/api/refresh') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    setImmediate(() => scanAndSave('manual'));
    return sendJson(res, 202, { scanning: true });
  }
  if (pathname === '/api/stats') {
    return sendJson(res, 200, {
      users: Object.keys(index.users || {}).length,
      media: (index.media || []).length,
      lastScanAt: index.lastScan ? index.lastScan.at : null,
      lastScanType: index.lastScan ? index.lastScan.type : null,
      scanning,
    });
  }
  if (pathname === '/api/texts') {
    const status = query.get('status');
    const by = query.get('by') || ''; // 按「提交抓取的用户」筛选（超级用户用）
    const superUser = auth.isSuperUser(req.authUser);
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    const entries = Object.entries(posts).map(([tweetId, p]) => ({ tweetId, ...p }));
    const stats = { total: entries.length, ok: 0, pending: 0, failed: 0, not_found: 0 };
    for (const e of entries) stats[e.status] = (stats[e.status] || 0) + 1;
    // 提交者是超级用户专属信息：普通用户既拿不到名单，也过滤不了
    // 下拉列出所有已有账号（没提交过的也列，数量为 0），并带上各自提交的抓取数
    const submitCount = new Map();
    for (const e of entries) {
      if (e.submittedBy) submitCount.set(e.submittedBy, (submitCount.get(e.submittedBy) || 0) + 1);
    }
    const submitterNames = new Set([...Object.keys(auth.users), ...submitCount.keys()]);
    const submitters = superUser
      ? [...submitterNames].sort().map((u) => ({ user: u, count: submitCount.get(u) || 0 }))
      : [];
    let filtered = status ? entries.filter((e) => e.status === status) : entries;
    if (by && superUser) filtered = filtered.filter((e) => e.submittedBy === by);
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const page = filtered.slice(offset, offset + limit);
    if (!superUser) for (const it of page) delete it.submittedBy;
    return sendJson(res, 200, {
      stats,
      progress: {
        total: stats.total,
        done: (stats.ok || 0) + (stats.failed || 0) + (stats.not_found || 0),
        pending: stats.pending || 0,
        running: fetchQueue.size > 0,
      },
      items: page,
      total: filtered.length,
      submitters,
    });
  }
  if (pathname === '/api/texts/retry' && req.method === 'POST') {
    const body = await readBody(req);
    const p = posts[body.tweetId];
    if (!p) return sendJson(res, 404, { error: '记录不存在' });
    posts[body.tweetId] = { ...p, status: 'pending', retryCount: 0, updatedAt: Date.now() };
    fetchQueue.add(body.tweetId);
    store.savePosts(DATA_DIR, posts);
    return sendJson(res, 200, { ok: true });
  }
  // 用 gallery-dl 补抓文案（只取元数据，不下载媒体）；mode=unmarked|failed
  if (pathname === '/api/texts/refetch' && req.method === 'POST') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    const body = await readBody(req);
    const mode = body.mode === 'failed' ? 'failed' : 'unmarked';
    if (metaJob.running) return sendJson(res, 409, { error: '已有补抓任务在跑，先停止或等它结束' });
    const list = mode === 'failed' ? pickFailedTargets() : pickUnmarkedTargets();
    const take = list.slice(0, META_MAX_BATCH);
    metaJob.queue = take;
    metaJob.total = take.length;
    metaJob.done = 0;
    metaJob.ok = 0;
    metaJob.miss = 0;
    metaJob.error = 0;
    metaJob.stopped = '';
    metaJob.startedAt = Date.now();
    console.log(`[meta] 开始补抓 ${take.length} 条（${mode}），间隔 ${META_MIN_MS}-${META_MAX_MS}ms`);
    metaLoop();
    return sendJson(res, 200, {
      ok: true,
      mode,
      queued: take.length,
      skipped: Math.max(0, list.length - take.length),
      batchMax: META_MAX_BATCH,
    });
  }
  if (pathname === '/api/texts/refetch/status') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    const { queue, ...rest } = metaJob;
    return sendJson(res, 200, { ...rest, queued: queue.length });
  }
  if (pathname === '/api/texts/refetch/stop' && req.method === 'POST') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    metaJob.queue = [];
    metaJob.stopped = '已手动停止';
    return sendJson(res, 200, { ok: true });
  }
  // gallery-dl 版本检查 / 容器内更新（仅超级用户）
  if (pathname === '/api/gallery-dl/version') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    const force = query.get('force') === '1';
    if (!force && GDL.checkedAt && Date.now() - GDL.checkedAt < GDL_CACHE_MS) {
      return sendJson(res, 200, GDL);
    }
    GDL.current = await gdlVersion();
    try {
      GDL.latest = await gdlLatest();
      GDL.error = '';
    } catch (e) {
      GDL.error = e.message || 'PyPI 请求失败';
    }
    GDL.hasUpdate = !!(GDL.latest && GDL.current && GDL.latest !== GDL.current);
    GDL.checkedAt = Date.now();
    return sendJson(res, 200, GDL);
  }
  if (pathname === '/api/gallery-dl/update' && req.method === 'POST') {
    if (!auth.isSuperUser(req.authUser)) return sendJson(res, 403, { error: '无权限' });
    if (GDL.updating) return sendJson(res, 409, { error: '正在更新中' });
    if (downloading || downloadQueue.length || metaJob.running) {
      return sendJson(res, 409, { error: '有抓取任务正在进行，先等它结束再更新' });
    }
    GDL.updating = true;
    try {
      const r = await gdlUpdate();
      GDL.checkedAt = 0;
      if (r.ok) {
        GDL.current = r.to;
        GDL.latest = r.to;
        GDL.hasUpdate = false;
        GDL.updateResult = `已更新 v${r.from} → v${r.to}`;
        console.log(`[gallery-dl] 更新成功 v${r.from} → v${r.to}`);
        return sendJson(res, 200, r);
      }
      GDL.updateResult = r.error;
      console.error(`[gallery-dl] 更新失败：${r.error}`);
      return sendJson(res, 500, r);
    } finally {
      GDL.updating = false;
    }
  }
  if (pathname === '/api/texts/manual' && req.method === 'POST') {
    const body = await readBody(req);
    const tweetId = String(body.tweetId || '');
    const text = String(body.text || '').trim();
    if (!tweetId || !text) return sendJson(res, 400, { error: '缺少帖子 ID 或文案' });
    const item = index.media.find((m) => m.tweetId === tweetId);
    posts[tweetId] = {
      ...(posts[tweetId] || {}),
      user: (posts[tweetId] && posts[tweetId].user) || (item ? item.user : null),
      date: (posts[tweetId] && posts[tweetId].date) || (item ? item.date : null),
      text,
      source: 'manual',
      status: 'ok',
      error: undefined,
      retryCount: 0,
      updatedAt: Date.now(),
      fetchedAt: Date.now(),
    };
    store.savePosts(DATA_DIR, posts);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not Found' });
}

// 媒体路径安全解析：必须落在媒体库内，且不得命中隐藏目录/文件
// （.data 里存着 cookies、索引、头像，绝不能经 /media 或 /thumb 读出去）
function safeMediaPath(rel) {
  const rootReal = path.resolve(ROOT);
  const full = path.resolve(rootReal, rel);
  if (!full.startsWith(rootReal + path.sep)) return null;
  if (rel.split(/[\\/]+/).some((seg) => seg.startsWith('.'))) return null;
  return full;
}

// 防盗链：媒体资源的 Referer/Origin 必须与本站 Host 一致；无来源（直接打开/另存为）放行
function sameSite(req) {
  const ref = req.headers.referer || req.headers.origin;
  if (!ref) return true;
  try {
    return new URL(ref).host === (req.headers.host || '');
  } catch {
    return false;
  }
}

// ---------- 请求入口（HTTPS 主服务使用） ----------
function handleRequest(req, res) {
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const { pathname } = u;

  // 登录保护：除公开路径外，先校验 Cookie 会话
  if (!PUBLIC_PATHS.has(pathname)) {
    const token = parseCookies(req.headers.cookie).xlikes_token;
    const user = auth.checkToken(token);
    if (!user) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: '未登录' });
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }
    req.authUser = user;
  }

  // 防盗链：原图 / 视频 / 缩略图 / 头像 只允许本站来源引用（外站 embed 直接 403）
  if (
    !sameSite(req) &&
    (pathname.startsWith('/media/') ||
      pathname.startsWith('/thumb/') ||
      pathname.startsWith('/avatar/'))
  ) {
    return sendJson(res, 403, { error: '禁止外站引用' });
  }

  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, u.searchParams);

  if (pathname.startsWith('/avatar/')) {
    const user = decodeURIComponent(pathname.slice('/avatar/'.length));
    const file = findAvatarFile(user);
    if (!file) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    return serveFile(req, res, file);
  }

  if (pathname.startsWith('/thumb/')) {
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice('/thumb/'.length));
    } catch {
      return sendJson(res, 400, { error: 'Bad thumb path' });
    }
    const full = safeMediaPath(rel);
    if (!full) return sendJson(res, 403, { error: 'Forbidden' });
    const ext = path.extname(full).slice(1).toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'mp4'].includes(ext)) return sendJson(res, 404, { error: 'Not media' });
    const thumb = thumbs.generateThumb(DATA_DIR, full, rel, ext);
    // 缩略图带 mtime 版本号 → 内容不变可长缓存（immutable），变动时 URL 变、自动刷新
    if (thumb) return serveFile(req, res, thumb, 'public, max-age=31536000, immutable');
    return serveFile(req, res, full); // 无 ffmpeg 或生成失败时回退原图
  }

  if (pathname.startsWith('/media/')) {
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice('/media/'.length));
    } catch {
      return sendJson(res, 400, { error: 'Bad media path' });
    }
    const full = safeMediaPath(rel);
    if (!full) return sendJson(res, 403, { error: 'Forbidden' });
    return serveFile(req, res, full);
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  return serveFile(req, res, file);
}

// ---------- 启动 ----------
// 已有索引里的历史媒体缺 addedAt 时，启动后跑一次全量扫描补齐（旧数据取文件 mtime）
const needStamp = (index.media || []).some((m) => !m.addedAt);
if (process.argv.includes('--rescan') || !index.media.length || !index.lastScan || needStamp) {
  scanAndSave('auto');
}
syncNewPosts();
setInterval(incrementalScan, RESCAN_MS);

let key, cert;
try {
  key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
  cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
} catch {
  console.error(`[https] 证书缺失，请先运行 scripts/gen-cert.sh 生成 ${CERT_DIR}/cert.pem`);
  process.exit(1);
}

const secureServer = https.createServer({ key, cert }, handleRequest);

// HTTP 端口仅做 302 跳转到 HTTPS
const redirectServer = http.createServer((req, res) => {
  const host = (req.headers.host || '<host-ip>').split(':')[0];
  res.writeHead(302, { Location: `https://${host}:${PUBLIC_HTTPS_PORT}${req.url}` });
  res.end();
});

secureServer.listen(HTTPS_PORT, () => {
  console.log(`Xlikes 已启动（HTTPS）: https://0.0.0.0:${HTTPS_PORT}`);
  console.log(`媒体根目录: ${ROOT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  if (!process.env.XLIKES_MEDIA_ROOT) {
    console.log(`提示: 未设置 XLIKES_MEDIA_ROOT，使用默认目录 ${ROOT}（可通过环境变量自定义）`);
  }
  if (!index.media.length) console.log('提示: 索引为空，正在后台扫描，稍后刷新页面');
  const pending = Object.values(posts).filter((p) => p.status === 'pending' || p.status === 'failed').length;
  if (pending) console.log(`[fetch] 后台待抓取文案 ${pending} 条，每 ${FETCH_INTERVAL_MS}ms 抓 1 条`);
});
redirectServer.listen(HTTP_PORT, () => {
  console.log(`HTTP 跳转服务: http://0.0.0.0:${HTTP_PORT} -> https://…:${PUBLIC_HTTPS_PORT}`);
});
