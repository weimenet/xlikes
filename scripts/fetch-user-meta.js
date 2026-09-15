#!/usr/bin/env node
// 全局补全用户头像与显示名：直接用 fxtwitter 用户端点查用户本身（不依赖帖子，帖子被删也能取到）
// 每个 ID 只抓一次，只补缺失项。
// 用法：node scripts/fetch-user-meta.js [--force]
//   --force  强制重抓所有 ID（默认只抓缺失显示名或头像的 ID）
// 环境变量：DATA_DIR（默认 ../data）、FETCH_RATE_MS（每个 ID 间隔，默认 800，防封）
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const RATE_MS = Number(process.env.FETCH_RATE_MS || 800);
const FORCE = process.argv.includes('--force');

function findAvatarFile(user) {
  try {
    const prefix = encodeURIComponent(user) + '.';
    const name = fs.readdirSync(AVATAR_DIR).find((f) => f.startsWith(prefix));
    return name ? path.join(AVATAR_DIR, name) : null;
  } catch {
    return null;
  }
}

async function downloadAvatar(user, url) {
  if (!url || !/^https?:/i.test(url)) return false;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Xlikes/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return false;
    let ext;
    try {
      ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
    } catch {
      ext = '.jpg';
    }
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) ext = '.jpg';
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const old = findAvatarFile(user);
    if (old) {
      try { fs.unlinkSync(old); } catch {}
    }
    const file = path.join(AVATAR_DIR, `${encodeURIComponent(user)}${ext}`);
    fs.writeFileSync(file, buf);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 直接查用户本身（fxtwitter 用户端点）；账号不存在/查询失败返回 null
async function fetchUserMeta(user) {
  try {
    const res = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(user)}`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = data && data.user;
    if (!u) return null;
    return { displayName: u.name || '', avatarUrl: u.avatar_url || '' };
  } catch {
    return null;
  }
}

async function main() {
  const index = store.loadIndex(DATA_DIR);
  const userMeta = store.loadUserMeta(DATA_DIR);
  const users = Object.keys(index.users || {});
  if (!users.length) {
    console.log('没有用户，请先扫描媒体库（或确认 DATA_DIR 正确）');
    return;
  }

  let checked = 0;
  let complete = 0;
  let fetched = 0;
  let fail = 0;
  for (const user of users) {
    checked++;
    const meta = userMeta[user] || {};
    const hasName = !!meta.displayName;
    const hasAvatar = !!findAvatarFile(user);
    if (!FORCE && hasName && hasAvatar) {
      complete++;
      continue;
    }

    process.stdout.write(`[fetch] ${user} ... `);
    const r = await fetchUserMeta(user);
    if (!r) {
      fail++;
      console.log('账号不存在或查询失败');
      await sleep(RATE_MS);
      continue;
    }
    if (r.displayName && !meta.displayName) meta.displayName = r.displayName;
    let gotAvatar = false;
    if (r.avatarUrl && (!hasAvatar || FORCE)) {
      gotAvatar = await downloadAvatar(user, r.avatarUrl);
      if (gotAvatar) meta.avatarUrl = r.avatarUrl;
    }
    if (meta.displayName || meta.avatarUrl) {
      meta.avatarAt = meta.avatarAt || Date.now();
      userMeta[user] = meta;
      store.saveUserMeta(DATA_DIR, userMeta);
    }
    const finalName = meta.displayName || r.displayName || '';
    const finalAvatar = gotAvatar || hasAvatar;
    console.log(`name=${finalName || '-'} avatar=${finalAvatar ? 'y' : 'n'}`);
    fetched++;
    if (!finalName && !finalAvatar) fail++;
    await sleep(RATE_MS);
  }

  console.log(`\n完成：共 ${checked} 个 ID，已完整 ${complete}，本次抓取 ${fetched}，未补到（账号不存在/查询失败）${fail}`);
}

main().catch((e) => {
  console.error('执行失败:', e);
  process.exit(1);
});
