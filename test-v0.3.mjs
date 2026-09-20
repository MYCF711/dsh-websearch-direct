/**
 * v0.3 验证：新引擎 / 组合引擎 / 四个缺陷回归
 * 用法: DSH_HOME=D:/dsh-1 node test-v0.3.mjs [组名]
 *   [组名] 可选：engines | composite | fixes | mirror | all（默认 all）
 */
import { pathToFileURL } from 'node:url';

const PLUGIN = 'D:/dsh-1/profiles/ht/node_modules/dsh-websearch-direct/dist/index.js';
const only = process.argv[2] || 'all';
const run = (g) => only === 'all' || only === g;

// 让插件解析链看到 --profile ht（复现 junction 部署下的真实解析环境）
if (!process.argv.includes('--profile')) process.argv.push('--profile', 'ht');

const mod = await import(pathToFileURL(PLUGIN).href);
console.log('插件:', mod.name, '| inject:', JSON.stringify(mod.inject),
  '| Config:', typeof mod.Config, '| apply:', typeof mod.apply);

/* ---------------------------------------------------------------- mock ctx */

function makeCtx(configOverride = {}) {
  const cap = { search: null, fetch: null, tools: [], sections: [], settings: null, warns: [] };
  const logger = {
    info: (...a) => console.log('  [info]', ...a),
    warn: (...a) => { cap.warns.push(a.join(' ')); console.log('  [warn]', ...a); },
    debug: () => {},
  };
  let disposed = false;
  const ctx = {
    logger: () => logger,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject(names, cb) {
      if (names.some((n) => !['tools', 'systemPrompt', 'settings'].includes(n))) return;
      cb({
        effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
        tools: { register(t) { cap.tools.push(t); return () => {}; }, get: () => undefined },
        systemPrompt: { section(s) { cap.sections.push(s); return () => {}; }, getSectionOrder: () => 2000 },
        settings: {
          register(ns, schema, opts) {
            cap.settings = { ns, hasSchema: !!schema, base: opts?.base };
            return { get: () => configOverride };
          },
        },
      });
    },
    web: {
      registerSearchProvider: (p) => { cap.search = p; return () => {}; },
      registerFetchProvider: (p) => { cap.fetch = p; return () => {}; },
    },
  };
  mod.apply(ctx, {});
  cap.disposed = () => disposed;
  return cap;
}

const t = (label, v) => `${label}=${v}`;

/**
 * 工具层是唯一会返回路由元数据（baseEngine / routes / via）的入口，
 * seam provider 的返回结构由 dsh 规定，不该塞自定义字段。
 *
 * 同时模拟宿主的**无损 JSON 边界**：dsh-tools 要求工具输出能
 * JSON.parse(JSON.stringify(v)) 无损往返，嵌套的 undefined 会被拒绝
 * （"value is not lossless JSON"）。这个校验只在真宿主里触发，mock 直调
 * execute 抓不到 —— 所以在这里替宿主把门：v0.3.1 曾因 `notes: undefined`
 * 导致真宿主里每次搜索 100% 失败。
 */
