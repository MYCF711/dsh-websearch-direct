// Offline smoke test: drives the plugin's real apply() through a fake ctx.
import { apply } from './dist/index.js';

function makeCtx() {
  const p = {};
  return {
    p,
    ctx: {
      web: {
        registerSearchProvider(x) { p.search = x; return () => {}; },
        registerFetchProvider(x) { p.fetch = x; return () => {}; },
      },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      inject() {},
      logger: () => ({ warn: (m) => console.log('   [warn]', m) }),
    },
  };
}

function clearProxy() {
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
}

async function run(label, config, query) {
  console.log(`\n===== ${label} =====`);
  const { ctx, p } = makeCtx();
  apply(ctx, config);
  console.log('available(search) =', p.search.available());
  console.log('available(fetch)  =', p.fetch.available());
  try {
    const r = await p.search.search({ query });
    console.log(`sources = ${r.sources.length}, content chars = ${r.content.length}`);
    r.sources.slice(0, 3).forEach((s, i) => {
      console.log(`  [${i + 1}] ${s.title.slice(0, 60)}`);
      console.log(`      ${s.url.slice(0, 90)}`);
      if (s.snippet) console.log(`      ${s.snippet.slice(0, 90)}`);
    });
    return r.sources[0]?.url;
  } catch (e) {
    console.log('SEARCH FAILED:', e.message);
    return null;
  }
}

// --- scenario 1: direct connection, exactly what dsh has (no proxy vars) ---
clearProxy();
const firstUrl = await run('直连 / 无代理（等同 dsh 运行环境）', { proxyUrl: '' }, 'DeepSeek 最新模型');

// --- scenario 2: through a proxy (only if the host exposes one) ---
const savedProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (savedProxy) {
  await run(`走代理 ${savedProxy}`, { proxyUrl: savedProxy, engineOrder: ['duckduckgo', 'bing'] }, 'deepseek latest model');
} else {
  console.log('\n===== 走代理 =====\n(当前 shell 无代理变量，跳过)');
}

// --- scenario 3: fetch a page body ---
if (firstUrl) {
  console.log('\n===== web_fetch =====');
  const { ctx, p } = makeCtx();
  apply(ctx, { proxyUrl: '' });
  try {
    const r = await p.fetch.fetch({ url: firstUrl });
    console.log(`url=${r.url}`);
    console.log(`chars=${r.body.content.length} truncated=${r.truncated}`);
    console.log('preview:', r.body.content.slice(0, 200).replace(/\s+/g, ' '));
  } catch (e) {
    console.log('FETCH FAILED:', e.message);
  }
}
