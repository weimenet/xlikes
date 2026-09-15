// 文件名解析：<用户ID>_<YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.<ext>
const path = require('path');
const { tweetTime } = require('./snowflake');

// mediaId 允许字母、数字、下划线、连字符：历史文件是纯数字（下载工具命名），
// gallery-dl 下载的是 X 的媒体名（如 HIFt_NMbsAAoqPE，含下划线）
const FILE_RE =
  /^(?<user>.+?)_(?<date>\d{8})__(?<tweet>\d+)_(?<media>\d+)_(?<mediaId>[A-Za-z0-9_-]+)\.(?<ext>jpg|jpeg|png|mp4)$/i;

function parseFile(filePath) {
  const m = FILE_RE.exec(path.basename(filePath));
  if (!m) return null;
  const g = m.groups;
  const tweetId = g.tweet;
  return {
    user: g.user,
    date: `${g.date.slice(0, 4)}-${g.date.slice(4, 6)}-${g.date.slice(6, 8)}`,
    tweetId,
    mediaIndex: Number(g.media),
    mediaId: g.mediaId,
    ext: g.ext.toLowerCase(),
    time: tweetTime(tweetId),
  };
}

module.exports = { FILE_RE, parseFile };
