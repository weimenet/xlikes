// 认证模块：用户库（手动维护）、scrypt 密码哈希、单设备会话、登录日志
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const USERS_FILE = 'users.json';
const LOG_FILE = 'login-log.json';
const MAX_LOG = 1000;

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

class Auth {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.usersFile = path.join(dataDir, USERS_FILE);
    this.logFile = path.join(dataDir, LOG_FILE);
    this.users = load(this.usersFile); // { username: {salt, hash, currentTokenHash, createdAt, updatedAt} }
    this.logs = load(this.logFile); // { username: [{time, ip, ua, device, result, replaced}] }
  }

  saveUsers() {
    atomicWrite(this.usersFile, this.users);
  }

  saveLogs() {
    atomicWrite(this.logFile, this.logs);
  }

  // 重新加载用户表（支持运行时用 add-user.js 等外部方式建号/改密）
  reload() {
    this.users = load(this.usersFile);
  }

  addUser(username, password) {
    if (!username || !password) throw new Error('用户名和密码不能为空');
    if (this.users[username]) throw new Error(`用户 ${username} 已存在`);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    this.users[username] = {
      salt,
      hash,
      currentTokenHash: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.saveUsers();
  }

  setPassword(username, password) {
    const u = this.users[username];
    if (!u) throw new Error(`用户 ${username} 不存在`);
    const salt = crypto.randomBytes(16).toString('hex');
    u.salt = salt;
    u.hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    u.currentTokenHash = null; // 改密后所有已登录设备失效
    u.updatedAt = Date.now();
    this.saveUsers();
  }

  verify(username, password) {
    const u = this.users[username];
    if (!u) return false;
    const hash = crypto.scryptSync(String(password), u.salt, 64);
    return crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), hash);
  }

  createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    this.users[username].currentTokenHash = sha256(token);
    this.users[username].updatedAt = Date.now();
    this.saveUsers();
    return token;
  }

  // 校验 token，返回用户名或 null
  checkToken(token) {
    if (!token) return null;
    const h = sha256(token);
    for (const [name, u] of Object.entries(this.users)) {
      if (u.currentTokenHash === h) return name;
    }
    return null;
  }

  logout(token) {
    const name = this.checkToken(token);
    if (name) {
      this.users[name].currentTokenHash = null;
      this.saveUsers();
    }
  }

  logLogin(username, ip, ua, result, replaced) {
    const device = this.parseUA(ua);
    const entry = {
      time: Date.now(),
      ip,
      ua: (ua || '').slice(0, 200),
      device,
      result,
      replaced: !!replaced,
    };
    const list = this.logs[username] || [];
    list.unshift(entry);
    this.logs[username] = list.slice(0, MAX_LOG);
    this.saveLogs();
    return entry;
  }

  parseUA(ua = '') {
    let browser = 'unknown';
    let os = 'unknown';
    if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/iPhone|iPad/.test(ua)) os = 'iOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    return `${browser} / ${os}`;
  }
}

module.exports = { Auth, TOKEN_TTL_MS };
