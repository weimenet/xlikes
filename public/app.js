// Xlikes 前端：hash 路由 + 瀑布流 + 仿 X 帖子页（无框架）
const $main = document.getElementById('main');
const $loading = document.getElementById('loading');

// 会话失效（401）统一跳登录页
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401) {
    location.replace('/login.html');
    throw new Error('未登录');
  }
  return res;
};

function showToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', 'toast');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

const state = {
  mode: 'feed',
  offset: 0,
  total: Infinity,
  user: null,
  feedQuery: '',
  feedFilters: { sort: 'new', from: '', to: '' },
  userSort: 'alpha-asc',
  userQuery: '',
  userData: [],
  cols: computeCols(),
  colCursor: 0,
  loading: false,
  colEls: [],
};

let textTimer = null;

function searchBar(placeholder, onSearch) {
  const input = el('input', 'searchbar');
  input.placeholder = placeholder;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onSearch(input.value.trim()), 300);
  });
  return input;
}

// 排序 + 时间段筛选栏（全部贴文 / 搜索结果共用）
function filterBar(f, onChange) {
  const bar = el('div', 'filter-bar');
  const sortSel = el('select');
  sortSel.innerHTML = '<option value="new">日期 新→旧</option><option value="old">日期 旧→新</option>';
  sortSel.value = f.sort;
  const fromInput = el('input');
  fromInput.type = 'date';
  fromInput.value = f.from;
  const toInput = el('input');
  toInput.type = 'date';
  toInput.value = f.to;
  const apply = () => {
    f.sort = sortSel.value;
    f.from = fromInput.value;
    f.to = toInput.value;
    onChange();
  };
  sortSel.onchange = apply;
  fromInput.onchange = apply;
  toInput.onchange = apply;
  bar.append(sortSel, fromInput, toInput);
  return bar;
}

function computeCols() {
  const w = window.innerWidth;
  return w < 560 ? 2 : w < 900 ? 3 : w < 1300 ? 4 : 5;
}

