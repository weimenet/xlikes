// 认证模块：用户库（手动维护）、scrypt 密码哈希、多设备会话、登录日志
//
// 超级用户判定（可查看/管理所有账号的登录设备与日志）：
//   1) 默认部署只有一个账号 —— 那个账号就是超级用户，不需要任何配置；
//   2) 需要指定多个超级用户时，用环境变量 XLIKES_SUPERUSERS（逗号分隔），
//      或在数据目录放一个 superusers.txt（每行一个用户名，# 开头为注释）；
//   3) 新增普通账号的能力保留在本模块与 scripts/add-user.js（用法见脚本内注释）。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const USERS_FILE = 'users.json';
const LOG_FILE = 'login-log.json';
const MAX_LOG = 1000;
const LASTSEEN_SAVE_MS = 60 * 1000; // lastSeen 落盘节流，避免每次请求都写盘

// 读取超级用户名单（环境变量 + 数据目录下的 superusers.txt；都不配则只依赖「单账号」规则）
function loadSuperUsers(dataDir) {
  const set = new Set(
    String(process.env.XLIKES_SUPERUSERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  try {
    const txt = fs.readFileSync(path.join(dataDir, 'superusers.txt'), 'utf8');
    for (const line of txt.split('\n')) {
      const name = line.trim();
      if (name && !name.startsWith('#')) set.add(name);
    }
  } catch {}
  return set;
}

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
    this.superUsers = loadSuperUsers(dataDir);
    this.logs = load(this.logFile); // { username: [{time, ip, ua, device, result, replaced}] }
    this.users = load(this.usersFile); // { username: {salt, hash, sessions:[], createdAt, updatedAt} }
    if (this.migrate(this.users)) this.saveUsers();
    this._lastSeenSaved = 0;
  }

  // 兼容旧版单会话结构（currentTokenHash）→ 多会话 sessions；并回填缺失的 ip/ua/device
  migrate(users) {
    let changed = false;
    for (const [username, u] of Object.entries(users)) {
      if (!Array.isArray(u.sessions)) {
        const legacy = u.currentTokenHash;
        u.sessions = legacy
          ? [{ id: 'legacy-' + legacy.slice(0, 8), tokenHash: legacy, createdAt: u.updatedAt || Date.now(), lastSeen: u.updatedAt || Date.now(), ip: '', ua: '', device: 'unknown' }]
          : [];
        delete u.currentTokenHash;
        changed = true;
      }
      // 旧会话（迁移而来）没有 ip/ua/device，用登录日志里最近一次成功登录回填
      const lastOk = (this.logs[username] || []).find((e) => e.result === 'ok');
      if (lastOk) {
        for (const s of u.sessions || []) {
          if (!s.ip && lastOk.ip) { s.ip = lastOk.ip; changed = true; }
          if (!s.ua && lastOk.ua) { s.ua = lastOk.ua; changed = true; }
          if ((!s.device || s.device === 'unknown') && lastOk.device) { s.device = lastOk.device; changed = true; }
        }
      }
    }
    return changed;
  }

  saveUsers() {
    // 写盘前先读一遍磁盘：外部脚本（scripts/add-user.js）刚建的新账号会被吸收进内存，
    // 否则本进程内存里的旧快照会把它整个覆盖掉（表现为「建完号刷新一下就没了」）
    // 已存在的账号按 updatedAt 取较新的一份，这样外部脚本改密码同样能生效
    try {
      const onDisk = load(this.usersFile);
      for (const [name, u] of Object.entries(onDisk)) {
        const cur = this.users[name];
        if (!cur || (u.updatedAt || 0) > (cur.updatedAt || 0)) this.users[name] = u;
      }
    } catch {}
    atomicWrite(this.usersFile, this.users);
  }

  saveLogs() {
    atomicWrite(this.logFile, this.logs);
  }

  // 重新加载用户表（支持运行时用 add-user.js 等外部方式建号/改密）
  reload() {
    this.users = load(this.usersFile);
    if (this.migrate(this.users)) this.saveUsers();
  }

  addUser(username, password) {
    if (!username || !password) throw new Error('用户名和密码不能为空');
    if (this.users[username]) throw new Error(`用户 ${username} 已存在`);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    this.users[username] = {
      salt,
      hash,
      sessions: [],
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
    u.sessions = []; // 改密后所有已登录设备失效
    u.updatedAt = Date.now();
    this.saveUsers();
  }

  verify(username, password) {
    const u = this.users[username];
    if (!u) return false;
    const hash = crypto.scryptSync(String(password), u.salt, 64);
    return crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), hash);
  }

  isSuperUser(username) {
    if (!username) return false;
    if (this.superUsers.has(username)) return true;
    // 默认部署只有一个账号：它就是超级用户
    const names = Object.keys(this.users || {});
    return names.length === 1 && names[0] === username;
  }

  // 登录创建新会话（多设备并存，不再顶下线）
  createSession(username, meta = {}) {
    const u = this.users[username];
    if (!u) throw new Error(`用户 ${username} 不存在`);
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      id: crypto.randomBytes(8).toString('hex'),
      tokenHash: sha256(token),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      ip: meta.ip || '',
      ua: (meta.ua || '').slice(0, 200),
      device: this.parseUA(meta.ua),
    };
    u.sessions = (u.sessions || []).filter((s) => Date.now() - s.createdAt < TOKEN_TTL_MS);
    u.sessions.push(session);
    u.updatedAt = Date.now();
    this.saveUsers();
    return { token, sessionId: session.id };
  }

  // 校验 token，返回用户名或 null（顺带更新 lastSeen，节流落盘）
  checkToken(token) {
    if (!token) return null;
    const h = sha256(token);
    for (const [name, u] of Object.entries(this.users)) {
      for (const s of u.sessions || []) {
        if (s.tokenHash === h) {
          s.lastSeen = Date.now();
          this._throttleSave();
          return name;
        }
      }
    }
    return null;
  }

  _throttleSave() {
    if (Date.now() - this._lastSeenSaved > LASTSEEN_SAVE_MS) {
      this._lastSeenSaved = Date.now();
      this.saveUsers();
    }
  }

  findSession(token) {
    if (!token) return null;
    const h = sha256(token);
    for (const [name, u] of Object.entries(this.users)) {
      for (const s of u.sessions || []) {
        if (s.tokenHash === h) return { username: name, sessionId: s.id };
      }
    }
    return null;
  }

  // 当前设备登出（只移除该 token 对应的会话）
  logout(token) {
    const found = this.findSession(token);
    if (!found) return;
    const u = this.users[found.username];
    u.sessions = (u.sessions || []).filter((s) => s.id !== found.sessionId);
    this.saveUsers();
  }

  // 踢下线：移除指定账号的某个会话；返回是否真的移除
  revokeSession(username, sessionId) {
    const u = this.users[username];
    if (!u || !sessionId) return false;
    const before = (u.sessions || []).length;
    u.sessions = (u.sessions || []).filter((s) => s.id !== sessionId);
    this.saveUsers();
    return (u.sessions || []).length < before;
  }

  // 单账号会话列表（脱敏，不含 tokenHash）
  listSessions(username) {
    const u = this.users[username];
    if (!u) return [];
    return (u.sessions || []).map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, ip: s.ip, device: s.device }));
  }

  // 所有账号会话列表（超级用户）
  listAllSessions() {
    const out = [];
    for (const [username, u] of Object.entries(this.users)) {
      for (const s of u.sessions || []) {
        out.push({ username, id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, ip: s.ip, device: s.device });
      }
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  logLogin(username, ip, ua, result) {
    const device = this.parseUA(ua);
    const entry = {
      time: Date.now(),
      ip,
      ua: (ua || '').slice(0, 200),
      device,
      result,
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
