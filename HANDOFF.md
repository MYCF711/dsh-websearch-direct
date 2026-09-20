# dsh-websearch-direct 交接文档

> 面向接手的 agent。读完这份即可独立维护/二次开发这个插件。
> 最后更新：2026-09-21，版本 **v0.4.9**（修复 0.4.6 展开崩溃 + 0.4.7 入口行操作崩溃 + 0.4.8 tab 无文字/＋代理网址复制；已部署于 DSH Desktop 日常实例）。

---

## 0. ⚠️ 必读：浏览器半边的五个缺陷（0.4.6 / 0.4.7 / 0.4.8 → 0.4.9 全修）

**这两个版本的 `client/client.js` 都带着必崩缺陷出厂**，且都只在**展开卡片后**才触发。0.4.8 一次修完。

### 缺陷 A/B（0.4.6 出厂即坏）—— 展开卡片即崩

**现象**：卡片能出现，**一点标题行整张卡片就从列表消失**（每次必现；F5 后回来、再点又消失）。

```
ReferenceError: state is not defined   at Card (client.js:620)
❌ slot entry crashed in `settings.plugin.item`
```

| # | 缺陷 | 为什么"看着正常" |
| --- | --- | --- |
| A | 引用了不存在的 `state`（改名残留；真实绑定是 `statusMsg`/`error`/`saving`） | 三行位于 `!open ? null : …` 的**展开分支**，收起时从不求值 |
| B | `actionsRow` 被调用（L660、L704）但**整个函数体丢失** | 同样只在展开时执行 |

宿主对槽位条目是**按条目捕获并卸载**，所以症状是"整卡消失"而不是红屏。

### 缺陷 C（0.4.7 仍带）—— 点入口行的「×」/ 改网址即崩

**现象**（展开后点代理行的 ×）：`Uncaught TypeError: Cannot read properties of undefined (reading 'filter')` at `onRemoveEntry`。

**根因**：`Card` 里定义了 `decorate(src)`，作用是给每条 route 补 `allRoutes: src.routes`（以及 `engineId`/`custom`/`proxyIndex`），**但它从未被调用**（死代码）。而 `onUrlSave` / `onSwitch` / `onRemoveEntry` 三个 handler 全都读 `route.allRoutes`。`SourceBlock` 是**顶层函数**，看不到 `Card` 内部的 `decorate`，于是把**原始** `src.routes` 直接交给 `EntryRow` → `allRoutes === undefined`。

**0.4.8 的修法**（就地装饰，`SourceBlock` 不动）：

```js
// Card 的 render 里，创建 SourceBlock 时：
source: Object.assign({}, src, { routes: src.routes.map(decorate(src)) }),
```

⚠️ 注意**不能**写成 `src.routes.map(decorate(src))` 放进 `SourceBlock` 内部 —— `decorate` 不在那个作用域，会 `ReferenceError: decorate is not defined`（本会话踩过）。

**影响面**：`onRemove(route)` 与 `onUrlSave(route, url)` 都会崩（后者是"改代理网址"）；`onSwitch` 走的是另一分支，0.4.7 下侥幸不崩。

### 缺陷 D/E（0.4.8 仍带）—— tab 没文字 + 「＋代理网址」复制已有网址

**D. 两个一级 tab 按钮没有文字**：`TEXT.tabSources` / `TEXT.tabBasic` **从未在 TEXT 表里定义**（模板引用 `undefined` → 按钮渲染成空胶囊）。定稿文案见 `preview/卡片交互预览_v3.html` L194-195：**入口源管理 / 基础设置**。

**E. 点「＋ 代理网址」会把已有代理网址整批复制**：

```js
// 错误写法（0.4.8）
var urls = src.routes.map(r2 => ({ url: r2.url })).filter(r2 => isHttpUrl(r2.url));
```

`src.routes` 里**既有内置入口也有用户自己加的入口**，全量回传 `routeExtras` ⇒ 宿主把内置直连/备用当新条目追加 ⇒ 每次点击都翻倍。实测落盘证据：

