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
let metaTimer = null;
let jobTimer = null;

// 搜索框 + 搜索按钮：触屏上没有回车键，靠按钮触发；桌面端保留输入防抖
function searchBar(placeholder, onSearch) {
  const wrap = el('div', 'search-wrap');
  const input = el('input', 'searchbar');
  input.placeholder = placeholder;
  const btn = el('button', 'btn search-btn', '搜索');
  btn.type = 'button';
  const submit = () => onSearch(input.value.trim());
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(submit, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      submit();
    }
  });
  btn.onclick = () => {
    clearTimeout(timer);
    submit();
  };
  wrap.append(input, btn);
  // 兼容旧调用方 `search.value = …`
  Object.defineProperty(wrap, 'value', {
    get: () => input.value,
    set: (v) => {
      input.value = v || '';
    },
  });
  return wrap;
}

// ---------- 排序图标（统一风格：24 网格、圆头描边、跟随文字色）----------
const SVG_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">';
const I = {
  cal: '<rect x="3" y="4.5" width="12" height="11" rx="2.5"/><path d="M6.5 3v3M11.5 3v3M3 8.5h12"/>',
  add: '<rect x="3" y="4.5" width="12" height="11" rx="2.5"/><path d="M9 7.5v5M6.5 10h5"/>',
  az: '<path d="M4 16l3.5-9 3.5 9M5.3 12.6h4.4"/>',
  barsDesc: '<path d="M5 19V7M12 19V11M19 19V15"/>',
  barsAsc: '<path d="M5 19V15M12 19V11M19 19V7"/>',
  down: '<path d="M18.5 8v9M15.8 14.2l2.7 2.8 2.7-2.8"/>',
  up: '<path d="M18.5 17V8M15.8 11.2l2.7-2.8 2.7 2.8"/>',
};
const icon = (name) => SVG_OPEN + I[name] + '</svg>';
const sortIcon = (name, dir) => SVG_OPEN + I[name] + I[dir] + '</svg>';

const FEED_SORTS = [
  { value: 'new', label: '发布 新→旧', html: sortIcon('cal', 'down') },
  { value: 'old', label: '发布 旧→新', html: sortIcon('cal', 'up') },
  { value: 'added-desc', label: '添加 新→旧', html: sortIcon('add', 'down') },
  { value: 'added-asc', label: '添加 旧→新', html: sortIcon('add', 'up') },
];
const USER_SORTS = [
  { value: 'alpha-asc', label: 'ID A→Z', html: sortIcon('az', 'down') },
  { value: 'alpha-desc', label: 'ID Z→A', html: sortIcon('az', 'up') },
  { value: 'count-desc', label: '贴文 多→少', html: icon('barsDesc') },
  { value: 'count-asc', label: '贴文 少→多', html: icon('barsAsc') },
];

// 排序图标按钮组：点哪个就按哪个排（替代原来的下拉框）
function sortIcons(options, value, onPick) {
  const wrap = el('div', 'sort-icons');
  for (const o of options) {
    const b = el('button', 'sort-btn' + (o.value === value ? ' active' : ''), o.html);
    b.type = 'button';
    b.title = o.label;
    b.setAttribute('aria-label', o.label);
    b.onclick = () => {
      if (b.classList.contains('active')) return;
      for (const s of wrap.children) s.classList.remove('active');
      b.classList.add('active');
      onPick(o.value);
    };
    wrap.appendChild(b);
  }
  return wrap;
}

// ---------- 排序偏好：按登录账号分别记在本地 ----------
let currentUser = '';
let isSuperUser = false;
function sortKey(kind) {
  return `xlikes.sort.${kind}.${currentUser || 'anon'}`;
}
function saveSort(kind, value) {
  try {
    localStorage.setItem(sortKey(kind), value);
  } catch {}
}
function loadSort(kind, fallback) {
  try {
    return localStorage.getItem(sortKey(kind)) || fallback;
  } catch {
    return fallback;
  }
}
async function loadPrefs() {
  try {
    const d = await (await fetch('/api/me')).json();
    currentUser = d.username || '';
    isSuperUser = !!d.superUser;
  } catch {}
  state.feedFilters.sort = loadSort('feed', state.feedFilters.sort);
  state.userSort = loadSort('users', state.userSort);
}

// 排序 + 时间段筛选栏（全部贴文 / 搜索结果共用）
function filterBar(f, onChange) {
  const bar = el('div', 'filter-bar');
  let sort = f.sort;
  let fromVal = f.from || '';
  let toVal = f.to || '';
  const apply = () => {
    f.sort = sort;
    f.from = fromVal;
    f.to = toVal;
    onChange();
  };
  const fromField = dateField('起始日期', fromVal, (v) => {
    fromVal = v;
    apply();
  });
  const toField = dateField('结束日期', toVal, (v) => {
    toVal = v;
    apply();
  });
  bar.append(
    sortIcons(FEED_SORTS, f.sort, (v) => {
      sort = v;
      saveSort('feed', v);
      apply();
    }),
    fromField,
    toField
  );
  return bar;
}

