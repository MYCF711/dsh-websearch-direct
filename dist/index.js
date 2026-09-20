/**
 * dsh-websearch-direct — v0.3
 *
 * A zero-API-key web search / fetch provider for DeepSeek Harness (dsh).
 *
 * Why this exists: the stock `deepseek-official` channel burns a full model
 * round-trip per search and requires DEEPSEEK_API_KEY, while the popular
 * `web-search-free` plugin needs keys for endpoints that are almost all
 * hosted overseas — from a machine with no proxy those calls intermittently
 * time out ("sometimes it can't reach the network"). This plugin talks to
 * search endpoints that resolve over a plain direct connection and optionally
 * routes through a user-supplied proxy, so the agent gets a working
 * `web_search` / `web_fetch` with nothing to configure.
 *
 * v0.2 added engine awareness (a `github` engine, code-intent auto-routing,
 * and the `web_search_engine` tool).
 *
 * v0.3 turns "code search" from a single source into a group:
 *   - repo engines: github / gitlab / codeberg / gitea / gitee(需 token)
 *   - package engines: npm / crates / packagist / nuget / rubygems / maven /
 *     huggingface
 *   - composite engines `repo` and `pkg` fan out in PARALLEL and round-robin
 *     merge, so one host cannot dominate the answer the way github-only did
 *   - GitHub fetch mirror fallback (ghproxy.net / ghfast.top / gh-proxy.com)
 *     for raw.githubusercontent.com and github.com URLs
 *   - fixes found by the v0.2 trial report: silent proxyUrl death (bare
 *     `import('undici')` could not resolve under a junction install, AND a
 *     cross-instance `ProxyAgent` is rejected by the global fetch — see the
 *     proxy note below), `engineOrder` losing its fallback when every entry was
 *     invalid, loose `enableFetch` parsing, and a silent ignore of an unknown
 *     engine hint at the seam layer.
 *
 * v0.3.1 replaces "one engine = one hardcoded URL" with an explicit
 * engine/route split:
 *
 *   引擎 = 逻辑源（一份仓库、一个包生态、一个搜索引擎）
 *   路由 = 指向同一份内容的入口：直连 / 镜像 / 加速代理 / 第三方索引
 *
 * A mirror of the same repository is NOT a second engine. `github` appears once
 * in the engine list; `api.github.com`, `gh-proxy.com`, `gh-proxy.org` and
 * `cors.isteed.cc` are routes underneath it, tried in order with per-route
 * health demotion. Every route's UA is carried on the route, because
 * availability is header-sensitive in ways that are not guessable: Codeberg's
 * WAF answers 403 to a *complete browser* UA (even on /api/v1/version) and 200
 * to an honest bot UA, while Bing wants the browser UA. Routes that were
 * measured dead are recorded in each engine's `rejected` field instead of being
 * silently retried forever.
 *
 * Retrieval only — no LLM is involved, so searches cost zero model tokens.
 *
 * Dependency policy: every @deepseek-ai import is optional and guarded. The
 * plugin keeps working (basic search + fetch) even if a dsh upgrade removes
 * or renames an API, which is exactly how sibling plugins break.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';

/**
 * Where to look for our own optional dependencies.
 *
 * `import('@deepseek-ai/x')` resolves from the importing FILE's directory, which
 * is right for a normal install (`profiles/<p>/node_modules/<pkg>/`) but fails
 * for a linked, junctioned or mounted plugin — and a silent failure here
 * cascades, because a missing `schema` is not the same as a missing feature
 * (see `Config` below), and a missing `undici` silently kills `proxyUrl`.
 *
 * Order: the plugin's own location, then the working directory, then the
 * profile that is actually booting (read from argv) and its shared
 * `node_modules`. Every candidate is optional; the first one that resolves wins.
 */
function resolutionBases() {
  const bases = [import.meta.url];
  const push = (path) => {
    try {
      bases.push(pathToFileURL(path).href);
    } catch {
      /* ignore a candidate we cannot even turn into a URL */
    }
  };
  push(join(process.cwd(), '_'));

  const home = process.env.DSH_HOME;
  const argv = process.argv;
  const at = argv.indexOf('--profile');
  const profile = at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('-') ? argv[at + 1] : null;
  if (home && profile) push(join(home, 'profiles', profile, '_'));
  if (home) push(join(home, 'profiles', 'node_modules', '_'));
  return bases;
}

const BASES = resolutionBases();

/** Import a peer we can live without. Returns null when no candidate resolves. */
async function optionalImport(spec) {
  for (const base of BASES) {
    try {
      const resolved = createRequire(base).resolve(spec);
      return await import(pathToFileURL(resolved).href);
    } catch {
      /* try the next base */
    }
  }
  return null;
}

let Schema = null;
let defineTool = null;
{
  const schemastery = await optionalImport('@deepseek-ai/schemastery');
  Schema = schemastery?.default ?? null;
  const tools = await optionalImport('@deepseek-ai/dsh-tools');
  defineTool = tools?.defineTool ?? null;
}

export const name = 'websearch-direct';
export const inject = ['web'];
export const SETTINGS_NAMESPACE = 'websearch-direct';

/* ----------------------------------------------------------- engine meta */

/* ------------------------------------------------------------ UA / 常量 */

/**
 * 两套 UA，因为实测结果是分裂的：
 *
 *   · API 端点（codeberg、crates.io、GitHub…）要一个「自报家门」的 UA。
 *     Codeberg 的 WAF 会专门拦完整浏览器 UA —— 连 /api/v1/version 都回 403，
 *     而同一个请求换成 bot UA 就是 200。crates.io 反过来拦 curl 的默认 UA。
 *     bot UA 在两端都是 200，且它是诚实的。
 *   · 网页搜索（Bing / 百度）要浏览器 UA，否则可能被当成爬虫。
 *
 * 所以 UA 挂在**路由**上而不是插件上：同一份内容换个入口，头就该跟着换。
 */
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';
const UA_BOT = 'dsh-websearch-direct/0.3 (+https://workbuddy.cn)';

/* ----------------------------------------------------- 引擎 = 逻辑源 + 路由 */

/**
 * 引擎 = 逻辑源（一份仓库 / 一个包生态 / 一个搜索引擎）。
 * 路由 = 指向同一份内容的入口：直连、镜像、加速代理、第三方索引。
 *
 * 一个源只占一个引擎位。`github` 只出现一次，`api.github.com`、
 * `gh-proxy.com`、`gh-proxy.org` 都是它下面的路由 —— 同一份仓库的镜像
 * 不会在引擎列表里重复出现，也不会在 `repo` 合并里被当成两个源。
 *
 * tier 是路由的实测性质，不是猜测：
 *   0  直连 / 权威端点
 *   1  镜像 / 加速代理（内容等价，改的只是访问路径）
 *   2  第三方索引（内容来自目标源，由第三方站点搬运，可能滞后）
 *       —— 这一档目前的候选全部没过「换个查询词结果会变」的内容校验，见 rejected
 *
 * 下表的 routes 只放**实测可用**的入口（2026-09，本机直连 + HTTP 代理双路验证）。
 * 实测不可用的候选一律不占位，统一记在每个引擎的 `rejected` 里 ——
 * 免得下次有人再花一轮去试同一个死链。
 */