function findUndefined(v, path = '$', out = []) {
  if (v === undefined) out.push(`${path} = undefined`);
  else if (Array.isArray(v)) v.forEach((x, i) => findUndefined(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) findUndefined(x, `${path}.${k}`, out);
  return out;
}

const callTool = async (cap, args) => {
  const r = await cap.tools[0].execute(args);
  const bad = findUndefined(r);
  if (bad.length) {
    throw new Error(`工具输出含 undefined（dsh 无损 JSON 边界会拒绝）: ${bad.join(', ')}`);
  }
  if (JSON.stringify(JSON.parse(JSON.stringify(r))) !== JSON.stringify(r)) {
    throw new Error('工具输出不能无损往返 JSON（键被 stringify 丢弃）');
  }
  return r;
};

/* -------------------------------------------------------- A. 新引擎逐跑 */

if (run('engines')) {
  console.log('\n########## A. 新增引擎真跑（engine 显式指定） ##########');
  const cap = makeCtx({ maxResults: 4, timeoutMs: 25000 });

  const cases = [
    ['gitlab', 'wechat'],
    ['codeberg', 'wechat'],
    ['gitea', 'wechat'],
    ['gitee', 'wechat'],           // 无 token → 应明确报错
    ['npm', 'wechat'],
    ['npmmirror', 'wechat'],
    ['crates', 'wechat'],
    ['packagist', 'wechat'],
    ['nuget', 'wechat'],
    ['rubygems', 'wechat'],
  ];

  for (const [engine, query] of cases) {
    const t0 = Date.now();
    try {
      const r = await cap.search.search({ query, engine, maxResults: 4 });
      const first = r.sources[0];
      console.log(`  ${engine.padEnd(11)} OK ${String(Date.now() - t0).padStart(6)}ms 条数=${r.sources.length} 首条=${first?.title?.slice(0, 58)}`);
      console.log(`  ${' '.repeat(11)} url=${first?.url}`);
    } catch (e) {
      console.log(`  ${engine.padEnd(11)} ${Date.now() - t0}ms ${e.message.slice(0, 130)}`);
    }
  }
}

/* --------------------------------------------------------- B. 组合引擎 */

if (run('composite')) {
  console.log('\n########## B. 组合引擎 repo / pkg（多源合并） ##########');
  const cap = makeCtx({ maxResults: 8, timeoutMs: 25000 });

  for (const [engine, query] of [['repo', 'wechat'], ['pkg', 'wechat']]) {
    const t0 = Date.now();
    try {
      const r = await cap.search.search({ query, engine, maxResults: 8 });
      console.log(`\n  --- ${engine}("${query}") ${Date.now() - t0}ms 条数=${r.sources.length} ---`);
      const hosts = new Set();
      for (const s of r.sources) {
        try { hosts.add(new URL(s.url).host); } catch {}
        console.log(`    ${s.title.slice(0, 74)}`);
      }
      console.log('    来源主机:', [...hosts].join(', '));
      console.log('    多源合并:', hosts.size >= 2 ? '✅ 覆盖多个托管站' : '❌ 只有单一来源');
    } catch (e) {
      console.log(`  ${engine} FAIL: ${e.message.slice(0, 200)}`);
    }
  }

  // 自动路由
  console.log('\n  --- 自动路由（省略 engine）---');
  for (const q of ['dsh plugin', 'npm registry 镜像', '杭州天气']) {
    try {
      const r = await cap.tools.length
        ? await cap.tools[0].execute({ query: q, maxResults: 3 })
        : null;
      console.log(`    "${q}" → engine=${r.engine} sources=${r.sources.length} 首条=${r.sources[0]?.title?.slice(0, 50)}`);
    } catch (e) {
      console.log(`    "${q}" FAIL ${e.message.slice(0, 120)}`);
    }
  }
}

/* ------------------------------------------------------------- C. 缺陷 */

if (run('fixes')) {
  console.log('\n########## C. 四个缺陷回归 ##########');

  // C1 / D3: enableFetch 严格解析
  console.log('\n  [D3] enableFetch 严格解析');
  for (const v of [false, true, 'false', '0', 'no', 'off', 'true', 'yes', undefined]) {
    const cap = makeCtx({ enableFetch: v });
    console.log(`    enableFetch=${JSON.stringify(v)} → available()=${cap.fetch.available()}`);
  }

  // C2 / D4: seam 层未知引擎不再静默
  console.log('\n  [D4] seam 层传未知引擎（应 warn，且不静默）');
  {
    const cap = makeCtx({ maxResults: 3 });
    const r = await cap.search.search({ query: '杭州天气', engine: 'googol', maxResults: 3 });
    console.log(`    返回条数=${r.sources.length}  warn 条数=${cap.warns.length}`);
    console.log(`    warn: ${cap.warns[0]?.slice(0, 110)}`);
  }

  // C3 / D2: engineOrder 全非法 → 回退默认
  console.log('\n  [D2] engineOrder 全非法 → 应回退默认顺序，不再抛 "已尝试 ）"');
  {
    const cap = makeCtx({ engineOrder: ['google'], maxResults: 3 });
    try {
      const r = await cap.search.search({ query: '杭州天气', maxResults: 3 });
      console.log(`    ✅ 未抛错，条数=${r.sources.length} 首条=${r.sources[0]?.title?.slice(0, 50)}`);
    } catch (e) {
      console.log(`    ❌ 仍抛错: ${e.message}`);
    }
  }

  // C4 / D1: 代理 dispatcher 真的生效（把代理指向黑洞端口，请求必须失败）
  console.log('\n  [D1] proxyUrl 是否真的被使用（代理指向黑洞端口 http://127.0.0.1:1）');
  {
    const cap = makeCtx({ proxyUrl: 'http://127.0.0.1:1', maxResults: 2, timeoutMs: 8000 });
    try {
      const r = await cap.search.search({ query: '杭州天气', maxResults: 2 });
      console.log(`    ❌ 仍然成功（条数=${r.sources.length}）→ 代理没生效！`);
    } catch (e) {
      console.log(`    ✅ 按预期失败 → 代理 dispatcher 生效: ${e.message.slice(0, 100)}`);
    }
    console.log(`    代理相关 warn: ${cap.warns.filter((w) => /代理|proxy|undici|ProxyAgent/i.test(w)).join(' | ') || '（无）'}`);
  }
  {
    const cap = makeCtx({ proxyUrl: '', maxResults: 2, timeoutMs: 15000 });
    const r = await cap.search.search({ query: '杭州天气', maxResults: 2 });
    console.log(`    对照（无代理）: 成功 条数=${r.sources.length} 首条=${r.sources[0]?.title?.slice(0, 40)}`);
  }

  // 凭据不外流：token 只能出现在直连入口的请求里
  console.log('\n  [F1] githubToken 只发给权威直连入口，不发给第三方加速代理');
  {
    const bad = 'ghp_THIS_TOKEN_IS_INTENTIONALLY_INVALID';
    // 故意用无效 token，并强制先直连：
    //   直连入口若带上 token → GitHub 回 401 → 说明「token 只发给直连」成立
    //   随后回退到加速入口 → 不该带 token → 所以能匿名成功
    const cap = makeCtx({ githubToken: bad, maxResults: 3, timeoutMs: 20000, routePolicy: 'direct-first' });
    let via = null;
    let out = null;
    try {
      out = await callTool(cap, { query: 'wechat', engine: 'github', maxResults: 3 });
      via = String(out.routes.github);
    } catch (e) {
      out = { error: e.message };
    }
    const direct401 = cap.warns.some((w) => /直连 api\.github\.com.*401/.test(w));
    const accelOk = !!out.sources && !/^直连/.test(via || '');
    console.log(`    直连入口带 token 的取证: ${direct401 ? '✅ 命中 HTTP 401（GitHub 拒了这个无效 token，证明它确实被带上了）' : '❌ 没有 401，无法证明直连入口带了 token'}`);
    console.log(`    加速入口的结果: ${out.sources ? `${out.sources.length} 条，入口=${JSON.stringify(via)}` : `失败 ${String(out.error).slice(0, 80)}`}`);
    console.log(`    判定: ${direct401 && accelOk ? '✅ 直连带凭据被拒 → 加速入口匿名成功（token 未外流给第三方代理）' : '⚠ 需要人工核对'}`);
  }

  // 401 不等于入口坏掉：凭据问题不能污染路由健康
  console.log('\n  [F2] 4xx（凭据/请求问题）不降级该入口');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 20000, routePolicy: 'direct-first' });
    const r = await callTool(cap, { query: 'wechat', engine: 'github', maxResults: 3 });
    const via = String(r.routes.github);
    console.log(`    刚发生过 401 之后，无 token 再查 github → 入口=${JSON.stringify(via)}`);
    console.log(`    判定: ${/直连 api\.github\.com/.test(via) ? '✅ 401 没有把直连入口降级' : '❌ 一次凭据错误污染了整个会话的路由顺序'}`);
  }

  // 并发首调用不得吞掉代理（缓存 promise，而不是缓存结果）
  console.log('\n  [F3] 组合引擎并发首调用时，代理仍然生效');
  {
    const cap = makeCtx({ proxyUrl: 'http://127.0.0.1:1', maxResults: 6, timeoutMs: 8000 });
    let n = 0;
    try {
      const r = await callTool(cap, { query: 'wechat', engine: 'repo', maxResults: 6 });
      n = r.sources.length;
      console.log(`    ❌ 黑洞代理下 repo 竟然返回了 ${n} 条 → 有并发分支绕过了代理`);
    } catch (e) {
      console.log(`    ✅ 按预期全部失败：${e.message.slice(0, 110)}`);
    }
    const bogus = cap.warns.filter((w) => /无法解析 undici/.test(w));
    console.log(`    「undici 不可用」误报: ${bogus.length ? `❌ ${bogus.length} 条（并发竞态）` : '✅ 无'}`);
  }

  // 工具输出必须能无损往返 JSON（宿主的硬性校验，v0.3.1 在这里翻过车）
  console.log('\n  [F4] 工具输出无损 JSON（notes 为空时不得留 undefined 键）');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 20000 });
    const r = await callTool(cap, { query: 'wechat', engine: 'npm', maxResults: 3 });
    console.log(`    成功路径（无 errors）键 = ${Object.keys(r).join(', ')}`);
    console.log(`    判定: ${'notes' in r ? '⚠ notes 仍在（应为空时省略）' : '✅ 空时不留 notes 键，可无损往返'}`);
    const bad = findUndefined(r);
    console.log(`    深度 undefined 扫描: ${bad.length ? '❌ ' + bad.join(', ') : '✅ 无'}`);
  }

  // 注册物 + 提示段
  console.log('\n  [注册物] mock ctx apply');
  {
    const cap = makeCtx({});
    console.log('    searchProvider id =', cap.search?.id, '| available =', cap.search?.available?.());
    console.log('    fetchProvider  id =', cap.fetch?.id, '| available =', cap.fetch?.available?.());
    console.log('    工具 =', cap.tools.map((x) => x.name).join(', '));
    console.log('    提示段 =', cap.sections.map((s) => `${s.name}(order:${s.order})`).join(', '));
    console.log('    settings ns =', cap.settings?.ns, '| hasSchema =', cap.settings?.hasSchema);
    console.log('\n    --- 提示段全文 ---');
    console.log(cap.sections[0]?.text?.() ?? '(无)');
  }
}

