/**
 * v3 数据模型专项回归（矩阵视角，与 test-v0.4-ui.mjs 互为独立通道）
 *
 * 存在理由：test-v0.4-ui.mjs 是「卡片数据面」套件，覆盖 U0–U10；
 * 本文件用**独立的 harness 与独立的断言措辞**再打一遍 v3 的核心不变量，
 * 使「v3 迁移是否正确」有两把不共享失效模式的尺子。
 *
 * 覆盖：
 *   V3-1 删除代理后启停状态不错位（v2 按 label 定位会错位）
 *   V3-2 运行时筛选读条目本身，而非只读 routeOverrides
 *   V3-3 custom.proxies[i].enabled=false 在 GET 快照回显
 *   V3-4 v2 旧配置（routeOverrides 存 enabled）向后兼容
 *   V3-5 routeExtras（内置源追加入口）enabled 的读盘 / POST / 运行时三条路径
 *   V3-6 v1 遗留形状读盘不崩 + 幂等
 *
 * 用法（cwd 必须是 C:/Users/Administrator/.workbuddy/binaries/node/workspace）：
 *   node test-v3-model.mjs
 *   WSD_DIST=<任意副本>/dist/index.js node test-v3-model.mjs   # 打旧代码取 red 证据
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

// 用 fileURLToPath 而不是手工剥前缀：后者在 8.3 短路径（ADMINI~1）下会得到
// 百分号编码的路径，existsSync 直接判否 —— 会让测试在 %TEMP% 下假报「dist 不存在」。
const DIST = process.env.WSD_DIST
  ? process.env.WSD_DIST
  : fileURLToPath(new URL('./dist/index.js', import.meta.url));

if (!existsSync(DIST)) {
  console.error(`dist 不存在：${DIST}`);
  process.exit(2);
}
console.log(`# dist = ${DIST}`);

const plugin = await import(pathToFileURL(DIST).href);

function makeCtx() {
  const routes = new Map();
  const warns = [];
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
        else if (n === 'settings') svc[n] = { register: () => ({ get: () => ({}), watch: () => {} }) };
      }
      cb(svc);
    },
    effect: (fn) => { try { fn(); } catch {} return () => {}; },
  };
  return { ctx, routes, warns, tools, get provider() { return searchProvider; } };
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/** 每个用例独占 DSH_HOME：引擎 id（custom-<cat>-N）与 label（代理 N）都按位置生成，跨用例必撞。 */
let seq = 0;
function iso(tag, preload) {
  const home = `${process.env.TEMP || '.'}/wsd-v3m-${tag}-${process.pid}-${seq++}`;
  process.env.DSH_HOME = home;
  if (preload) {
    mkdirSync(`${home}/storages/websearch-direct`, { recursive: true });
    writeFileSync(`${home}/storages/websearch-direct/ui-config.json`, JSON.stringify(preload, null, 2));
  }
  return home;
}
async function boot(tag, preload) {
  const home = iso(tag, preload);
  const cap = makeCtx();
  plugin.apply(cap.ctx, {});
  cap.home = home;
  return cap;
}
const res = () => ({ writeHead() {}, end(b) { this.body = b; } });
const call = async (h, method, body) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const r = res();
  const req = { method, headers: {}, on(ev, cb) {
    if (ev === 'data' && payload) setTimeout(() => cb(payload), 0);
    if (ev === 'end') setTimeout(cb, 1); return req; } };
  await h(req, r);
  return JSON.parse(r.body);
};
const srcRoutes = (snap, name) => {
  for (const c of snap.categories) for (const e of c.engines)
    if (e.custom && e.label === name) return e.routes;
  return null;
};
const engRoutes = (snap, id) => {
  for (const c of snap.categories) for (const e of c.engines) if (e.id === id) return e.routes;
  return null;
};
const enOf = (routes) => (routes || []).filter((r) => r.tier === 1).map((r) => r.enabled);