const ENGINES_META = {
  github: {
    label: 'GitHub',
    group: 'repo',
    what: '代码仓库与开源项目（按 star 排序）',
    useWhen: '找开源项目、库、框架、SDK、CLI、插件源码；对比同类实现；查某个项目有多少 star / 是否活跃',
    token: 'githubToken',
    accept: 'application/vnd.github+json',
    search: (r, q, n) =>
      `${r.base}/search/repositories?q=${encodeURIComponent(q)}&per_page=${n}&sort=stars&order=desc`,
    pick: (d) => {
      if (d.message && !d.items) throw new Error(`GitHub API: ${d.message}`);
      return (d.items || []).map((it) =>
        repoItem({
          url: it.html_url,
          name: it.full_name,
          stars: it.stargazers_count,
          desc: it.description,
          lang: it.language,
          updated: it.pushed_at,
          extra: it.topics?.length ? `topics: ${it.topics.slice(0, 5).join(', ')}` : '',
        })
      );
    },
    routes: [
      { label: '直连 api.github.com', base: 'https://api.github.com', tier: 0 },
      { label: 'gh-proxy.com 加速', base: 'https://gh-proxy.com/https://api.github.com', tier: 1 },
      { label: 'gh-proxy.org 加速', base: 'https://gh-proxy.org/https://api.github.com', tier: 1 },
      { label: 'cors.isteed.cc 加速', base: 'https://cors.isteed.cc/https://api.github.com', tier: 1 },
    ],
    rejected:
      'ghproxy.net / ghfast.top（只代理 raw 文件，代 API 一律 403）；' +
      'kkgithub.com、gh.llkk.cc、gitclone.com、hub.gitmirror.com、ghps.cc、gh.api.99988866.xyz、' +
      'ghp.ci、mirror.ghproxy.com、ghproxy.cc、ghproxy.homeboyc.cn、cors.eu.org、api.codetabs.com、' +
      'api.allorigins.win（实测均失败或返回非 JSON）；' +
      'repos.ecosyste.ms（HTTP 200、JSON 结构也合法，但 **完全忽略查询参数** —— ' +
      'query/q/search/加排序四种写法返回同一个固定列表，全是 "0/..." 这种垃圾仓库。' +
      '这条特别值得记：200 不等于可用，可用性探测必须验证「换个查询词结果会变」）',
  },
  gitlab: {
    label: 'GitLab',
    group: 'repo',
    what: 'GitLab.com 上的公开项目',
    useWhen: 'GitHub 上找不到、或想找只在 GitLab 托管的项目与从自建实例迁移过来的项目',
    accept: 'application/json',
    search: (r, q, n) =>
      `${r.base}/projects?search=${encodeURIComponent(q)}&order_by=star_count&sort=desc&per_page=${n}`,
    pick: (d) => {
      if (!Array.isArray(d)) throw new Error('GitLab 返回结构异常');
      return d
        .filter((it) => it && it.web_url)
        .map((it) =>
          repoItem({
            url: it.web_url,
            name: it.path_with_namespace || it.name,
            stars: it.star_count,
            desc: it.description,
            lang: it.language,
            updated: it.last_activity_at,
          })
        );
    },
    routes: [{ label: '直连 gitlab.com', base: 'https://gitlab.com/api/v4', tier: 0 }],
    rejected:
      'framagit.org（TLS/网络不可达）；salsa.debian.org、invent.kde.org、gitlab.gnome.org（可达但搜索域只覆盖各自项目库，通用关键词命中率近 0，收录只会白增延迟）',
  },
  codeberg: {
    label: 'Codeberg',
    group: 'repo',
    what: 'Codeberg（非营利代码托管，Gitea 内核）',
    useWhen: '找无商业托管的开源项目、隐私友好的替代实现；结果独立于 GitHub',
    accept: 'application/json',
    search: (r, q, n) =>
      `${r.base}/repos/search?q=${encodeURIComponent(q)}&sort=stars&order=desc&limit=${n}`,
    pick: (d) => giteaPick(d, 'Codeberg'),
    routes: [
      {
        // 必须用 bot UA：完整浏览器 UA 会被 WAF 403（实测 /api/v1/version 同样 403）
        label: '直连 codeberg.org',
        base: 'https://codeberg.org/api/v1',
        tier: 0,
        ua: 'bot',
      },
    ],
  },
  gitea: {
    label: 'Gitea.com',
    group: 'repo',
    what: 'Gitea 官方托管站上的公开仓库',
    useWhen: '找自托管生态（Gitea / Forgejo）相关项目与插件',
    accept: 'application/json',
    search: (r, q, n) =>
      `${r.base}/repos/search?q=${encodeURIComponent(q)}&sort=stars&order=desc&limit=${n}`,
    pick: (d) => giteaPick(d, 'Gitea'),
    routes: [{ label: '直连 gitea.com', base: 'https://gitea.com/api/v1', tier: 0 }],
  },
  gitee: {
    label: 'Gitee 码云',
    group: 'repo',
    what: '国内代码托管（中文项目、国内团队作品）',
    useWhen: '找国内开源项目、国产替代方案、中文文档为主的仓库',
    token: 'giteeToken',
    accept: 'application/json',
    search: (r, q, n, o) =>
      `${r.base}/search/repositories?q=${encodeURIComponent(q)}&per_page=${n}` +
      `&access_token=${encodeURIComponent(o.giteeToken)}`,
    pick: (d) => {
      if (!Array.isArray(d)) throw new Error('Gitee 返回结构异常（token 是否有效？）');
      return d.map((it) =>
        repoItem({
          url: it.html_url,
          name: it.full_name,
          stars: it.stargazers_count,
          desc: it.description,
          lang: it.language,
          updated: it.updated_at || it.pushed_at,
        })
      );
    },
    routes: [{ label: '直连 gitee.com', base: 'https://gitee.com/api/v5', tier: 0 }],
    note:
      '搜索 API 必须带访问令牌：匿名访问返回 200 + 空数组，看起来像「没有结果」。' +
      '未配置 giteeToken 时该引擎被自动跳过，不会污染 repo 的合并结果。',
  },
  npm: {
    label: 'npm',
    group: 'pkg',
    what: 'npm 包（Node / JS / TS 生态）',
    useWhen: '找 JS/TS 库与 CLI 工具、查包名是否被占用、看包版本与发布时间',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}/-/v1/search?text=${encodeURIComponent(q)}&size=${n}`,
    pick: (d, route) =>
      (d.objects || []).map((o) => {
        const p = o.package || {};
        return pkgItem({
          url: `${route.web}/package/${p.name}`,
          name: p.name,
          version: p.version,
          downloads: o.downloads?.monthly ?? o.score?.detail?.popularity ?? null,
          desc: p.description,
          extra: p.date ? `发布: ${String(p.date).slice(0, 10)}` : '',
        });
      }),
    routes: [
      { label: '直连 registry.npmjs.org', base: 'https://registry.npmjs.org', tier: 0, web: 'https://www.npmjs.com' },
      { label: 'npmmirror 镜像', base: 'https://registry.npmmirror.com', tier: 1, web: 'https://npmmirror.com' },
      { label: '腾讯云镜像', base: 'https://mirrors.cloud.tencent.com/npm', tier: 1, web: 'https://www.npmjs.com' },
    ],
    rejected: 'mirrors.huaweicloud.com/repository/npm（返回结构不是 npm search 格式）',
    note: 'npmmirror 只是 npm 的一条镜像路由，内容与 npm 一致，因此不再单独占一个引擎 id；' +
      '仍然可以写 engine="npmmirror" 强制走这条路由。',
  },
  crates: {
    label: 'crates.io',
    group: 'pkg',
    what: 'Rust crate',
    useWhen: '找 Rust 库、查 crate 下载量与版本',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}?q=${encodeURIComponent(q)}&per_page=${n}`,
    pick: (d) =>
      (d.crates || []).map((c) =>
        pkgItem({
          url: `https://crates.io/crates/${c.name}`,
          name: c.name,
          version: c.max_version,
          downloads: c.downloads,
          desc: c.description,
          extra: c.repository || '',
        })
      ),
    routes: [
      { label: '直连 crates.io', base: 'https://crates.io/api/v1/crates', tier: 0 },
      { label: 'rsproxy.cn 加速', base: 'https://rsproxy.cn/api/v1/crates', tier: 1 },
    ],
    rejected: 'mirrors.ustc.edu.cn（404）、mirrors.tuna.tsinghua.edu.cn（403）—— 两站只镜像 crate 下载，不提供搜索 API',
  },
  packagist: {
    label: 'Packagist',
    group: 'pkg',
    what: 'PHP Composer 包',
    useWhen: '找 PHP 库与框架组件',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}/search.json?q=${encodeURIComponent(q)}&per_page=${n}`,
    pick: (d) =>
      (d.results || []).map((x) =>
        pkgItem({
          url: `https://packagist.org/packages/${x.name}`,
          name: x.name,
          downloads: x.downloads,
          desc: x.description,
          extra: x.repository || '',
        })
      ),
    routes: [{ label: '直连 packagist.org', base: 'https://packagist.org', tier: 0 }],
    rejected: 'mirrors.aliyun.com/composer（404，只镜像下载不提供搜索）',
  },
  nuget: {
    label: 'NuGet',
    group: 'pkg',
    what: '.NET 包',
    useWhen: '找 C# / .NET 库',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}/query?q=${encodeURIComponent(q)}&take=${n}`,
    pick: (d) =>
      (d.data || []).map((p) =>
        pkgItem({
          url: `https://www.nuget.org/packages/${p.id}`,
          name: p.id,
          version: p.version,
          downloads: p.totalDownloads,
          desc: p.description,
          extra: p.projectUrl || '',
        })
      ),
    routes: [
      { label: '直连 azuresearch-usnc', base: 'https://azuresearch-usnc.nuget.org', tier: 0 },
      { label: 'azuresearch-ussc 备用', base: 'https://azuresearch-ussc.nuget.org', tier: 1 },
    ],
    rejected: 'api.nuget.org/v3/query（404）、nuget.cdn.azure.cn（不可达）',
  },
  rubygems: {
    label: 'RubyGems',
    group: 'pkg',
    what: 'Ruby gem',
    useWhen: '找 Ruby 库与 Rails 相关组件',
    accept: 'application/json',
    search: (r, q) => `${r.base}/search.json?query=${encodeURIComponent(q)}`,
    pick: (d, _route, opts) => {
      const arr = Array.isArray(d) ? d : [];
      return arr.slice(0, opts.maxResults).map((g) =>
        pkgItem({
          url: `https://rubygems.org/gems/${g.name}`,
          name: g.name,
          version: g.version,
          downloads: g.downloads,
          desc: g.info,
          extra: g.homepage_uri || '',
        })
      );
    },
    routes: [{ label: '直连 rubygems.org', base: 'https://rubygems.org/api/v1', tier: 0 }],
    rejected: 'mirrors.tuna.tsinghua.edu.cn/rubygems（403，只镜像下载）',
  },
  maven: {
    label: 'Maven Central',
    group: 'pkg',
    what: 'Maven Central 上的 Java / JVM 构件',
    useWhen: '找 Java / Kotlin / Scala 库与框架组件',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}/select?q=${encodeURIComponent(q)}&rows=${n}&wt=json`,
    pick: (d) =>
      ((d.response && d.response.docs) || []).map((x) => {
        const [g, a] = String(x.id || '').split(':');
        return pkgItem({
          url: g && a ? `https://central.sonatype.com/artifact/${g}/${a}` : `https://search.maven.org/#search|ga|1|${x.id}`,
          name: x.id,
          version: x.latestVersion,
          downloads: null,
          desc: 'Maven Central 构件（groupId:artifactId）',
          extra: x.p || '',
        });
      }),
    routes: [{ label: '直连 search.maven.org', base: 'https://search.maven.org/solrsearch', tier: 0 }],
    rejected: 'central.sonatype.com/api/internal/browse（405，内部接口不外放）',
  },
  huggingface: {
    label: 'HuggingFace',
    group: 'pkg',
    what: 'HuggingFace 模型与数据集',
    useWhen: '找预训练模型、数据集、微调权重；确认某个模型是否存在及其下载量',
    accept: 'application/json',
    search: (r, q, n) => `${r.base}/api/models?search=${encodeURIComponent(q)}&limit=${n}&full=false`,
    pick: (d) =>
      (Array.isArray(d) ? d : []).map((m) =>
        pkgItem({
          url: `https://huggingface.co/${m.id}`,
          name: m.id,
          version: null,
          downloads: m.downloads,
          desc: (m.tags || []).filter((t) => !/^(transformers|pytorch|tf|safetensors|arxiv:)/.test(t)).slice(0, 6).join(', '),
          extra: m.likes != null ? `♥${m.likes}` : '',
        })
      ),
    routes: [
      { label: 'hf-mirror.com 加速', base: 'https://hf-mirror.com', tier: 1 },
      { label: '直连 huggingface.co', base: 'https://huggingface.co', tier: 0 },
    ],
    // 实测本机直连 huggingface.co 不可达。默认 direct-first 会让每次冷启动的
    // pkg 搜索白白多等一次超时（实测 16s），所以这个引擎默认先走镜像。
    preferAccel: true,
    note:
      '本机直连 huggingface.co 不可达，默认先走 hf-mirror.com 镜像（实测可用）；' +
      '仍可写 engine="hf-mirror" 显式指定该路由，或用 routePolicy=direct-first 强制先直连。',
  },
  bing: {
    label: 'Bing 中国',
    group: 'web',
    what: '通用网页搜索',
    useWhen:
      '技术文档、教程、新闻、产品官网、报错信息——中英文通用，默认引擎' +
      '（Edge 浏览器的默认搜索引擎同为 Bing，二者等价）',
    html: true,
    ua: 'browser',
    search: (r, q) => `${r.base}/search?q=${encodeURIComponent(q)}&ensearch=0&count=20`,
    pick: (html, _route, opts) => parseBing(html, opts),
    routes: [
      { label: 'cn.bing.com', base: 'https://cn.bing.com', tier: 0 },
      { label: 'www.bing.com 备用', base: 'https://www.bing.com', tier: 1 },
    ],
  },
  baidu: {
    label: '百度',
    group: 'web',
    what: '中文网页搜索',
    useWhen: '纯中文内容、国内站点、百科、问答、论坛帖',
    html: true,
    ua: 'browser',
    search: (r, q) => `${r.base}/s?wd=${encodeURIComponent(q)}&rn=20`,
    pick: (html, _route, opts) => parseBaidu(html, opts),
    routes: [{ label: 'www.baidu.com', base: 'https://www.baidu.com', tier: 0 }],
    rejected: 'm.baidu.com（移动版结构不同且同样有反爬校验，收录无收益）',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    group: 'web',
    what: '英文隐私搜索',
    useWhen: '英文资料且不希望被追踪；本机实测两个入口均不可达，故排在顺序末位',
    html: true,
    ua: 'browser',
    direct: false,
    search: (r, q) => `${r.base}${r.path || ''}?q=${encodeURIComponent(q)}`,
    pick: (html, _route, opts) => parseDdg(html, opts),
    routes: [
      { label: 'html.duckduckgo.com', base: 'https://html.duckduckgo.com', path: '/html/', tier: 0 },
      { label: 'lite.duckduckgo.com', base: 'https://lite.duckduckgo.com', path: '/lite/', tier: 1 },
    ],
  },
  repo: {
    label: '代码仓库（多源合并）',
    group: 'composite',
    what: '并行查询配置里的所有代码托管源（默认 GitHub + GitLab + Codeberg + Gitea；配了 Gitee 令牌还会带上码云），按来源轮转合并',
    useWhen: '默认的代码/仓库意图入口。想要多源覆盖而不是只看 GitHub 时用它；想只看某一个源就显式指定该引擎',
  },
  pkg: {
    label: '包仓库（多源合并）',
    group: 'composite',
    what: '并行查询配置里的所有包仓库源（默认 npm + crates.io + Packagist + NuGet + RubyGems + Maven Central + HuggingFace）',
    useWhen: '默认的依赖包意图入口。跨语言找库、比较同类包、确认包名与最新版本',
  },
};

