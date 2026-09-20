/**
 * v0.4.3 设置卡片数据面测试（数据模型 v3）：
 *   U1 GET 快照：四大类、按源分组、入口字段（key/url/type/removable）
 *   U2 POST routeOverrides {proxy,url} 即时生效
 *   U3 自定义源：创建（名称+官方网址+proxies）→ 引擎安装 → 并入快照
 *   U4 恢复默认清空一切
 *   U5 幂等
 *   U6 v3 数据模型：删除代理后启停状态不错位 + v2 旧配置向后兼容
 *      （完整 v3 矩阵见 test-v3-model.mjs；此处内联核心回归，保证主套件覆盖）
 * 不打真实网络。用法：node test-v0.4-ui.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

// 测试必须自持 DSH_HOME：apply() 会在 DSH_HOME 下读写 ui-config.json，
// 而宿主进程的 DSH_HOME 可能指向真实实例目录（只读/会污染用户配置）。
// 固定到临时目录 → 套件与运行环境解耦，且不触碰真实配置。
process.env.DSH_HOME = `${process.env.TEMP || process.env.TMPDIR || '.'}/wsd-ui-home-${process.pid}`;

const plugin = await import('./dist/index.js');

function makeCtx(config = {}) {
  const routes = new Map();
  const warns = [];
  const settingsRegistered = [];
  const tools = [];
  let searchProvider = null;
  const ctx = {
    logger: () => ({ warn: (m) => warns.push(String(m)), info: () => {}, debug: () => {} }),
    web: {
      registerSearchProvider: (p) => { searchProvider = p; },
      registerFetchProvider: () => {},
    },
    inject(names, cb) {
      const svc = { effect: (fn) => { try { fn(); } catch { /* 降级 */ } return () => {}; } };
      for (const n of names) {
        if (n === 'webServer') svc[n] = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
        else if (n === 'tools') svc[n] = { register: (def) => { tools.push(def); return () => {}; } };
        else if (n === 'settings') svc[n] = { register: (ns) => { settingsRegistered.push(ns); return { get: () => ({ ...config }), watch: () => {} }; } };
      }
      cb(svc);
    },
    effect: (fn) => { try { fn(); } catch {} return () => {}; },
  };
  return { ctx, routes, warns, settingsRegistered, tools, get provider() { return searchProvider; } };
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/**
 * 每个用例独占一个 DSH_HOME。
 * 必须如此：apply() 会从 DSH_HOME 读 ui-config.json，而自定义源的引擎 id
 * （custom-<cat>-N）与路由 label（代理 N）都是**按位置生成**的，跨用例天然会撞。
 * 不隔离就会出现「上一个用例残留的 v2 routeOverrides 被当成当前用例的旧配置」，
 * 那是最难查的一类假红/假绿。
 */
let caseSeq = 0;
function isolateHome(tag, preload) {
  const home = `${process.env.TEMP || '.'}/wsd-ui-${tag}-${process.pid}-${caseSeq++}`;
  process.env.DSH_HOME = home;
  if (preload) {
    mkdirSync(`${home}/storages/websearch-direct`, { recursive: true });
    writeFileSync(`${home}/storages/websearch-direct/ui-config.json`, JSON.stringify(preload, null, 2));
  }
  return home;
}

const cap = makeCtx({});
isolateHome('main');
plugin.apply(cap.ctx, {});

const getConfig = cap.routes.get('/dsh-websearch-direct/api/config');
const postConfig = cap.routes.get('/dsh-websearch-direct/api/config');
const postReset = cap.routes.get('/dsh-websearch-direct/api/reset');
if (!getConfig || !postConfig || !postReset) {
  console.error('路由未注册 —— apply() 里 webServer 注入失败');
  process.exit(1);
}
check('U0 配置路由已注册', true);

const res1 = { writeHead() {}, end(body) { this.body = body; } };
const call = async (handler, method, body) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method,
    headers: {},
    on(ev, cb) {
      if (ev === 'data' && payload) setTimeout(() => cb(payload), 0);
      if (ev === 'end') setTimeout(cb, 1);
      return req;
    },
  };
  await handler(req, res1);
  return JSON.parse(res1.body);
};

