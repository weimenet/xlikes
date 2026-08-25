// JSON 文件存储：媒体索引 + 帖子文案缓存（数据量小，零依赖）
const fs = require('fs');
const path = require('path');

const INDEX_FILE = 'xlikes-index.json';
const POSTS_FILE = 'xlikes-posts.json';
const LEGACY_INDEX_FILE = 'xlikes-index.json';
const LEGACY_POSTS_FILE = 'xlikes-posts.json';

// 旧版数据文件名迁移：仅当新文件名不存在且旧文件名存在时重命名（保留已有数据）
function migrateFile(dataDir, oldName, newName) {
  const oldPath = path.join(dataDir, oldName);
  const newPath = path.join(dataDir, newName);
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    try {
      fs.renameSync(oldPath, newPath);
    } catch {}
  }
}

function loadIndex(dataDir) {
  migrateFile(dataDir, LEGACY_INDEX_FILE, INDEX_FILE);
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
  migrateFile(dataDir, LEGACY_POSTS_FILE, POSTS_FILE);
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, POSTS_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function savePosts(dataDir, posts) {
  atomicWrite(path.join(dataDir, POSTS_FILE), posts);
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

module.exports = { loadIndex, saveIndex, loadPosts, savePosts };