```jsonc
// storages/websearch-direct/ui-config.json（用户只加过 1 条）
"routeExtras": { "bing": [ {"url":"https://cn.bing.com"}, {"url":"https://www.bing.com"},
                           {"url":"https://cn.bing.com"}, {"url":"https://www.bing.com"} ] }
```

**正确写法（0.4.9）**：内置源只回传「用户自己加的那些」——宿主快照里 `removable===true` 且非自定义源的路由就是 `routeExtras` 条目（宿主 `uiSnapshot` 的 `removable: !!r.extra || (isCustom && r.tier !== 0)`；`extra` 字段本身不外露，`removable` 是它唯一的对外投影）：

```js
var urls = src.routes.filter(r2 => r2.removable)
                      .map(r2 => ({ url: r2.url }))
                      .filter(r2 => isHttpUrl(r2.url));
urls.push({ url: "" });
```

**⚠️ 「保存」按钮灰着不是 bug**：`dirty` 只统计 Key / 全局代理（`keyVal`/`clearFlag`/`proxyVal`），与定稿预览 L190/L221 **完全一致**；入口行的一切改动（网址、开关、增删）都是**即时 POST 落盘**，不经过「保存」。实测：`ui-config.json` 会在操作瞬间更新 mtime。

### 为什么五个缺陷都能一路绿灯出厂

本项目**没有任何客户端组件测试**。`test-v0.4-ui.mjs`（40 例）只测宿主半边数据面（mock ctx + 直调 HTTP 路由），**从不渲染 React 组件** —— 展开分支从未被执行过。

### 修复

1. A：`state.status/error/saving` → `statusMsg` / `error` / `saving`
2. B：`actionsRow` 按 **`preview/卡片交互预览_v3.html` L203-232 的定稿实现重建**（恢复默认两段式防呆 4s 复位 → 放弃修改 → 保存；`saving || !dirty` 时保存禁用），handler 复用组件里已有的 `resetAll`/`discard`/`save`/`confirming`/`confirmTimer`
3. C：`decorate(src)` 接进 `SourceBlock` 的 `source`（见上）
4. D：补 `TEXT.tabSources` / `TEXT.tabBasic`（文案取自定稿预览）
5. E：`onAddProxy` 改为只回传 `removable` 路由（见上）

