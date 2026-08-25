// 通过 CDP 打开页面，模拟滚动到底部，验证瀑布流是否持续加载（含 JS 报错捕获）
const CDP = 'http://localhost:9222';
const PAGE = process.env.PAGE || 'http://localhost:3000';
const ROUNDS = Number(process.env.ROUNDS || 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tabs = await (await fetch(`${CDP}/json`)).json();
  let tab = tabs.find((t) => t.type === 'page');
  if (!tab) {
    const created = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
    tab = await created.json();
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('JS ERROR:', JSON.stringify(m.params.exceptionDetails).slice(0, 600));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      console.log('console.error:', JSON.stringify(m.params.args).slice(0, 400));
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id).res(m.result);
      pending.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { res: resolve, rej: reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r && r.result ? r.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(6000);

  const snap = () =>
    ev(
      `({cards: document.querySelectorAll('.card').length,
         cols: document.querySelectorAll('.col').length,
         scrollH: document.body.scrollHeight,
         innerH: window.innerHeight,
         scrollY: window.scrollY,
         loading: !document.getElementById('loading').classList.contains('hidden')})`
    );

  console.log('initial:', JSON.stringify(await snap()));
  for (let i = 1; i <= ROUNDS; i++) {
    await ev('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(3000);
    console.log(`after scroll ${i}:`, JSON.stringify(await snap()));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
