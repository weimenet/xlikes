// Twitter snowflake ID -> 精确发布时间（毫秒）
const EPOCH = 1288834974657n;

function tweetTime(tweetId) {
  const id = BigInt(String(tweetId));
  return Number((id >> 22n) + EPOCH);
}

module.exports = { tweetTime };