**新增的回归测试**（都在 `D:\DSH\tmp\wsd-install-check-20260921\`）：
- `test-client-card-expand.mjs` —— 展开态能渲染（4 判据）
- `test-client-remove-entry.mjs` —— 入口行三个 handler 不崩 + 删除后的 POST 载荷正确（6 判据）
- `test-client-buttons.mjs` —— **全量按钮审计**（25 判据）：每个按钮存在/有文字/点击行为正确，含 tab 文案、＋代理网址载荷、两段式恢复默认、放弃修改不落盘、保存灰置语义

两者都用 `renderToStaticMarkup` 驱动，**无浏览器**。关键手法见 §5 经验 15/16/17。

**红 → 绿证据链**（都是当场跑的）：

```
0.4.6 展开态：      ❌ ReferenceError: state is not defined        exit 1
修掉 A 之后：       ❌ ReferenceError: actionsRow is not defined   exit 1   ← 证明缺陷集恰好 A/B 两处
0.4.7 入口行 ×：    ❌ TypeError: ... reading 'filter'  at onRemoveEntry    ← 缺陷 C
0.4.8：             ✅ 展开 4/0 + 入口行 6/0                        exit 0
```

**教训**：`client.js` 的展开分支此前**从未被任何测试执行过**。"UI 有预览 HTML、用户看过定稿"不等于"实装代码能跑" —— 预览是独立实现，实装是另一份代码，两者必须各验一次。

---

## 1. 这个插件是什么

给 DeepSeek Harness（dsh）用的**免 API Key** 联网搜索 / 网页抓取插件。

- 引擎 = 逻辑源（GitHub、npm、HuggingFace、Bing…），入口 = 每个源下的具体网址（官方直连 / 加速镜像）
- 代码意图自动路由（repo/pkg 组合引擎并发多源合并）
- **不消耗任何模型 token**（模型只读返回的检索结果）
- v0.4 起带**设置页配置卡片**（dsh Web UI → 设置 → 插件）

## 2. 仓库与运行时位置

| 内容 | 路径 |
| --- | --- |
| 插件源码（交接主目录） | `C:/Users/Administrator/WorkBuddy/2026-09-19-19-14-44/dsh-websearch-direct/` |
| 打包产物（**§10 冻结基线对应件**） | `D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-0.4.6.tgz`（md5 `e8464f6572886ea1f3a4501efeb5c3f9`） |
| ~~旧指路~~（**已过期，勿用**） | ~~`D:/DSH/tmp/dsh-websearch-direct-0.4.6.tgz`（md5 `73bfbf92e5df97f45f65ef4578727c29`）~~ → 2026-09-21 实测：该件 `dist=30766AF9 / client=17A3FBA3 / package.json=7195C69E`，**三项均与 §10 冻结基线不符**；另 `D:/DSH/tmp/wsd-preflight/…0.4.6.tgz`（md5 `c6ddcde6330a82174960a462314032f9`）为 `dist=B8555455 / client=711EE88E / package.json=B538BB00`，dist 亦不符。**同名三件内容互异，选件必须按 §10 哈希判，不许按文件名或 mtime 判。** |
| 测试实例 profile | `D:/dsh-1/profiles/web/`（package.json 依赖指向上面的 tgz） |
| 网关 | 端口 43130，启动命令见 §7 |
| 运行时 UI 配置 | `<DSH_HOME>/storages/websearch-direct/ui-config.json`（测试实例 = `D:/dsh-1/storages/websearch-direct/ui-config.json`） |
| 归档（历史版本） | 源码目录 `_archive/`：`v0.3.1-qualified`、`v0.4.3-rejected` |

### 2.1 部署台账（2026-09-21 实测）

| 实例 | profile | 装的是什么 | 判定依据 |
| --- | --- | --- | --- |
| **DSH Desktop（用户日常）** | `C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web` | **0.4.9**（0.2.0 → 0.4.6 → 0.4.7 → 0.4.8 → 0.4.9） | 磁盘 `package.json` = 0.4.9；`dsh.client={"platform":"web"}`；`client/client.js` sha256前8=`A73C24E3`、`dist/index.js`=`7AC798EA`（宿主半边与 §10 基线逐字节相同）；manifest spec 与 lockfile 均指向 0.4.9 制品 |
| 测试实例 | `D:/dsh-1/profiles/web` | 0.4.6（**浏览器半边坏的**，未由本次会话升级） | 未由本次会话复验 |

⚠️ **制品台账（同名不同内容，选件必须按哈希判）**

| 版本 | 制品 | md5 | client.js sha256前8 | dist/index.js |
| --- | --- | --- | --- | --- |
| 0.4.6 | `D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-0.4.6.tgz` | `e8464f6572886ea1f3a4501efeb5c3f9` | `711EE88E`（**展开即崩**） | `7AC798EA` |
| 0.4.7 | `D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-0.4.7.tgz` | `6e1facdecd9e6e85920ad6cbdcad4604` | `97A7B6FD`（修了 A/B，**入口行操作仍崩**） | `7AC798EA` |
| 0.4.8 | `D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-0.4.8.tgz` | `d5109fdea2787b6acceebcd6c01d9701` | `A5DAC64B`（A/B/C 修，D/E 仍带） | `7AC798EA` |
| **0.4.9** | **`D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-0.4.9.tgz`** | **`e2ab74aa971a6649492fa4ed010783e0`** | **`A73C24E3`**（A–E 全修） | `7AC798EA` |

⚠️ **升级前的旧状态（供回滚参照）**
- Desktop 曾长期装 **0.2.0**（`D:/DSH/tmp/wsd-pkg/dsh-websearch-direct-0.2.0.tgz`）：`files` 白名单只有 `dist` + `cordis.patch.yml`、**无 `dsh.client`**、包内无 `client/` ⇒ 浏览器半边根本不存在 —— 这是「UI 写了却不生效」的根因（不是 UI 写错，是装错版本）。
- 升级备份：`package.json.bak-wsd046-20260921-025623`（0.2.0→0.4.6）、`pnpm-lock.yaml.bak-wsd046-…`、`package.json.bak-wsd047-20260921-031651`（0.4.6→0.4.7）、`pnpm-lock.yaml.bak-wsd047-…`、`package.json.bak-wsd048-20260921-032439`（0.4.7→0.4.8）、`pnpm-lock.yaml.bak-wsd048-…`、`package.json.bak-wsd049-20260921-033238`（0.4.8→0.4.9）、`pnpm-lock.yaml.bak-wsd049-…`。

⚠️ **升级方式**：`dsh plugin --profile web add file:D:/DSH/tmp/wsd-deploy/dsh-websearch-direct-<ver>.tgz`（走 Desktop 自带 pnpm 垫片；该垫片会为 Harness 运行中的实例做 EPERM 恢复，并**自动保护 generation 投影**，每次都输出 `excluded 1 / restored 1 generation projection(s)`）。副作用实测：**除本插件外，其余 16 个依赖、bundles 顺序（本插件仍在第 12 位）均零改动**。

⚠️ **打包注意**：`pnpm pack` 可用（app 内无 npm）；**给原生 exe 传参时不要加 `2>&1`** —— 本机实测加了会被沙箱拒绝（`程序'node.exe'运行失败：拒绝访问`），去掉即成功。



## 3. 源码结构

```
dsh-websearch-direct/
├── dist/index.js        宿主半边（全部逻辑）：引擎/路由/多源合并 + 设置数据面
├── client/client.js     浏览器半边（设置卡片 UI，react createElement 手写，无构建步骤）
├── cordis.patch.yml     bundle patch 清单（宿主按它加载本插件）
├── package.json         dsh.client={platform:web} + exports{./client}（卡片组合的依据）
├── test-v0.3.mjs        全量功能回归（all = 5 组）
├── test-v0.4-ui.mjs     设置卡片数据面测试（14 例）
└── preview/卡片交互预览_v3.html   UI 交互预览（纯前端模拟，交接演示用）
```

**宿主半边核心概念**（dist/index.js）：

- `ENGINES_META`：引擎→路由表。每条路由 `{label, base, tier}`，tier 0=直连、1=加速/代理
- `runEngine`：路由排序（健康度 + routePolicy + 卡片覆盖）→ 逐条尝试 → 健康度记录
- `runRoute`：单入口请求；支持卡片对 url/proxy 的逐入口覆盖
- `membersOf`：组合引擎成员（代码/包管理），自定义源按大类自动并入
- 设置数据面（`apply()` 内）：`settings.register('websearch-direct')` + HTTP 路由 `/dsh-websearch-direct/api/config`（GET/POST）、`/api/reset`（POST）

**数据模型 v2**（ui-config.json，卡片是唯一写者）：

```jsonc
{
  "version": 2,
  "apiKey": "",                    // 空=免Key直连；填=所有联网搜索用它（GitHub Token）
  "proxyUrl": "",                  // 全局代理，空=不走
  "routeOverrides": {              // 「引擎id|路由label」→ 覆盖
    "github|直连 api.github.com": { "url": "https://…", "enabled": false, "proxy": true }
    // enabled=false = 停用（代理行蓝色开关）；url = 改写入口网址；proxy = 走全局代理
  },
  "routeExtras": { "github": [ { "url": "" } ] },   // 给内置源追加的代理入口（空url=待填，运行时跳过）
  "custom": { "code": [ { "name": "哔哩哔哩", "url": "官方网址", "proxies": [ {"url": "代理网址"} ] } ], "pkg": [], "model": [], "web": [] }
}
```

- `BUILTIN_ROUTES` 出厂快照 + `syncUiRoutes()` 幂等重建（恢复默认不残留）
- 自定义源 = 克隆同类内置引擎定义只换 base（解析器/UA 继承）
- **即时生效**：卡片 POST → applyUiUpdate → saveUiState + installCustomEngines，不重启

**浏览器半边契约**（client/client.js）：

- `window.__ModuleLoader__.load({id, factory})` 包装；`apply(ctx)` 里 `ctx.inject(['settingsScope'])` 认领 `settings.plugin.item` 槽位（key = 宿主 settings 命名空间 `websearch-direct`）
- **纯度门槛**：不得 import `@deepseek-ai/dsh-client-ui-settings-plugins`；react / `@deepseek-ai/dsh-client-ui-primitives` 在平台基线模块表里，无需 `dsh.client.external`
- 原语缺失时静默 return（不弄白设置页）

**设置卡片 UI（定稿版）**：

```
一级抽屉（官方 PluginCard 外壳，--dsw-* 变量，chevron 展开/收起）
└─ 一级 tab 条：[入口源管理][基础设置]     右侧：未保存徽标/状态提示
   ├─ 入口源管理：可滚动(max-height 400)类目列表
   │   ▸ 代码仓库 5 个源 …（chevron 可折叠）
   │     源名 + [直连|代理 纯标记] + [可编辑网址输入框(失焦/回车即存)]
   │     代理行另带 [蓝色启停开关] + [×]；每源「＋ 代理网址」；每类「＋ 添加自定义源」
   └─ 基础设置：官方字段模板（标签行徽标右置 / 通栏输入框 / 说明另起一行 / 字段间分隔线）
   每个 tab 内容右下角动作行：[恢复默认(两段式防呆)][放弃修改][保存]，无分隔线
   网址 normUrl 自动补 https://；入口增删/改网址/切开关全部即时 POST 生效
