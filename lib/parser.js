// 文件名解析：<用户ID>_<YYYYMMDD>__<帖子ID>_<媒体编号>_<媒体ID>.<ext>
const path = require('path');
const { tweetTime } = require('./snowflake');

const FILE_RE =
  /^(?<user>.+?)_(?<date>\d{8})__(?<tweet>\d+)_(?<media>\d+)_(?<mediaId>\d+)\.(?<ext>jpg|jpeg|png|mp4)$/i;

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