// ---------- 工具 ----------
function hashUser(h) {
  let x = 0;
  for (const c of h) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function avatar(user, size) {
  const node = el('div', 'avatar', user[0].toUpperCase());
  node.style.cssText = `background: hsl(${hashUser(user)} 70% 45%); width:${size || 44}px;height:${size || 44}px;`;
  return node;
}

// 帖子卡片：同一帖子的媒体拼图合并 + 底部悬浮 ID/文案
function postCard(post) {
  const a = el('a', 'card');
  a.href = `#/post/${post.tweetId}`;
  const n = Math.min(post.media.length, 4);
  const grid = el('div', `mosaic m${n}`);
  for (const m of post.media.slice(0, 4)) {
    const cell = el('div', 'mosaic-cell');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = m.thumbUrl || m.url;
    cell.appendChild(img);
    if (m.ext === 'mp4') cell.appendChild(el('span', 'play', '▶'));
    grid.appendChild(cell);
  }
  if (post.media.length > 4) {
    grid.appendChild(el('div', 'mosaic-more', `+${post.media.length - 4}`));
  }
  a.appendChild(grid);
  const overlay = el('div', 'card-overlay');
  overlay.appendChild(el('div', 'overlay-id', `@${post.user}`));
  overlay.appendChild(el('div', 'overlay-text', post.text ? escapeHtml(post.text) : ''));
  a.appendChild(overlay);
  return a;
}

// ---------- 瀑布流 ----------
function createColumns() {
  const wrap = el('div', 'columns');
  const cols = [];
  for (let i = 0; i < state.cols; i++) {
    const c = el('div', 'col');
    cols.push(c);
    wrap.appendChild(c);
  }
  state.colEls = cols;
  return wrap;
}

// 追加到同一组列，按顺序轮询分配，保证每列内保持时间轴顺序、超出可视范围自然向下延伸
function appendItems(items) {
  items.forEach((item) => {
    state.colEls[state.colCursor % state.cols].appendChild(postCard(item));
    state.colCursor++;
  });
}

function maxColHeight() {
  return Math.max(0, ...state.colEls.map((c) => c.offsetHeight));
}

async function loadMore() {
  if (state.mode !== 'feed' && state.mode !== 'user') return;
  if (state.loading || state.offset >= state.total) return;
  state.loading = true;
  // 首次加载约 3 屏；滚动后保证视口下方还有约 3 屏缓冲，继续往下加载
  const target = window.scrollY > 0 ? window.scrollY + window.innerHeight * 4 : window.innerHeight * 3;
  try {
    while (state.offset < state.total && maxColHeight() < target) {
      $loading.classList.remove('hidden');
      const f = state.feedFilters || { sort: 'new', from: '', to: '' };
      const qp = `sort=${f.sort}&from=${encodeURIComponent(f.from || '')}&to=${encodeURIComponent(f.to || '')}`;
      const url =
        state.mode === 'feed'
          ? state.feedQuery
            ? `/api/search?q=${encodeURIComponent(state.feedQuery)}&${qp}&offset=${state.offset}&limit=24`
            : `/api/feed?${qp}&offset=${state.offset}&limit=24`
          : `/api/user/${encodeURIComponent(state.user)}?offset=${state.offset}&limit=24`;
      const data = await (await fetch(url)).json();
      if (!data.items.length) {
        state.total = state.offset;
        break;
      }
      appendItems(data.items);
      state.offset += data.items.length;
      state.total = data.total;
    }
  } catch {
    // 静默失败，下次滚动重试
  } finally {
    $loading.classList.add('hidden');
    state.loading = false;
  }
}

// ---------- 页面 ----------
function renderFeed() {
  state.mode = 'feed';
  state.offset = 0;
  state.total = Infinity;
  state.colCursor = 0;
  $main.innerHTML = '';
  const resetFeed = () => {
    state.offset = 0;
    state.total = Infinity;
    state.colCursor = 0;
    const cols = $main.querySelector('.columns');
    if (cols) cols.remove();
    $main.appendChild(createColumns());
    loadMore();
  };
  const search = searchBar('搜索 ID 或帖子文案…', (q) => {
    state.feedQuery = q;
    resetFeed();
  });
  search.value = state.feedQuery;
  const top = el('div', 'feed-top');
  top.appendChild(search);
  top.appendChild(filterBar(state.feedFilters, resetFeed));
  $main.appendChild(top);
  $main.appendChild(createColumns());
  loadMore();
}

async function renderUsers() {
  state.mode = 'users';
  $main.innerHTML = '';
  $main.appendChild(el('div', 'page-title', 'ID索引'));
  const bar = el('div', 'filter-bar');
  const search = searchBar('搜索用户 ID…', (q) => {
    state.userQuery = q;
    renderUserList();
  });
  const sortSel = el('select');
  sortSel.innerHTML =
    '<option value="alpha-asc">ID A→Z</option><option value="alpha-desc">ID Z→A</option>' +
    '<option value="count-desc">贴文 多→少</option><option value="count-asc">贴文 少→多</option>';
  sortSel.value = state.userSort;
  sortSel.onchange = () => {
    state.userSort = sortSel.value;
    renderUserList();
  };
  bar.append(search, sortSel);
  $main.appendChild(bar);
  const wrap = el('div', 'users-layout');
  const list = el('div', 'users-main');
  const crumb = el('div', 'breadcrumb');
  wrap.append(list, crumb);
  $main.appendChild(wrap);

  function renderUserList() {
    list.innerHTML = '';
    crumb.innerHTML = '';
    const q = (state.userQuery || '').toLowerCase();
    let users = state.userData.filter((u) => !q || u.user.toLowerCase().includes(q));
    const s = state.userSort;
    if (s === 'alpha-asc') users.sort((a, b) => (a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1));
    else if (s === 'alpha-desc') users.sort((a, b) => (a.user.toLowerCase() > b.user.toLowerCase() ? -1 : 1));
    else if (s === 'count-desc') users.sort((a, b) => b.count - a.count);
    else users.sort((a, b) => a.count - b.count);

    const groups = new Map();
    for (const u of users) {
      const k = firstKey(u.user);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(u);
    }
    const desc = s === 'alpha-desc';
    const keys = [...groups.keys()].sort((a, b) => groupOrder(a, desc) - groupOrder(b, desc));
    if (!keys.length) {
      list.appendChild(el('div', 'empty', '没有匹配的 ID'));
      return;
    }
    for (const k of keys) {
      const label = k === '数字' ? '0-9' : k === '符号' ? '# 特殊符号' : k;
      const sec = el('div', 'user-group');
      sec.id = 'group-' + k;
      sec.appendChild(el('div', 'group-title', label));
      const grid = el('div', 'users-grid');
      for (const u of groups.get(k)) {
        const card = el('a', 'user-card');
        card.href = `#/user/${encodeURIComponent(u.user)}`;
        const av = el('div', 'avatar', u.user[0].toUpperCase());
        av.style.cssText = `background: hsl(${hashUser(u.user)} 70% 45%);`;
        const body = el('div', '', `<div class="name">@${u.user}</div><div class="sub">${u.first} ~ ${u.last}</div>`);
        const count = el('div', 'count', `${u.count}`);
        card.append(av, body, count);
        grid.appendChild(card);
      }
      sec.appendChild(grid);
      list.appendChild(sec);
      const b = el('a', 'crumb-item', k === '数字' ? '0-9' : k === '符号' ? '#' : k);
      b.href = '#group-' + k;
      b.onclick = (e) => {
        e.preventDefault();
        const t = document.getElementById('group-' + k);
        if (t) t.scrollIntoView({ behavior: 'smooth' });
      };
      crumb.appendChild(b);
    }
  }

  try {
    const data = await (await fetch('/api/users?limit=2000&offset=0')).json();
    state.userData = data.items;
    renderUserList();
  } catch {
    list.appendChild(el('div', 'empty', '加载失败'));
  }
}

// 用户 ID 首字母分组：字母 A-Z（忽略大小写）/ 数字 / 特殊符号
function firstKey(name) {
  const c = name[0];
  if (/[a-z]/i.test(c)) return c.toUpperCase();
  if (/[0-9]/.test(c)) return '数字';
  return '符号';
}

function groupOrder(k, desc) {
  let pos;
  if (k === '数字') pos = 26;
  else if (k === '符号') pos = 27;
  else pos = k.charCodeAt(0) - 65;
  return desc ? 27 - pos : pos;
}

async function renderUser(user) {
  state.mode = 'user';
  state.offset = 0;
  state.total = Infinity;
  state.user = user;
  state.colCursor = 0;
  $main.innerHTML = '';
  const head = el('div', '', '');
  const back = el('button', 'back', '← 返回');
  back.onclick = () => (location.hash = '#/');
  head.appendChild(back);
  const info = el('div', 'user-head');
  info.appendChild(avatar(user, 56));
  info.appendChild(el('div', '', `<div class="uname" style="font-size:18px">@${user}</div>`));
  head.appendChild(info);
  $main.appendChild(head);
  $main.appendChild(createColumns());
  loadMore();
}

async function renderPost(tweetId) {
  state.mode = 'post';
  $main.innerHTML = '';
  const page = el('div', 'post-page');
  $main.appendChild(page);
  const back = el('button', 'back', '← 返回');
  back.onclick = () => history.back();
  page.appendChild(back);
  const search = searchBar('搜索 ID 或帖子文案…', (q) => {
    if (q) renderSearchResults(q);
  });
  page.appendChild(search);
  try {
    const data = await (await fetch(`/api/post/${tweetId}`)).json();
    const card = el('article', 'post-card');
    const head = el('div', 'post-head');
    head.appendChild(avatar(data.user, 48));
    head.appendChild(el('div', '', `<div class="uname">@${data.user}</div><div class="udate">${fmtTime(data.time)}</div>`));
    const xlink = el('a', 'xlink', '查看原文 ↗');
    xlink.href = data.postUrl;
    xlink.target = '_blank';
    xlink.rel = 'noopener';
    head.appendChild(xlink);
    card.appendChild(head);

    const text = el('p', data.text ? 'post-text' : 'post-text loading', data.text ? escapeHtml(data.text) : '文案加载中…');
    card.appendChild(text);
    const retryBtn = el('button', 'btn', '重试抓取');
    retryBtn.style.display = 'none';
    retryBtn.onclick = async () => {
      retryBtn.style.display = 'none';
      text.className = 'post-text loading';
      text.textContent = '文案加载中…';
      await fetch('/api/texts/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweetId }),
      });
      startPoll(tweetId, text, retryBtn);
    };
    card.appendChild(retryBtn);
    const manualBtn = el('button', 'btn', '手动填写文案');
    manualBtn.style.display = 'none';
    manualBtn.onclick = () =>
      manualTextDialog(tweetId, '', (t) => {
        text.className = 'post-text';
        text.textContent = t;
        retryBtn.style.display = 'none';
        manualBtn.style.display = 'none';
      });
    card.appendChild(manualBtn);

    const media = el('div', `post-media ${data.media.length > 1 ? 'many' : 'one'}`);
    for (const m of data.media) {
      const box = el('div', 'media-item');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = m.thumbUrl || m.url; // 帖子内先显示缩略图，点击加载原图
      box.appendChild(img);
      if (m.ext === 'mp4') {
        box.appendChild(el('span', 'play-lg', '▶ 点击播放原视频'));
        box.onclick = () => {
          const v = document.createElement('video');
          v.controls = true;
          v.autoplay = true;
          v.playsInline = true;
          v.innerHTML = `<source src="${m.url}" type="video/mp4">`;
          box.replaceChildren(v);
        };
      } else {
        box.onclick = () => openLightbox(m.url); // 点击看原图
      }
      media.appendChild(box);
    }
    card.appendChild(media);
    card.appendChild(el('div', 'post-url-bar', `原帖：${data.postUrl}`));
    page.appendChild(card);

    if (data.textStatus === 'not_found') {
      text.className = 'post-text';
      text.textContent = '原帖不存在或已删除，可手动填写文案或到原帖查看。';
      retryBtn.style.display = '';
      manualBtn.style.display = '';
    } else if (data.textStatus !== 'ok') {
      startPoll(tweetId, text, retryBtn, manualBtn);
    }
  } catch {
    $main.appendChild(el('div', 'empty', '帖子不存在'));
  }
}