```

## 4. API（插件自有路由）

| 方法/路径 | 作用 |
| --- | --- |
| GET `/dsh-websearch-direct/api/config` | v2 快照（categories→engines→routes 含 key/url/type/enabled/switchable/removable/empty） |
| POST 同路径 | 增量合并：`{apiKey?, clearApiKey?, proxyUrl?, routeOverrides?, routeExtras?, custom?}`；override 传 null = 恢复默认 |
| POST `/dsh-websearch-direct/api/reset` | 删配置文件 + 回出厂（幂等） |

搜索能力走 dsh 标准 seam：`web.registerSearchProvider` / `web.registerFetchProvider` + `@deepseek-ai/dsh-tools` 的 `web_search_engine` 工具（可选依赖，缺失自动降级）。

## 5. 关键经验 / 坑（踩过的，别再踩）

### 打包与部署

1. **pnpm 对同版本 `file:` tgz 会命中缓存**——重新打包后必须 `pnpm update <包名>` 强刷，普通 `pnpm install` 不够。
2. **client 半边改动走 HMR 热刷，不用重启网关**（宿主监听 artifact 变化 → rebuilt()）；宿主半边（dist）改动必须重启。
3. `npm pack` 前确认 `files` 字段含 `client`（漏了卡片组合会因缺 bundle 响亮报错）。
4. 验证上线三步：插件 API `curl --noproxy '*' http://127.0.0.1:<port>/<pkg>/api/config` 200；首页（带 token，`-L` 跟随 303）的 `__DSH_BOOT__` 里 grep 自己的 `client.js`；下载 `/plugins/??…` 组合包 `node --check` 语法。

