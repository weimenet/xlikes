// JSON 文件存储：媒体索引 + 帖子文案缓存（数据量小，零依赖）
const fs = require('fs');
const path = require('path');

const INDEX_FILE = 'xlikes-index.json';
const POSTS_FILE = 'xlikes-posts.json';
const USER_META_FILE = 'user-meta.json';
const DOWNLOADS_FILE = 'download-jobs.json';

function loadIndex(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, INDEX_FILE), 'utf8'));
  } catch {
    return { version: 1, generatedAt: 0, media: [] };
  }
}

function saveIndex(dataDir, index) {
  index.generatedAt = Date.now();
  atomicWrite(path.join(dataDir, INDEX_FILE), index);
}

function loadPosts(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, POSTS_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function savePosts(dataDir, posts) {
  atomicWrite(path.join(dataDir, POSTS_FILE), posts);
}

function loadUserMeta(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, USER_META_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function saveUserMeta(dataDir, meta) {
  atomicWrite(path.join(dataDir, USER_META_FILE), meta);
}

// 抓取队列：落盘保存，任务保留 7 天后自动清理
function loadDownloads(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, DOWNLOADS_FILE), 'utf8'));
  } catch {
    return { seq: 0, jobs: [] };
  }
}

function saveDownloads(dataDir, obj) {
  atomicWrite(path.join(dataDir, DOWNLOADS_FILE), obj);
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

module.exports = {
  loadIndex,
  saveIndex,
  loadPosts,
  savePosts,
  loadUserMeta,
  saveUserMeta,
  loadDownloads,
  saveDownloads,
};