// ---------- 搜索结果页（帖子页进入） ----------
async function renderSearchResults(q) {
  state.mode = 'search';
  $main.innerHTML = '';
  const page = el('div', 'post-page');
  $main.appendChild(page);
  const back = el('button', 'back', '← 返回');
  back.onclick = () => history.back();
  page.appendChild(back);
  page.appendChild(el('div', 'page-title', `搜索：${q}`));
  const f = { sort: 'new', from: '', to: '' };
  const resultCount = el('div', 'empty', '');
  page.appendChild(filterBar(f, load));
  page.appendChild(resultCount);
  const list = el('div', 'text-list');
  page.appendChild(list);
  async function load() {
    list.innerHTML = '';
    resultCount.textContent = '';
    try {
      const data = await (
        await fetch(
          `/api/search?q=${encodeURIComponent(q)}&sort=${f.sort}&from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}&limit=200`
        )
      ).json();
      for (const it of data.items) {
        const row = el('div', 'text-row');
        const link = el('a', '', `@${it.user}`);
        link.href = `#/post/${it.tweetId}`;
        const tid = el('span', 'tid', it.tweetId);
        const date = el('span', 'time', it.date);
        row.append(link, tid, date);
        list.appendChild(row);
        if (it.text) {
          const snippet = el('div', 'search-snippet', escapeHtml(it.text.slice(0, 80)) + (it.text.length > 80 ? '…' : ''));
          snippet.style.color = 'var(--muted)';
          snippet.style.fontSize = '12px';
          snippet.style.margin = '-6px 0 6px 40px';
          list.appendChild(snippet);
        }
      }
      if (!data.items.length) list.appendChild(el('div', 'empty', '没有匹配的结果'));
      resultCount.textContent = `共 ${data.total} 条结果`;
    } catch {
      list.appendChild(el('div', 'empty', '搜索失败'));
    }
  }
  load();
}

