// 扫描媒体目录：只读文件名（正则匹配），不读文件内容
// 用异步 fs，避免扫描期间阻塞事件循环（否则 TLS 握手/API 请求会超时 504）
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseFile } = require('./parser');

async function scanUserDir(userDir, root) {
  const items = [];
  for (const dirpath of await listDirs(userDir)) {
    let names;
    try {
      names = await fsp.readdir(dirpath);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dirpath, name);
      const item = parseFile(full);
      if (item) {
        if (root) item.rel = path.relative(root, full);
        // 文件修改时间：用于给历史数据补齐「添加时间」（addedAt）
        try {
          item.mtimeMs = (await fsp.stat(full)).mtimeMs;
        } catch {}
        items.push(item);
      }
    }
  }
  return items;
}

async function listDirs(root) {
  const out = [];
  let names;
  try {
    names = await fsp.readdir(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue; // 跳过隐藏目录（如 .data 数据目录）
    const p = path.join(root, name);
    try {
      if ((await fsp.stat(p)).isDirectory()) out.push(p);
    } catch {}
  }
  return out;
}

// 全量扫描；limit 供测试/首次快速启动用，同时记录用户目录 mtime 供增量扫描
async function scanRoot(root, limit = 0) {
  const media = [];
  const users = {};
  for (const userDir of await listDirs(root)) {
    const user = path.basename(userDir);
    try {
      users[user] = (await fsp.stat(userDir)).mtimeMs;
    } catch {
      continue;
    }
    for (const item of await scanUserDir(userDir, root)) {
      media.push(item);
      if (limit && media.length >= limit) return { media, users };
    }
  }
  return { media, users };
}

function sortByTimeDesc(media) {
  return media.sort((a, b) => b.time - a.time);
}

async function userDirMtimes(root, users) {
  const mtimes = {};
  for (const user of Object.keys(users)) {
    try {
      mtimes[user] = (await fsp.stat(path.join(root, user))).mtimeMs;
    } catch {
      mtimes[user] = -1; // 目录被删除
    }
  }
  return mtimes;
}

module.exports = { scanRoot, scanUserDir, sortByTimeDesc, userDirMtimes, listDirs };