// 日期筛选：平时显示「起始日期 / 结束日期」，点击弹出系统日期选择器
// 做法是把原生 date 控件透明铺满整块，点哪都是点它，全平台都不用自己造日历
function dateField(placeholder, value, onPick) {
  const wrap = el('div', 'date-field');
  const label = el('span', 'date-label', value || placeholder);
  if (!value) label.classList.add('ph');
  const clear = el('button', 'date-clear', '×');
  clear.type = 'button';
  clear.title = '清除日期';
  const native = document.createElement('input');
  native.type = 'date';
  native.className = 'date-native';
  native.value = value || '';
  const setVal = (v) => {
    native.value = v;
    label.textContent = v || placeholder;
    label.classList.toggle('ph', !v);
    clear.style.display = v ? '' : 'none';
  };
  setVal(value || '');
  native.onchange = () => {
    setVal(native.value);
    onPick(native.value);
  };
  clear.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setVal('');
    onPick('');
  };
  // 兜底：点在框内任意位置（包括内边距）都唤起日期选择器
  wrap.onclick = (e) => {
    if (e.target === clear || e.target === native) return;
    if (native.showPicker) {
      try {
        native.showPicker();
        return;
      } catch {}
    }
    native.focus();
    native.click();
  };
  wrap.append(label, clear, native);
  return wrap;
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

// 头像：优先本地缓存图，失败回退彩色占位
function avatar(user, size) {
  const img = document.createElement('img');
  img.className = 'avatar';
  img.loading = 'lazy';
  img.src = `/avatar/${encodeURIComponent(user)}`;
  img.alt = user;
  img.style.cssText = `width:${size || 44}px;height:${size || 44}px;object-fit:cover;`;
  img.onerror = () => {
    const d = el('div', 'avatar', user[0].toUpperCase());
    d.style.cssText = `background: hsl(${hashUser(user)} 70% 45%); width:${size || 44}px;height:${size || 44}px;`;
    img.replaceWith(d);
  };
  return img;
}

// 帖子卡片：媒体区（单图按原始比例完整显示、多图拼图）+ 信息区（@ID / 时间 / 两行文案）
function postCard(post) {
  const a = el('a', 'card');
  a.href = `#/post/${post.tweetId}`;

  const media = el('div', 'card-media');
  const n = Math.min(post.media.length, 4);
  if (n === 1) {
    // 单图：按原始宽高比完整显示，不裁剪
    const m = post.media[0];
    media.classList.add('single');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = m.thumbUrl || m.url;
    media.appendChild(img);
    if (m.ext === 'mp4') media.appendChild(el('span', 'play', '▶'));
  } else {
    // 多图：拼图网格（标准比例）
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
    media.appendChild(grid);
  }
  a.appendChild(media);

  // 信息区：头像 + 第一行（用户名 / @ID）+ 第二行（日期）+ 两行文案
  const info = el('div', 'card-info');
  const head = el('div', 'card-head');
  const pic = avatar(post.user, 32);
  pic.classList.add('card-avatar');
  head.appendChild(pic);
  const meta = el('div', 'card-meta');
  const row1 = el('div', 'card-row');
  row1.appendChild(el('span', 'card-user', post.displayName ? escapeHtml(post.displayName) : `@${post.user}`));
  if (post.displayName) row1.appendChild(el('span', 'card-handle', `@${post.user}`));
  const row2 = el('div', 'card-row');
  row2.appendChild(el('span', 'card-time', fmtTime(post.time)));
  meta.appendChild(row1);
  meta.appendChild(row2);
  head.appendChild(meta);
  info.appendChild(head);
  info.appendChild(el('div', 'card-text', post.text ? escapeHtml(post.text) : ''));
  a.appendChild(info);

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
  // 与「全部贴文」同一套对齐方式：搜索框占满剩余宽度，筛选控件跟在右侧
  const bar = el('div', 'feed-top');
  const search = searchBar('搜索用户 ID…', (q) => {
    state.userQuery = q;
    renderUserList();
  });
  search.value = state.userQuery || '';
  const filter = el('div', 'filter-bar');
  filter.appendChild(
    sortIcons(USER_SORTS, state.userSort, (v) => {
      state.userSort = v;
      saveSort('users', v);
      renderUserList();
    })
  );
  bar.append(search, filter);
  const wrap = el('div', 'users-layout');
  const main = el('div', 'users-main');
  const list = el('div', 'users-list');
  // 搜索栏放进左列：宽度自动与卡片区对齐，右侧留出面包屑的位置
  main.append(bar, list);
  const crumb = el('div', 'breadcrumb');
  wrap.append(main, crumb);
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
        // 与卡片一致：第一行 用户名 + @ID（靠右），第二行 日期范围
        const meta = el('div', 'user-meta');
        const row1 = el('div', 'meta-row');
        row1.appendChild(el('div', 'name', u.displayName ? escapeHtml(u.displayName) : `@${escapeHtml(u.user)}`));
        if (u.displayName) row1.appendChild(el('span', 'handle', `@${escapeHtml(u.user)}`));
        const row2 = el('div', 'meta-row');
        row2.appendChild(el('span', 'sub', `${u.first} ~ ${u.last}`));
        meta.append(row1, row2);
        card.append(avatar(u.user), meta, el('div', 'count', `${u.count}`));
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
  // 头像右侧：用户名一行、@ID 一行，左对齐
  const meta = el('div', 'user-meta');
  const nameRow = el('div', 'meta-row');
  const nameEl = el('div', 'uname', `@${escapeHtml(user)}`);
  nameRow.appendChild(nameEl);
  const handleRow = el('div', 'meta-row');
  const handleEl = el('span', 'handle', `@${escapeHtml(user)}`);
  handleRow.appendChild(handleEl);
  handleRow.style.display = 'none'; // 没有昵称时，第一行本身就是 @ID
  meta.append(nameRow, handleRow);
  info.appendChild(meta);
  // 最右侧：跳到 X.com 该用户主页
  const xbtn = el('a', 'xlink', 'X 主页 ↗');
  xbtn.href = `https://x.com/${encodeURIComponent(user)}`;
  xbtn.target = '_blank';
  xbtn.rel = 'noopener';
  info.appendChild(xbtn);
  head.appendChild(info);
  $main.appendChild(head);
  $main.appendChild(createColumns());
  (async () => {
    try {
      const d = await (await fetch(`/api/user-meta/${encodeURIComponent(user)}`)).json();
      if (d.displayName) {
        nameEl.textContent = d.displayName;
        handleRow.style.display = '';
      }
    } catch {}
  })();
  loadMore();
}

