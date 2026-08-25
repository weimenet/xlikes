// 帖子文案抓取：多数据源按顺序尝试
// fxtwitter → vxtwitter → oembed → wayback（被删帖历史快照）→ x embed 页 → x 主站 r-bcqeeo
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 统一请求入口：带 15 秒超时，防止慢源阻塞抓取队列
function get(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
}

async function fetchText(tweetId, user) {
  const sources = [
    () => fetchFxtwitter(tweetId, user),
    () => fetchVxtwitter(tweetId, user),
    () => fetchOembed(tweetId, user),
    () => fetchWayback(tweetId, user),
    () => fetchEmbedPage(tweetId, user),
    () => scrapeX(tweetId, user),
  ];
  for (const fn of sources) {
    const r = await safe(fn);
    if (r && r.text) {
      return {
        status: 'ok',
        text: r.text,
        source: r.source,
        displayName: r.displayName || '',
        avatarUrl: r.avatarUrl || '',
      };
    }
    if (r && r.notFound) return { status: 'not_found', text: null, source: 'none' };
  }
  return { status: 'failed', text: null, source: 'none' };
}

async function safe(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function fetchOembed(tweetId, user) {
  const url =
    'https://publish.twitter.com/oembed?omit_script=true&dnt=true&url=' +
    encodeURIComponent(`https://x.com/${user}/status/${tweetId}`);
  const res = await get(url, { headers: { 'user-agent': UA } });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const data = await res.json();
  const html = data && data.html ? data.html : '';
  // oembed 返回的 blockquote 中第一个 <p> 即推文正文
  const m = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  const text = m ? decodeHtml(stripTags(m[1])) : '';
  return text.trim() ? { text: text.trim(), source: 'oembed', displayName: data.author_name || '' } : null;
}

async function fetchFxtwitter(tweetId, user) {
  const res = await get(`https://api.fxtwitter.com/${user}/status/${tweetId}`, {
    headers: { 'user-agent': UA },
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const data = await res.json();
  const tweet = data && data.tweet;
  const text = tweet && tweet.text;
  if (!text) return null;
  const author = (tweet && tweet.author) || {};
  return { text, source: 'fxtwitter', displayName: author.name || '', avatarUrl: author.avatar_url || '' };
}

async function fetchVxtwitter(tweetId, user) {
  const res = await get(`https://api.vxtwitter.com/${user}/status/${tweetId}`, {
    headers: { 'user-agent': UA },
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const data = await res.json();
  const text = data && data.text;
  if (!text) return null;
  const u = data && data.user;
  return { text, source: 'vxtwitter', displayName: (u && u.name) || '', avatarUrl: (u && u.avatar_url) || '' };
}

async function fetchEmbedPage(tweetId, user) {
  const res = await get(`https://x.com/${user}/status/${tweetId}/embed`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const html = await res.text();
  const text = extractTweetText(html);
  return text ? { text, source: 'embed' } : null;
}

// Wayback Machine 历史快照：帖子被删/账号锁定时仍有概率拿到删除前的文案
async function fetchWayback(tweetId, user) {
  // 老快照多为 twitter.com，新页面为 x.com，两个域名都查
  for (const host of ['x.com', 'twitter.com']) {
    const target = `${host}/${user}/status/${tweetId}`;
    const cdx = await get(
      `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&limit=5&filter=statuscode:200&collapse=digest`,
      { headers: { 'user-agent': UA } }
    );
    if (!cdx.ok) continue;
    const rows = await cdx.json();
    if (!Array.isArray(rows) || rows.length < 2) continue;
    for (const row of rows.slice(1)) {
      const ts = row[1];
      const original = row[2] || target;
      const snap = await get(`https://web.archive.org/web/${ts}id_/${original}`, {
        headers: { 'user-agent': UA },
        redirect: 'follow',
      });
      if (!snap.ok) continue;
      const html = await snap.text();
      const text = extractTweetText(html);
      if (text) return { text, source: 'wayback' };
    }
  }
  return null;
}

async function scrapeX(tweetId, user) {
  const res = await get(`https://x.com/${user}/status/${tweetId}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) return null;
  const html = await res.text();
  const text = extractTweetText(html);
  return text ? { text, source: 'x' } : null;
}

// 兼容新旧版 X/Twitter 页面的正文提取
function extractTweetText(html) {
  const patterns = [
    /data-testid="tweetText"[^>]*>([\s\S]*?)<\//i,
    /class="[^"]*\bjs-tweet-text\b[^"]*"[^>]*>([\s\S]*?)<\//i,
    /class="[^"]*\bTweetTextSize\b[^"]*"[^>]*>([\s\S]*?)<\//i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const t = decodeHtml(stripTags(m[1])).trim();
      if (t) return t;
    }
  }
  // X 前端正文使用 r-bcqeeo 类；取文本最长的匹配块
  const re = /<div[^>]*class="[^"]*\br-bcqeeo\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let best = '';
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = decodeHtml(stripTags(m[1])).trim();
    if (t.length > best.length) best = t;
  }
  return best || null;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

module.exports = { fetchText, fetchWayback };
