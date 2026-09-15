// 缩略图生成：ffmpeg 抽帧/缩放 → WebP（小体积），缓存到 data/thumbs/；无 ffmpeg 时前端回退原图
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const THUMB_MAX_W = 320;    // 瀑布流最大显示宽约 288px（桌面 5 列），320 足够且体积小
const THUMB_QUALITY = 75;   // libwebp 质量（0-100）
const THUMB_EXT = '.webp';

let ffmpegReady = null;

function ffmpegAvailable() {
  if (ffmpegReady === null) {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegReady = true;
    } catch {
      ffmpegReady = false;
    }
  }
  return ffmpegReady;
}

function thumbFile(dataDir, rel) {
  const h = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 24);
  return path.join(dataDir, 'thumbs', `${h}${THUMB_EXT}`);
}

// 生成缩略图（mp4 抽帧 / 图片缩放）→ WebP 缓存，返回缓存路径；失败返回 null
// force=true 时覆盖已有缓存（用于「抓到 X 封面后替换抽帧结果」）
function generateThumb(dataDir, fullPath, rel, ext, force = false) {
  if (!ffmpegAvailable()) return null;
  const out = thumbFile(dataDir, rel);
  if (!force && fs.existsSync(out)) return out;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const vf = `scale='min(${THUMB_MAX_W},iw)':-2`;
    const input =
      ext === 'mp4'
        ? ['-ss', '0.2', '-i', fullPath, '-frames:v', '1', '-vf', vf]
        : ['-i', fullPath, '-vf', vf];
    const args = [...input, '-c:v', 'libwebp', '-quality', String(THUMB_QUALITY), '-y', out];
    execFileSync('ffmpeg', args, { stdio: 'ignore', timeout: 30000 });
    return out;
  } catch {
    return null;
  }
}

module.exports = { ffmpegAvailable, generateThumb, thumbFile, THUMB_MAX_W, THUMB_EXT };