let pollTimer = null;
function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPoll(tweetId, textEl, retryBtn, manualBtn) {
  stopPoll();
  let tries = 0;
  pollTimer = setInterval(async () => {
    try {
      const r = await (await fetch(`/api/text/${tweetId}`)).json();
      if (r.text) {
        stopPoll();
        textEl.className = 'post-text';
        textEl.textContent = r.text;
        if (retryBtn) retryBtn.style.display = 'none';
        if (manualBtn) manualBtn.style.display = 'none';
      } else if (r.textStatus === 'not_found') {
        stopPoll();
        textEl.className = 'post-text';
        textEl.textContent = '原帖不存在或已删除，可手动填写文案或到原帖查看。';
        if (retryBtn) retryBtn.style.display = '';
        if (manualBtn) manualBtn.style.display = '';
      } else if (++tries >= 12) {
        stopPoll();
        textEl.className = 'post-text';
        textEl.textContent = '自动抓取失败（账号可能被锁定或帖子不可访问），可重试、手动填写文案，或到原帖查看。';
        if (retryBtn) retryBtn.style.display = '';
        if (manualBtn) manualBtn.style.display = '';
      }
    } catch {
      stopPoll();
    }
  }, 2500);
}

function manualTextDialog(tweetId, initial, onSave) {
  const ov = el('div', 'lightbox');
  const box = el('div', 'manual-box');
  const ta = document.createElement('textarea');
  ta.rows = 6;
  ta.placeholder = '粘贴或输入该帖子的文案…';
  ta.value = initial || '';
  const save = el('button', 'btn primary', '保存');
  const cancel = el('button', 'btn', '取消');
  const row = el('div', 'row');
  row.append(save, cancel);
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const r = await fetch('/api/texts/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tweetId, text }),
    });
    if (r.ok) {
      ov.remove();
      onSave(text);
    }
  };
  cancel.onclick = () => ov.remove();
  ov.onclick = (e) => {
    if (e.target === ov) ov.remove();
  };
  box.append(ta, row);
  ov.appendChild(box);
  document.body.appendChild(ov);
  ta.focus();
}

