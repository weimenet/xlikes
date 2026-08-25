// 手动添加/修改 Xlikes 用户（唯一入口，无注册接口）
// 用法：node scripts/add-user.js <用户名> [密码]         添加用户
//       node scripts/add-user.js --set-password <用户名> [新密码]  修改密码（踢掉所有会话）
// 数据目录由 DATA_DIR 指定，默认 ./data
const path = require('path');
const { Auth } = require('../lib/auth');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const args = process.argv.slice(2);
const auth = new Auth(dataDir);

function usage() {
  console.log('用法:');
  console.log('  node scripts/add-user.js <用户名> [密码]');
  console.log('  node scripts/add-user.js --set-password <用户名> [新密码]');
  process.exit(1);
}

if (args[0] === '--set-password') {
  const [username, password] = args.slice(1);
  if (!username || !password) usage();
  auth.setPassword(username, password);
  console.log(`已修改 ${username} 的密码，所有已登录设备已失效。`);
} else {
  const [username, password] = args;
  if (!username || !password) usage();
  auth.addUser(username, password);
  console.log(`用户 ${username} 已创建。`);
}
