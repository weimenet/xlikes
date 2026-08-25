// 冒烟测试：健康检查、feed、用户、帖子、缩略图、媒体 Range、文案管理、静态页
const BASE = process.env.BASE || 'http://localhost:3000';

async function get(p, opts) {
  return fetch(BASE + p, opts);
}

(async () => {
  const health = await (await get('/api/health')).json();
  console.log('health:', JSON.stringify(health));

  const feed = await (await get('/api/feed?limit=2')).json();
  console.log('feed total:', feed.total);
  for (const i of feed.items) console.log('  item:', i.user, i.tweetId, i.ext, i.date, i.thumbUrl);

  const users = await (await get('/api/users?limit=2')).json();
  console.log('users:', JSON.stringify(users.items));

  const item = feed.items[0];
  if (item) {
    const post = await (await get(`/api/post/${item.tweetId}`)).json();
    console.log(
      'post:',
      JSON.stringify({
        tweetId: post.tweetId,
        user: post.user,
        date: post.date,
        media: post.media.length,
        textStatus: post.textStatus,
        postUrl: post.postUrl,
      })
    );

    const media = await get(item.url, { headers: { Range: 'bytes=0-99' } });
    await media.arrayBuffer();
    console.log(
      'media range:',
      media.status,
      media.headers.get('content-type'),
      media.headers.get('content-range')
    );

    const thumb = await get(item.thumbUrl, { headers: { Range: 'bytes=0-99' } });
    await thumb.arrayBuffer();
    console.log('thumb:', thumb.status, thumb.headers.get('content-type'));
  }

  const texts = await (await get('/api/texts?limit=2')).json();
  console.log('texts stats:', JSON.stringify(texts.stats));

  if (item) {
    const retry = await fetch(`${BASE}/api/texts/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweetId: item.tweetId }),
    });
    console.log('retry:', retry.status, JSON.stringify(await retry.json()));

    const add = await fetch(`${BASE}/api/texts/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/${item.user}/status/${item.tweetId}` }),
    });
    console.log('add:', add.status, JSON.stringify(await add.json()));
  }

  const index = await get('/');
  console.log('index:', index.status, index.headers.get('content-type'));
})();