### 宿主沙箱

5. 启动网关**必须 `--no-open`**（否则拉浏览器触发沙箱 reg.exe 黑名单，进程被杀）；用 `Bash run_in_background=true` 起。
6. 本机 curl 一律 `--noproxy '*'`（全局代理劫持 localhost 返回 502）。
7. **测试脚本 cwd 必须在 WorkBuddy node workspace**（`C:/Users/Administrator/.workbuddy/binaries/node/workspace`），否则 undici / `@deepseek-ai/dsh-tools` 解析不到（代理测试会假失败）。
8. GUI 程序 / 无头浏览器（agent-browser 的 snapshot/screenshot）常被沙箱 SIGTERM——UI 验证交给用户浏览器，或用 DOM shim 模拟点击做逻辑验证。

### UI/交互（用户多轮定稿的结论）

9. **先出可点击 HTML 预览、用户定稿后再实装**——这次流程证明能省大量返工；预览文件放 `preview/`。
10. 用户口味：字段用官方模板（标签行徽标右置/通栏输入框/说明另起一行）；动作按钮右下角、顺序 恢复默认→放弃修改→保存、恢复默认不用 ghost 样式；一切改动"即时生效"，主保存只管 Key/全局代理。
11. 网址输入**必须自动补 `https://`**（用户会直接输 `www.bilibili.com`，纯 isHttpUrl 校验会让保存按钮永远禁用）。
12. 对 `render()` 全量重建的 UI 写自动化点击测试时，**每次点击后必须重新从根取节点**（旧引用是拆除前的树）。
15. 🔴 **"预览定稿"≠"实装跑过"**：预览 HTML 是**另一份独立实现**，实装 `client/client.js` 是另一份代码。0.4.6 的教训 —— 用户在预览上定的稿没问题，实装里展开分支却带着 `state`/`actionsRow` 两处必崩缺陷出厂，因为**没有任何测试执行过实装代码的展开分支**。回归测试见 §0 末（`test-client-card-expand.mjs`）。
16. 🔴 **写客户端组件测试时，必须在 `factory()` 之前替换 `react.useState`**：bundle 在 factory 期就执行了 `var useState = react.useState`（client.js L18-21）**捕获引用**，事后打补丁对组件**完全无效**（本会话踩过：patch 打完渲染仍然全绿，其实是根本没进展开分支 —— 假绿）。
17. **展开分支的崩溃在页面上表现为"整张卡片从列表消失"**，而不是红屏或错误提示：宿主对槽位条目是**按条目捕获并卸载**（`slot entry crashed in settings.plugin.item`）。所以"卡片没了"要优先怀疑**展开时求值的那些表达式**（收起态不执行）。
18. 🔴 **定义在 `Card` 内部的 helper，顶层子组件看不到**：`decorate` 定义在 `Card` 里，而 `SourceBlock` 是顶层函数 —— 直接在 `SourceBlock` 里调 `decorate(src)` 会 `ReferenceError: decorate is not defined`。正确做法是在 `Card` 的 render 里就地装饰后再传下去（`source: Object.assign({}, src, { routes: src.routes.map(decorate(src)) })`）。
19. 🔴 **"定义了"≠"被调用"**：`decorate` 是**死代码**（全文件只有定义、零调用点），3 个 handler 却都依赖它补的字段。写完 helper 要搜一遍调用点；静态检查"函数存在"完全抓不到这类缺陷。**判据**：`Select-String -Pattern 'decorate'` 只命中定义行 = 它从未生效过。
20. **测试渲染到"类目"一层还不够**：`CategoryBox` 的 children 在 `open=false` 时返回 `null`，`EntryRow` 不会被创建。入口行级断言必须同时把 `openCats` 置为 `{<catId>: true}`（见 §6）。