/* U1 GET 快照（v3：enabled 存在 custom.proxies[i] 条目本身） */
const snap1 = await call(getConfig, 'GET');
check('U1 快照 version=3', snap1.version === 3, `got ${snap1.version}`);
check('U1 四大类', snap1.categories.length === 4);
const code = snap1.categories.find((c) => c.id === 'code');
const github = code.engines.find((e) => e.id === 'github');
check('U1 源字段（key/url/type/removable/empty）', !!github.routes[0].key
  && typeof github.routes[0].url === 'string'
  && github.routes[0].type === 'direct'
  && github.routes[0].removable === false
  && github.routes[0].empty === false);
check('U1 GitHub 含加速入口（type=proxy）', github.routes.some((r2) => r2.type === 'proxy' && r2.tier === 1));

/* U2 POST routeOverrides：直连入口 → 代理 + URL 覆盖 */
const post1 = await call(postConfig, 'POST', {
  apiKey: 'ghp_TEST_TOKEN',
  proxyUrl: 'http://127.0.0.1:58993',
  routeOverrides: { 'github|直连 api.github.com': { proxy: true, url: 'https://api.example.com' } },
});
check('U2 POST ok + apiKeySet', post1.ok === true && post1.apiKeySet === true);
const gh2 = post1.categories.find((c) => c.id === 'code').engines.find((e) => e.id === 'github');
const direct2 = gh2.routes.find((r2) => r2.key === 'github|直连 api.github.com');
check('U2 类型切换生效（direct→proxy）', direct2.type === 'proxy');
check('U2 网址覆盖生效', direct2.url === 'https://api.example.com' && direct2.defaultUrl === 'https://api.github.com');

/* U3 自定义源：名称 + 官方网址 + 代理 */
const post2 = await call(postConfig, 'POST', {
  custom: {
    code: [{ name: '本地 Gitea', url: 'https://gitea.example.com', proxies: [{ url: 'https://mirror.example.com' }] }],
    web: [{ name: ' Bing 测试', url: 'https://cn.bing.com', proxies: [] }],
  },
});
const code3 = post2.categories.find((c) => c.id === 'code');
const customSrc = code3.engines.find((e) => e.custom);
check('U3 自定义源出现在快照（含代理入口）', !!customSrc
  && customSrc.label === '本地 Gitea'
  && customSrc.routes.length === 2
  && customSrc.routes[1].removable === true);
const web3 = post2.categories.find((c) => c.id === 'web');
check('U3 网页搜索类目计入自定义源', web3.engines.some((e) => e.custom && e.label === 'Bing 测试'));

/* U4 恢复默认 */
const post3 = await call(postReset, 'POST');
check('U4 reset 清空 apiKey', post3.apiKeySet === false);
check('U4 reset 移除自定义源', post3.categories.every((c) => !c.engines.some((e) => e.custom)));
check('U4 reset 恢复默认类型', post3.categories.flatMap((c) => c.engines).every((e) => e.routes.every((r2) => r2.type === (r2.tier === 1 ? 'proxy' : 'direct'))));

/* U5 幂等 */
{
  const cap2 = makeCtx({});
  isolateHome('u5');
  plugin.apply(cap2.ctx, {});
  check('U5 重复 apply 不抛错（幂等安装）', true);
}

/* U6 v3 数据模型：删除代理后启停状态不错位（v2 按 label 定位会错位） */
{
  const cap3 = makeCtx({});
  isolateHome('u6');
  plugin.apply(cap3.ctx, {});
  const post3b = cap3.routes.get('/dsh-websearch-direct/api/config');
  const rowsOf = (snap) => {
    for (const c of snap.categories) {
      for (const e of c.engines) if (e.custom && e.label === 'U6 源') return e.routes;
    }
    return null;
  };
  const en = (rows) => rows.filter((r) => r.tier === 1).map((r) => r.enabled);

  // 3 条代理 → 停用第 2 条
  const s6a = await call(post3b, 'POST', {
    custom: { code: [{ name: 'U6 源', url: 'https://gitea.example.com', proxies: [
      { url: 'https://p1.example.com' },
      { url: 'https://p2.example.com', enabled: false },
      { url: 'https://p3.example.com' },
    ] }] },
  });
  check('U6a 停用第 2 条 → [true,false,true]', en(rowsOf(s6a)).join(',') === 'true,false,true',
    JSON.stringify(en(rowsOf(s6a))));

  // 删除第 1 条 → 原第 2/3 条各自状态必须跟着自己走
  const s6b = await call(post3b, 'POST', {
    custom: { code: [{ name: 'U6 源', url: 'https://gitea.example.com', proxies: [
      { url: 'https://p2.example.com', enabled: false },
      { url: 'https://p3.example.com' },
    ] }] },
  });
  const rows6 = rowsOf(s6b);
  check('U6b ★核心★ 删除第 1 条后剩余仍为 [false,true]（不错位）',
    en(rows6).join(',') === 'false,true', JSON.stringify(en(rows6)));
  check('U6c 剩余代理 url 顺序为 p2,p3',
    rows6.filter((r) => r.tier === 1).map((r) => r.url).join(',') ===
      'https://p2.example.com,https://p3.example.com');
  check('U6d proxyIndex 随数组重排为 0,1',
    rows6.filter((r) => r.tier === 1).map((r) => r.proxyIndex).join(',') === '0,1');
}