async function renderPost(tweetId) {
  state.mode = 'post';
  $main.innerHTML = '';
  const page = el('div', 'post-page');
  $main.appendChild(page);
  const bar = el('div', 'post-bar');
  const back = el('button', 'back', '← 返回');
  back.onclick = () => history.back();
  bar.appendChild(back);
  const search = searchBar('搜索 ID 或帖子文案…', (q) => {
    if (q) renderSearchResults(q);
  });
  bar.appendChild(search);
  page.appendChild(bar);
  try {
    const data = await (await fetch(`/api/post/${tweetId}`)).json();
    const card = el('article', 'post-card');
    const head = el('div', 'post-head');
    // 头像 + 用户名 + @ID 整块可点，跳到站内该用户的 ID 页面
    const userLink = el('a', 'post-user');
    userLink.href = `#/user/${encodeURIComponent(data.user)}`;
    userLink.appendChild(avatar(data.user, 48));
    // 与卡片一致：第一行 用户名 + @ID（紧跟用户名），第二行 日期
    const pmeta = el('div', 'post-meta');
    const prow1 = el('div', 'meta-row');
    prow1.appendChild(el('div', 'uname', data.displayName ? escapeHtml(data.displayName) : `@${escapeHtml(data.user)}`));
    if (data.displayName) prow1.appendChild(el('span', 'handle', `@${escapeHtml(data.user)}`));
    const prow2 = el('div', 'meta-row');
    prow2.appendChild(el('span', 'udate', fmtTime(data.time)));
    pmeta.append(prow1, prow2);
    userLink.appendChild(pmeta);
    head.appendChild(userLink);
    const xlink = el('a', 'xlink', '查看原文 ↗');
    xlink.href = data.postUrl;
    xlink.target = '_blank';
    xlink.rel = 'noopener';
    head.appendChild(xlink);
    card.appendChild(head);

    const text = el('p', data.text ? 'post-text' : 'post-text loading');
    text.innerHTML = data.text ? postTextHtml(data.text) : '文案加载中…';
    // 用户表是异步拉的，加载完之后把文案里的 @ID 补成站内链接
    if (data.text && /@[A-Za-z0-9_]/.test(data.text)) {
      ensureUserMap().then(() => {
        if (document.body.contains(text)) text.innerHTML = postTextHtml(data.text);
      });
    }
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
        text.innerHTML = postTextHtml(t);
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
        // 提示文字随 NSFW 状态切换（CSS 控制），NSFW 模式下不响应点击
        const tip = el('span', 'play-lg');
        tip.appendChild(el('span', 'play-on', '▶ 点击播放原视频'));
        tip.appendChild(el('span', 'play-off', 'NSFW 模式无法播放'));
        box.appendChild(tip);
        box.onclick = () => {
          if (document.body.classList.contains('nsfw')) return; // 解除 NSFW 才能播放
          const v = document.createElement('video');
          v.controls = true;
          v.playsInline = true;
          v.autoplay = true;
          v.innerHTML = `<source src="${m.url}" type="video/mp4">`;
          // 播放期间返回手势 / 返回键 → 停止播放并回到缩略图，而不是离开详情页
          const orig = Array.from(box.childNodes);
          let restored = false;
          pushDismissable(() => {
            if (restored) return;
            restored = true;
            try {
              v.pause();
            } catch {}
            box.replaceChildren(...orig); // 原节点还活着（只是暂时移出 DOM），事件监听也保留
          });
          box.replaceChildren(v);
          bindMediaMenu(v, () => videoMenu(v, m.url)); // 长按 / 右键：保存、复制当前帧、画中画
        };
      } else {
        box.onclick = () => openLightbox(m.url); // 点击看原图
      }
      media.appendChild(box);
    }
    card.appendChild(media);
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
        const link = el(
          'a',
          '',
          it.displayName
            ? `${escapeHtml(it.displayName)} <span class="handle">@${escapeHtml(it.user)}</span>`
            : `@${escapeHtml(it.user)}`
        );
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
        textEl.innerHTML = postTextHtml(r.text);
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

// 打开一个「用返回手势 / 返回键就能关掉」的浮层或状态：
// 压入一条历史，返回时执行 doClose；主动关闭则回退掉这条历史，保持历史栈干净
function pushDismissable(doClose) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', onPop);
    doClose();
  };
  const onPop = () => finish();
  history.pushState({ xlikesDismiss: Date.now() }, '');
  window.addEventListener('popstate', onPop);
  return {
    close() {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', onPop);
      doClose();
      history.back(); // 回退掉刚才压入的那条
    },
  };
}

function openLightbox(url) {
  const ov = el('div', 'lightbox');
  const img = document.createElement('img');
  img.src = url;
  ov.appendChild(img);
  let closed = false;
  const dismiss = pushDismissable(() => {
    if (closed) return;
    closed = true;
    ov.remove();
  });
  ov.onclick = () => dismiss.close();
  bindMediaMenu(img, () => imageMenu(url)); // 长按 / 右键：保存、复制
  document.body.appendChild(ov);
}