### 其他

13. 用户明确要求：**测试实例未经允许不准 kill**；改配置要重启时先问。
14. dsh 插件"自带浏览器半边就拥有自己的卡片"三件套：settings 命名空间 + 自有 HTTP 数据面 + `settings.plugin.item` 槽位——这是 dshmarket 验证过的模式，照抄即可。

## 6. 测试

```bash
cd C:/Users/Administrator/.workbuddy/binaries/node/workspace   # cwd 决定依赖解析
node D:/DSH/tmp/wsd-work/dsh-websearch-direct/test-v3-model.mjs   # 宿主半边 v3 模型，期望 28/0
node D:/DSH/tmp/wsd-work/dsh-websearch-direct/test-v0.4-ui.mjs    # 宿主半边数据面，期望 40/0
```

**客户端半边的回归测试（0.4.7/0.4.8 新增，无浏览器）**：改任何 `client.js` 都必须跑这两条。

```bash
$NODE = "D:/DSH Desktop/resources/app/node_modules/node/bin/node.exe"
$T    = "D:/DSH/tmp/wsd-install-check-20260921"

& $NODE $T/test-client-card-expand.mjs   <被测 client.js 路径>   # 期望 4 通过 / 0 失败
& $NODE $T/test-client-remove-entry.mjs  <被测 client.js 路径>   # 期望 6 通过 / 0 失败
```

