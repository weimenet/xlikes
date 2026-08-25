// 缩略图生成：ffmpeg 抽帧/缩放，缓存到 data/thumbs/；无 ffmpeg 时前端回退原图
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const THUMB_MAX_W = 480;

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
  return path.join(dataDir, 'thumbs', `${h}.jpg`);
}

// 生成缩略图，返回缓存路径；失败返回 null
function generateThumb(dataDir, fullPath, rel, ext) {
  if (!ffmpegAvailable()) return null;
  const out = thumbFile(dataDir, rel);
  if (fs.existsSync(out)) return out;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const vf = `scale='min(${THUMB_MAX_W},iw)':-2`;
    const args =
      ext === 'mp4'
        ? ['-ss', '0.2', '-i', fullPath, '-frames:v', '1', '-vf', vf, '-q:v', '4', '-y', out]
        : ['-i', fullPath, '-vf', vf, '-q:v', '4', '-y', out];
    execFileSync('ffmpeg', args, { stdio: 'ignore', timeout: 30000 });
    return out;
  } catch {
    return null;
  }
}

module.exports = { ffmpegAvailable, generateThumb, thumbFile };