/* U7 v2 旧配置向后兼容：enabled 存在 routeOverrides["<engId>|代理 N"] */
{
  const cap4 = makeCtx({});
  isolateHome('u7', {
    version: 2,
    routeOverrides: { 'custom-code-1|代理 2': { enabled: false } },
    routeExtras: {},
    custom: { code: [{ name: 'U7 旧源', url: 'https://gitea.example.com', proxies: [
      { url: 'https://a.example.com' }, { url: 'https://b.example.com' }] }] },
  });
  plugin.apply(cap4.ctx, {});
  const s7 = await call(cap4.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let rows7 = null;
  for (const c of s7.categories) for (const e of c.engines) if (e.custom && e.label === 'U7 旧源') rows7 = e.routes;
  check('U7a v2 旧配置读盘成功（源存在）', !!rows7);
  check('U7b ★兼容★ 旧 routeOverrides.enabled=false 仍生效 [true,false]',
    rows7.filter((r) => r.tier === 1).map((r) => r.enabled).join(',') === 'true,false',
    JSON.stringify(rows7.filter((r) => r.tier === 1).map((r) => r.enabled)));
  check('U7c 旧配置归一后 version=3', s7.version === 3, `got ${s7.version}`);
}

/* U8 幂等：同一入参重复 POST 状态不翻转；去掉 enabled 能翻回启用 */
{
  const cap5 = makeCtx({});
  isolateHome('u8');
  plugin.apply(cap5.ctx, {});
  const post5 = cap5.routes.get('/dsh-websearch-direct/api/config');
  const en5 = (snap) => {
    for (const c of snap.categories) for (const e of c.engines) if (e.custom && e.label === 'U8 源') return e.routes.filter((r) => r.tier === 1).map((r) => r.enabled);
    return [];
  };
  const body8 = { custom: { code: [{ name: 'U8 源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p1.example.com', enabled: false }, { url: 'https://p2.example.com' }] }] } };
  const a8 = await call(post5, 'POST', body8);
  const b8 = await call(post5, 'POST', body8);
  check('U8a 两次 POST 同一入参结果一致 [false,true]',
    en5(a8).join(',') === 'false,true' && en5(b8).join(',') === 'false,true',
    `${en5(a8).join(',')} / ${en5(b8).join(',')}`);
  const c8 = await call(post5, 'POST', { custom: { code: [{ name: 'U8 源', url: 'https://gitea.example.com',
    proxies: [{ url: 'https://p1.example.com' }, { url: 'https://p2.example.com' }] }] } });
  check('U8b 去掉 enabled 后恢复启用 [true,true]', en5(c8).join(',') === 'true,true', en5(c8).join(','));
}