function openLightbox(url) {
  const ov = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = url;
  ov.appendChild(img);
  ov.onclick = () => ov.remove();
  document.body.appendChild(ov);
}

// ---------- 文案管理页 ----------
const STATUS_LABEL = { ok: '已抓取', pending: '待抓取', failed: '抓取失败', not_found: '原帖不存在' };
const textState = { status: '', offset: 0, total: 0 };

async function renderTexts(container) {
  state.mode = 'texts';
  clearInterval(textTimer);
  container.innerHTML = '';
  container.appendChild(el('div', 'page-title', '文案抓取管理'));
  const progressWrap = el('div', 'progress-wrap');
  const bar = el('div', 'progress-bar');
  const fill = el('div', 'progress-fill');
  bar.appendChild(fill);
  const progLabel = el('span', 'progress-label', '…');
  progressWrap.append(bar, progLabel);
  container.appendChild(progressWrap);
  const msg = el('div', 'msg', '');
  container.appendChild(msg);

  function updateProgress(p) {
    if (!p || !p.total) return;
    const pct = Math.round((p.done / p.total) * 100);
    fill.style.width = `${pct}%`;
    progLabel.textContent = `${p.done}/${p.total}（${pct}%）· ${p.running ? '抓取中' : '空闲'}`;
    progLabel.classList.toggle('progress-running', !!p.running);
  }

  const chipsCfg = [
    { key: 'total', label: '总数', filter: '' },
    { key: 'ok', label: '已抓取', filter: 'ok' },
    { key: 'pending', label: '待抓取', filter: 'pending' },
    { key: 'failed', label: '抓取失败', filter: 'failed' },
    { key: 'not_found', label: '原帖不存在', filter: 'not_found' },
  ];
  const statsRow = el('div', 'stats-row');
  const chips = chipsCfg.map((cfg) => {
    const c = el('span', 'chip', `${cfg.label} <b>…</b>`);
    if (cfg.filter === textState.status) c.classList.add('active');
    c.onclick = () => {
      textState.status = cfg.filter;
      textState.offset = 0;
      renderConsole();
    };
    statsRow.appendChild(c);
    return c;
  });
  container.appendChild(statsRow);

  const toolbar = el('div', 'toolbar');
  const input = el('input');
  input.placeholder = '手动添加：粘贴 x.com 链接，如 https://x.com/user/status/123456789';
  const addBtn = el('button', 'btn primary', '添加');
  const retryAll = el('button', 'btn', '重试全部失败');
  const refresh = el('button', 'btn', '刷新');
  toolbar.append(input, addBtn, retryAll, refresh);
  container.appendChild(toolbar);

  addBtn.onclick = async () => {
    const url = input.value.trim();
    if (!url) return (msg.textContent = '请先粘贴链接');
    const r = await fetch('/api/texts/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    msg.textContent = r.ok ? `已加入抓取队列：@${d.user} ${d.tweetId}` : d.error || '添加失败';
    input.value = '';
    textState.offset = 0;
    renderConsole();
  };
  retryAll.onclick = async () => {
    const r = await fetch('/api/texts/retry-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: textState.status || 'failed' }),
    });
    const d = await r.json();
    msg.textContent = `已把 ${d.count} 条加入重试队列`;
    textState.offset = 0;
    renderConsole();
  };
  refresh.onclick = () => renderConsole();

  const list = el('div', 'text-list');
  container.appendChild(list);
  const moreBtn = el('button', 'btn', '加载更多');
  moreBtn.style.display = 'none';
  moreBtn.onclick = loadTexts;
  container.appendChild(moreBtn);

  async function loadTexts() {
    const q = textState.status ? `&status=${textState.status}` : '';
    try {
      const data = await (await fetch(`/api/texts?offset=${textState.offset}&limit=100${q}`)).json();
      chips.forEach((c, i) => {
        const cfg = chipsCfg[i];
        c.innerHTML = `${cfg.label} <b>${data.stats[cfg.key]}</b>`;
      });
      updateProgress(data.progress);
      for (const it of data.items) {
        const row = el('div', 'text-row');
        const link = el('a', '', `@${it.user}`);
        link.href = `#/post/${it.tweetId}`;
        const badge = el('span', `badge st-${it.status}`, STATUS_LABEL[it.status] || it.status);
        const time = el('span', 'time', it.updatedAt ? fmtTime(it.updatedAt) : '');
        const retry = el('button', 'btn', '重试');
        retry.onclick = async () => {
          await fetch('/api/texts/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tweetId: it.tweetId }),
          });
          badge.className = 'badge st-pending';
          badge.textContent = '待抓取';
          msg.textContent = `已加入重试队列：${it.tweetId}`;
        };
        const manual = el('button', 'btn', '手填');
        manual.onclick = () =>
          manualTextDialog(it.tweetId, it.text || '', () => {
            badge.className = 'badge st-ok';
            badge.textContent = '已抓取';
            msg.textContent = `已手动填写文案：${it.tweetId}`;
          });
        row.append(link, el('span', 'tid', it.tweetId), badge, time, manual, retry);
        list.appendChild(row);
      }
      textState.offset += data.items.length;
      textState.total = data.total;
      moreBtn.style.display = textState.offset < textState.total ? '' : 'none';
      if (!data.items.length) list.appendChild(el('div', 'empty', '暂无记录'));
    } catch {
      msg.textContent = '加载失败';
    }
  }
  loadTexts();
  textTimer = setInterval(async () => {
    try {
      const d = await (await fetch('/api/texts?limit=1')).json();
      updateProgress(d.progress);
    } catch {}
  }, 5000);
}