const REPO_ENGINES = ['github', 'gitlab', 'codeberg', 'gitea', 'gitee'];
const PKG_ENGINES = ['npm', 'crates', 'packagist', 'nuget', 'rubygems', 'maven', 'huggingface'];
const WEB_ENGINES = ['bing', 'baidu', 'duckduckgo'];
const COMPOSITE_ENGINES = ['repo', 'pkg'];
const ENGINE_IDS = [...REPO_ENGINES, ...PKG_ENGINES, ...WEB_ENGINES, ...COMPOSITE_ENGINES];

/**
 * 路由别名。旧版本里 npmmirror 是一个独立引擎，但它和 npm 查的是同一份包数据，
 * 只是访问路径不同 —— 按「同一个源只占一个引擎位」的原则，它降级成 npm 的一条路由。
 * 旧写法仍然能用，只是现在语义是「强制走这条路由」。
 */
const ENGINE_ALIASES = {
  npmmirror: { engine: 'npm', route: 'npmmirror' },
  'npm-mirror': { engine: 'npm', route: 'npmmirror' },
  'hf-mirror': { engine: 'huggingface', route: 'hf-mirror' },
  'gh-proxy': { engine: 'github', route: 'gh-proxy.com' },
  ghproxy: { engine: 'github', route: 'gh-proxy.com' },
  'github-mirror': { engine: 'github', route: 'gh-proxy.com' },
};
const ALL_ENGINE_IDS = [...ENGINE_IDS, ...Object.keys(ENGINE_ALIASES)];

/** 别名 → 真实引擎 id；原名照旧返回。 */
function baseEngineId(id) {
  return ENGINE_ALIASES[id]?.engine || id;
}

/** 别名指定的路由匹配串（用于把路由表过滤成一条）。 */
function pinnedRoute(id) {
  return ENGINE_ALIASES[id]?.route || null;
}

/**
 * Intent routing. Deliberately narrow: routing a normal question to a code
 * host would be worse than not routing at all, so only clear signals count.
 * Package-manager vocabulary is split out so "npm registry 镜像" lands on the
 * package group instead of on a repo host.
 */
const PKG_INTENT =
  /(\bnpm\b|\bpnpm\b|\byarn\b|\bpip\b|\bpypi\b|\bcargo\b|\bcrates?\b|\bmaven\b|\bgradle\b|\bnuget\b|\bgems?\b|rubygems|packagist|composer|\bgo mod\b|包管理|依赖包|第三方库)/i;

const CODE_INTENT =
  /(github|gitlab|gitee|codeberg|gitea|gitcode|\bgit\b|\brepos?\b|repositor|开源|源码|源代码|代码库|仓库|插件仓库|dsh[- _]?plugin|\blibrar|\bframework\b|\bsdk\b|\bcli\b)/i;

const DEFAULTS = {
  proxyUrl: '',
  engineOrder: ['bing', 'baidu', 'duckduckgo'],
  autoRoute: true,
  githubToken: '',
  giteeToken: '',
  enableGithubMirrors: true,
  routePolicy: 'auto',
  repoEngines: ['github', 'gitlab', 'codeberg', 'gitea', 'gitee'],
  // maven 故意不在默认成员里：search.maven.org 从本机实测极不稳定（同一个 UA
  // 一次 200 / 一次 15s 超时，三轮里成功约 1/3），放进组合只会稳定拖慢每一次
  // pkg 搜索。引擎本身保留，需要时用 engine="maven" 或加进 pkgEngines。
  pkgEngines: ['npm', 'crates', 'packagist', 'nuget', 'rubygems', 'huggingface'],
  maxResults: 8,
  timeoutMs: 15000,
  compositeMemberMs: 12000,
  fetchMaxChars: 20000,
  enableFetch: true,
};

export const Config = Schema
  ? Schema.object({
      proxyUrl: Schema.string().default('').description(
        '代理地址，留空则直连。例如 http://127.0.0.1:7890（Clash 默认端口）。' +
        '海外引擎（DuckDuckGo）在直连环境下通常不可达，填了代理才会被真正用到。'
      ),
      engineOrder: Schema.array(Schema.union(ALL_ENGINE_IDS))
        .default(DEFAULTS.engineOrder)
        .description('搜索引擎轮询顺序。代码/依赖类查询会先走 repo / pkg 多源合并，再按这里的顺序兜底。'),
      autoRoute: Schema.boolean().default(true).description(
        '自动路由：识别到依赖包意图 → pkg，代码/仓库/插件意图 → repo（均为多源合并）。关闭后一律按 engineOrder 顺序。'
      ),
      githubToken: Schema.string().default('').description(
        '可选的 GitHub Token，仅用于提高 api.github.com 的搜索频率上限（匿名约 10 次/分钟）。' +
        '留空则匿名访问，也支持环境变量 GITHUB_TOKEN。'
      ),
      giteeToken: Schema.string().default('').description(
        'Gitee 访问令牌。Gitee 的搜索 API 现在要求令牌，未配置时 gitee 引擎会被自动跳过' +
        '（其他代码源不受影响）。也支持环境变量 GITEE_TOKEN。'
      ),
      enableGithubMirrors: Schema.boolean().default(true).description(
        '抓取 raw.githubusercontent.com / github.com 失败时，自动改用 GitHub 加速镜像重试' +
        '（ghproxy.net / ghfast.top / gh-proxy.com）。国内网络下能显著提高成功率。'
      ),
      routePolicy: Schema.union(['auto', 'direct-first', 'accel-first'])
        .default('auto')
        .description(
          '同一个源的多个入口谁先试。auto（默认）：按引擎实测情况决定 —— 直连可用就先直连，' +
          '本机实测直连不可达的引擎（如 HuggingFace）先走镜像；direct-first：一律先直连；' +
          'accel-first：一律先走镜像/加速。第三方索引入口在任何策略下都排最后。' +
          '无论哪种顺序，本次会话里失败过的入口都会被自动排到后面。'
        ),
      repoEngines: Schema.array(Schema.union(ALL_ENGINE_IDS))
        .default(DEFAULTS.repoEngines)
        .description('repo 多源合并包含哪些代码托管源。可增删（设成空数组则回退内置默认）。'),
      pkgEngines: Schema.array(Schema.union(ALL_ENGINE_IDS))
        .default(DEFAULTS.pkgEngines)
        .description('pkg 多源合并包含哪些包仓库源。可增删（设成空数组则回退内置默认）。'),
      maxResults: Schema.number().default(DEFAULTS.maxResults).description('每次搜索返回的结果条数。'),
      timeoutMs: Schema.number().default(DEFAULTS.timeoutMs).description('单个 HTTP 请求的超时时间（毫秒）。'),
      fetchMaxChars: Schema.number().default(DEFAULTS.fetchMaxChars).description('抓取网页时正文的最大字符数。'),
      enableFetch: Schema.boolean().default(true).description('是否允许模型调用 web_fetch 抓取 URL 正文。'),
    })
  : undefined;

/*
 * When schemastery is unavailable we export NO schema at all, rather than a
 * plain defaults object. Cordis does `if (!runtime.Config) return config`, then
 * `runtime.Config['~standard'].validate(...)` — so a hand-rolled object without
 * the Standard Schema marker makes `.validate` a method call on undefined and
 * takes the ENTIRE plugin tree down, which is the opposite of degrading.
 * `undefined` means "no schema", the config passes through untouched, and
 * `apply` below merges DEFAULTS itself.
 */

/* ------------------------------------------------------------------ utils */

/** 路由没指定 ua 时的默认值（UA_BROWSER / UA_BOT 定义在文件顶部）。 */
const UA = UA_BROWSER;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Strict falsy parsing — `'false'`, `'0'`, `'no'`, `'off'` all count as off. */
function isOff(v) {
  if (v === false || v === 0) return true;
  if (typeof v === 'string') return ['false', '0', 'no', 'off', ''].includes(v.trim().toLowerCase());
  return false;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.max(Math.round(n), lo), hi);
}

/**
 * Proxy plumbing.
 *
 * Two separate traps live here, and v0.2 fell into both:
 *
 *  1. `import('undici')` is a BARE specifier, so it resolves from the plugin
 *     file's physical location. Under a junction / symlink install the parent
 *     chain has no `node_modules`, resolution fails, the failure was swallowed,
 *     and `proxyUrl` silently did nothing. We now resolve through the same
 *     multi-base chain as our other peers and WARN once when we cannot.
 *
 *  2. A `ProxyAgent` built from a *separately installed* undici cannot be handed
 *     to the global `fetch`, which uses Node's internal undici copy — the
 *     request dies with a bare `TypeError: fetch failed`. Measured directly:
 *
 *       undici.fetch(url, { dispatcher: new undici.ProxyAgent(p) })  → 200
 *       globalThis.fetch(url, { dispatcher: sameAgent })             → TypeError
 *
 *     So when a proxy is in play we ALSO take the `fetch` implementation from
 *     that same undici instance. Agent and fetch must come from one module.
 *
 * Deliberate non-feature: there is no silent "proxy failed → retry direct". A
 * configured proxy may exist precisely so traffic does NOT go out directly, and
 * quietly bypassing it would be worse than failing. Failures name the proxy.
 */
const NO_PROXY = () => ({ dispatcher: undefined, fetchImpl: null });

// The cache record doubles as the return value, so its dispatcher MUST be keyed
// `dispatcher`: `request()` destructures that name. Keying it `agent` — as an
// earlier revision did — makes every proxied call silently fall back to a direct
// connection, with no warning and no error. Verified by pointing proxyUrl at a
// black hole port: only a correctly shaped return value makes the request fail.
let cachedProxy = { proxyUrl: null, dispatcher: null, fetchImpl: null };

/**
 * 缓存的是 **Promise**，不是解析结果。
 *
 * 早先的写法是 `if (undiciTried) return undiciModule; undiciTried = true;
 * undiciModule = await optionalImport(...)` —— 组合引擎会并发发起请求，
 * 第一个调用刚置位 `undiciTried` 就 await 去了，另外几个并发调用立刻拿到
 * 还没赋值的 null，于是「undici 不存在」被当成结论，整条代理链静默失效。
 * 这个 bug 只在「一次搜索里并发多个 HTTP 请求」时才现形，串行测试永远抓不到。
 */
let undiciPromise = null;
let proxyWarned = false;
/** 同一个 proxyUrl 的首次构造也只做一次，避免并发调用各造一个 ProxyAgent。 */
let proxyBuild = { url: null, promise: null };

function getUndici() {
  if (!undiciPromise) undiciPromise = optionalImport('undici');
  return undiciPromise;
}

/** `{ dispatcher, fetchImpl }` — both undefined when there is nothing to proxy. */
async function resolveProxy(proxyUrl, logger) {
  if (!proxyUrl) return NO_PROXY();
  if (cachedProxy.proxyUrl === proxyUrl && cachedProxy.dispatcher) return cachedProxy;

  if (proxyBuild.url !== proxyUrl || !proxyBuild.promise) {
    proxyBuild = { url: proxyUrl, promise: buildProxy(proxyUrl, logger) };
  }
  const built = await proxyBuild.promise;
  if (built.dispatcher) cachedProxy = built;
  return built;
}