| 套件 | 覆盖 | 对 0.4.6 | 对 0.4.7 | 对 0.4.8 |
| --- | --- | --- | --- | --- |
| `test-client-card-expand.mjs` | 展开态能渲染（不抛错 / `wsd-tabs` / `wsd-scroll` / 头部） | ❌ `state is not defined` | ✅ 4/0 | ✅ 4/0 |
| `test-client-remove-entry.mjs` | 入口行 `onRemove`/`onSwitch`/`onUrlSave` 不崩 + 删除载荷正确 | — | ❌ 4 红（含 `reading 'filter'`） | ✅ 6/0 |

⚠️ 这两个套件都靠**替换 `react.useState`** 把组件驱动到展开态，且必须让 **`cardOpen`(第 8 个) 与 `openCats`(第 10 个) 同时为真** —— 只展开卡片、不展开类目的话，`EntryRow` **根本不会被创建**（`CategoryBox` 在 `open=false` 时返回 `null`），入口行测试会**假红/空转**。本会话踩过。

⚠️ 上表 `test-v3-model` / `test-v0.4-ui` 只覆盖**宿主半边**：它们 mock ctx + 直调 HTTP 路由，**从不渲染 React 组件**。这就是 A/B/C 三个客户端缺陷能一路绿灯出厂的原因。

注意：UI 测试会写 `~/.dsh/storages/websearch-direct/ui-config.json`（shim 环境），与线上配置（`D:/dsh-1/...`）互不影响。

## 7. 启动 / 重启网关（测试实例）

```bash
cd /d/dsh-1 && DSH_HOME='D:\dsh-1' \
  "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
  "C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --port 43130 --no-open \
  > "D:/DSH/tmp/_gw-43130.log" 2>&1
# （用 run_in_background 起；启动后从日志取本次 token：http://127.0.0.1:43130/?token=…）
```

## 8. 已知限制 / 未决

## 9. 已知残留与设计债（本次发布未修）

> 面向接手者：这三条是**静默缺陷**，不动代码也能遗留到下一个周期。必须写清，否则下一个人会重复踩。

### 三条核心已知残留 / 设计债

| 编号 | 一句话描述 | 触发边界 / 复现条件 | 状态 |
|---|---|---|---|
| **F3** | 内置源 `routeExtras` 启停**按 label 存**，删除前序条目后状态**转移到错误的行**。 | **错位 ⟺ 删除的条目位于被停用条目之前（d < p）**，3/6 组合最典型；对照 `custom.proxes` 完全正确 ⇒ 坐实「未做 v3 迁移」。 | **t13 评估：不阻塞发布**（触发需 ≥2 条 extra + 停用非首条 + 删其前面条目）。已记入 README；**后续任务做位置锚定迁移**（给 extra 路由加 `extraIndex`，与 v3 对 `custom.proxies` 的做法对齐）。⚠️ **不要用「重写时补写 `enabled`」**：会把默认启用固化成条目并可能覆盖 `routeOverrides` 的用户显式停用。 |
| **F3'** | **测试覆盖缺口**：删掉运行时停用判断后 `test-v0.4-ui.mjs` **38/0 全绿**（零判别力），仅 `V3-5c` 抓到。 | 运行时正对照原先不在册套件。 | **✅ 已闭合（套件侧）**：正对照 + 运行时 fetch 拦截已并入两套 —— `V3-9a/b`、`U12a/b`。复验：同样变异下 UI **38/2**（`U12b`/`U10f` 报红）、V3 **26/2**（`V3-9b`/`V3-5c` 报红）。正对照落地时当场抓到一次测试自身缺陷（配置写进 `search` 的 `_ui` 而非磁盘 ⇒ 请求静默落到 bing）。 |
| **F1** | `custom-<catId>-<n>` 解析三处重复，依赖「catId 不含 `-`」隐式约定；当前不可达，将来会三处同时静默错位。 | catId 不含 `-`（code/pkg/model/web 均满足）⇒ 路径永远走对；未来加含 `-` 的 catId 会三处静默失效。 | **未修（已知设计债，本次发布不动代码）**。计划发布后做：抽出 `parseCustomEngineId()` 三处共用 + 在 `UI_CATEGORY_DEFS` 加**启动即检闸门**（含 `-` 直接抛错）。⚠️ 曾实现过一版（`3C08F553`）后按用户裁定**回滚**，故当前 `dist` 内**不存在** `parseCustomEngineId`。 |

