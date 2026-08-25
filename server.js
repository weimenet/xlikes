// Xlikes 浏览服务：零依赖 Node 内置模块实现（HTTPS + 用户登录）
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const scanner = require('./lib/scanner');
const store = require('./lib/store');
const { fetchText } = require('./lib/fetcher');
const thumbs = require('./lib/thumbs');
const { Auth } = require('./lib/auth');

const ROOT = process.env.XLIKES_MEDIA_ROOT || path.join(__dirname, 'media');
// 宿主机上的媒体根实际路径（部署机视角）；用于把设置里的宿主机下载路径映射为容器内路径
const HOST_MEDIA_ROOT = process.env.XLIKES_HOST_MEDIA_ROOT || '';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const LIMIT = Number(process.env.XLIKES_MEDIA_LIMIT || 0); // 0 = 全部
const RESCAN_MS = Number(process.env.RESCAN_MS || 10 * 60 * 1000);
const RETRY_MS = 60 * 1000; // 文案抓取失败后的重试间隔
const FETCH_INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS || 5000); // 文案抓取限速（防封）
const MAX_AUTO_RETRY = 3; // 失败自动重试次数上限
const AUTO_RETRY_DELAY_MS = 10 * 60 * 1000; // 失败后自动重试间隔

let index = store.loadIndex(DATA_DIR);
let posts = store.loadPosts(DATA_DIR);
let settings = store.loadSettings(DATA_DIR);
const auth = new Auth(DATA_DIR);
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
function scanAndSave() {
  if (scanning) return;
  scanning = true;
  try {
    console.log(`[scan] 开始扫描 ${ROOT} ...`);
    const t0 = Date.now();
    const { media, users } = scanner.scanRoot(ROOT, LIMIT);
    index.media = scanner.sortByTimeDesc(media);
    index.users = users;
    store.saveIndex(DATA_DIR, index);
    syncNewPosts();
    console.log(`[scan] 完成，共 ${media.length} 条媒体，耗时 ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[scan] 失败:', err.message);
  } finally {
    scanning = false;
  }
}

function incrementalScan() {
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
      currentDirs = scanner.listDirs(ROOT);
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
        m = fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (m !== index.users[user]) changed.push(user);
    }
    if (!added.length && !removed.length && !changed.length) return;
    console.log(`[scan] 检测到目录变化：新增 ${added.length}，删除 ${removed.length}，变更 ${changed.length}`);

    let media = index.media.filter((x) => !removed.includes(x.user));
    for (const user of added) {
      const dir = path.join(ROOT, user);
      try {
        index.users[user] = fs.statSync(dir).mtimeMs;
        media.push(...scanner.scanUserDir(dir, ROOT));
      } catch {}
    }
    for (const user of changed) {
      const dir = path.join(ROOT, user);
      try {
        index.users[user] = fs.statSync(dir).mtimeMs;
        media = media.filter((x) => x.user !== user);
        media.push(...scanner.scanUserDir(dir, ROOT));
      } catch {}
    }
    for (const user of removed) delete index.users[user];
    index.media = scanner.sortByTimeDesc(media);
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
  fetchQueue.delete(id);
  const post = posts[id];
  if (!post || post.status === 'ok' || post.status === 'not_found') return;
  const user = post.user;
  console.log(`[fetch] 抓取文案 ${user}/${id}`);
  const r = await fetchText(id, user);
  const retryCount = r.status === 'failed' ? (post.retryCount || 0) + 1 : 0;
  posts[id] = {
    ...post,
    text: r.text,
    source: r.source,
    status: r.status,
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
  '.mp4': 'video/mp4',
};

function mediaUrl(item) {
  return `/media/${encodeURIComponent(item.rel)}`;
}

function thumbUrl(item) {
  return `/thumb/${encodeURIComponent(item.rel)}`;
}

// 将媒体项按帖子聚合（同一 tweetId 合并），媒体按媒体编号排序，附带已抓取文案
function groupPosts(list, sort) {
  const map = new Map();
  for (const m of list) {
    let p = map.get(m.tweetId);
    if (!p) {
      p = { tweetId: m.tweetId, user: m.user, date: m.date, time: m.time, media: [] };
      map.set(m.tweetId, p);
    }
    p.media.push({
      mediaIndex: m.mediaIndex,
      mediaId: m.mediaId,
      ext: m.ext,
      url: mediaUrl(m),
      thumbUrl: thumbUrl(m),
    });
  }
  const arr = [...map.values()].sort((a, b) => (sort === 'old' ? a.time - b.time : b.time - a.time));
  for (const p of arr) {
    const t = posts[p.tweetId];
    p.text = t && t.status === 'ok' ? t.text : null;
    p.media.sort((a, b) => a.mediaIndex - b.mediaIndex);
  }
  return arr;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const ext = path.extname(filePath).toLowerCase();
    // HTML 永不缓存；JS/CSS 短缓存（版本号兜底）；媒体与缩略图长缓存
    const cacheControl = ['.html'].includes(ext)
      ? 'no-store'
      : ['.js', '.css'].includes(ext)
        ? 'no-cache'
        : 'public, max-age=86400';
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
async function handleApi(req, res, pathname, query) {
  if (pathname === '/api/login' && req.method === 'POST') {
    auth.reload(); // 外部脚本可能刚写入新用户/新密码
    const body = await readBody(req);
    const username = String(body.username || '');
    const password = String(body.password || '');
    const ip = clientIp(req);
    const ua = req.headers['user-agent'] || '';
    if (!username || !password) {
      auth.logLogin(username || '?', ip, ua, 'missing_fields', false);
      return sendJson(res, 400, { error: '缺少用户名或密码' });
    }
    if (!auth.users[username]) {
      auth.logLogin(username, ip, ua, 'unknown_user', false);
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    if (!auth.verify(username, password)) {
      auth.logLogin(username, ip, ua, 'bad_password', false);
      return sendJson(res, 401, { error: '用户名或密码错误' });
    }
    const replaced = !!auth.users[username].currentTokenHash;
    const token = auth.createSession(username);
    auth.logLogin(username, ip, ua, 'ok', replaced);
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
    return sendJson(res, 200, { username: req.authUser });
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
  if (pathname === '/api/login-log') {
    const limit = Math.min(Number(query.get('limit') || 50), 200);
    const items = [];
    for (const [username, list] of Object.entries(auth.logs)) {
      for (const e of list) items.push({ username, ...e });
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
    const page = postsArr.slice(offset, offset + limit);
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
    const page = postsArr.slice(offset, offset + limit);
    return sendJson(res, 200, { items: page, total: postsArr.length });
  }
  let m = pathname.match(/^\/api\/user\/([^/]+)$/);
  if (m) {
    const user = decodeURIComponent(m[1]);
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 48), 200);
    const items = index.media.filter((x) => x.user === user);
    const postsArr = groupPosts(items, 'new');
    const page = postsArr.slice(offset, offset + limit);
    return sendJson(res, 200, { user, items: page, total: postsArr.length });
  }
  m = pathname.match(/^\/api\/post\/(\d+)$/);
  if (m) {
    const tweetId = m[1];
    const media = index.media.filter((x) => x.tweetId === tweetId);
    if (!media.length) return sendJson(res, 404, { error: '帖子不存在' });
    const item = media[0];
    const p = posts[tweetId];
    ensureTextJob(tweetId);
    return sendJson(res, 200, {
      tweetId,
      user: item.user,
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
    setImmediate(scanAndSave);
    return sendJson(res, 202, { scanning: true });
  }
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { downloadDir: settings.downloadDir || '' });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const downloadDir = String(body.downloadDir || '').trim();
      if (!downloadDir) {
        return sendJson(res, 400, { error: '下载文件夹路径不能为空' });
      }
      if (!path.isAbsolute(downloadDir)) {
        return sendJson(res, 400, { error: '下载文件夹路径必须是绝对路径' });
      }
      // downloadDir 为宿主机实际路径（部署机视角）；下载功能使用时需经挂载映射到容器内路径
      settings = { ...settings, downloadDir };
      store.saveSettings(DATA_DIR, settings);
      let containerPath = '';
      let warning = '';
      if (HOST_MEDIA_ROOT && downloadDir.startsWith(HOST_MEDIA_ROOT)) {
        // 媒体根已可写挂载进容器：宿主机路径前缀替换为容器内媒体根，保存后即可用
        containerPath = path.join(ROOT, downloadDir.slice(HOST_MEDIA_ROOT.length));
      } else if (HOST_MEDIA_ROOT) {
        warning = `该路径不在媒体根目录（${HOST_MEDIA_ROOT}）内，未挂载进容器，需手动在 compose 中添加挂载`;
      }
      return sendJson(res, 200, { ok: true, downloadDir, containerPath, warning });
    }
    return sendJson(res, 405, { error: '方法不支持' });
  }
  if (pathname === '/api/texts') {
    const status = query.get('status');
    const offset = Number(query.get('offset') || 0);
    const limit = Math.min(Number(query.get('limit') || 100), 500);
    const entries = Object.entries(posts).map(([tweetId, p]) => ({ tweetId, ...p }));
    const stats = { total: entries.length, ok: 0, pending: 0, failed: 0, not_found: 0 };
    for (const e of entries) stats[e.status] = (stats[e.status] || 0) + 1;
    const filtered = status ? entries.filter((e) => e.status === status) : entries;
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sendJson(res, 200, {
      stats,
      progress: {
        total: stats.total,
        done: (stats.ok || 0) + (stats.failed || 0) + (stats.not_found || 0),
        pending: stats.pending || 0,
        running: fetchQueue.size > 0,
      },
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
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
  if (pathname === '/api/texts/retry-all' && req.method === 'POST') {
    const body = await readBody(req);
    const status = body.status || 'failed';
    let n = 0;
    for (const [id, p] of Object.entries(posts)) {
      if (p.status === status) {
        posts[id] = { ...p, status: 'pending', retryCount: 0, updatedAt: Date.now() };
        fetchQueue.add(id);
        n++;
      }
    }
    store.savePosts(DATA_DIR, posts);
    return sendJson(res, 200, { ok: true, count: n });
  }
  if (pathname === '/api/texts/add' && req.method === 'POST') {
    const body = await readBody(req);
    const m = /(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i.exec(body.url || '');
    if (!m) return sendJson(res, 400, { error: '无法解析链接，形如 https://x.com/<用户>/status/<帖子ID>' });
    const user = m[1];
    const tweetId = m[2];
    const existed = !!posts[tweetId];
    posts[tweetId] = { ...(posts[tweetId] || {}), user, status: 'pending', updatedAt: Date.now() };
    fetchQueue.add(tweetId);
    store.savePosts(DATA_DIR, posts);
    return sendJson(res, 200, { tweetId, user, added: !existed || posts[tweetId].status !== 'ok' });
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

  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, u.searchParams);

  if (pathname.startsWith('/thumb/')) {
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice('/thumb/'.length));
    } catch {
      return sendJson(res, 400, { error: 'Bad thumb path' });
    }
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(path.resolve(ROOT) + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
    const ext = path.extname(full).slice(1).toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'mp4'].includes(ext)) return sendJson(res, 404, { error: 'Not media' });
    const thumb = thumbs.generateThumb(DATA_DIR, full, rel, ext);
    return serveFile(req, res, thumb || full); // 无 ffmpeg 或生成失败时回退原图
  }

  if (pathname.startsWith('/media/')) {
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice('/media/'.length));
    } catch {
      return sendJson(res, 400, { error: 'Bad media path' });
    }
    const full = path.resolve(ROOT, rel);
    if (!full.startsWith(path.resolve(ROOT) + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
    return serveFile(req, res, full);
  }

  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  return serveFile(req, res, file);
}

// ---------- 启动 ----------
if (process.argv.includes('--rescan') || !index.media.length) scanAndSave();
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
  res.writeHead(302, { Location: `https://${host}:5287${req.url}` });
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
  console.log(`HTTP 跳转服务: http://0.0.0.0:${HTTP_PORT} -> https://…:5287`);
});