// ---------- 长按 / 右键菜单：统一各浏览器的媒体操作 ----------
let menuJustShown = 0;

function toast(text) {
  const t = el('div', 'toast show', text);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function closeCtxMenu() {
  for (const n of document.querySelectorAll('.ctx-menu')) n.remove();
}

function showCtxMenu(x, y, items) {
  closeCtxMenu();
  const menu = el('div', 'ctx-menu');
  for (const it of items) {
    const b = el('button', '', it.label);
    b.type = 'button';
    b.onclick = () => {
      closeCtxMenu();
      Promise.resolve(it.run()).catch((e) => toast(String((e && e.message) || e || '操作失败')));
    };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  menuJustShown = Date.now();
}

// 触屏长按（500ms，移动超过 10px 取消）+ 桌面右键，绑到同一套菜单
function bindMediaMenu(node, buildItems) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return cancel();
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        const items = buildItems();
        if (items.length) showCtxMenu(sx, sy, items);
      }, 500);
    },
    { passive: true }
  );
  node.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!timer || Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) cancel();
    },
    { passive: true }
  );
  node.addEventListener('touchend', cancel);
  node.addEventListener('touchcancel', cancel);
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = buildItems();
    if (items.length) showCtxMenu(e.clientX, e.clientY, items);
  });
}

// 长按弹出菜单后，吃掉紧随其后的那次 click，避免顺手把大图关掉（菜单自身的点击不受影响）
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() - menuJustShown < 400 && !e.target.closest('.ctx-menu')) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true
);
document.addEventListener('click', closeCtxMenu);
window.addEventListener('scroll', closeCtxMenu, { passive: true });

function mediaFileName(url, fallback) {
  try {
    return decodeURIComponent(String(url).split('/').pop().split('?')[0]) || fallback;
  } catch {
    return fallback;
  }
}

// 保存：能调起分享就分享（iOS 上才能存进相册），否则直接下载
async function saveMedia(url, fallbackName) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('获取文件失败');
  const blob = await res.blob();
  const name = mediaFileName(url, fallbackName);
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: name });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('已开始下载');
}

const canCopyImage = () => !!(navigator.clipboard && window.ClipboardItem);

// 复制图片（统一转成 PNG，兼容性最好）
async function copyImage(url) {
  const blob = await (await fetch(url)).blob();
  let out = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    out = await new Promise((r) => c.toBlob(r, 'image/png'));
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': out })]);
  toast('已复制图片');
}

// 复制视频当前帧
async function copyVideoFrame(v) {
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  toast('已复制当前帧');
}

const canPiP = (v) => !!(document.pictureInPictureEnabled && v.requestPictureInPicture);

async function togglePiP(v) {
  if (document.pictureInPictureElement) await document.exitPictureInPicture();
  else await v.requestPictureInPicture();
}

// 大图模式的菜单
function imageMenu(url) {
  const items = [{ label: '保存到设备', run: () => saveMedia(url, 'image.jpg') }];
  if (canCopyImage()) items.push({ label: '复制图片', run: () => copyImage(url) });
  return items;
}

// 视频播放中的菜单
function videoMenu(v, url) {
  const items = [{ label: '保存到设备', run: () => saveMedia(url, 'video.mp4') }];
  if (canCopyImage()) items.push({ label: '复制当前帧', run: () => copyVideoFrame(v) });
  if (canPiP(v)) items.push({ label: '画中画', run: () => togglePiP(v) });
  return items;
}

// ---------- 抓取页（普通用户视角）：只看自己提交的抓取记录，失败的可重试 ----------
async function renderMyDownloads(container) {
  container.appendChild(el('div', 'page-title', '抓取管理'));
  const list = el('div', 'text-list');
  container.appendChild(list);
  const empty = el('div', 'empty', '');
  container.appendChild(empty);
  const DL_STATUS = { pending: '排队中', running: '抓取中', done: '已完成', failed: '失败', exists: '已存在' };
  const DL_BADGE = {
    pending: 'st-pending',
    running: 'st-pending',
    done: 'st-ok',
    failed: 'st-failed',
    exists: 'st-ok',
  };

  async function load() {
    let items = [];
    try {
      items = (await (await fetch('/api/downloads')).json()).items || [];
    } catch {}
    list.innerHTML = '';
    if (!items.length) {
      empty.textContent = '还没有提交过抓取，把 X 链接粘到顶部输入栏就能抓取。';
      return;
    }
    empty.textContent = '';
    for (const j of items) {
      const tid = (j.url.match(/\/(\d{10,})/) || [])[1] || '';
      const a = el('a', '', j.url.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, ''));
      a.href = tid ? `#/post/${tid}` : j.url;
      a.title = j.url;
      const row = el('div', 'text-row');
      row.append(
        a,
        el('span', `badge ${DL_BADGE[j.status] || ''}`, DL_STATUS[j.status] || j.status),
        el('span', 'time', fmtTime(j.addedAt))
      );
      if (j.status === 'failed' || j.status === 'exists') {
        const btn = el('button', 'btn', j.status === 'exists' ? '仍然抓取' : '重试');
        btn.onclick = async () => {
          btn.disabled = true;
          await fetch('/api/download/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: j.id }),
          }).catch(() => {});
          load();
        };
        row.appendChild(btn);
      }
      // 抓完/已在库的，给一个直达站内记录（帖子详情页）的按钮
      if (tid && (j.status === 'done' || j.status === 'exists')) {
        const view = el('button', 'btn', '查看');
        view.title = '打开站内记录（帖子详情页）';
        view.onclick = () => {
          location.hash = `#/post/${tid}`;
        };
        row.appendChild(view);
      }
      list.appendChild(row);
    }
  }
  await load();
  clearInterval(jobTimer);
  jobTimer = setInterval(load, 5000);
}

