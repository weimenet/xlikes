#!/usr/bin/env node
// 视频缩略图批量生成：优先抓 X 封面（vxtwitter），抓不到再本地 ffmpeg 抽帧
// 统一输出 WebP 小图缓存（data/thumbs/*.webp），供 /thumb/ 路由直接命中
// 用法：node scripts/fetch-thumbs.js [--force]
//   --force  强制重建所有视频缩略图（默认跳过已有缓存的）
// 环境变量：DATA_DIR、XLIKES_MEDIA_ROOT、FETCH_RATE_MS（每个帖限速，默认 800ms）
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
const thumbs = require('../lib/thumbs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_ROOT = process.env.XLIKES_MEDIA_ROOT || path.join(__dirname, '..', 'media');
const RATE_MS = Number(process.env.FETCH_RATE_MS || 800);
const FORCE = process.argv.includes('--force');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 抓该帖各媒体的封面（走 fxtwitter；vxtwitter 在容器内会被 Cloudflare 拦 403）
// 返回 { count: 媒体总数, covers: Map(mediaIndex(1-based) -> thumbnail_url) }
async function fetchCovers(user, tweetId) {
  const res = await fetch(`https://api.fxtwitter.com/${user}/status/${tweetId}`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const list = data && data.tweet && data.tweet.media && data.tweet.media.all;
  if (!Array.isArray(list)) return null;
  const covers = new Map();
  list.forEach((m, i) => {
    if (m && m.thumbnail_url) covers.set(i + 1, m.thumbnail_url); // 媒体编号从 1 起
  });
  return { count: list.length, covers };
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return false;
  fs.writeFileSync(file, buf);
  return true;
}

async function main() {
  const index = store.loadIndex(DATA_DIR);
  const all = index.media || [];
  if (!all.length) {
    console.log('没有媒体，无需处理');
    return;
  }

  // 按帖分组；记录每帖媒体总数用于校验封面顺序对齐
  const byPost = new Map();
  const mediaCount = new Map();
  for (const m of all) {
    mediaCount.set(m.tweetId, (mediaCount.get(m.tweetId) || 0) + 1);
    if (!byPost.has(m.tweetId)) byPost.set(m.tweetId, []);
    byPost.get(m.tweetId).push(m);
  }

  const total = all.length;
  let done = 0;
  let grabbed = 0; // 视频：用 X 封面生成
  let framed = 0; // 视频：本地抽帧兜底
  let scaled = 0; // 图片：直接缩放
  let skipped = 0; // 已有缓存跳过
  let failed = 0;

  for (const [tweetId, items] of byPost) {
    const pending = items.filter((m) => FORCE || !fs.existsSync(thumbs.thumbFile(DATA_DIR, m.rel)));
    skipped += items.length - pending.length;
    done += items.length - pending.length;

    // 只对缺视频缩略图的帖抓封面
    const needCover = pending.some((m) => m.ext === 'mp4');
    let covers = null;
    if (needCover) {
      const user = items[0].user;
      try {
        const fc = await fetchCovers(user, tweetId);
        // 返回的媒体总数与本地一致才用（顺序对齐）；否则整帖回退抽帧
        if (fc && fc.count === mediaCount.get(tweetId)) covers = fc.covers;
      } catch {
        covers = null;
      }
    }

    for (const m of pending) {
      let ok = false;
      if (m.ext === 'mp4') {
        const url = covers && covers.get(m.mediaIndex);
        if (url) {
          const tmp = path.join(DATA_DIR, 'thumbs', `.tmp-${process.pid}-${m.mediaIndex}.jpg`);
          try {
            if (await download(url, tmp)) ok = !!thumbs.generateThumb(DATA_DIR, tmp, m.rel, 'jpg', true);
          } catch {
            ok = false;
          } finally {
            try { fs.unlinkSync(tmp); } catch {}
          }
          if (ok) grabbed++;
        }
        if (!ok) {
          // 抓不到封面（删帖/锁定/接口失败）→ 本地抽帧兜底
          const full = path.join(MEDIA_ROOT, m.rel);
          if (thumbs.generateThumb(DATA_DIR, full, m.rel, 'mp4', true)) {
            ok = true;
            framed++;
          }
        }
      } else {
        // 图片：直接从原图缩放
        const full = path.join(MEDIA_ROOT, m.rel);
        if (thumbs.generateThumb(DATA_DIR, full, m.rel, m.ext, true)) {
          ok = true;
          scaled++;
        }
      }
      if (!ok) failed++;
      done++;
    }
    if (needCover) await sleep(RATE_MS);
    process.stdout.write(
      `\r[thumb] ${done}/${total} 已有 ${skipped} 封面 ${grabbed} 抽帧 ${framed} 缩放 ${scaled} 失败 ${failed}   `
    );
  }

  console.log(
    `\n完成：共 ${total} 个媒体，跳过(已有) ${skipped}，视频抓封面 ${grabbed}，视频抽帧 ${framed}，图片缩放 ${scaled}，失败 ${failed}`
  );
}

main().catch((e) => {
  console.error('执行失败:', e);
  process.exit(1);
});
