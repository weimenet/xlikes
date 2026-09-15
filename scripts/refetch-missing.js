#!/usr/bin/env node
// 回补被判为「原帖不存在」的帖子文案：用 gallery-dl 只取元数据（--simulate，不下载媒体）
// 用法：node scripts/refetch-missing.js [--limit N] [--dry] [--min-ms 1500] [--max-ms 4000]
// 特点：随机间隔 + 每若干条长停顿 + 连续失败自动降速 / 中止；每 20 条落盘一次，可随时中断重跑
const path = require('path');
const { execFile } = require('child_process');
const store = require('../lib/store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONF = process.env.GALLERY_DL_CONF || path.join(__dirname, '..', 'gallery-dl.toml');

function flag(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const LIMIT = Number(flag('--limit', 0)) || 0;
const SAMPLE = Number(flag('--sample', 0)) || 0; // 均匀抽样这么多条先试（估算捞回率）
const DRY = !!flag('--dry', false);
const MIN_MS = Number(flag('--min-ms', 1500));
const MAX_MS = Number(flag('--max-ms', 4000));
const BREAK_EVERY = Number(flag('--break-every', 35)); // 每这么多条插入一次长停顿
const MAX_STREAK = Number(flag('--max-streak', 15)); // 连续拿不到这么多条就停下（多半是登录态失效）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// 只取元数据：--simulate 不落任何文件，-j 输出 JSON
function fetchMeta(user, tweetId) {
  return new Promise((resolve) => {
    const url = `https://x.com/${user}/status/${tweetId}`;
    execFile(
      'gallery-dl',
      ['--config-toml', CONF, '--simulate', '-j', url],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const s = String(stdout || '');
        const a = s.indexOf('[');
        const b = s.lastIndexOf(']');
        if (b <= a) return resolve({ error: String(err && err.message || 'no output').slice(0, 80) });
        let data;
        try {
          data = JSON.parse(s.slice(a, b + 1));
        } catch {
          return resolve({ error: 'bad json' });
        }
        for (const item of Array.isArray(data) ? data : []) {
          const m = Array.isArray(item) ? item[1] : item;
          if (m && m.content) {
            return resolve({
              text: String(m.content).trim(),
              user: (m.author && m.author.name) || user,
              displayName: (m.author && m.author.nick) || '',
              avatarUrl: (m.author && m.author.profile_image) || '',
            });
          }
        }
        resolve({ deleted: true }); // 帖子本身不存在 / 已删 / 账号受保护
      }
    );
  });
}

(async () => {
  const posts = store.loadPosts(DATA_DIR);
  const targets = Object.entries(posts).filter(([, p]) => p && p.status === 'not_found' && p.user);
  let queue = targets;
  if (SAMPLE) {
    const step = Math.max(1, Math.floor(targets.length / SAMPLE));
    queue = [];
    for (let i = 0; i < targets.length && queue.length < SAMPLE; i += step) queue.push(targets[i]);
  } else if (LIMIT) {
    queue = targets.slice(0, LIMIT);
  }
  console.log(
    `[${ts()}] 待回补 ${targets.length} 条（not_found）` +
      `${SAMPLE ? `，均匀抽样 ${queue.length} 条试跑` : LIMIT ? `，本次只处理前 ${queue.length} 条` : ''}` +
      `${DRY ? '（dry run，不写盘）' : ''}`
  );

  let ok = 0;
  let miss = 0;
  let deleted = 0;
  let broke = 0;
  let done = 0;
  let streak = 0;
  for (const [id, p] of queue) {
    const got = await fetchMeta(p.user, id);
    done++;
    if (got && got.text) {
      ok++;
      streak = 0;
      posts[id] = {
        ...p,
        ...got,
        source: 'gallery-dl',
        status: 'ok',
        retryCount: 0,
        error: undefined,
        fetchedAt: Date.now(),
        updatedAt: Date.now(),
      };
      console.log(`[${ts()}] ${done}/${queue.length} ✓ ${p.user}/${id}  ${got.text.slice(0, 40).replace(/\s+/g, ' ')}`);
    } else if (got && got.deleted) {
      deleted++;
      streak++;
      console.log(`[${ts()}] ${done}/${queue.length} × ${p.user}/${id}  帖子确实不存在`);
    } else {
      miss++;
      streak++;
      broke++;
      console.log(`[${ts()}] ${done}/${queue.length} ! ${p.user}/${id}  抓取异常：${(got && got.error) || '未知'}`);
    }
    if (!DRY && done % 20 === 0) store.savePosts(DATA_DIR, posts);

    if (streak >= MAX_STREAK) {
      console.log(`[${ts()}] ‼ 连续 ${streak} 条拿不到，先停下（大概率是登录态失效或被限流）`);
      break;
    }

    // 不固定节奏：随机间隔 + 失败越多越慢 + 每隔若干条来一次长停顿
    let wait = rnd(MIN_MS, MAX_MS) + Math.min(streak, 5) * 1500;
    if (done % BREAK_EVERY === 0) wait += rnd(15000, 45000);
    if (done < queue.length) await sleep(wait);
  }

  if (!DRY) store.savePosts(DATA_DIR, posts);
  console.log(
    `[${ts()}] 结束：处理 ${done} 条 → 拿到文案 ${ok} 条，确认已不存在 ${deleted} 条，抓取异常 ${broke} 条`
  );
})();