/* U9 运行时：停用的自定义代理入口不参与路由 + v1 遗留形状读盘不崩 */
{
  const cap6 = makeCtx({});
  isolateHome('u9a');
  plugin.apply(cap6.ctx, {});
  const post6 = cap6.routes.get('/dsh-websearch-direct/api/config');
  const s9 = await call(post6, 'POST', {
    custom: { code: [{ name: 'U9 运行源', url: 'https://gitea.example.com', proxies: [
      { url: 'https://p1.example.com', enabled: false }, { url: 'https://p2.example.com' }] }] },
  });
  let rows9 = null;
  for (const c of s9.categories) for (const e of c.engines) if (e.custom && e.label === 'U9 运行源') rows9 = e.routes;
  check('U9a 快照正确区分停用/启用 [false,true]',
    rows9.filter((r) => r.tier === 1).map((r) => r.enabled).join(',') === 'false,true');
  check('U9b 每条代理入口带 proxyIndex（运行时按位置筛选的锚点）',
    rows9.filter((r) => r.tier === 1).map((r) => r.proxyIndex).join(',') === '0,1');
  // v1 遗留形状 {label,url,proxy} 读盘不崩
  const cap7 = makeCtx({});
  isolateHome('u9c', {
    version: 1, routeOverrides: {}, routeExtras: {},
    custom: { code: [{ label: 'U9 V1 老源', url: 'https://old.example.com', proxy: 'https://p.example.com' }] },
  });
  plugin.apply(cap7.ctx, {});
  const s9b = await call(cap7.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let found1 = null;
  for (const c of s9b.categories) for (const e of c.engines) if (e.custom) found1 = e;
  check('U9c v1 遗留 {label,url,proxy} 被归一成 name（读盘不崩）',
    !!found1 && found1.label === 'U9 V1 老源', found1 ? found1.label : 'null');
  check('U9d v1 配置读上来后 version=3', s9b.version === 3, `got ${s9b.version}`);
}

/* U10 routeExtras（内置源「＋代理」入口）的 enabled 必须能存下来
 *
 * routeExtras 是与 custom / routeOverrides 并列的**独立写入路径**：
 * 内置源追加的代理入口存在这里，形如 { "<engineId>": [ { url, enabled? } ] }。
 * 它有两处归一化：读盘（normaliseUiState）与 POST 入参（applyUiUpdate）。
 * 任一处置丢 enabled，停用状态就会静默变回启用 —— 两处都要覆盖。
 */
{
  // ---- U10a 读盘路径：磁盘上的 enabled:false 必须回显为 false ----
  const cap8 = makeCtx({});
  isolateHome('u10a', {
    version: 3,
    routeOverrides: {},
    routeExtras: { github: [{ url: 'https://example-proxy.test', enabled: false }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  plugin.apply(cap8.ctx, {});
  const s10 = await call(cap8.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let gh10 = null;
  for (const c of s10.categories) for (const e of c.engines) if (e.id === 'github') gh10 = e.routes;
  const extra10 = gh10 ? gh10.filter((r) => r.key === 'github|自定义代理 1') : [];
  check('U10a 读盘：routeExtras 的 enabled=false 回显为 false（不是 true）',
    extra10.length === 1 && extra10[0].enabled === false,
    JSON.stringify(extra10.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // ---- U10b POST 入参路径：POST 带 enabled:false 必须落库并在快照回显 ----
  const cap9 = makeCtx({});
  isolateHome('u10b');
  plugin.apply(cap9.ctx, {});
  const post9 = cap9.routes.get('/dsh-websearch-direct/api/config');
  const s10b = await call(post9, 'POST', {
    routeExtras: { github: [{ url: 'https://posted-proxy.test', enabled: false }] },
  });
  let gh10b = null;
  for (const c of s10b.categories) for (const e of c.engines) if (e.id === 'github') gh10b = e.routes;
  const extra10b = gh10b ? gh10b.filter((r) => r.key === 'github|自定义代理 1') : [];
  check('U10b POST：入参 enabled=false 落库并回显为 false',
    extra10b.length === 1 && extra10b[0].enabled === false,
    JSON.stringify(extra10b.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // ---- U10c POST 后重新读盘（模拟重启）：状态不丢 ----
  const cap10 = makeCtx({});
  plugin.apply(cap10.ctx, {}); // DSH_HOME 未变 → 读回 U10b 刚写的文件
  const s10c = await call(cap10.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let gh10c = null;
  for (const c of s10c.categories) for (const e of c.engines) if (e.id === 'github') gh10c = e.routes;
  const extra10c = gh10c ? gh10c.filter((r) => r.key === 'github|自定义代理 1') : [];
  check('U10c 重启后仍为 false（写盘→读盘往返不丢）',
    extra10c.length === 1 && extra10c[0].enabled === false,
    JSON.stringify(extra10c.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // ---- U10d 缺省即启用：不带 enabled 的条目仍为 true（不能一律写成 false）----
  const cap11 = makeCtx({});
  isolateHome('u10d', {
    version: 3, routeOverrides: {},
    routeExtras: { github: [{ url: 'https://on-proxy.test' }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  plugin.apply(cap11.ctx, {});
  const s10d = await call(cap11.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let gh10d = null;
  for (const c of s10d.categories) for (const e of c.engines) if (e.id === 'github') gh10d = e.routes;
  const extra10d = gh10d ? gh10d.filter((r) => r.key === 'github|自定义代理 1') : [];
  check('U10d 缺省即启用：无 enabled 字段的条目为 true',
    extra10d.length === 1 && extra10d[0].enabled === true,
    JSON.stringify(extra10d.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // ---- U10e 混合：一条停用一条启用，顺序与状态都要对 ----
  const cap12 = makeCtx({});
  isolateHome('u10e', {
    version: 3, routeOverrides: {},
    routeExtras: { github: [{ url: 'https://off.test', enabled: false }, { url: 'https://on.test' }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  plugin.apply(cap12.ctx, {});
  const s10e = await call(cap12.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  let gh10e = null;
  for (const c of s10e.categories) for (const e of c.engines) if (e.id === 'github') gh10e = e.routes;
  const ex10e = gh10e ? gh10e.filter((r) => r.key.startsWith('github|自定义代理')) : [];
  // ---- U10f 运行时：停用的 routeExtras 入口必须被 runEngine 过滤掉 ----
  // 快照回显对了还不够：决定「真的走哪条入口」的是 runEngine 里的路由筛选。
  // 该筛选此前只看 routeOverrides / custom，从不看 routeExtras，
  // 于是 routeExtras 里停用的入口仍会被真实请求使用。
  const cap13 = makeCtx({});
  isolateHome('u10f', {
    version: 3, routeOverrides: {},
    routeExtras: { bing: [{ url: 'https://off-extra.test', enabled: false }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  plugin.apply(cap13.ctx, {});
  const prov13 = cap13.provider;
  // 只允许 off-extra.test 这条被停用的入口可用，其余全部断网：
  // 若运行时正确过滤，应报「没有可用路由」；若未过滤，会真的去请求它。
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new Error('测试断言：不应发生真实请求');
  };
  let runtimeMsg = '';
  try {
    await prov13.search({ query: 'x', engine: 'bing', maxResults: 1, proxyUrl: '', _ui: {
      routeOverrides: {},
      routeExtras: { bing: [{ url: 'https://off-extra.test', enabled: false }] },
      custom: {},
    } });
  } catch (e) {
    runtimeMsg = String(e && e.message);
  } finally {
    globalThis.fetch = origFetch;
    if (typeof origFetch !== 'function') delete globalThis.fetch;
  }
  const hitDisabled = seen.some((u) => u.includes('off-extra.test'));
  check('U10f 运行时：停用的 routeExtras 入口不被真实请求（命中即失败）',
    hitDisabled === false,
    hitDisabled ? `被请求了: ${JSON.stringify(seen)}` : `msg=${runtimeMsg.slice(0, 80)} seen=${JSON.stringify(seen)}`);
}

/* U11 F1：v2 僵尸 routeOverrides 键吞掉「启用」+ 清理不得误伤内置源
 *
 * v2 存量配置升级到 v3 后，读取侧是「v3 条目 OR v2 键」的合并。
 * 若 custom 分支不清 v2 遗留键，用户点「启用」会失效 —— 客户端只 POST custom，
 * 永远碰不到那个键 ⇒ 磁盘说启用、界面说停用、且无报错。
 * 🔴 清理必须只针对 custom-* 前缀：内置源追加入口的停用至今依赖 routeOverrides。
 */
{
  // ---- U11a v2 僵尸键：点启用必须真的生效 ----
  const cap14 = makeCtx({});
  const home14 = isolateHome('u11a', {
    version: 2,
    routeOverrides: { 'custom-code-1|代理 2': { enabled: false } },
    routeExtras: {},
    custom: { code: [{ name: 'U11 源', url: 'https://gitea.example.com',
      proxies: [{ url: 'https://p1.test' }, { url: 'https://p2.test' }] }],
      pkg: [], model: [], web: [] },
  });
  plugin.apply(cap14.ctx, {});
  const h14 = cap14.routes.get('/dsh-websearch-direct/api/config');
  const g14 = (snap) => {
    for (const c of snap.categories) for (const e of c.engines)
      if (e.custom && e.label === 'U11 源') return e.routes.filter((r) => r.tier === 1).map((r) => r.enabled);
    return [];
  };
  const s14a = await call(h14, 'GET');
  check('U11a 升级后初始 [true,false]（v2 键生效）', g14(s14a).join(',') === 'true,false', JSON.stringify(g14(s14a)));
  const s14b = await call(h14, 'POST', { custom: { code: [{ name: 'U11 源', url: 'https://gitea.example.com',
    proxies: [{ url: 'https://p1.test' }, { url: 'https://p2.test' }] }] } });
  check('U11b ★核心★ 点启用后必须回 [true,true]（不被僵尸键压制）',
    g14(s14b).join(',') === 'true,true', `got ${g14(s14b).join(',')}`);
  const disk14 = JSON.parse((await import('node:fs')).readFileSync(
    `${home14}/storages/websearch-direct/ui-config.json`, 'utf8'));
  check('U11c 磁盘上 custom-* 僵尸键已删除',
    Object.keys(disk14.routeOverrides).filter((k) => k.startsWith('custom-')).length === 0,
    JSON.stringify(Object.keys(disk14.routeOverrides)));

  // ---- U11d 🔴 回归：内置源 github 的键不得被删 ----
  const cap15 = makeCtx({});
  const home15 = isolateHome('u11d', {
    version: 3,
    routeOverrides: { 'github|自定义代理 1': { enabled: false } },
    routeExtras: { github: [{ url: 'https://gh-extra.test' }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  plugin.apply(cap15.ctx, {});
  const h15 = cap15.routes.get('/dsh-websearch-direct/api/config');
  const gh15 = (snap) => {
    for (const c of snap.categories) for (const e of c.engines)
      if (e.id === 'github') return e.routes.filter((r) => r.key.startsWith('github|自定义代理'));
    return [];
  };
  const s15a = await call(h15, 'GET');
  check('U11d 内置源追加入口初始为停用', gh15(s15a).length === 1 && gh15(s15a)[0].enabled === false,
    JSON.stringify(gh15(s15a).map((r) => r.enabled)));
  const s15b = await call(h15, 'POST', { custom: { code: [{ name: '并存源', url: 'https://gitea.example.com', proxies: [] }] } });
  check('U11e ★回归★ custom 写入后内置源键仍在、停用仍生效',
    gh15(s15b).length === 1 && gh15(s15b)[0].enabled === false,
    JSON.stringify(gh15(s15b).map((r) => r.enabled)));
  const disk15 = JSON.parse((await import('node:fs')).readFileSync(
    `${home15}/storages/websearch-direct/ui-config.json`, 'utf8'));
  check('U11f 磁盘上 github| 键未被删除',
    Object.keys(disk15.routeOverrides).some((k) => k.startsWith('github|')),
    JSON.stringify(Object.keys(disk15.routeOverrides)));
}

/* U12 运行时真值（带正对照）+ 闸门有效性
 *
 * 来源：t3 复核 F3'。现有断言几乎全在**快照层**；实测过——把 runEngine 的
 * 停用过滤整个删掉，快照类断言仍 13/0 全绿。所以必须补一条**运行时**断言。
 * 且必须带**正对照**：先证明「启用的那条确实被请求」，否则「停用项未被请求」
 * 可能只是仪器根本没走到该引擎（两边都没命中也会显示"通过"）。
 */
{
  const cap16 = makeCtx({});
  // 引擎注册来自**磁盘配置**（apply 时 installCustomEngines），不是 search 的 _ui 入参。
  // 所以必须先把源种进 ui-config.json，否则 custom-code-1 根本没注册，
  // 请求会静默落到 bing —— 正对照正是为了逮住这种「仪器没走到该引擎」。
  isolateHome('u12', {
    version: 3, routeOverrides: {}, routeExtras: {},
    custom: { code: [{ name: 'U12 源', url: 'https://s.test',
      proxies: [{ url: 'https://on.test' }, { url: 'https://off.test', enabled: false }] }],
      pkg: [], model: [], web: [] },
  });
  plugin.apply(cap16.ctx, {});
  const hits16 = [];
  const realFetch16 = globalThis.fetch;
  globalThis.fetch = async (u) => { hits16.push(String(u)); throw new Error('BLOCKED'); };
  try {
    await cap16.provider.search({ query: 'x', engine: 'custom-code-1', maxResults: 1, proxyUrl: '' });
  } catch { /* 预期：被拦截后全部失败 */ } finally {
    globalThis.fetch = realFetch16;
    if (typeof realFetch16 !== 'function') delete globalThis.fetch;
  }
  const hitOn16 = hits16.some((u) => u.includes('on.test'));
  const hitOff16 = hits16.some((u) => u.includes('off.test'));
  check('U12a 【仪器自检】运行时启用项被请求（正对照，否则 U12b 无效）',
    hitOn16, hitOn16 ? '' : `未命中 on.test；hits=${JSON.stringify(hits16)}`);
  check('U12b ★核心★ 运行时停用项未被请求（快照层之外的真值）',
    hitOn16 && !hitOff16, hitOn16 ? (hitOff16 ? 'off.test 被请求了' : 'off 未出现') : '无法判定（自检未过）');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