/* ------------------------------------------------------------ V3-1 不错位 */
console.log('\n[V3-1] 3 条代理：停用第 2 条 → 删除第 1 条 → 状态不错位');
{
  const cap = await boot('v31');
  const post = cap.routes.get('/dsh-websearch-direct/api/config');
  const s0 = await call(post, 'POST', { custom: { code: [{ name: 'V3 源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p1.example.com' }, { url: 'https://p2.example.com' }, { url: 'https://p3.example.com' }] }] } });
  check('V3-1a 3 条代理默认启用', enOf(srcRoutes(s0, 'V3 源')).join(',') === 'true,true,true',
    JSON.stringify(enOf(srcRoutes(s0, 'V3 源'))));
  check('V3-1b proxyIndex 锚点 = 0,1,2',
    srcRoutes(s0, 'V3 源').filter((r) => r.tier === 1).map((r) => r.proxyIndex).join(',') === '0,1,2');

  const s1 = await call(post, 'POST', { custom: { code: [{ name: 'V3 源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p1.example.com' }, { url: 'https://p2.example.com', enabled: false }, { url: 'https://p3.example.com' }] }] } });
  check('V3-1c 停用第 2 条 → [true,false,true]', enOf(srcRoutes(s1, 'V3 源')).join(',') === 'true,false,true',
    JSON.stringify(enOf(srcRoutes(s1, 'V3 源'))));

  const s2 = await call(post, 'POST', { custom: { code: [{ name: 'V3 源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p2.example.com', enabled: false }, { url: 'https://p3.example.com' }] }] } });
  const r2 = srcRoutes(s2, 'V3 源');
  check('V3-1d 删除后剩 p2,p3',
    r2.filter((r) => r.tier === 1).map((r) => r.url).join(',') === 'https://p2.example.com,https://p3.example.com');
  check('V3-1e ★核心★ 状态跟着 URL 走 [false,true]',
    enOf(r2).join(',') === 'false,true', `expected false,true got ${enOf(r2).join(',')}`);
  check('V3-1f proxyIndex 随数组重排 0,1',
    r2.filter((r) => r.tier === 1).map((r) => r.proxyIndex).join(',') === '0,1');
}

/* -------------------------------------------------- V3-2 运行时筛选读条目 */
console.log('\n[V3-2] 运行时按条目定位，而非只看 routeOverrides');
{
  const cap = await boot('v32');
  const post = cap.routes.get('/dsh-websearch-direct/api/config');
  const s = await call(post, 'POST', { custom: { code: [{ name: 'V3 运行源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p1.example.com', enabled: false }, { url: 'https://p2.example.com' }] }] } });
  check('V3-2a 快照区分 [false,true]', enOf(srcRoutes(s, 'V3 运行源')).join(',') === 'false,true',
    JSON.stringify(enOf(srcRoutes(s, 'V3 运行源'))));
  const src = readFileSync(DIST, 'utf8');
  check('V3-2b 运行时存在按 proxyIndex 回查条目的分支', /entry\.enabled === false/.test(src));
  check('V3-2c 路由构建写入 proxyIndex', /proxyIndex:\s*j/.test(src));
}