### 其他残留（低优先）

| 编号 | 内容 | 状态 |
|---|---|---|
| 残留 A | `＋代理网址` 对内置源是加空位行、对自定义源是弹表单，交互不统一 | 低优先 |
| 残留 B | 越界 `routeOverrides` 键永久残留无 GC；**清理只能针对 `custom-` 前缀**（内置源 extra 停用仍依赖该键） | **未修，计划发布后处理**。方案：`normaliseUiState` 丢弃失效键，且 `loadUiState` 仅在**确实丢键**时回写磁盘（否则下次读盘键又回来）。边界须由 `V3-8`/`U11d-f` 两条回归锁住。⚠️ 曾实现过一版（`3C08F553`）后按用户裁定**回滚**。 |

### 管线状态

- **F3'** 的运行时正对照待并入在册套件（t3 建议），不在本次发布。
- **F1** 待重构 `parseCustomEngineId()`，不在本次发布。

## 10. 冻结基线（本会话交付版本哈希）

```
dist/index.js       sha256(前 16)=7AC798EA
test-v3-model.mjs   sha256(前 16)=F37E115C
test-v0.4-ui.mjs    sha256(前 16)=2696CBDE
client/client.js    sha256(前 16)=711EE88E
package.json        sha256(前 16)=B538BB00
README.md           sha256(前 16)=8F3E5D1A
```

⚠️ **预检全绿**（本次发布校验报告在 `D:/DSH/tmp/wsd-preflight/PREFLIGHT.md`）：
- `npm pack --dry-run` entryCount=6（**LICENSE 在内**）、BOM 全无、`package.json` 合法（`license=GPL-3.0-only`）
- 无污染文件、无额外输出

⚠️ 若实际不符，**本基线不继承**，需重跑校验命令。

## 11. 复跑命令（交付后验证方式）

```bash
cd C:/Users/Administrator/.workbuddy/binaries/node/workspace
node D:/DSH/tmp/wsd-work/dsh-websearch-direct/test-v3-model.mjs   # 期望 26/0
node D:/DSH/tmp/wsd-work/dsh-websearch-direct/test-v0.4-ui.mjs    # 期望 38/0
```

⚠️ **退出码必须用可信通道**：`spawnSync(..., {stdio:'ignore'})` 读 `status`，或 sentinel `.cmd` + `%ERRORLEVEL%`。
⚠️ **piped stdio 本机恒空**（`run_in_background=true` 模式下 stdout/stderr 被重定向到 `$null`），空输出≠通过 —— 本会话已有多人因此写出错误结论。

⚠️ **`test-v0.3.mjs` 的 `[F1]/[F2]` 不可作交付判据**：依赖外部网络，wsd-verify 实测**同一 dist 哈希上跑出三种判定**（GitHub 403↔401 漂移）。

## 12. 本次修了哪些静默缺陷（简要）

- v2 兼容成死代码（`entry` 恒为真致三元短路）
- `normaliseUiState` / `applyUiUpdate` / `uiSnapshot`+`runEngine` 三处 `routeExtras` 丢 `enabled`
- **F1 僵尸键**：`applyUiUpdate` 的 custom 分支未清理 v2 `routeOverrides` 键，导致"点启用不生效、磁盘说已启用、界面弹回、无报错"