// ---------- 登录日志页 ----------
async function renderLogs(container) {
  state.mode = 'logs';
  container.innerHTML = '';
  container.appendChild(el('div', 'page-title', '登录日志（最近 50 条）'));
  const list = el('div', 'text-list');
  container.appendChild(list);
  try {
    const data = await (await fetch('/api/login-log?limit=50')).json();
    const RESULT = { ok: '成功', bad_password: '密码错误', unknown_user: '用户不存在', missing_fields: '缺少字段' };
    for (const e of data.items) {
      const row = el('div', 'text-row');
      const user = el('span', '', `@${e.username}`);
      const badge = el('span', `badge ${e.result === 'ok' ? 'st-ok' : 'st-failed'}`, RESULT[e.result] || e.result);
      const info = el('span', 'tid', `${e.ip} · ${e.device}${e.replaced ? ' · 顶掉旧会话' : ''}`);
      const time = el('span', 'time', fmtTime(e.time));
      row.append(user, badge, info, time);
      list.appendChild(row);
    }
    if (!data.items.length) list.appendChild(el('div', 'empty', '暂无记录'));
  } catch {
    list.appendChild(el('div', 'empty', '加载失败'));
  }
}

// ---------- 账户管理页 ----------
function renderAccount(container) {
  state.mode = 'account';
  container.appendChild(el('div', 'page-title', '账户管理'));
  const card = el('div', 'post-card');
  const userBlock = el('div', 'account-user');
  userBlock.appendChild(el('div', 's-label', '当前用户名'));
  const uname = el('div', 'account-username', '…');
  userBlock.appendChild(uname);
  card.appendChild(userBlock);
  const section = el('div', 'account-section-title', '修改密码');
  card.appendChild(section);
  const form = el('div', 'account-form');
  const oldP = el('input');
  oldP.className = 'text-input';
  oldP.type = 'password';
  oldP.placeholder = '当前密码';
  const newP = el('input');
  newP.className = 'text-input';
  newP.type = 'password';
  newP.placeholder = '新密码(至少8位)';
  const confirmP = el('input');
  confirmP.className = 'text-input';
  confirmP.type = 'password';
  confirmP.placeholder = '确认新密码';
  const msg = el('div', 'msg', '');
  const btn = el('button', 'btn primary', '保存');
  btn.onclick = async () => {
    if (newP.value !== confirmP.value) return (msg.textContent = '两次输入的新密码不一致');
    const r = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldP.value, newPassword: newP.value }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      msg.textContent = '修改成功，请用新密码重新登录。';
      setTimeout(() => (location.href = '/login.html'), 1200);
    } else {
      msg.textContent = d.error || '修改失败';
    }
  };
  form.append(oldP, newP, confirmP, btn, msg);
  card.appendChild(form);
  const logoutBtn = el('button', 'btn logout-btn', '退出登录');
  logoutBtn.onclick = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = '/login.html';
  };
  container.appendChild(card);
  container.appendChild(logoutBtn);
  (async () => {
    try {
      const d = await (await fetch('/api/me')).json();
      uname.textContent = d.username || '?';
    } catch {}
  })();
}