/* ---------------------------------------------------------- V3-3 快照回显 */
console.log('\n[V3-3] custom.proxies[i].enabled=false 在 GET 快照回显');
{
  const cap = await boot('v33', { version: 3, routeOverrides: {}, routeExtras: {}, custom: {
    code: [{ name: '回显源', url: 'https://gitea.example.com', proxies: [
      { url: 'https://a.example.com' }, { url: 'https://b.example.com', enabled: false }] }],
    pkg: [], model: [], web: [] } });
  const s = await call(cap.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  check('V3-3a GET 快照 version=3', s.version === 3, `got ${s.version}`);
  check('V3-3b 磁盘 enabled=false 回显 [true,false]', enOf(srcRoutes(s, '回显源')).join(',') === 'true,false',
    JSON.stringify(enOf(srcRoutes(s, '回显源'))));
}

/* -------------------------------------------------------- V3-4 v2 向后兼容 */
console.log('\n[V3-4] v2 旧配置（routeOverrides 存 enabled）向后兼容');
{
  const cap = await boot('v34', { version: 2, routeOverrides: { 'custom-code-1|代理 2': { enabled: false } },
    routeExtras: {}, custom: { code: [{ name: '旧配置源', url: 'https://gitea.example.com',
      proxies: [{ url: 'https://a.example.com' }, { url: 'https://b.example.com' }] }],
      pkg: [], model: [], web: [] } });
  const s = await call(cap.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  const rows = srcRoutes(s, '旧配置源');
  check('V3-4a 旧配置读上来（两条代理）', !!rows && rows.filter((r) => r.tier === 1).length === 2);
  check('V3-4b ★兼容★ 旧 enabled=false 仍生效 [true,false]',
    enOf(rows).join(',') === 'true,false', JSON.stringify(enOf(rows)));
  check('V3-4c 归一后 version=3', s.version === 3, `got ${s.version}`);
}

/* ------------------------------------------------- V3-5 routeExtras 三路径 */
console.log('\n[V3-5] routeExtras（内置源追加入口）enabled 三条路径');
{
  const cap = await boot('v35a', { version: 3, routeOverrides: {},
    routeExtras: { github: [{ url: 'https://off.test', enabled: false }, { url: 'https://on.test' }] },
    custom: { code: [], pkg: [], model: [], web: [] } });
  const s = await call(cap.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  const ex = (engRoutes(s, 'github') || []).filter((r) => r.key.startsWith('github|自定义代理'));
  check('V3-5a 读盘：混合两条 [false,true] 且 URL 顺序正确',
    ex.map((r) => r.enabled).join(',') === 'false,true'
      && ex.map((r) => r.url).join(',') === 'https://off.test,https://on.test',
    JSON.stringify(ex.map((r) => ({ url: r.url, enabled: r.enabled }))));

  const cap2 = await boot('v35b');
  const p2 = cap2.routes.get('/dsh-websearch-direct/api/config');
  const s2 = await call(p2, 'POST', { routeExtras: { github: [{ url: 'https://posted.test', enabled: false }] } });
  const ex2 = (engRoutes(s2, 'github') || []).filter((r) => r.key.startsWith('github|自定义代理'));
  check('V3-5b POST 入参：enabled=false 落库并回显',
    ex2.length === 1 && ex2[0].enabled === false,
    JSON.stringify(ex2.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // 运行时：停用的 routeExtras 入口不得被真实请求
  const cap3 = await boot('v35c', { version: 3, routeOverrides: {},
    routeExtras: { bing: [{ url: 'https://off-extra.test', enabled: false }] },
    custom: { code: [], pkg: [], model: [], web: [] } });
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); throw new Error('测试断言：不应发生真实请求'); };
  try {
    await cap3.provider.search({ query: 'x', engine: 'bing', maxResults: 1, proxyUrl: '',
      _ui: { routeOverrides: {}, routeExtras: { bing: [{ url: 'https://off-extra.test', enabled: false }] }, custom: {} } });
  } catch { /* 预期：无可用路由或全失败 */ } finally {
    globalThis.fetch = orig;
    if (typeof orig !== 'function') delete globalThis.fetch;
  }
  check('V3-5c ★核心★ 运行时：停用的 routeExtras 入口未被真实请求',
    seen.some((u) => u.includes('off-extra.test')) === false, JSON.stringify(seen));
}

/* ------------------------------------------------- V3-6 v1 兼容 + 幂等 */
console.log('\n[V3-6] v1 遗留形状读盘不崩 + 幂等');
{
  const cap = await boot('v36a', { version: 1, routeOverrides: {}, routeExtras: {},
    custom: { code: [{ label: 'V1 老源', url: 'https://old.example.com', proxy: 'https://p.example.com' }],
      pkg: [], model: [], web: [] } });
  const s = await call(cap.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  check('V3-6a v1 {label,url,proxy} 被归一成 name', !!srcRoutes(s, 'V1 老源'));

  const cap2 = await boot('v36b');
  const p2 = cap2.routes.get('/dsh-websearch-direct/api/config');
  const body = { custom: { code: [{ name: '幂等源', url: 'https://gitea.example.com', proxies: [
    { url: 'https://p1.example.com', enabled: false }, { url: 'https://p2.example.com' }] }] } };
  const a = await call(p2, 'POST', body);
  const b = await call(p2, 'POST', body);
  check('V3-6b 两次 POST 一致 [false,true]',
    enOf(srcRoutes(a, '幂等源')).join(',') === 'false,true' && enOf(srcRoutes(b, '幂等源')).join(',') === 'false,true',
    `${enOf(srcRoutes(a, '幂等源')).join(',')} / ${enOf(srcRoutes(b, '幂等源')).join(',')}`);
}

/* ------------------------------------------- V3-7 F1：v2 僵尸键吞掉「启用」 */
console.log('\n[V3-7] F1：v2 僵尸 routeOverrides 键不得吞掉 v3 的「启用」');
{
  // v2 存量配置升级：custom-code-1 的「代理 2」在 routeOverrides 里被停用
  const home = await boot('v37', {
    version: 2,
    routeOverrides: { 'custom-code-1|代理 2': { enabled: false } },
    routeExtras: {},
    custom: { code: [{ name: 'F1 源', url: 'https://gitea.example.com',
      proxies: [{ url: 'https://p1.test' }, { url: 'https://p2.test' }] }],
      pkg: [], model: [], web: [] },
  });

  const cfgFile = `${home.home}/storages/websearch-direct/ui-config.json`;
  const h1 = await call(home.routes.get('/dsh-websearch-direct/api/config'), 'GET');
  const before = srcRoutes(h1, 'F1 源');
  check('V3-7a 升级后初始状态 [true,false]（v2 键生效）',
    enOf(before).join(',') === 'true,false', JSON.stringify(enOf(before)));

  // 用户点「启用第 2 条」：client.rebuildCustom 只 POST custom，不带任何 enabled
  const h2 = await call(home.routes.get('/dsh-websearch-direct/api/config'), 'POST', {
    custom: { code: [{ name: 'F1 源', url: 'https://gitea.example.com',
      proxies: [{ url: 'https://p1.test' }, { url: 'https://p2.test' }] }] },
  });
  const after = srcRoutes(h2, 'F1 源');
  check('V3-7b ★核心★ 点启用后必须回 [true,true]（不被 v2 僵尸键压制）',
    enOf(after).join(',') === 'true,true', `got ${enOf(after).join(',')}`);

  // 磁盘校验：custom-* 的僵尸键必须被清掉
  const disk = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const zombie = Object.keys(disk.routeOverrides || {}).filter((k) => k.startsWith('custom-'));
  check('V3-7c 磁盘上 custom-* 僵尸键已删除',
    zombie.length === 0, JSON.stringify(zombie));
  check('V3-7d 磁盘 custom 条目持久化正确（无 enabled = 已启用）',
    (disk.custom?.code?.[0]?.proxies || []).every((p) => p.enabled !== false),
    JSON.stringify(disk.custom?.code?.[0]?.proxies));
}

/* ----------------------------- V3-8 🔴 关键回归：内置源 extas 停用不能被误伤 */
console.log('\n[V3-8] 🔴 回归保护：清理只针对 custom-*，内置源追加代理的停用仍生效');
{
  const cap = await boot('v38', {
    version: 3,
    // 内置源 github 追加代理的停用走 routeOverrides（该路由无 proxyIndex）
    routeOverrides: { 'github|自定义代理 1': { enabled: false } },
    routeExtras: { github: [{ url: 'https://gh-extra.test' }] },
    custom: { code: [], pkg: [], model: [], web: [] },
  });
  const h = cap.routes.get('/dsh-websearch-direct/api/config');
  const s0 = await call(h, 'GET');
  const ex0 = (engRoutes(s0, 'github') || []).filter((r) => r.key.startsWith('github|自定义代理'));
  check('V3-8a 内置源追加入口初始为停用（靠 routeOverrides）',
    ex0.length === 1 && ex0[0].enabled === false,
    JSON.stringify(ex0.map((r) => ({ url: r.url, enabled: r.enabled }))));

  // 触发一次 custom 写入（这是修复要动的那条路径）——内置源的键必须活下来
  const s1 = await call(h, 'POST', {
    custom: { code: [{ name: '并存的自定义源', url: 'https://gitea.example.com', proxies: [] }] },
  });
  const ex1 = (engRoutes(s1, 'github') || []).filter((r) => r.key.startsWith('github|自定义代理'));
  check('V3-8b ★回归★ custom 写入后，内置源 `github|...` 键仍在且停用仍生效',
    ex1.length === 1 && ex1[0].enabled === false,
    JSON.stringify(ex1.map((r) => ({ url: r.url, enabled: r.enabled }))));
  check('V3-8c 磁盘上 github 的 routeOverrides 键未被删除',
    Object.keys(JSON.parse(readFileSync(`${cap.home}/storages/websearch-direct/ui-config.json`, 'utf8')).routeOverrides || {})
      .some((k) => k.startsWith('github|')));
}

/* ------------------- V3-9 运行时真值（带正对照） -------------------
 *
 * 来源：t3 复核 F3'。现有断言几乎全在**快照层**；t3 实测过 —— 把 runEngine 的
 * 停用过滤整个删掉，`test-v0.4-ui.mjs` 仍 38/0 全绿（零判别力）。故补**运行时**断言。
 *
 * 关键在**正对照**：必须先证明「启用的那条确实被请求了」，否则「停用项没被请求」
 * 可能只是仪器根本没走到该引擎（两边都没命中也会显示"通过"）。
 * 落地时正对照当场抓到一次测试自身缺陷：初版把配置写进 search 的 `_ui` 入参，
 * 而引擎注册读的是**磁盘配置** ⇒ 请求静默落到 bing，被正对照逮住。
 *
 * 注：本组只断言**当前发布版 dist** 的行为，不依赖任何未发布改动。
 */
console.log('\n[V3-9] 运行时真值（带正对照，不依赖快照层）');
{
  const cap = await boot('v39ab', {
    version: 3, routeOverrides: {}, routeExtras: {},
    custom: { code: [{ name: 'S', url: 'https://s.test', proxies: [
      { url: 'https://on.test' }, { url: 'https://off.test', enabled: false },
    ] }], pkg: [], model: [], web: [] },
  });
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => { hits.push(String(u)); throw new Error('BLOCKED'); };
  try {
    await cap.provider.search({ query: 'x', engine: 'custom-code-1', maxResults: 1, proxyUrl: '' });
  } catch { /* 预期：全部被拦截失败 */ } finally {
    globalThis.fetch = realFetch;
    if (typeof realFetch !== 'function') delete globalThis.fetch;
  }
  const hitOn = hits.some((u) => u.includes('on.test'));
  const hitOff = hits.some((u) => u.includes('off.test'));
  check('V3-9a 【仪器自检】启用项被请求（正对照，否则 9b 无效）',
    hitOn, hitOn ? '' : `未命中 on.test ⇒ 仪器没走到该引擎；hits=${JSON.stringify(hits)}`);
  check('V3-9b ★核心★ 运行时停用项未被请求',
    hitOn && !hitOff, hitOn ? (hitOff ? 'off.test 被请求了' : 'off 未出现') : '无法判定（自检未过）');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