async function buildProxy(proxyUrl, logger) {
  const mod = await getUndici();
  const ProxyAgent = mod?.ProxyAgent ?? mod?.default?.ProxyAgent;
  const fetchImpl = mod?.fetch ?? mod?.default?.fetch ?? null;

  if (!ProxyAgent || !fetchImpl) {
    if (!proxyWarned) {
      proxyWarned = true;
      logger?.warn?.(
        `websearch-direct: 已配置 proxyUrl=${proxyUrl}，但无法解析 undici（ProxyAgent/fetch 不可用），` +
          '本次代理不会生效。修法：把 undici 装进插件所在的 node_modules，' +
          '或设置 NODE_USE_ENV_PROXY=1 让 Node 直接读取 HTTP(S)_PROXY 环境变量。'
      );
    }
    return NO_PROXY();
  }

  try {
    // Agent 和 fetch 必须来自同一个 undici 实例：跨实例的 ProxyAgent 会被
    // 全局 fetch 拒绝（TypeError: fetch failed）。见文件顶部的代理说明。
    const dispatcher = new ProxyAgent(proxyUrl);
    return { proxyUrl, dispatcher, fetchImpl };
  } catch (err) {
    if (!proxyWarned) {
      proxyWarned = true;
      logger?.warn?.(`websearch-direct: ProxyAgent 构造失败（${err.message}），代理不会生效。`);
    }
    return NO_PROXY();
  }
}

async function request(url, { proxyUrl, timeoutMs, signal, accept, ua, extraHeaders, logger } = {}) {
  const { dispatcher, fetchImpl } = await resolveProxy(proxyUrl, logger);
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      dispatcher,
      redirect: 'follow',
      headers: {
        'User-Agent': ua || UA,
        Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...extraHeaders,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    // Name the proxy: a bare "fetch failed" with a proxy in play is the least
    // diagnosable error this plugin can produce.
    if (proxyUrl && err?.name !== 'AbortError' && !/^HTTP \d/.test(String(err?.message))) {
      throw new Error(`经代理 ${proxyUrl} 请求失败: ${err.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** GET + JSON parse with a readable failure message. */
async function getJson(url, opts, what) {
  const raw = await request(url, { ...opts, accept: opts.accept || 'application/json' });
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${what} 返回非 JSON（可能被限流或拦截）`);
  }
  return data;
}

/* ------------------------------------------------------- web/html 解析器 */

/**
 * 这三个只负责「把 HTML 变成结果」，URL 拼接交给路由表。
 * 拆开是因为同一个搜索引擎可能有多个入口（cn.bing.com / www.bing.com、
 * html.duckduckgo.com / lite.duckduckgo.com），解析逻辑却是同一套。
 */

/** Bing 结果页：每条是 <li class="b_algo"> 块。 */
function parseBing(html, opts) {
  const out = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const m = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!m) continue;
    const url = decodeEntities(m[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ url, title: stripTags(m[2]), snippet: p ? stripTags(p[1]) : '' });
    if (out.length >= opts.maxResults) break;
  }
  return out;
}

/** 百度结果页：标题在 <h3 class="t"> 里，摘要散落在正文，靠 URL 位置回捞。 */
function parseBaidu(html, opts) {
  if (/百度安全验证|verify\.baidu|wappass\.baidu/i.test(html)) {
    throw new Error('百度返回了反爬验证页，该入口本轮不可用');
  }
  const out = [];
  const re = /<h3[^>]*class="[^"]*t[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < opts.maxResults) {
    const raw = decodeEntities(m[1]);
    if (!/^https?:\/\//i.test(raw)) continue;
    out.push({ url: raw, title: stripTags(m[2]), snippet: '' });
  }
  for (const item of out) {
    const idx = html.indexOf(item.url);
    if (idx === -1) continue;
    const tail = html.slice(idx, idx + 3000);
    const s = tail.match(/<span[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (s) item.snippet = stripTags(s[1]);
  }
  return out;
}

/**
 * DuckDuckGo 两个入口的标记不同：
 *   html.duckduckgo.com → a.result__a / a.result__snippet
 *   lite.duckduckgo.com → a.result-link
 * 用一套宽松解析同时覆盖，链接都要解 uddg= 跳转参数。
 */
function parseDdg(html, opts) {
  const out = [];
  const re =
    /<a[^>]+class="(?:result__a|result-link)"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="(?:result__a|result-link)"|$)/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < opts.maxResults) {
    let url = decodeEntities(m[1]);
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snip = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({ url, title: stripTags(m[2] || ''), snippet: snip ? stripTags(snip[1]) : '' });
  }
  return out;
}

/* ----------------------------------------------------------- repo engines */

function repoItem({ url, name, stars, desc, lang, updated, extra }) {
  return {
    url,
    title: `${name}  ★${stars ?? 0}`,
    score: Number(stars) || 0,
    snippet: [desc || '', lang ? `语言: ${lang}` : '', updated ? `最近更新: ${String(updated).slice(0, 10)}` : '', extra || '']
      .filter(Boolean)
      .join(' · '),
  };
}

/** Gitea / Forgejo / Codeberg 共用一套返回结构。 */
function giteaPick(data, label) {
  const arr = data?.data || data?.items || [];
  if (!Array.isArray(arr)) throw new Error(`${label} 返回结构异常`);
  return arr.map((it) =>
    repoItem({
      url: it.html_url,
      name: it.full_name,
      stars: it.stars_count,
      desc: it.description,
      lang: it.language,
      updated: it.updated_at,
    })
  );
}

/* -------------------------------------------------------- package engines */

function pkgItem({ url, name, version, downloads, desc, extra }) {
  return {
    url,
    title: `${name}${version ? `@${version}` : ''}${downloads != null ? `  ⤓${downloads}` : ''}`,
    score: Number(downloads) || 0,
    snippet: [desc || '', extra || ''].filter(Boolean).join(' · '),
  };
}

/* ------------------------------------------------------------ 路由执行层 */

/**
 * 路由健康状态：只活在进程内。失败过的路由会被排到同引擎的其它路由之后，
 * 一条都没有成功过的引擎下次仍然从第一条开始试 —— 所以这不是"记住了别试"，
 * 而是"这一轮先换条路"。外部网络恢复后不会留下永久性拉黑。
 */
const routeHealth = new Map();
const routeKey = (id, route) => `${id}|${route.label}`;

function markRouteFailed(id, route, message) {
  const k = routeKey(id, route);
  const cur = routeHealth.get(k) || { fails: 0, lastError: '' };
  routeHealth.set(k, { fails: cur.fails + 1, lastError: message });
}

function markRouteOk(id, route) {
  routeHealth.delete(routeKey(id, route));
}

/**
 * 路由顺序 = 失败次数 → tier 策略 → 声明顺序。
 * `direct-first` 先直连（数据最权威、无第三方转折）；
 * `accel-first` 先走镜像/加速（国内网络直连经常超时）；
 * `auto`（默认）按引擎自己决定 —— 实测直连不可达的引擎（如 huggingface）
 * 先走镜像，其余先直连。tier 2 的第三方索引在任何策略下都排最后。
 */