// ---------- 文案管理页（超级用户） ----------
const STATUS_LABEL = { ok: '已抓取', pending: '待抓取', failed: '抓取失败', not_found: '原帖不存在' };
const textState = { status: '', by: '', offset: 0, total: 0 };

async function renderTexts(container) {
  state.mode = 'texts';
  clearInterval(textTimer);
  container.innerHTML = '';
  // 普通用户只看自己提交的抓取记录；全站文案管理是超级用户功能
  if (!isSuperUser) return renderMyDownloads(container);
  // 标题行：状态提示跟在标题后面，不单独占一行
  const titleRow = el('div', 'texts-title-row');
  titleRow.appendChild(el('div', 'page-title', '抓取管理'));
  const msg = el('div', 'msg', '');
  titleRow.appendChild(msg);
  // 标题最右侧：gallery-dl 版本号 + 检查更新（本页是超级用户视图）
  const gdlVer = el('span', 'gdl-ver', 'gallery-dl: …');
  const gdlBtn = el('button', 'btn primary', '检查更新');
  gdlBtn.type = 'button';
  const gdlBox = el('div', 'gdl-box');
  gdlBox.append(gdlVer, gdlBtn);
  titleRow.appendChild(gdlBox);
  container.appendChild(titleRow);

  let gdlMode = 'check';
  function gdlPaint(busy, verText, btnText, btnCls) {
    gdlVer.textContent = verText;
    gdlBtn.textContent = btnText;
    gdlBtn.className = `btn${btnCls ? ' ' + btnCls : ''}`;
    gdlBtn.disabled = !!busy;
  }
  async function gdlCheck(force) {
    gdlMode = 'check';
    gdlPaint(true, 'gallery-dl: 检查中…', '检查中…', '');
    try {
      const d = await (await fetch(`/api/gallery-dl/version${force ? '?force=1' : ''}`)).json();
      if (d.hasUpdate) {
        gdlMode = 'update';
        gdlPaint(false, `gallery-dl: ${d.current} → ${d.latest}`, '立即更新', 'success');
      } else if (d.latest || d.current) {
        gdlPaint(false, `gallery-dl: v${d.latest || d.current}`, '最新版本', 'muted');
      } else {
        throw new Error('no version');
      }
    } catch {
      gdlPaint(false, 'gallery-dl: 检查失败', '重试', '');
    }
  }
  gdlBtn.onclick = async () => {
    if (gdlMode !== 'update') return gdlCheck(true);
    gdlMode = 'check';
    gdlPaint(true, 'gallery-dl: 正在更新…', '更新中…', '');
    try {
      const r = await fetch('/api/gallery-dl/update', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        gdlPaint(false, `gallery-dl: v${d.to}`, '最新版本', 'muted');
        msg.textContent = `gallery-dl 已更新：v${d.from} → v${d.to}`;
      } else {
        gdlPaint(false, 'gallery-dl: 更新失败', '重试', '');
        msg.textContent = d.error || '更新失败';
      }
    } catch {
      gdlPaint(false, 'gallery-dl: 更新失败', '重试', '');
      msg.textContent = '更新失败，请稍后重试';
    }
  };
  gdlCheck(false);
  const progressWrap = el('div', 'progress-wrap');
  const bar = el('div', 'progress-bar');
  const fill = el('div', 'progress-fill');
  bar.appendChild(fill);
  const progLabel = el('span', 'progress-label', '…');
  progressWrap.append(bar, progLabel);
  // 操作按钮放右上角，与进度条同一行
  const actions = el('div', 'texts-actions');
  const refreshBtn = el('button', 'btn', '刷新');
  const retryAllBtn = el('button', 'btn', '重试全部失败');
  const stopBtn = el('button', 'btn', '停止');
  stopBtn.style.display = 'none';
  actions.append(refreshBtn, retryAllBtn, stopBtn);
  if (!isSuperUser) actions.style.display = 'none'; // gallery-dl 补抓只有超级用户能触发
  const headRow = el('div', 'texts-head');
  headRow.append(progressWrap, actions);
  container.appendChild(headRow);

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
  // 超级用户：按「提交抓取的用户」筛选列表
  const submitterSel = el('select', 'submitter-filter');
  submitterSel.title = '筛选提交的用户';
  submitterSel.style.display = isSuperUser ? '' : 'none';
  submitterSel.onchange = () => {
    textState.by = submitterSel.value;
    textState.offset = 0;
    list.innerHTML = '';
    loadTexts();
  };
  statsRow.appendChild(submitterSel);
  container.appendChild(statsRow);

  // 用 gallery-dl 补抓文案（只取元数据）；服务端自带限速、长停顿、连续无收获自动停止
  async function runRefetch(mode) {
    const r = await fetch('/api/texts/refetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return (msg.textContent = d.error || '启动失败');
    msg.textContent = d.queued
      ? `已用 gallery-dl 补抓 ${d.queued} 条${d.skipped ? `（超出单次上限 ${d.batchMax}，剩余 ${d.skipped} 条可再点一次）` : ''}`
      : '没有需要补抓的帖子';
    pollMeta();
  }
  // 刷新：重新拉列表 + 用 gallery-dl 补抓还没有标记的帖子
  refreshBtn.onclick = () => {
    list.innerHTML = '';
    textState.offset = 0;
    loadTexts();
    runRefetch('unmarked');
  };
  retryAllBtn.onclick = () => runRefetch('failed');
  stopBtn.onclick = async () => {
    await fetch('/api/texts/refetch/stop', { method: 'POST' });
    msg.textContent = '已请求停止补抓';
  };

  let metaWasRunning = false;
  async function pollMeta() {
    clearTimeout(metaTimer);
    try {
      const d = await (await fetch('/api/texts/refetch/status')).json();
      if (d.total) {
        msg.textContent =
          `gallery-dl 补抓：${d.done}/${d.total} · 成功 ${d.ok} · 无收获 ${d.miss + d.error}` +
          `${d.current ? ` · 当前 ${d.current}` : ''}${d.stopped ? ` · ${d.stopped}` : ''}`;
      }
      stopBtn.style.display = d.running ? '' : 'none';
      if (metaWasRunning && !d.running) {
        // 补抓结束后刷新列表和统计
        list.innerHTML = '';
        textState.offset = 0;
        loadTexts();
      }
      metaWasRunning = !!d.running;
      if (d.running) metaTimer = setTimeout(pollMeta, 3000);
    } catch {}
  }

  const list = el('div', 'text-list');
  container.appendChild(list);
  const moreBtn = el('button', 'btn', '加载更多');
  moreBtn.style.display = 'none';
  moreBtn.onclick = loadTexts;
  container.appendChild(moreBtn);

  if (isSuperUser) pollMeta(); // 进页面先同步一次补抓进度（超级用户专属）

  let loadFail = 0;
  async function loadTexts() {
    const q =
      (textState.status ? `&status=${textState.status}` : '') +
      (textState.by ? `&by=${encodeURIComponent(textState.by)}` : '');
    try {
      const data = await (await fetch(`/api/texts?offset=${textState.offset}&limit=100${q}`)).json();
      chips.forEach((c, i) => {
        const cfg = chipsCfg[i];
        c.innerHTML = `${cfg.label} <b>${data.stats[cfg.key]}</b>`;
      });
      if (isSuperUser) {
        const opts = data.submitters || [];
        const cur = textState.by || '';
        submitterSel.innerHTML =
          '<option value="">筛选提交的用户</option>' +
          opts
            .map((o) => `<option value="${escapeHtml(o.user)}">${escapeHtml(o.user)}（${o.count}）</option>`)
            .join('');
        submitterSel.value = opts.some((o) => o.user === cur) ? cur : '';
      }
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
        row.append(link, el('span', 'tid', it.tweetId), badge);
        if (isSuperUser) {
          // 超级用户：显示这条抓取是谁提交的（顶部抓取栏提交的链接才有）
          const who = el('span', 'tid', it.submittedBy ? `@${it.submittedBy}` : '—');
          who.title = '提交抓取的用户';
          row.append(who);
        }
        row.append(time, manual, retry);
        list.appendChild(row);
      }
      textState.offset += data.items.length;
      textState.total = data.total;
      moreBtn.style.display = textState.offset < textState.total ? '' : 'none';
      if (!data.items.length) list.appendChild(el('div', 'empty', '暂无记录'));
    } catch {
      // 容器重启期间打开页面会撞上一次失败，自动重试两次再提示刷新
      if (loadFail++ < 2) {
        msg.textContent = '加载失败，3 秒后重试…';
        setTimeout(loadTexts, 3000);
      } else {
        msg.textContent = '加载失败，请刷新页面重试';
      }
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
  card.appendChild(el('div', 'account-section-title', '当前用户名'));
  const uname = el('div', 'account-username', '…');
  card.appendChild(uname);
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

// ---------- 登录设备页 ----------
async function renderDevices(container) {
  state.mode = 'devices';
  container.appendChild(el('div', 'page-title', '登录设备'));
  const list = el('div', 'text-list');
  container.appendChild(list);

  const me = await (await fetch('/api/sessions')).json().catch(() => ({ items: [], superUser: false }));
  let allMode = false;

  const toggle = el('button', 'btn dev-toggle', '查看所有账号设备');
  toggle.style.display = me.superUser ? '' : 'none';
  toggle.onclick = async () => {
    if (!allMode) {
      const all = await (await fetch('/api/sessions/all')).json().catch(() => ({ items: [] }));
      allMode = true;
      toggle.textContent = '只看我的设备';
      renderRows(all.items, true);
    } else {
      allMode = false;
      toggle.textContent = '查看所有账号设备';
      renderRows(me.items, false);
    }
  };
  container.insertBefore(toggle, list);

  function row(s, showUser) {
    const r = el('div', 'text-row');
    r.append(
      el('span', '', showUser ? `@${s.username}` : s.device),
      el('span', 'tid', s.ip || '未知 IP'),
      el('span', 'time', fmtTime(s.lastSeen))
    );
    if (s.current) {
      r.appendChild(el('span', 'badge st-ok', '当前设备'));
    } else {
      const kick = el('button', 'btn', '踢下线');
      kick.onclick = async () => {
        const body = showUser ? { username: s.username, sessionId: s.id } : { sessionId: s.id };
        const res = await fetch('/api/sessions/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (!d.ok) return showToast(d.error || '踢下线失败');
        const next = allMode
          ? (await (await fetch('/api/sessions/all')).json().catch(() => ({ items: [] }))).items
          : (await (await fetch('/api/sessions')).json().catch(() => ({ items: [] }))).items;
        renderRows(next, allMode);
      };
      r.appendChild(kick);
    }
    return r;
  }

  function renderRows(items, showUser) {
    list.innerHTML = '';
    if (!items.length) {
      list.appendChild(el('div', 'empty', allMode ? '没有其它登录设备' : '没有已登录设备'));
      return;
    }
    for (const s of items) list.appendChild(row(s, showUser));
  }

  renderRows(me.items, false);
}

// ---------- 扫描页 ----------
async function renderScan(container) {
  container.appendChild(el('div', 'page-title', '扫描'));
  const card = el('div', 'post-card');
  const btn = el('button', 'btn primary', '立即扫描');
  btn.style.marginTop = '12px';
  if (!isSuperUser) btn.style.display = 'none'; // 手动扫描是超级用户操作
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
  // 扫描页只对超级用户开放；普通用户进控制台默认落到「抓取」页
  let sub = location.hash.split('/')[2] || (isSuperUser ? 'scan' : 'texts');
  if (sub === 'scan' && !isSuperUser) sub = 'texts';
  $main.innerHTML = '';
  const layout = el('div', 'console-layout');
  const side = el('aside', 'console-side');
  const navs = [
    ['scan', '扫描'],
    ['texts', '抓取'],
    ['logs', '日志'],
    ['account', '账户管理'],
    ['devices', '登录设备'],
  ].filter(([key]) => key !== 'scan' || isSuperUser);
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
  else if (sub === 'devices') renderDevices(content);
  else renderScan(content);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 文案里的 @ID → 站内用户页链接（只有站内已存在的 ID 才加链接）----------
const MENTION_RE = /(^|[^\w])@([A-Za-z0-9_]{2,30})/g;
let userMap = null; // lower(用户ID) -> 原始用户ID
let userMapLoading = null;
function ensureUserMap() {
  if (userMap) return Promise.resolve(userMap);
  if (!userMapLoading) {
    userMapLoading = fetch('/api/users?limit=2000&offset=0')
      .then((r) => r.json())
      .then((d) => {
        const m = new Map();
        for (const u of d.items || []) m.set(String(u.user).toLowerCase(), u.user);
        userMap = m;
        return m;
      })
      .catch(() => {
        userMap = new Map();
        return userMap;
      });
  }
  return userMapLoading;
}
function postTextHtml(raw) {
  const escaped = escapeHtml(String(raw || ''));
  if (!userMap || !userMap.size) return escaped;
  return escaped.replace(MENTION_RE, (all, pre, handle) => {
    const orig = userMap.get(handle.toLowerCase());
    return orig ? `${pre}<a class="mention" href="#/user/${encodeURIComponent(orig)}">@${handle}</a>` : all;
  });
}

// ---------- 路由 ----------
function render() {
  clearInterval(textTimer);
  clearTimeout(metaTimer);
  clearInterval(jobTimer);
  const h = location.hash;
  if (h.startsWith('#/post/')) renderPost(h.slice(7));
  else if (h.startsWith('#/user/')) renderUser(decodeURIComponent(h.slice(7)));
  else if (h.startsWith('#/console')) renderConsole();
  else if (h.startsWith('#/texts')) location.hash = '#/console/texts';
  else if (h.startsWith('#/logs')) location.hash = '#/console/logs';
  else if (h.startsWith('#/password')) location.hash = '#/console/account';
  else if (h.startsWith('#/devices')) location.hash = '#/console/devices';
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

// ---------- NSFW 模式：一键模糊所有媒体，只保留文案 ----------
const NSFW_KEY = 'xlikes.nsfw';
function applyNsfw(on) {
  document.body.classList.toggle('nsfw', on);
  const cb = document.getElementById('nsfwToggle');
  if (cb) cb.checked = on;
}
(() => {
  const cb = document.getElementById('nsfwToggle');
  let on = true; // 默认开启；用户手动关过就以本地记录为准
  try {
    const saved = localStorage.getItem(NSFW_KEY);
    if (saved !== null) on = saved === '1';
  } catch {}
  applyNsfw(on);
  if (cb) {
    cb.onchange = () => {
      const next = cb.checked;
      try {
        localStorage.setItem(NSFW_KEY, next ? '1' : '0');
      } catch {}
      applyNsfw(next);
    };
  }
})();

// ---------- 粘贴 X 链接抓取（gallery-dl） ----------
const dlUrl = document.getElementById('dl-url');
const dlBtn = document.getElementById('dl-btn');
const dlMsg = document.getElementById('dl-msg');
const dlQueueBtn = document.getElementById('dl-queue-btn');
const dlModal = document.getElementById('dl-modal');
const dlList = document.getElementById('dl-list');
const dlModalClose = document.getElementById('dl-modal-close');
let dlQueueTimer = null;

async function submitDownload() {
  const url = (dlUrl.value || '').trim();
  if (!url) return;
  dlBtn.disabled = true;
  dlMsg.textContent = '提交中…';
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      dlMsg.textContent = d.error || '提交失败';
      return;
    }
    dlUrl.value = '';
    const queued = (d.count || 0) - (d.exists || 0);
    dlMsg.textContent = d.exists
      ? queued
        ? `已加入 ${queued} 个任务，另有 ${d.exists} 个已在库中（未重复下载）`
        : `${d.exists} 个帖子已在库中，未重复下载（可在「队列」里选择仍然抓取）`
      : `已加入 ${d.count} 个任务`;
    pollDownload(d.ids || []);
  } catch {
    dlMsg.textContent = '请求失败';
  } finally {
    dlBtn.disabled = false;
  }
}

// 轮询本次提交的任务，跑完后刷新页面列表
async function pollDownload(ids) {
  if (!ids.length) return;
  try {
    const r = await (await fetch('/api/downloads')).json();
    const mine = (r.items || []).filter((x) => ids.includes(x.id));
    const active = mine.filter((x) => x.status === 'running' || x.status === 'pending');
    const failed = mine.filter((x) => x.status === 'failed');
    const done = mine.filter((x) => x.status === 'done');
    const exists = mine.filter((x) => x.status === 'exists');
    if (active.length) {
      dlMsg.textContent = `队列中 ${active.length} 个（完成 ${done.length}，失败 ${failed.length}）`;
      setTimeout(() => pollDownload(ids), 2000);
      return;
    }
    dlMsg.textContent =
      `✅ 完成 ${done.length} 个` +
      (exists.length ? `，已在库中 ${exists.length} 个（未重复下载）` : '') +
      (failed.length ? `，失败 ${failed.length} 个（可在「队列」里重试）` : '');
    render();
    if (dlModal && !dlModal.classList.contains('hidden')) refreshQueue();
  } catch {
    dlMsg.textContent = '';
  }
}

/* ---------- 队列弹窗 ---------- */
const DL_LABEL = {
  running: '⏳ 进行中',
  pending: '🕒 排队中',
  failed: '❌ 失败',
  exists: '📚 已存在',
  done: '✅ 已完成',
};
const DL_GROUPS = [
  ['running', '正在进行'],
  ['pending', '未完成（排队中）'],
  ['failed', '失败'],
  ['exists', '已在库中（未重复下载）'],
  ['done', '已完成'],
];

async function refreshQueue() {
  if (!dlList) return;
  const r = await (await fetch('/api/downloads')).json().catch(() => ({ items: [] }));
  const items = r.items || [];
  dlList.innerHTML = '';
  let shown = 0;
  for (const [status, title] of DL_GROUPS) {
    // 同组内按加入时间新→旧，方便看最近的任务
    const list = items
      .filter((x) => x.status === status)
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    if (!list.length) continue;
    dlList.appendChild(el('div', 'dl-group', `${title}（${list.length}）`));
    for (const job of list) {
      const row = el('div', 'dl-item');
      row.appendChild(el('span', `dl-status ${status}`, DL_LABEL[status] || status));
      // 链接指向站内已保存的记录（帖子详情页），点击顺带关掉弹窗
      const tid = job.tweetId || (job.url.match(/\/(\d{10,})/) || [])[1] || '';
      const urlEl = el('a', 'dl-url', job.url);
      if (tid) {
        urlEl.href = `#/post/${tid}`;
        urlEl.title = job.existing ? `已在库中 ${job.existing} 张，点击查看站内记录` : '点击查看站内记录';
        urlEl.onclick = () => closeQueue();
      } else {
        urlEl.href = job.url;
      }
      row.appendChild(urlEl);
      if (job.error) row.appendChild(el('span', 'dl-error', job.error));
      // 抓取完成的（或已在库的）给一个直达站内记录的按钮
      if (tid && (status === 'done' || status === 'exists')) {
        const view = el('button', 'btn dl-view', '查看');
        view.title = '打开站内记录（帖子详情页）';
        view.onclick = () => {
          closeQueue();
          location.hash = `#/post/${tid}`;
        };
        row.appendChild(view);
      }
      if (status === 'failed' || status === 'exists') {
        // 已存在的任务也留一个出口：确认要重抓就进队列（老帖补全的情况下用得上）
        const btn = el('button', 'btn dl-retry', status === 'exists' ? '仍然抓取' : '重试');
        btn.onclick = async () => {
          btn.disabled = true;
          await fetch('/api/download/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: job.id }),
          }).catch(() => {});
          refreshQueue();
        };
        row.appendChild(btn);
      }
      dlList.appendChild(row);
      shown++;
    }
  }
  if (!shown) dlList.appendChild(el('div', 'empty', '队列是空的'));
}

function openQueue() {
  if (!dlModal) return;
  dlModal.classList.remove('hidden');
  refreshQueue();
  clearInterval(dlQueueTimer);
  dlQueueTimer = setInterval(refreshQueue, 3000);
}

function closeQueue() {
  if (!dlModal) return;
  dlModal.classList.add('hidden');
  clearInterval(dlQueueTimer);
}

if (dlBtn) dlBtn.onclick = submitDownload;
if (dlQueueBtn) dlQueueBtn.onclick = openQueue;
if (dlModalClose) dlModalClose.onclick = closeQueue;
if (dlModal) {
  dlModal.addEventListener('click', (e) => {
    if (e.target === dlModal) closeQueue();
  });
}
if (dlUrl) {
  dlUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitDownload();
  });
}

// 全站卡片 / 按钮的 R 角 = 输入框的圆角（输入框高度的一半），随实际高度动态变化
function syncRadius() {
  const field = dlUrl || document.querySelector('.searchbar');
  if (!field) return;
  const h = field.getBoundingClientRect().height;
  if (h > 0) document.documentElement.style.setProperty('--radius', `${h / 2}px`);
}
syncRadius();
if (window.ResizeObserver && dlUrl) new ResizeObserver(syncRadius).observe(dlUrl);
window.addEventListener('resize', syncRadius);

// 先读当前账号的排序偏好，再渲染首屏
(async () => {
  await loadPrefs();
  render();
})();