/* ------------------------------------------------------------ D. 镜像 */

if (run('mirror')) {
  console.log('\n########## D. GitHub 加速镜像分支 ##########');
  const cap = makeCtx({ timeoutMs: 12000 });

  // 直连可达的正常路径 → via 应为空
  try {
    const r = await cap.fetch.fetch({ url: 'https://raw.githubusercontent.com/github/gitignore/main/Node.gitignore' });
    console.log(`  正常 raw 路径: statusCode=${r.statusCode} 字符=${r.body.content.length} note=${JSON.stringify(r.body.note ?? null)}`);
  } catch (e) { console.log('  正常 raw 路径 FAIL:', e.message.slice(0, 120)); }

  // 直连 404 → 应触发镜像分支（错误信息里能看到镜像名）
  try {
    const r = await cap.fetch.fetch({ url: 'https://raw.githubusercontent.com/github/gitignore/main/__no_such_file__.txt' });
    console.log('  不存在的文件竟然成功了？', r.statusCode);
  } catch (e) {
    const hit = ['ghproxy.net', 'ghfast.top', 'gh-proxy.com'].filter((m) => e.message.includes(m));
    console.log(`  不存在路径 → ${hit.length} 个镜像被尝试（${hit.join(', ')}）→ 镜像分支${hit.length ? ' ✅ 已执行' : ' ❌ 未执行'}`);
    console.log(`  错误: ${e.message.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------ E. 路由模型 */

if (run('routes')) {
  console.log('\n########## E. 引擎 / 路由模型 ##########');

  // R1 别名 = 强制走某条路由，不新增引擎位
  console.log('\n  [R1] 别名 npmmirror → npm 的镜像入口（不是独立引擎）');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 25000 });
    const r = await callTool(cap, { query: 'wechat', engine: 'npmmirror', maxResults: 3 });
    console.log(`    engine=${r.engine} baseEngine=${r.baseEngine} routes=${JSON.stringify(r.routes)}`);
    console.log(`    条数=${r.sources.length} 首条=${r.sources[0]?.title?.slice(0, 50)}`);
    console.log(
      `    判定: ${r.baseEngine === 'npm' && /npmmirror/.test(JSON.stringify(r.routes)) ? '✅ 归一为 npm 并 pin 到 npmmirror 入口' : '❌ 未按别名语义执行'}`
    );
  }

  // R2 结果带 via
  console.log('\n  [R2] 结果携带实际入口');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 25000 });
    const r = await callTool(cap, { query: 'dsh plugin', engine: 'github', maxResults: 3 });
    const vias = [...new Set(r.sources.map((s) => s.via).filter(Boolean))];
    console.log(`    github 条数=${r.sources.length} 入口=${JSON.stringify(r.routes)}`);
    console.log(`    sources[].via = ${JSON.stringify(vias)}`);
    console.log(`    判定: ${vias.length ? '✅ 每条结果标注了实际入口' : '❌ 缺失 via'}`);
  }

  // R3 routePolicy 改变入口顺序
  console.log('\n  [R3] routePolicy=direct-first vs accel-first');
  for (const policy of ['direct-first', 'accel-first']) {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 25000, routePolicy: policy });
    try {
      const r = await callTool(cap, { query: 'wechat', engine: 'github', maxResults: 3 });
      console.log(`    ${policy.padEnd(13)} → 入口 = ${JSON.stringify(r.routes.github)}`);
    } catch (e) {
      console.log(`    ${policy.padEnd(13)} → 失败 ${e.message.slice(0, 90)}`);
    }
  }

  // R4 auto 策略：实测直连不可达的引擎冷启动就直接走镜像
  console.log('\n  [R4] routePolicy=auto（默认）→ huggingface 冷启动直接走镜像');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 20000 });
    const t0 = Date.now();
    try {
      const r = await callTool(cap, { query: 'wechat', engine: 'huggingface', maxResults: 3 });
      console.log(
        `    ${String(Date.now() - t0).padStart(6)}ms 入口=${JSON.stringify(r.routes.huggingface)} 条数=${r.sources.length}`
      );
      console.log(`    判定: ${/hf-mirror/.test(String(r.routes.huggingface)) && Date.now() - t0 < 8000 ? '✅ 没浪费时间在已知不可达的直连上' : '⚠ 检查策略是否生效'}`);
    } catch (e) {
      console.log(`    失败 ${e.message.slice(0, 130)}`);
    }
  }

  // R5 direct-first 强制先直连 → 真实回退 + 失败入口降级
  console.log('\n  [R5] routePolicy=direct-first → 直连超时后回退，且失败入口下次被排后');
  {
    const cap = makeCtx({ maxResults: 3, timeoutMs: 20000, routePolicy: 'direct-first' });
    for (let i = 1; i <= 2; i++) {
      const t0 = Date.now();
      try {
        const r = await callTool(cap, { query: 'wechat', engine: 'huggingface', maxResults: 3 });
        console.log(
          `    第${i}次: ${String(Date.now() - t0).padStart(6)}ms 入口=${JSON.stringify(r.routes.huggingface)} 条数=${r.sources.length} 首条=${r.sources[0]?.title?.slice(0, 40)}`
        );
      } catch (e) {
        console.log(`    第${i}次: ${Date.now() - t0}ms 失败 ${e.message.slice(0, 130)}`);
      }
    }
    console.log('    预期: 第1次先撞直连超时再落镜像；第2次失败过的直连入口被排到后面，明显更快');
  }

  // R6 repo 合并：成员是逻辑源，不重复
  console.log('\n  [R6] repo 多源合并的成员是逻辑源');
  {
    const cap = makeCtx({ maxResults: 8, timeoutMs: 25000 });
    const r = await callTool(cap, { query: 'wechat', engine: 'repo', maxResults: 8 });
    const used = r.usedEngines || [];
    console.log(`    合并来源 = ${used.join(' + ')}`);
    console.log(`    去重检查 = ${new Set(used).size === used.length ? '✅ 无重复源' : '❌ 有源重复出现'}`);
    console.log(`    各源入口 = ${JSON.stringify(r.routes)}`);
    console.log(`    条数=${r.sources.length}`);
  }
}

console.log('\n=== 完成 ===');