function orderedRoutes(def, engineId, policy, pin) {
  let list = def.routes || [];
  if (pin) {
    const hit = list.filter((r) => r.label.includes(pin));
    if (hit.length) list = hit;
  }
  const eff = policy === 'direct-first' || policy === 'accel-first'
    ? policy
    : def.preferAccel
      ? 'accel-first'
      : 'direct-first';
  const rank = (r) => (eff === 'accel-first' ? (r.tier === 1 ? 0 : r.tier === 0 ? 1 : 2) : r.tier);
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const fa = routeHealth.get(routeKey(engineId, a.r))?.fails || 0;
      const fb = routeHealth.get(routeKey(engineId, b.r))?.fails || 0;
      if (fa !== fb) return fa - fb;
      const ta = rank(a.r);
      const tb = rank(b.r);
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** UA 挂在路由上：API 入口用自报 UA，网页入口用浏览器 UA。 */
function routeUa(def, route) {
  const want = route.ua || def.ua;
  if (want === 'bot') return UA_BOT;
  if (want === 'browser') return UA_BROWSER;
  return def.html ? UA_BROWSER : UA_BOT;
}

/** 跑一条路由：拼 URL → 取文本/JSON → 交给解析器（路由可覆盖引擎级实现）。 */
async function runRoute(def, route, query, opts) {
  const n = clampInt(opts.maxResults, 1, 30, 8);
  // 设置卡片里的单入口代理开关：true = 强制走全局代理；false = 强制直连；
  // 缺省 = 跟随全局。GitHub 的加速镜像不需要代理就能用，所以「开代理」
  // 对它意味着「优先用加速镜像」，对其它入口才意味着真正的 proxy。
  let proxyUrl = opts.proxyUrl;
  const ov = opts._ui?.routeOverrides?.[`${opts._engineId}|${route.label}`];
  if (ov?.proxy === true) proxyUrl = opts._globalProxyUrl || '';
  else if (ov?.proxy === false) proxyUrl = '';
  // 卡片里可以直接改写入口网址（设置 → 插件 → 输入框）。
  const effRoute = ov?.url ? { ...route, base: ov.url } : route;
  // 路由可以自带 search / pick：第三方索引的端点和返回结构都和主源不同
  // （repos.ecosyste.ms 就不是 GitHub 的 /search/repositories）。
  const build = effRoute.search || def.search;
  const pick = effRoute.pick || def.pick;
  const url = build(effRoute, query, n, opts);
  const ua = routeUa(def, effRoute);
  const accept = effRoute.accept || def.accept;
  // 凭据只发给权威直连入口。第三方加速代理 / 索引站点会看到整条请求，
  // 把 PAT 送过去等于把令牌交给一个无关的第三方 —— 宁可让加速路由跑匿名限流。
  const extraHeaders =
    def.token === 'githubToken' && opts.githubToken && route.tier === 0
      ? { Authorization: `Bearer ${opts.githubToken}` }
      : undefined;

  let payload;
  if (def.html) {
    payload = await request(url, { ...opts, proxyUrl, ua, accept, extraHeaders });
  } else {
    payload = await getJson(url, { ...opts, proxyUrl, ua, accept, extraHeaders }, def.label);
  }
  // 每条结果都带上它是从哪条入口拿到的：结果异常时先看这个再怀疑内容。
  // 组合引擎会把成员结果原样带进合并结果，所以这里的 via 会一路留到最后。
  return (pick(payload, route, opts) || []).map((it) => ({ ...it, via: route.label }));
}

/**
 * 这条入口是不是「不可用」，还是只是「这次请求被拒」？
 *
 * 区分很重要：4xx 里的 400/401/404 说明入口本身是通的 —— 只是这次没带对
 * 凭据、或者查的东西不存在。把这种失败记成「入口不可用」，会让一次无效 token
 * 把一条好好的直连入口在整个会话里排到最后（实测踩到过：无效 token 触发的
 * 401 让后续所有 github 搜索都先绕去第三方加速代理）。
 *
 * 403 / 429 / 5xx 和网络层错误才是真的入口问题：WAF 拦截、限流、网关故障。
 */
function isRouteUnavailable(message) {
  const http = String(message || '').match(/HTTP (\d{3})/);
  if (!http) return true; // fetch failed / 超时 / DNS → 入口不可用
  const code = Number(http[1]);
  return code === 403 || code === 429 || code >= 500;
}

/**
 * 跑一个引擎：按路由表依次尝试，第一条成功的就返回。
 * 空结果算成功的答复（同一份内容换入口也一样空），不再浪费后续路由的往返。
 */
async function runEngine(engineId, query, opts) {
  const def = ENGINES_META[engineId];
  if (!def) throw new Error(`未知引擎 "${engineId}"`);

  const policy = ['direct-first', 'accel-first'].includes(opts.routePolicy)
    ? opts.routePolicy
    : 'auto';
  const pin = opts._routePin || null;
  // 空网址的入口（卡片里「添加代理」后还没填 URL）不参与运行时。
  let routes = orderedRoutes(def, engineId, policy, pin).filter((r) => r.base);
  // 卡片里被蓝色开关停用的代理入口也不参与运行时（保留配置，随时可再启用）。
  // 自定义代理：启停状态优先读条目本身（custom.proxies[proxyIndex].enabled，
  // v3 数据模型）；routeOverrides.enabled 仅作 v2 旧配置回退。
  const uiOv = opts._ui?.routeOverrides;
  const uiCustom = opts._ui?.custom;
  const uiExtras = opts._ui?.routeExtras;
  if (
    (uiOv && Object.keys(uiOv).length) ||
    (uiCustom && Object.keys(uiCustom).length) ||
    (uiExtras && Object.keys(uiExtras).length) // 只看前两者会漏掉纯 routeExtras 的停用配置
  ) {
    routes = routes.filter((r) => {
      if (r.tier !== 1) return true;
      if (engineId.startsWith('custom-') && typeof r.proxyIndex === 'number') {
        const catId = engineId.slice('custom-'.length, engineId.lastIndexOf('-'));
        const srcNo = Number(engineId.slice(engineId.lastIndexOf('-') + 1)) - 1;
        const entry = (uiCustom?.[catId] || [])[srcNo]?.proxies?.[r.proxyIndex];
        // v3 条目显式 false → 停用；否则继续看 v2 回退键，不能在这里 early return
        // （entry 恒为真，early return 会吞掉 v2 旧配置的「停用」）。
        if (entry && entry.enabled === false) return false;
      } else if (r.extra && typeof r.extraIndex === 'number') {
        // 内置源「＋代理」入口：状态存在 routeExtras[engId][extraIndex].enabled。
        const extra = (uiExtras?.[engineId] || [])[r.extraIndex];
        if (extra && extra.enabled === false) return false;
      }
      return uiOv?.[`${engineId}|${r.label}`]?.enabled !== false;
    });
  }
  if (!routes.length) throw new Error(`${def.label}：没有可用路由`);

  // 设置卡片的单入口代理开关参与路由排序。语义对齐用户直觉：
  //   任意入口 proxy=true → 该引擎整体 accel-first（加速镜像/代理入口排最前，
  //     —— GitHub 的 gh-proxy.com 这类镜像本身就是「代理」，无需本机代理地址）
  //   任意入口 proxy=false → 该引擎整体 direct-first，且该入口排最前
  //   缺省 → 引擎默认策略。稳定排序保住健康度/层级顺序。
  const overrides = opts._ui?.routeOverrides;
  if (overrides && Object.keys(overrides).length) {
    const ov = (r) => overrides[`${engineId}|${r.label}`]?.proxy;
    const wantsProxy = (def.routes || []).some((r) => ov(r) === true);
    const wantsDirect = (def.routes || []).some((r) => ov(r) === false);
    if (wantsProxy || wantsDirect) {
      const eff = wantsProxy ? 'accel-first' : 'direct-first';
      const rank = (r) =>
        eff === 'accel-first' ? (r.tier === 1 ? 0 : r.tier === 0 ? 1 : 2) : r.tier;
      const forced = (r) => (ov(r) === false ? -1 : 0); // 显式「直连」的入口在 direct-first 下排最前
      routes = [...routes].sort((a, b) => {
        const fa = forced(a) - forced(b);
        if (fa) return fa;
        const ta = rank(a) - rank(b);
        if (ta) return ta;
        return 0;
      });
    }
  }
  opts._engineId = engineId;

  const failures = [];
  for (const route of routes) {
    const t0 = Date.now();
    try {
      const items = await runRoute(def, route, query, opts);
      markRouteOk(engineId, route);
      if (!items.length) {
        opts.logger?.debug?.(`websearch-direct: ${def.label} 经「${route.label}」无结果`);
      }
      return { items, via: route.label, ms: Date.now() - t0, failures };
    } catch (err) {
      failures.push(`${route.label}: ${err.message}`);
      const unusable = isRouteUnavailable(err.message);
      if (unusable) markRouteFailed(engineId, route, err.message);
      if (routes.length > 1) {
        opts.logger?.warn?.(
          `websearch-direct: ${def.label} 入口「${route.label}」失败 — ${err.message}；换下一条入口` +
            (unusable ? '' : '（该入口本身可用，不计入降级）')
        );
      }
    }
  }
  throw new Error(
    routes.length === 1
      ? failures[0]
      : `${routes.length} 条入口全部失败 → ${failures.join(' | ')}`
  );
}

/* -------------------------------------------------------------- registry */

/** 所有非组合引擎 → 「(query, opts) => { items, via, ms, failures }」。 */
const ENGINES = {};
for (const [id, def] of Object.entries(ENGINES_META)) {
  if (def.group === 'composite') continue;
  ENGINES[id] = (query, opts) => runEngine(id, query, opts);
}

/** 组合引擎的成员列表：可配置，默认取内置列表；自定义引擎按大类自动并入。 */
function membersOf(kind, cfg) {
  const key = kind === 'repo' ? 'repoEngines' : 'pkgEngines';
  const fallback = kind === 'repo' ? REPO_ENGINES : PKG_ENGINES;
  const list = Array.isArray(cfg?.[key]) && cfg[key].length ? cfg[key] : fallback;
  const catId = kind === 'repo' ? 'code' : 'pkg';
  const customs = kind === 'repo' || kind === 'pkg' ? customEngineIdsFor(catId) : [];
  return [...new Set([...list.map(baseEngineId), ...customs])].filter((e) => ENGINES[e]);
}

/** Is this engine usable with the current config? */
function engineReady(id, cfg) {
  const base = baseEngineId(id);
  if (base === 'gitee') return !!(cfg?.giteeToken || process.env.GITEE_TOKEN);
  if (base === 'repo' || base === 'pkg') return membersOf(base, cfg).some((e) => engineReady(e, cfg));
  return !!ENGINES[base];
}

/** 归一化 URL：用于跨源去重（大小写、www.、query、尾斜杠都不该造成两条）。 */
function canonUrl(u) {
  try {
    const x = new URL(String(u));
    return `${x.hostname.replace(/^www\./i, '').toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(u || '').replace(/[#?].*$/, '').replace(/\/+$/, '');
  }
}

/**
 * Composite search: fan out to every ready member IN PARALLEL, then merge by
 * round-robin so the answer is genuinely multi-source instead of "GitHub plus
 * whatever is left". Each member's own results are sorted by its native
 * popularity metric first; cross-host scores are not comparable, which is
 * exactly why we interleave rather than sort globally.
 *
 * 成员是**逻辑源**（github / gitlab / …），不是路由。同一个源的镜像和加速
 * 在 runEngine 内部就已经收敛成一条结果，不会在这里被当成两个源重复出现。
 */
function compositeSearch(kind, label) {
  return async function searchComposite(query, opts) {
    const cfg = opts._cfg || {};
    const ready = membersOf(kind, cfg).filter((id) => engineReady(id, cfg));
    if (!ready.length) throw new Error(`${label}：没有可用的子引擎`);

    const perEngine = clampInt(Math.ceil(opts.maxResults / ready.length) + 2, 3, 30, 5);
    // 组合引擎的耗时 = 最慢的那个成员，所以成员必须有比全局更紧的上限：
    // 否则一个不稳的源（实测 maven 端点 15s+ 超时）会把整次搜索拖到 20 秒以上。
    // 被放弃的成员会出现在 failures 里，不会静默消失。
    const memberMs = clampInt(
      Math.min(opts.timeoutMs || DEFAULTS.timeoutMs, DEFAULTS.compositeMemberMs),
      3000,
      60000,
      DEFAULTS.compositeMemberMs
    );

    const settled = await Promise.allSettled(
      ready.map(async (id) => {
        const meta = ENGINES_META[id] || {};
        // Gitee answers in ~10s, so give slow members more headroom.
        const timeoutMs = Math.round(memberMs * (meta.slow ? 1.8 : 1));
        const r = await ENGINES[id](query, { ...opts, maxResults: perEngine, timeoutMs });
        const items = (r.items || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
        return { id, items, via: r.via };
      })
    );

    const groups = [];
    const failures = [];
    const routes = {};
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        routes[ready[i]] = s.value.via;
        if (s.value.items.length) groups.push(s.value);
      } else {
        failures.push(`${ready[i]}: ${s.reason?.message ?? s.reason}`);
      }
    });

    if (!groups.length) {
      throw new Error(
        `${label}：所有源均无结果${failures.length ? `（${failures.join(' | ')}）` : ''}`
      );
    }

    const want = clampInt(opts.maxResults, 1, 30, DEFAULTS.maxResults);
    const merged = [];
    const seen = new Set();
    for (let depth = 0; merged.length < want; depth++) {
      let progressed = false;
      for (const g of groups) {
        const item = g.items[depth];
        if (!item) continue;
        progressed = true;
        const key = canonUrl(item.url);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const label2 = ENGINES_META[g.id]?.label || g.id;
        merged.push({ ...item, url: item.url, title: `[${label2}] ${item.title}`, engine: g.id });
        if (merged.length >= want) break;
      }
      if (!progressed) break;
    }

    return {
      items: merged,
      usedEngines: groups.map((g) => g.id),
      routes,
      failures,
    };
  };
}

const COMPOSITES = {
  repo: compositeSearch('repo', '代码仓库多源合并'),
  pkg: compositeSearch('pkg', '包仓库多源合并'),
};

/**
 * Composite engines return a richer shape than a plain engine, so normalise
 * here. A plain engine yields `{ items, via, failures }`; a composite yields
 * `{ items, usedEngines, routes, failures }`. `routes` records which entry of
 * each source actually answered — that is what makes "同一份内容的多个入口"
 * observable instead of a black box.
 */
function normaliseResult(id, result) {
  if (Array.isArray(result)) return { items: result, usedEngines: [id], routes: {}, failures: [] };
  return {
    items: result.items || [],
    usedEngines: result.usedEngines || [id],
    routes: result.routes || (result.via ? { [id]: result.via } : {}),
    failures: result.failures || [],
  };
}

/* --------------------------------------------------------------- routing */

/**
 * Decide which engines to try, in order. An explicit choice always wins.
 * Otherwise dependency vocabulary routes to the `pkg` group and code/repo
 * vocabulary to the `repo` group — both multi-source — with the configured
 * web engines kept as fallbacks so a code host having a bad day still answers.
 */
function pickOrder(query, explicit, cfg) {
  const known = (e) => !!(ENGINES[e] || COMPOSITES[e] || ENGINE_ALIASES[e]);
  // A configured order that filters down to nothing must NOT replace the
  // defaults — an all-invalid engineOrder used to leave an empty list, which
  // then surfaced as "所有引擎均失败（已尝试 ）。"
  const configured = (Array.isArray(cfg.engineOrder) ? cfg.engineOrder : [])
    .map(baseEngineId)
    .filter((e) => ENGINES[e] || COMPOSITES[e]);
  const fallback = configured.length ? configured : DEFAULTS.engineOrder.slice();

  // 别名（npmmirror / hf-mirror …）要原样保留，runSearch 靠它决定 pin 哪条路由
  if (explicit && known(explicit)) return [explicit];

  if (cfg.autoRoute !== false) {
    const q = String(query || '');
    if (PKG_INTENT.test(q)) return ['pkg', ...fallback.filter((e) => e !== 'pkg')];
    if (CODE_INTENT.test(q)) return ['repo', ...fallback.filter((e) => e !== 'repo')];
  }
  return fallback;
}

function renderSources(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}${s.snippet ? `\n${s.snippet}` : ''}`)
    .join('\n\n');
}

/* ------------------------------------------------------------ GitHub 镜像 */

const GH_MIRRORS = ['https://ghproxy.net/', 'https://ghfast.top/', 'https://gh-proxy.com/'];
const GH_MIRRORABLE =
  /^https?:\/\/(raw\.githubusercontent\.com|github\.com|objects\.githubusercontent\.com|codeload\.github\.com|gist\.githubusercontent\.com|gist\.github\.com)\//i;

/**
 * Fetch a URL, falling back to a GitHub acceleration mirror when the direct
 * connection cannot reach it. Mainland networks frequently cannot open
 * raw.githubusercontent.com even though api.github.com works, so a mirror is
 * often the difference between "the agent can read the file" and not.
 */
async function fetchWithMirrors(url, opts) {
  try {
    return { text: await request(url, opts), via: null };
  } catch (err) {
    if (isOff(opts.enableGithubMirrors) || !GH_MIRRORABLE.test(url)) throw err;
    const errors = [err.message];
    for (const mirror of GH_MIRRORS) {
      try {
        const text = await request(mirror + url, opts);
        return { text, via: mirror.replace(/\/+$/, '') };
      } catch (e) {
        errors.push(`${mirror} → ${e.message}`);
      }
    }
    throw new Error(`直连失败（${err.message}），且 ${GH_MIRRORS.length} 个 GitHub 加速镜像均失败：${errors.slice(1).join(' | ')}`);
  }
}

/* ------------------------------------------------------------------ tools */

/** 一个引擎的入口清单（只列多条入口的引擎，一条的不啰嗦）。 */
function routeLine(id) {
  const rs = ENGINES_META[id]?.routes || [];
  if (rs.length <= 1) return '';
  const marks = { 0: '直连', 1: '加速', 2: '索引' };
  return ` 　 入口（自动回退）: ${rs.map((r) => `${r.label}[${marks[r.tier] || r.tier}]`).join(' → ')}`;
}

/** Grouped description — the model's map of the engines. */
function toolDescription(cfg) {
  const line = (id) => {
    const m = ENGINES_META[id];
    const hasDirect = (m.routes || []).some((r) => r.tier === 0);
    const reach = m.direct === false ? '直连不可达，走镜像' : hasDirect ? '直连可用' : '仅镜像入口';
    const token = m.token && !engineReady(id, cfg) ? '，当前未配置令牌→自动跳过' : '';
    const rl = routeLine(id);
    return `  - ${id}（${m.label}，${reach}${token}）: ${m.what}。适合：${m.useWhen}${rl ? `\n${rl}` : ''}`;
  };
  return [
    '网页/代码/依赖包搜索，可显式指定搜索引擎。当任务明显匹配某个引擎时优先用本工具，而不是通用搜索。',
    '代码仓库类（省略 engine 时自动走 repo 多源合并）：',
    ...REPO_ENGINES.map(line),
    `  - repo（多源合并，推荐）: 并行查询 ${membersOf('repo', cfg).join(' + ')}，按来源轮转合并，避免只看 GitHub`,
    '依赖包类（省略 engine 时自动走 pkg 多源合并）：',
    ...PKG_ENGINES.map(line),
    `  - pkg（多源合并，推荐）: 并行查询 ${membersOf('pkg', cfg).join(' + ')}`,
    '通用网页：',
    ...WEB_ENGINES.map(line),
    '请求的是「源」，不是「入口」：同一个源的直连 / 镜像 / 加速代理由插件内部按顺序回退，',
    '你不需要也不应该把镜像当成独立的搜索引擎。想强制走某条入口时才用这些别名：',
    `  ${Object.entries(ENGINE_ALIASES).map(([a, v]) => `${a}→${v.engine}(${v.route})`).join('｜')}`,
    cfg.autoRoute === false
      ? '省略 engine 时按配置的 engineOrder 顺序尝试。'
      : '省略 engine 时自动路由：依赖包意图 → pkg；代码/仓库/插件意图 → repo；其余按配置顺序。',
    'engine 传 auto 等同于省略。若某个引擎失败（限流、反爬、无令牌），会自动降级到下一个。',
    '返回值里的 routes 字段记录了每个源实际用了哪条入口 —— 结果异常时先看它，再怀疑内容。',
  ].join('\n');
}

/**
 * System-prompt guidance placed right after the stock `web_search` section.
 * Tool descriptions tell the model *what exists*; this tells it *which one to
 * reach for*, which is what actually changes behaviour.
 */
function enginePrompt(cfg) {
  const usable = (id) => engineReady(id, cfg) && ENGINES_META[id].group !== 'composite';
  const list = ENGINE_IDS.filter(usable)
    .map((id) => {
      const m = ENGINES_META[id];
      const n = (m.routes || []).length;
      return `${id}=${m.label}（${m.what}${n > 1 ? `；${n} 条入口自动回退` : ''}）`;
    })
    .join('；');
  return [
    `可用搜索引擎：${list}。`,
    '每个引擎背后可能有多个入口（直连 / 镜像 / 加速代理），插件自己会按顺序回退，你不需要关心走的是哪条路。',
    '当任务明显匹配某个引擎时，用 web_search_engine 并显式指定 engine，而不是笼统地用 web_search：',
    '· 找开源项目 / 库 / 框架 / SDK / CLI / 插件源码、对比同类实现 → engine="repo"（默认多源合并：GitHub + GitLab + Codeberg + Gitea，配了 Gitee 令牌还会带上码云），不要只指定 github，否则会漏掉其他托管站的项目',
    '· 找依赖包 / 库的版本与下载量（npm / Rust / PHP / .NET / Ruby / Java / HuggingFace 模型） → engine="pkg"',
    '· 找模型 / 数据集 → engine="huggingface"；只看某一个源 → engine="gitlab"、"engine="codeberg" 等',
    '· 纯中文内容、国内站点、百科、问答、论坛帖 → engine="baidu"',
    '· 技术文档 / 教程 / 新闻 / 产品官网 / 报错信息（中英文通用） → 省略 engine，默认走 Bing 中国（与 Edge 默认搜索引擎一致）',
    cfg.autoRoute === false
      ? '当前配置已关闭自动路由，省略 engine 时按 engineOrder 顺序尝试。'
      : '省略 engine 时会自动路由：依赖包意图 → pkg，代码/仓库/插件意图 → repo，其余按 Bing → 百度 顺序。',
    '回答时说明结果来自哪个搜索引擎及其局限（例如仓库类搜索只覆盖各托管站的公开项目，不代表全网；镜像入口的数据可能比官方源滞后）。',
  ].join('\n');
}

/* ----------------------------------------------------------------- plugin */

/* ------------------------------------------------ 设置页 UI（卡片数据面） */

/**
 * 设置 → 插件 里的「联网搜索（直连优先）」卡片走的是 dshmarket 验证过的三件套：
 *
 *   1. settings 命名空间（上面 apply 里已注册）——让设置页把 `websearch-direct`
 *      列进「插件配置」标签页；
 *   2. 自有 HTTP 路由 /dsh-websearch-direct/api/*——卡片读写配置的数据面；
 *   3. 浏览器半边 client/client.js——认领 `settings.plugin.item` 槽位（key=命名空间）。
 *
 * UI 配置持久化在 <DSH_HOME>/storages/websearch-direct/ui-config.json，
 * 与 cordis 配置（Config schema）解耦：卡片是这个文件的唯一写者。
 */

/** 设置卡片上的四个大类：id → 内置源清单 + 自定义源的兼容类型。 */
const UI_CATEGORY_DEFS = [
  { id: 'code', label: '代码仓库', engines: ['github', 'gitlab', 'codeberg', 'gitea', 'gitee'], customKind: 'gitea' },
  { id: 'pkg', label: '包管理', engines: ['npm', 'crates', 'packagist', 'nuget', 'rubygems'], customKind: 'npm' },
  { id: 'model', label: '模型仓库', engines: ['huggingface'], customKind: 'hf' },
  { id: 'web', label: '网页搜索', engines: ['bing', 'baidu', 'duckduckgo'], customKind: 'bing' },
];

/** 每个大类最多允许几个自定义源（防呆上限）。 */
const UI_CUSTOM_MAX = 8;

/**
 * UI 配置数据模型版本（写进 ui-config.json 与 GET 快照）。
 *   v1 → v2：custom 从 {label,url,proxy} 变成 {name,url,proxies[]}
 *   v2 → v3：自定义代理的启停状态从 routeOverrides["<engId>|代理 N"]
 *            （按 label 定位，删除代理后 label 重排 → 状态错位）
 *            移进 custom.proxies[i].enabled（按数组位置定位）。
 * 读盘对 v1/v2/v3 都兼容：normaliseUiState 会把旧形状归一成当前形状。
 */
const UI_MODEL_VERSION = 3;

const UI_DEFAULT = {
  version: UI_MODEL_VERSION,
  /** 空 = 免 Key 直连（默认）；填写 = 所有联网搜索使用此 Key。 */
  apiKey: '',
  /** 全局代理地址；空 = 不走全局代理。 */
  proxyUrl: '',
  /** 「引擎id|路由label」 -> { proxy?: true|false, url?: 覆盖地址 }；删除该键 = 恢复默认。 */
  routeOverrides: {},
  /** 引擎id -> [ { url } ]：给内置源追加的代理入口（url 可为空 = 待填写，运行时跳过）。 */
  routeExtras: {},
  /** 大类id -> [ { name, url, proxies: [ { url } ] } ]：自定义源 = 名称 + 官方直连 + 代理列表。 */
  custom: { code: [], pkg: [], model: [], web: [] },
};

function uiStateFile() {
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'storages', 'websearch-direct', 'ui-config.json');
}

