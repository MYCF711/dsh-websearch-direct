# dsh-websearch-direct 交接文档

> 面向接手的 agent。读完这份即可独立维护/二次开发这个插件。
> 最后更新：2026-09-20，版本 v0.4.6（已部署于测试实例并线上运行）。

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
| 打包产物 | `D:/DSH/tmp/dsh-websearch-direct-0.4.6.tgz`（md5 `73bfbf92e5df97f45f65ef4578727c29`） |
| 测试实例 profile | `D:/dsh-1/profiles/web/`（package.json 依赖指向上面的 tgz） |
| 网关 | 端口 43130，启动命令见 §7 |
| 运行时 UI 配置 | `<DSH_HOME>/storages/websearch-direct/ui-config.json`（测试实例 = `D:/dsh-1/storages/websearch-direct/ui-config.json`） |
| 归档（历史版本） | 源码目录 `_archive/`：`v0.3.1-qualified`、`v0.4.3-rejected` |

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

### 其他

13. 用户明确要求：**测试实例未经允许不准 kill**；改配置要重启时先问。
14. dsh 插件"自带浏览器半边就拥有自己的卡片"三件套：settings 命名空间 + 自有 HTTP 数据面 + `settings.plugin.item` 槽位——这是 dshmarket 验证过的模式，照抄即可。

## 6. 测试

```bash
cd C:/Users/Administrator/.workbuddy/binaries/node/workspace   # cwd 决定依赖解析
node C:/Users/Administrator/WorkBuddy/2026-09-19-19-14-44/dsh-websearch-direct/test-v0.3.mjs all    # 引擎/回归，16✅
node C:/Users/Administrator/WorkBuddy/2026-09-19-19-14-44/dsh-websearch-direct/test-v0.4-ui.mjs     # 数据面，14✅
```

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

