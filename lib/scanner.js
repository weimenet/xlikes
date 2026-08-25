// 扫描媒体目录：只读文件名（正则匹配），不读文件内容
const fs = require('fs');
const path = require('path');
const { parseFile } = require('./parser');

function scanUserDir(userDir, root) {
  const items = [];
  for (const dirpath of listDirs(userDir)) {
    for (const name of fs.readdirSync(dirpath)) {
      const item = parseFile(path.join(dirpath, name));
      if (item) {
        if (root) item.rel = path.relative(root, path.join(dirpath, name));
        items.push(item);
      }
    }
  }
  return items;
}

function listDirs(root) {
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.')) continue; // 跳过隐藏目录（如 .data 数据目录）
    const p = path.join(root, name);
    if (fs.statSync(p).isDirectory()) out.push(p);
  }
  return out;
}

// 全量扫描；limit 供测试/首次快速启动用，同时记录用户目录 mtime 供增量扫描
function scanRoot(root, limit = 0) {
  const media = [];
  const users = {};
  for (const userDir of listDirs(root)) {
    const user = path.basename(userDir);
    users[user] = fs.statSync(userDir).mtimeMs;
    for (const item of scanUserDir(userDir, root)) {
      media.push(item);
      if (limit && media.length >= limit) return { media, users };
    }
  }
  return { media, users };
}

function sortByTimeDesc(media) {
  return media.sort((a, b) => b.time - a.time);
}

function userDirMtimes(root, users) {
  const mtimes = {};
  for (const user of Object.keys(users)) {
    try {
      mtimes[user] = fs.statSync(path.join(root, user)).mtimeMs;
    } catch {
      mtimes[user] = -1; // 目录被删除
    }
  }
  return mtimes;
}

module.exports = { scanRoot, scanUserDir, sortByTimeDesc, userDirMtimes, listDirs };