function asUrl(v) {
  const s = String(v ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function normaliseUiState(raw) {
  const s = { ...structuredClone(UI_DEFAULT), ...(raw && typeof raw === 'object' ? raw : {}) };
  s.apiKey = typeof s.apiKey === 'string' ? s.apiKey : '';
  s.proxyUrl = typeof s.proxyUrl === 'string' ? s.proxyUrl : '';
  const overrides = {};
  if (s.routeOverrides && typeof s.routeOverrides === 'object') {
    for (const [k, v] of Object.entries(s.routeOverrides)) {
      if (typeof k !== 'string' || !k.includes('|') || !v || typeof v !== 'object') continue;
      const o = {};
      if (v.proxy === true || v.proxy === false) o.proxy = v.proxy;
      const u = asUrl(v.url);
      if (u) o.url = u;
      // v2 遗留：启停状态存在 routeOverrides[<engId>|<label>].enabled。
      // 这里必须原样保留 —— 丢掉它会让旧配置里「停用的入口」在下次读盘时
      // 静默变回启用（内置源的追加入口至今仍走这条路径）。
      if (v.enabled === false) o.enabled = false;
      if (Object.keys(o).length) overrides[k] = o;
    }
  }
  s.routeOverrides = overrides;
  const extras = {};
  if (s.routeExtras && typeof s.routeExtras === 'object') {
    for (const [engId, list] of Object.entries(s.routeExtras)) {
      if (typeof engId !== 'string' || engId.startsWith('custom-') || !Array.isArray(list)) continue;
      // routeExtras 是与 routeOverrides / custom 并列的独立写入路径：内置源用
      // 「＋代理」追加的入口存在这里。启停状态同样必须原样保留 ——
      // 旧写法 `list.map(x => asUrl(x?.url))` 只取 url，会把 enabled 丢掉，
      // 于是停用的追加入口每次读盘都静默变回启用。
      const items = list
        .map((x) => ({ url: asUrl(x?.url), enabled: x && typeof x === 'object' && x.enabled === false }))
        .filter((x) => x.url)
        .slice(0, UI_CUSTOM_MAX)
        .map((x) => ({ url: x.url, ...(x.enabled ? { enabled: false } : {}) }));
      if (items.length) extras[engId] = items;
    }
  }
  s.routeExtras = extras;
  const custom = {};
  for (const cat of UI_CATEGORY_DEFS) {
    const list = Array.isArray(s.custom?.[cat.id]) ? s.custom[cat.id] : [];
    custom[cat.id] = list
      .slice(0, UI_CUSTOM_MAX)
      .map((x) => ({
        // v1 遗留 { label, url, proxy } → { name, url, proxies: [] }
        name: String(x.name ?? x.label ?? '').trim().slice(0, 40),
        url: asUrl(x.url),
        proxies: Array.isArray(x.proxies)
          ? x.proxies
              .map((p) => ({
                url: asUrl(p?.url ?? p),
                // v3：启停状态存在条目本身（缺省 = 启用）；v1/v2 遗留条目无此字段。
                ...(p && typeof p === 'object' && p.enabled === false ? { enabled: false } : {}),
              }))
              .filter((p) => p.url)
              .slice(0, UI_CUSTOM_MAX)
          : [],
      }))
      .filter((x) => x.url);
  }
  s.custom = custom;
  // 旧配置（v1/v2）读上来后归一成当前模型版本：结构已经按 v3 形状重建，
  // version 字段必须跟着走，否则「版本号」与「真实结构」会长期不一致。
  s.version = UI_MODEL_VERSION;
  return s;
}

function loadUiState() {
  try {
    return normaliseUiState(JSON.parse(readFileSync(uiStateFile(), 'utf8')));
  } catch {
    return structuredClone(UI_DEFAULT);
  }
}

function saveUiState(state) {
  const file = uiStateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

/** 内置路由的出厂快照：syncUiRoutes 每次从这里重建，保证「恢复默认」幂等。 */
const BUILTIN_ROUTES = {};
for (const [id, def] of Object.entries(ENGINES_META)) {
  BUILTIN_ROUTES[id] = (def.routes || []).map((r) => ({ ...r }));
}

/** 把 routeExtras（内置源追加的代理入口）同步进运行时路由表。 */
function syncUiRoutes(state) {
  for (const [engId, def] of Object.entries(ENGINES_META)) {
    if (engId.startsWith('custom-')) continue;
    const pristine = BUILTIN_ROUTES[engId];
    if (!pristine) continue;
    const extras = (state.routeExtras[engId] || []).map((x, i) => ({
      label: `自定义代理 ${i + 1}`,
      base: x.url, // 可为空 = 待填写；runEngine 会跳过空入口
      tier: 1,
      extra: true,
      // extraIndex = 在 routeExtras[engId] 数组里的位置。与自定义源代理的
      // proxyIndex 同理：启停状态按位置回查条目本身，不靠 label 字符串定位。
      extraIndex: i,
    }));
    def.routes = pristine.concat(extras);
  }
}

/**
 * 把自定义源安装成真实引擎，并同步内置源的追加入口。
 * 克隆同类内置引擎的定义、只换 base —— 自建 Gitea 的 API 和 gitea.com
 * 是同一个形状，npmmirror 和 registry.npmjs.org 也是。
 */
function installCustomEngines(state) {
  for (const engId of Object.keys(ENGINES_META)) {
    if (engId.startsWith('custom-')) {
      delete ENGINES_META[engId];
      delete ENGINES[engId];
    }
  }
  syncUiRoutes(state);
  const kinds = { code: 'gitea', pkg: 'npm', model: 'hf', web: 'bing' };
  const groups = { code: 'repo', pkg: 'pkg', model: 'pkg', web: 'web' };
  for (const cat of UI_CATEGORY_DEFS) {
    (state.custom[cat.id] || []).forEach((src, i) => {
      if (!src.url) return;
      const engId = `custom-${cat.id}-${i + 1}`;
      const ref = ENGINES_META[kinds[cat.id] === 'gitea' ? 'gitea' : kinds[cat.id] === 'npm' ? 'npm' : kinds[cat.id] === 'hf' ? 'huggingface' : 'bing'];
      if (!ref) return;
      const name = src.name || src.url.replace(/^https?:\/\//i, '');
      const routes = [{ label: '直连', base: src.url, tier: 0 }];
      (src.proxies || []).forEach((p, j) => {
        // proxyIndex = 在 custom.proxies 数组里的位置：启停状态存在条目本身
        // （p.enabled），删除某条代理后其余条目位置不变，不会错位。
        routes.push({ label: `代理 ${j + 1}`, base: p.url, tier: 1, proxyIndex: j });
      });
      ENGINES_META[engId] = {
        ...ref,
        label: name,
        group: groups[cat.id],
        routes,
      };
      ENGINES[engId] = (query, opts) => runEngine(engId, query, opts);
    });
  }
}

/** 某大类下已安装的自定义源引擎 id（供 membersOf 并入组合搜索）。 */
function customEngineIdsFor(catId) {
  return Object.keys(ENGINES_META).filter((id) => id.startsWith(`custom-${catId}-`));
}

/** 卡片 GET 的完整快照：源 → 入口（类型 + 可编辑网址 + 覆盖状态）。 */
function uiSnapshot(state) {
  return {
    version: UI_MODEL_VERSION,
    apiKeySet: !!state.apiKey,
    proxyUrl: state.proxyUrl,
    categories: UI_CATEGORY_DEFS.map((cat) => {
      const ids = cat.engines.filter((e) => ENGINES_META[e]).concat(customEngineIdsFor(cat.id));
      return {
        id: cat.id,
        label: cat.label,
        engines: ids.map((e) => {
          const def = ENGINES_META[e];
          const isCustom = e.startsWith('custom-');
          return {
            id: e,
            label: def.label,
            custom: isCustom,
            routes: (def.routes || []).map((r) => {
              const key = `${e}|${r.label}`;
              const ov = state.routeOverrides[key] || {};
              // 自定义代理的启停状态存在条目本身（custom.proxies[idx].enabled，
              // v3 数据模型）；routeOverrides.enabled 作 v2 旧配置回退——
              // 删除代理导致 label 重排时，按位置定位的状态不受影响。
              const catId = isCustom ? e.slice('custom-'.length, e.lastIndexOf('-')) : null;
              const idx = typeof r.proxyIndex === 'number' ? r.proxyIndex : -1;
              const entry = idx >= 0 && catId ? (state.custom[catId] || [])[Number(e.slice(e.lastIndexOf('-') + 1)) - 1]?.proxies?.[idx] : null;
              const legacyEnabled = ov.enabled !== false;
              // v3 条目显式为 false 时以条目为准；否则回退看 v2 的 routeOverrides。
              // 不能写成 `entry ? entry.enabled !== false : legacyEnabled`：
              // 自定义代理的 entry 恒为真，那样会让 v2 旧配置的「停用」被静默丢弃。
              // 内置源「＋代理」追加的入口走 routeExtras（extra:true），同样按
              // extraIndex 回查条目本身的 enabled —— 它与 routeOverrides 是两条
              // 独立路径，只看后者会让这类入口的停用状态永远显示为启用。
              const extraEntry =
                r.extra && typeof r.extraIndex === 'number'
                  ? (state.routeExtras[e] || [])[r.extraIndex]
                  : null;
              const entrySaysDisabled =
                (!!entry && entry.enabled === false) ||
                (!!extraEntry && extraEntry.enabled === false);
              const enabled = !(entrySaysDisabled || !legacyEnabled);
              return {
                key,
                tier: r.tier,
                ...(typeof r.proxyIndex === 'number' ? { proxyIndex: r.proxyIndex } : {}),
                url: ov.url || r.base || '',
                defaultUrl: r.base || '',
                type: (ov.proxy !== undefined ? ov.proxy : r.tier === 1) ? 'proxy' : 'direct',
                enabled,
                switchable: r.tier === 1,
                removable: !!r.extra || (isCustom && r.tier !== 0),
                empty: !r.base && !ov.url,
              };
            }),
          };
        }),
      };
    }),
    limits: { customMax: UI_CUSTOM_MAX },
  };
}

export function apply(ctx, config) {
  const logger = ctx.logger?.('websearch-direct') || console;

  // 设置卡片的数据面：启动即装载（文件不存在 = 全默认），卡片保存后热更新。
  let uiState = loadUiState();
  installCustomEngines(uiState);

  let resolved = () => ({ ...DEFAULTS, ...config });
  ctx.inject(['settings'], (sctx) => {
    // No schema means no settings form to render and nothing to register
    // against; the profile's own config stays authoritative.
    if (!Config) return;
    try {
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config });
      resolved = () => ({ ...DEFAULTS, ...scope.get() });
      sctx.effect(() => () => {
        resolved = () => ({ ...DEFAULTS, ...config });
      });
    } catch {
      /* Settings service unavailable — profile defaults stay in effect. */
    }
  });

  const opts = () => {
    const c = resolved();
    // UI 卡片是更友好的表面，所以它填的值优先于 cordis 配置里的同名字段。
    const globalProxy =
      (uiState.proxyUrl || '').trim() ||
      (c.proxyUrl || '').trim() ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      '';
    return {
      proxyUrl: globalProxy,
      timeoutMs: Number(c.timeoutMs) || DEFAULTS.timeoutMs,
      maxResults: Number(c.maxResults) || DEFAULTS.maxResults,
      githubToken:
        (uiState.apiKey || '').trim() ||
        (c.githubToken || '').trim() ||
        process.env.GITHUB_TOKEN ||
        '',
      giteeToken: (c.giteeToken || '').trim() || process.env.GITEE_TOKEN || '',
      enableGithubMirrors: !isOff(c.enableGithubMirrors),
      routePolicy: c.routePolicy === 'accel-first' || c.routePolicy === 'direct-first'
        ? c.routePolicy
        : 'auto',
      logger,
      _cfg: c,
      _ui: uiState,
      _globalProxyUrl: globalProxy,
    };
  };

  /** Shared by the seam provider and the engine tool. */
  async function runSearch(query, explicitEngine, maxResults, signal) {
    if (!query || !String(query).trim()) throw new Error('query is required');

    // A hint we do not recognise is NOT silently dropped any more: the tool
    // layer throws on it, and the seam layer used to look like it worked.
    if (explicitEngine && !ENGINES[explicitEngine] && !COMPOSITES[explicitEngine] && !ENGINE_ALIASES[explicitEngine]) {
      logger?.warn?.(
        `websearch-direct: 未知引擎 "${explicitEngine}"，已忽略该提示并改用自动路由/默认顺序。` +
          `可用：${ALL_ENGINE_IDS.join(' / ')}`
      );
    }

    const c = opts();
    const cfg = resolved();
    const want = clampInt(maxResults, 1, 30, c.maxResults);
    const order = pickOrder(query, explicitEngine, cfg);

    const errors = [];
    const attempted = [];
    const skipped = [];
    const routes = {};
    for (const wanted of order) {
      // 别名（npmmirror / hf-mirror …）在这里拆成「真实引擎 + 指定路由」
      const engine = baseEngineId(wanted);
      const fn = ENGINES[engine] || COMPOSITES[engine];
      if (!fn) continue;
      if (!engineReady(wanted, cfg)) {
        skipped.push(wanted);
        errors.push(`${wanted}: 未配置（跳过）`);
        continue;
      }
      attempted.push(wanted);
      const pin = pinnedRoute(wanted);
      if (pin && !(ENGINES_META[engine]?.routes || []).some((r) => r.label.includes(pin))) {
        logger?.warn?.(`websearch-direct: 别名 "${wanted}" 指定的入口 "${pin}" 在 ${engine} 上不存在，退回该引擎全部入口。`);
      }
      try {
        const raw = await fn(String(query), {
          ...c,
          maxResults: want,
          signal,
          _routePin: pin,
        });
        const norm = normaliseResult(engine, raw);
        const sources = norm.items.slice(0, want);
        if (!sources.length) {
          errors.push(`${wanted}: 无结果`);
          continue;
        }
        errors.push(...norm.failures);
        Object.assign(routes, norm.routes);
        return {
          engine: wanted,
          baseEngine: engine,
          usedEngines: norm.usedEngines,
          routes,
          sources,
          content: renderSources(sources),
          attempted,
          errors,
          skipped,
        };
      } catch (err) {
        errors.push(`${wanted}: ${err.message}`);
        logger?.warn?.(`websearch-direct: ${wanted} 失败 — ${err.message}；尝试下一个引擎`);
      }
    }

    if (!attempted.length) {
      throw new Error(
        `没有可用的引擎可尝试（order=[${order.join(', ')}]，跳过=[${skipped.join(', ')}]）。` +
          `可用引擎：${ALL_ENGINE_IDS.join(' / ')}。${errors.join(' | ')}`
      );
    }
    throw new Error(`所有引擎均失败（已尝试 ${attempted.join(' → ')}）。${errors.join(' | ')}`);
  }

  ctx.effect(() =>
    ctx.web?.registerSearchProvider({
      id: 'websearch-direct',
      // No credentials to check: this provider is always ready, which is the
      // whole point — the agent never hits WEB_PROVIDER_CREDENTIAL_MISSING.
      available: () => true,
      async search(req, signal) {
        const r = await runSearch(req.query, req.engine, req.maxResults, signal);
        return { content: r.content, sources: r.sources, truncated: false };
      },
    })
  );

  ctx.effect(() =>
    ctx.web?.registerFetchProvider({
      id: 'websearch-direct',
      available: () => !isOff(resolved().enableFetch),
      async fetch(req, signal) {
        const c = opts();
        const maxChars = Number(resolved().fetchMaxChars) || DEFAULTS.fetchMaxChars;
        const { text: raw, via } = await fetchWithMirrors(req.url, { ...c, signal });
        const text = htmlToText(raw);
        const truncated = text.length > maxChars;
        return {
          url: req.url,
          statusCode: 200,
          body: {
            kind: 'text',
            content: truncated ? text.slice(0, maxChars) : text,
            ...(via ? { note: `GitHub 直连失败，经加速镜像 ${via} 抓取` } : {}),
          },
          truncated,
        };
      },
    })
  );

  /* Engine-aware tools. Registered only when dsh-tools is importable, so a
   * future API change degrades to "search still works, tool disappears"
   * instead of breaking the whole plugin. */
  if (defineTool) {
    ctx.inject(['tools'], (sctx) => {
      sctx.effect(() => {
        const dispose = sctx.tools.register(
          defineTool({
            name: 'web_search_engine',
            description: toolDescription(resolved()),
            parameters: {
              query: {
                type: 'string',
                required: true,
                description: '搜索关键词。代码类查询可直接写项目名或技术栈，如 "dsh plugin"、"python http client"。',
              },
              engine: {
                type: 'string',
                description:
                  `指定搜索源，可选 ${ALL_ENGINE_IDS.join(' / ')}；推荐 repo（代码多源合并）/ pkg（依赖包多源合并）；` +
                  '传 auto 或省略则自动路由。别名（如 npmmirror / hf-mirror）表示「强制走该源的某一条入口」。',
              },
              maxResults: {
                type: 'number',
                description: '返回条数（默认 8，最大 30）。',
              },
            },
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => {
                const used = value.routes && Object.keys(value.routes).length
                  ? Object.entries(value.routes)
                      .map(([e, r]) => `${ENGINES_META[e]?.label || e}→${r}`)
                      .join('，')
                  : '';
                const head =
                  `引擎: ${ENGINES_META[value.baseEngine]?.label || value.engine}` +
                  (value.usedEngines?.length > 1
                    ? `（合并来源: ${value.usedEngines.map((e) => ENGINES_META[e]?.label || e).join(' + ')}）`
                    : '') +
                  (value.degraded ? `（首选不可用，已降级；尝试顺序 ${value.attempted.join(' → ')}）` : '') +
                  (used ? `\n实际入口: ${used}` : '');
                return [{ type: 'text', text: `${head}\n\n${value.content}` }];
              },
            },
            execute: async (args) => {
              const engine = args.engine && args.engine !== 'auto' ? args.engine : undefined;
              if (engine && !ENGINES[engine] && !COMPOSITES[engine] && !ENGINE_ALIASES[engine]) {
                throw new Error(
                  `未知引擎 "${engine}"。可用：${ALL_ENGINE_IDS.join(' / ')}，或省略改用自动路由。`
                );
              }
              const r = await runSearch(args.query, engine, args.maxResults);
              // dsh 的工具结果要求"无损 JSON"：JSON.parse(JSON.stringify(v)) 必须与
              // 原值一致。`notes: undefined` 这种显式 undefined 字段会被 stringify
              // 丢掉，导致每次调用都在宿主的工具结果边界被拒（"value is not
              // lossless JSON"）—— 而且只在真宿主里现形，mock 直调 execute 抓不到。
              // 规矩：不确定就别放字段，用条件展开，绝不写 `: undefined`。
              return {
                query: args.query,
                engine: r.engine,
                baseEngine: r.baseEngine,
                usedEngines: r.usedEngines,
                routes: r.routes,
                attempted: r.attempted,
                degraded: r.attempted.length > 1,
                ...(r.errors.length ? { notes: r.errors } : {}),
                content: r.content,
                sources: r.sources,
              };
            },
          })
        );
        return () => dispose();
      }, 'websearch-direct: engine tool');
    });

    /* Prompt guidance sits immediately after the stock `web_search` section
     * (order 2000) so the engine list reads as part of the same block.
     * Registered defensively: a dsh without systemPrompt just skips it. */
    ctx.inject(['systemPrompt'], (pctx) => {
      pctx.effect(() => {
        try {
          return pctx.systemPrompt.section({
            name: 'tool:web_search_engine',
            order: 2005,
            text: () => enginePrompt(resolved()),
          });
        } catch {
          return () => {};
        }
      }, 'websearch-direct: engine prompt');
    });
  } else {
    logger?.info?.('websearch-direct: @deepseek-ai/dsh-tools 不可用，跳过 web_search_engine 工具注册');
  }

  /* ---- 设置卡片的数据面：GET/POST 配置 + 恢复默认（防御式注册） ---- */
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const json = (res, code, obj) => {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      const readBody = (req) =>
        new Promise((resolveBody, rejectBody) => {
          let data = '';
          req.on('data', (c) => {
            data += c;
            if (data.length > 1e6) req.destroy();
          });
          req.on('end', () => {
            try {
              resolveBody(data ? JSON.parse(data) : {});
            } catch (err) {
              rejectBody(new Error(`请求体不是合法 JSON：${err.message}`));
            }
          });
          req.on('error', rejectBody);
        });

      /** 应用卡片提交的增量：只动卡片拥有的字段。 */
      const applyUiUpdate = (body) => {
        if (body.apiKey !== undefined && typeof body.apiKey === 'string') {
          uiState.apiKey = body.apiKey.trim();
        }
        if (body.clearApiKey === true) uiState.apiKey = '';
        if (body.proxyUrl !== undefined && typeof body.proxyUrl === 'string') {
          uiState.proxyUrl = body.proxyUrl.trim();
        }
        if (body.routeOverrides && typeof body.routeOverrides === 'object') {
          // 入参形状：{ "<engineId>|<routeLabel>": { proxy?, url?, enabled? } | null }
          for (const [k, v] of Object.entries(body.routeOverrides)) {
            if (typeof k !== 'string' || !k.includes('|')) continue;
            if (v === null || v === undefined) {
              delete uiState.routeOverrides[k]; // 恢复默认
              continue;
            }
            const o = {};
            if (v && typeof v === 'object') {
              if (v.proxy === true || v.proxy === false) o.proxy = v.proxy;
              const u = asUrl(v.url);
              if (u) o.url = u;
              if (v.enabled === false) o.enabled = false; // 缺省即启用
            }
            if (Object.keys(o).length) uiState.routeOverrides[k] = o;
            else delete uiState.routeOverrides[k];
          }
        }
        if (body.routeExtras && typeof body.routeExtras === 'object') {
          // 入参形状：{ "<engineId>": [ { url, enabled? } ] }（按引擎整体替换）
          // enabled 必须落库：内置源追加入口的停用状态存在条目本身，
          // 只保留 url 会让客户端刚点的「停用」在下次读盘时丢失。
          for (const [engId, list] of Object.entries(body.routeExtras)) {
            if (typeof engId !== 'string' || engId.startsWith('custom-') || !Array.isArray(list)) continue;
            uiState.routeExtras[engId] = list
              .map((x) => ({ url: asUrl(x?.url), enabled: x && typeof x === 'object' && x.enabled === false }))
              .filter((x) => x.url)
              .slice(0, UI_CUSTOM_MAX)
              .map((x) => ({ url: x.url, ...(x.enabled ? { enabled: false } : {}) }));
          }
        }
        if (body.custom && typeof body.custom === 'object') {
          // 入参形状：{ "<catId>": [ { name, url, proxies: [ { url, enabled? } ] } ] }（按大类整体替换）
          // v3：代理条目可携带 enabled（启停状态存在条目本身，label 重排不影响）。
          for (const cat of UI_CATEGORY_DEFS) {
            const list = body.custom[cat.id];
            if (!Array.isArray(list)) continue;
            uiState.custom[cat.id] = list
              .slice(0, UI_CUSTOM_MAX)
              .map((x) => ({
                name: String(x?.name ?? '').trim().slice(0, 40),
                url: asUrl(x?.url),
                proxies: Array.isArray(x?.proxies)
                  ? x.proxies
                      .map((p) => ({
                        url: asUrl(p?.url ?? p),
                        ...(p && typeof p === 'object' && p.enabled === false ? { enabled: false } : {}),
                      }))
                      .filter((p) => p.url)
                      .slice(0, UI_CUSTOM_MAX)
                  : [],
              }))
              .filter((x) => x.url);
            // v2 僵尸键清理：v3 的启停状态存在 custom.proxies[i].enabled，而读取侧
            // 是「v3 条目 OR v2 键」的合并（见 uiSnapshot）。若不清掉 v2 遗留的
            // routeOverrides["custom-<cat>-N|代理 M"].enabled=false，它会永久压制
            // 条目上的「启用」—— 客户端点启用只 POST custom，永远碰不到那个键，
            // 于是变成「磁盘说已启用、界面说已停用、且无任何报错」的死循环。
            //
            // 🔴 只清 custom- 前缀：内置源追加入口（routeExtras 产生、无 proxyIndex）
            // 的停用状态至今仍依赖 routeOverrides，误删会直接打断该功能。
            const prefix = `custom-${cat.id}-`;
            for (const k of Object.keys(uiState.routeOverrides)) {
              if (k.startsWith(prefix)) delete uiState.routeOverrides[k];
            }
          }
        }
        saveUiState(uiState);
        installCustomEngines(uiState);
      };

      const resetUi = () => {
        uiState = structuredClone(UI_DEFAULT);
        try {
          unlinkSync(uiStateFile());
        } catch {
          /* 文件本来就不存在，等于已重置 */
        }
        installCustomEngines(uiState);
      };

      const d1 = wctx.webServer.register({
        kind: 'exact',
        path: '/dsh-websearch-direct/api/config',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') return json(res, 200, uiSnapshot(uiState));
            if (req.method === 'POST') {
              const body = await readBody(req);
              applyUiUpdate(body);
              return json(res, 200, { ok: true, ...uiSnapshot(uiState) });
            }
            return json(res, 405, { error: 'method not allowed' });
          } catch (err) {
            return json(res, 400, { error: err.message });
          }
        },
      });
      const d2 = wctx.webServer.register({
        kind: 'exact',
        path: '/dsh-websearch-direct/api/reset',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
            resetUi();
            return json(res, 200, { ok: true, ...uiSnapshot(uiState) });
          } catch (err) {
            return json(res, 400, { error: err.message });
          }
        },
      });
      return () => {
        d1();
        d2();
      };
    }, 'websearch-direct: settings card routes');
  });
}