// ---------- 扫描页 ----------
async function renderScan(container) {
  container.appendChild(el('div', 'page-title', '扫描'));
  const card = el('div', 'post-card');
  const btn = el('button', 'btn primary', '立即扫描');
  btn.style.marginTop = '12px';
  function setRows(d) {
    card.innerHTML = '';
    const items = [
      ['用户 ID 数量', d.users],
      ['媒体数量', d.media],
      ['上一次扫描时间', d.lastScanAt ? fmtTime(d.lastScanAt) : '从未扫描'],
      ['扫描类型', d.lastScanType === 'manual' ? '手动扫描' : d.lastScanType === 'auto' ? '自动扫描' : '—'],
      ['扫描状态', d.scanning ? '扫描中…' : '空闲'],
    ];
    for (const [label, val] of items) {
      const row = el('div', 'stats-line');
      row.append(el('span', 's-label', label), el('span', 's-value', String(val)));
      card.appendChild(row);
    }
  }
  async function poll() {
    const d = await (await fetch('/api/stats')).json();
    setRows(d);
    if (d.scanning) {
      btn.disabled = true;
      btn.textContent = '扫描中…';
      setTimeout(poll, 2000);
    } else {
      btn.disabled = false;
      btn.textContent = '立即扫描';
    }
  }
  btn.onclick = async () => {
    try { await fetch('/api/refresh'); } catch {}
    poll();
  };
  container.append(card, btn);
  poll();
}

// ---------- 控制台页 ----------
function renderConsole() {
  state.mode = 'console';
  clearInterval(textTimer);
  const sub = (location.hash.split('/')[2]) || 'scan';
  $main.innerHTML = '';
  const layout = el('div', 'console-layout');
  const side = el('aside', 'console-side');
  const navs = [
    ['scan', '扫描'],
    ['texts', '文案'],
    ['logs', '日志'],
    ['account', '账户管理'],
  ];
  for (const [key, label] of navs) {
    const a = el('a', `console-nav${sub === key ? ' active' : ''}`, label);
    a.href = `#/console/${key}`;
    side.appendChild(a);
  }
  const content = el('div', 'console-content');
  layout.append(side, content);
  $main.appendChild(layout);
  if (sub === 'texts') renderTexts(content);
  else if (sub === 'logs') renderLogs(content);
  else if (sub === 'account') renderAccount(content);
  else renderScan(content);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 路由 ----------
function render() {
  clearInterval(textTimer);
  const h = location.hash;
  if (h.startsWith('#/post/')) renderPost(h.slice(7));
  else if (h.startsWith('#/user/')) renderUser(decodeURIComponent(h.slice(7)));
  else if (h.startsWith('#/console')) renderConsole();
  else if (h.startsWith('#/texts')) location.hash = '#/console/texts';
  else if (h.startsWith('#/logs')) location.hash = '#/console/logs';
  else if (h.startsWith('#/password')) location.hash = '#/console/account';
  else if (h.startsWith('#/users')) renderUsers();
  else renderFeed();
}

window.addEventListener('hashchange', render);
window.addEventListener('resize', () => {
  const c = computeCols();
  if (c !== state.cols) {
    state.cols = c;
    render();
  }
});
window.addEventListener('scroll', () => {
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 800) loadMore();
});

render();
