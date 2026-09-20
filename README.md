# dsh-websearch-direct

给 DeepSeek Harness（dsh）用的 **免 API Key** 联网搜索 / 网页抓取插件。

零配置装上就能用：不填任何 Key、不走任何 LLM、不消耗模型 token。
模型自己读取返回的检索结果 —— 也就是让 dsh 里的 agent 获得和「联网搜索工具」一样的能力。

**v0.4 起内置设置卡片**：dsh Web UI → 设置 → 插件 → 「联网搜索（直连优先）」，
可配 API Key（可选）、全局代理、按入口开关代理、添加自定义网址、一键恢复默认，
改动即时生效、无需重启。

## v0.4：设置页卡片（浏览器半边）

设置 → 插件 页里属于本插件的栏位，实现遵循 dsh 的「插件自带浏览器半边就拥有
自己的卡片」契约（与 dshmarket 同一套机制）：

| 组成 | 位置 | 作用 |
| --- | --- | --- |
| settings 命名空间 | 宿主半边 `settings.register('websearch-direct', …)` | 让「插件配置」标签页列出本插件 |
| HTTP 数据面 | `/dsh-websearch-direct/api/config`（GET/POST）、`/api/reset`（POST） | 卡片读写配置；改动**即时生效**（Key/代理/路由排序/自定义引擎全部热更新，无需重启） |
| 浏览器半边 | `client/client.js`（`dsh.client` 声明 + `./client` 出口） | 认领 `settings.plugin.item` 槽位（key=`websearch-direct`），渲染卡片 |

卡片能力：

- **API Key（可选）**：留空 = 免 Key 直连（默认，走本机直连出口而非 agent 模型）；
  填写 = 代码仓库引擎改用此 Key（GitHub Token）提高频率上限。密码框不回显现值。
- **全局代理地址**：留空不走全局代理；填了之后单入口的代理开关才对非镜像入口生效。
- **四大类优先入口**：代码仓库（GitHub/GitLab/Codeberg/Gitea/Gitee）、包管理
  （npm/crates/Packagist/NuGet/RubyGems）、模型仓库（HuggingFace）、网页搜索
  （Bing 中国/百度/DuckDuckGo）。每个入口一行：名称 + 实际地址 + 直连/加速标记，
  行可展开，展开后是**「此入口走代理」开关** —— 开了排到最前并走代理
  （加速镜像类入口本身就是代理性质），关了强制直连，改过会标「已改」可单条恢复。
- **添加自定义网址**：每个大类下小按钮添加（上限 8 条），按兼容类型接入 ——
  代码仓库=Gitea 兼容、包管理=npm registry 兼容镜像、模型仓库=HF 镜像兼容、
  网页搜索=Bing 兼容。自定义引擎自动并入对应的多源合并搜索。
- **恢复默认（防呆）**：两段式确认（点一次变「⚠ 确认恢复默认？」，4 秒不点自动
  退回），执行后清空 Key/代理/全部开关/自定义网址。

配置持久化在 `<DSH_HOME>/storages/websearch-direct/ui-config.json`，与 cordis
配置解耦：卡片是这个文件的唯一写者。

## 它解决什么

| 通道 | 凭据要求 | 联网方式 | 模型 token |
| --- | --- | --- | --- |
| 官方 `deepseek-official` | 必须 `DEEPSEEK_API_KEY` | DeepSeek 服务端 | 每次搜索烧一整轮 |
| `dsh-web-search-free` | 必须 Tavily / Exa / Jina / Brave… 的 Key | dsh 宿主进程直连**海外**端点 | 0 |
| `delef/dsh-free-web-search` | 无（10 引擎 fallback） | 直连海外 + Bing | 0 |
| **本插件** | **无** | dsh 宿主进程直连**国内可达**端点（可配代理） | 0 |

> `delef/dsh-free-web-search` 功能更全，但它 **import 了
> `@deepseek-ai/dsh-settings` 的 `installSettingsSection`**，
> 而该导出在 dsh-settings `0.1.5-rc.2` 里已被移除，实测报
> `does not provide an export named 'installSettingsSection'`
> —— 在 dsh 0.1.5-rc.2 上**装得上但加载失败**。
> 本插件对它用到的每个 `@deepseek-ai/*` 包都做**可选导入 + try/catch**，
> 解析不到就降级（最差情况只是少一个工具，搜索本身照常），
> 因此不受这类破坏性变更影响。

## v0.3：引擎 = 逻辑源，入口 = 路由

v0.2 只有一个 `github` 引擎；v0.3 把"代码搜索"从单一来源扩成一组源，
并且明确区分了两个概念 —— 这是 v0.3 最重要的设计，也是踩过坑之后才想清楚的：

- **引擎（engine）= 逻辑源**：一份仓库集合、一个包生态、一个搜索引擎。
- **路由（route）= 指向同一份内容的入口**：直连、镜像、加速代理、第三方索引。

> **同一个源的镜像不占第二个引擎位。**
> `github` 在引擎列表里只出现一次；`api.github.com`、`gh-proxy.com`、
> `gh-proxy.org`、`cors.isteed.cc` 都是它下面的**路由**。
> 这样 `repo` 多源合并的成员是「GitHub / GitLab / Codeberg / Gitea」四个
> **源**，而不是被几个镜像撑成十几条、同一份仓库在结果里出现两遍。

路由按顺序自动回退，**结果里会标出实际走的是哪条入口**（`routes` 字段 +
每条结果的 `via`）。失败的入口会在本次会话内被排到后面，下次仍从第一条开始试
—— 所以不是"永久拉黑"，外部网络恢复后不需要重启插件。

### 引擎与路由（2026-09 实测，本机直连 + HTTP 代理双路验证）

| 引擎 | 入口（按默认顺序） | 说明 |
| --- | --- | --- |
| `github` | `api.github.com`(直连) → `gh-proxy.com` → `gh-proxy.org` → `cors.isteed.cc`（均为 API 加速） | 匿名限流约 10 次/分钟，`githubToken` 可提高上限 |
| `gitlab` | `gitlab.com` | GitLab.com 公开项目 |
| `codeberg` | `codeberg.org` | **必须用自报 UA**，见下 |
| `gitea` | `gitea.com` | Gitea / Forgejo 生态 |
| `gitee` | `gitee.com` | 搜索 API **必须带令牌**，未配置则自动跳过 |
| `npm` | `registry.npmjs.org` → `registry.npmmirror.com` → `mirrors.cloud.tencent.com/npm` | 后两条是同一份包数据的镜像 |
| `crates` | `crates.io` → `rsproxy.cn` | |
| `packagist` | `packagist.org` | |
| `nuget` | `azuresearch-usnc` → `azuresearch-ussc` | |
| `rubygems` | `rubygems.org` | |
| `maven` | `search.maven.org` | 引擎可用但**不在 `pkg` 默认成员里**，见下 |
| `huggingface` | `hf-mirror.com`(镜像) → `huggingface.co`(直连) | 本机直连不可达，默认先走镜像 |
| `bing` | `cn.bing.com` → `www.bing.com` | 通用网页，**默认引擎** |
| `baidu` | `www.baidu.com` | 中文网页 |
| `duckduckgo` | `html.duckduckgo.com` → `lite.duckduckgo.com` | 本机实测两个入口都不可达，排在末位 |

组合引擎（一次搜索并行查多个**源**，按来源轮转合并）：

- `repo` = `github` + `gitlab` + `codeberg` + `gitea`（配了 Gitee 令牌还会带上码云）
- `pkg` = `npm` + `crates` + `packagist` + `nuget` + `rubygems` + `huggingface`

成员列表可用 `repoEngines` / `pkgEngines` 改。

### 路由别名（强制走某条入口）

| 别名 | 等价于 |
| --- | --- |
| `npmmirror` | `npm` 的 `registry.npmmirror.com` 入口 |
| `hf-mirror` | `huggingface` 的 `hf-mirror.com` 入口 |
| `gh-proxy` / `ghproxy` / `github-mirror` | `github` 的 `gh-proxy.com` 入口 |

> v0.2 里 `npmmirror` 是一个独立引擎。它和 `npm` 查的是同一份包数据，
> 只是访问路径不同，所以按"同一个源只占一个引擎位"降级成了路由。
> 旧写法 `engine="npmmirror"` 仍然能用，语义变成"强制走这条路由"。

### UA 挂在路由上，不挂在插件上

这一点非常反直觉，是实测出来的，值得单独记：

| 端点 | 完整浏览器 UA | 自报 bot UA |
| --- | --- | --- |
| `codeberg.org/api/v1/...` | **403**（连 `/api/v1/version` 都 403） | **200** |
| `crates.io/api/v1/...` | 200 | 200（但 `curl/8` UA 被 403） |
| `cn.bing.com/search` | 200 | 200（内容偏少） |

Codeberg 的 WAF 会专门拦「完整浏览器 UA」——一个像浏览器的 UA 打 API、
却不带其他浏览器指纹，看起来最像脚本。所以 API 入口用诚实的自报 UA
（`dsh-websearch-direct/0.3 (+https://workbuddy.cn)`），网页入口才用浏览器 UA。

### 明确排除的候选（都实测过，别再试）

| 候选 | 为什么不用 |
| --- | --- |
| `ghproxy.net` / `ghfast.top` 代理 API | 只代理 raw 文件，代理 API 一律 403（但抓 raw 文件时它们仍然可用） |
| `kkgithub.com`、`gh.llkk.cc`、`gitclone.com`、`hub.gitmirror.com`、`ghps.cc`、`ghp.ci`、`mirror.ghproxy.com`、`ghproxy.homeboyc.cn`、`cors.eu.org`、`api.codetabs.com`、`api.allorigins.win` | 实测不可达或返回非 JSON |
| `repos.ecosyste.ms` | **HTTP 200、JSON 结构也合法，但完全忽略查询参数** —— `query`/`q`/`search`/加排序四种写法返回同一个固定列表，全是 `0/...` 这种垃圾仓库。教训：**200 不等于可用，可用性探测必须验证"换个查询词结果会变"** |
| `grep.app` | 持续 429（本机 IP 被限流） |
| `searchcode.com` | API 已下线（404） |
| PyPI 搜索 | 官方 `/search/` 已是 JS 前端，返回 3KB 挑战页；`/simple/` 全量索引 46MB 不可用。按精确包名查元数据可抓 `https://pypi.org/pypi/<name>/json` |
| `salsa.debian.org`、`invent.kde.org`、`gitlab.gnome.org` | 可达，但搜索域只覆盖各自项目库，通用关键词命中率近 0，收录只会白增延迟 |
| `bitbucket.org` API | 404（已要求鉴权） |
| `mirrors.ustc.edu.cn`、`mirrors.tuna.tsinghua.edu.cn`、`mirrors.aliyun.com` | 只镜像**下载**，不提供搜索 API |

### 为什么 `maven` 不在 `pkg` 默认成员里

`search.maven.org` 从本机实测**极不稳定**：同一个 UA 一次 200、一次 15 秒超时，
三轮测量成功率约 1/3。组合引擎的耗时取决于最慢的成员，把它放进默认成员只会
让每一次 `pkg` 搜索白等一个 12 秒超时（实测 `pkg` 从 2.6 秒被拖到 25 秒）。
引擎本身保留，需要时用 `engine="maven"` 或把它加回 `pkgEngines`。

组合引擎另有一个**成员级超时上限**（`compositeMemberMs`，默认 12000）：
被放弃的成员会出现在 `failures` 里，不会静默消失。

## 三处一起作用，缺一不可

1. **`web_search_engine` 工具** —— 带 `engine` 参数，模型可以显式点名；
   工具描述里逐个写明每个引擎"搜什么、什么时候用、有哪些入口"。
2. **系统提示引导段落**（`order: 2005`，紧跟原生 `web_search` 那段）——
   工具描述只告诉模型"有什么"，这段告诉它"该挑哪个"，才是真正改变行为的东西。
3. **seam 层自动路由** —— 即使模型仍然调用原生 `web_search`（它没有 `engine` 参数），
   插件也会自己判断：命中代码/仓库/插件意图 → `repo`，依赖包意图 → `pkg`，
   否则按 `engineOrder`。这是"零 token 成本"的兜底。

引擎和入口两个层级都会自动降级：入口挂了换下一条入口，整个引擎挂了换下一个引擎。

> 注意区分**两种失败**：`403/429/5xx` 和网络错误才算「入口不可用」，
> 会被本次会话降级；`401/400/404` 说明入口本身是通的，只是这次凭据不对或
> 东西不存在，**不计入降级**。早先没区分，一次无效 token 触发的 401 让后续
> 所有 GitHub 搜索都绕去第三方加速代理。

### 实测（v0.3.1，测试实例 `D:/dsh-1`，mock ctx + 真实网络）

```
########## A. 逐引擎真跑（engine 显式指定）
  gitlab     OK  1136ms 条数=4     codeberg  OK 7947ms 条数=4
  gitea      OK  1737ms 条数=4     npm       OK 1365ms 条数=4
  npmmirror  OK   557ms 条数=4     crates    OK  806ms 条数=4
  packagist  OK   715ms 条数=4     nuget     OK 1047ms 条数=4
  rubygems   OK   330ms 条数=4     gitee     跳过（未配置令牌，明确报错而非假装无结果）

########## B. 组合引擎（一次搜索查多个源）
  repo("wechat")  6075ms 8 条 → github.com + gitlab.com + codeberg.org + gitea.com  ✅ 覆盖 4 个托管站
  pkg("wechat")   2577ms 8 条 → npmjs + crates.io + packagist + nuget + rubygems + hf-mirror  ✅ 覆盖 6 个源
  自动路由: "dsh plugin"→repo | "npm registry 镜像"→pkg | "杭州天气"→bing

########## C. 缺陷回归（v0.2 试用报告发现的 4 个）
  D1 代理 dispatcher 真的生效（黑洞端口导致全部入口失败，错误信息点名代理）  ✅
  D2 engineOrder 全非法 → 回退默认顺序，不再抛残缺错误                      ✅
  D3 enableFetch 'false'/'0'/'no'/'off' 均判为关闭                          ✅
  D4 seam 层未知引擎不再静默，warn 并列出可用值                             ✅

########## E. 路由模型
  R1 别名 npmmirror → 归一为 npm 并 pin 到该镜像入口                        ✅
  R2 结果携带实际入口（routes + sources[].via）                             ✅
  R3 routePolicy 改变入口顺序（direct-first→api.github.com / accel-first→gh-proxy.com） ✅
  R4 auto 策略：huggingface 冷启动直接走镜像，2557ms（省掉 13s 直连超时）    ✅
  R5 真实回退 + 失败入口降级：第 1 次 11096ms，第 2 次 478ms                ✅
  R6 repo 成员是逻辑源，无重复                                              ✅

### 数据模型（v3）与引擎 id 的显式闸门

UI 配置的数据模型版本见 `UI_MODEL_VERSION`（当前 **3**）：

- **v1 → v2**：`custom` 从 `{label,url,proxy}` 变成 `{name,url,proxies[]}`
- **v2 → v3**：自定义代理的启停状态从 `routeOverrides["<engId>|代理 N"]`（按 label 定位，
  删除代理后 label 重排 → 状态错位）移进 **`custom.proxies[i].enabled`**（按数组位置定位）

读盘对 v1/v2/v3 均兼容（`normaliseUiState` 归一化）；测试约定每个用例独占 `DSH_HOME`，
因为引擎 id（`custom-<catId>-N`）与 label（`代理 N`）都**按位置生成**，跨用例必撞。

**引擎 id 解析的隐式约定（未修，已知设计债）**：自定义源引擎 id 形如 `custom-<catId>-<srcNo>`，
解析时按**最后一个 `-`** 切分。该逻辑目前在 **3 处各写一遍**（约 L1070-1071、L1639-1641、L1648），
全部依赖「catId 不含 `-`」这一**未写入代码的隐式约定** —— 将来新增含 `-` 的类目会三处同时静默错位
（不报错、测试全绿、状态挂到别的源）。

当前四类目（`code`/`pkg`/`model`/`web`）均不含 `-`，故**当前不可达**。
**本次发布未修**，计划发布后做：抽出单一 `parseCustomEngineId(engId)` 三处共用，
并在 `UI_CATEGORY_DEFS` 定义处加**启动即检**的闸门断言（含 `-` 直接抛错）。

### 已知限制（内置源多入口场景下的状态错位）

内置源的 `routeExtras`（自定义加速入口）**停用状态按 label 存**（如
`github|自定义代理 2`），而删除/重写时 label 会随位置重排 ⇒ 出现：

1. 内置源（如 github）有 ≥2 条 extra，用户停用了**第 2 条 B**；
2. 再删除 **A**（B 前面的那条）；
3. B 的停用状态会**静默转移到错误的行**：从未停用的 B 被误关，用户视角是「我关的是 A，怎么 B 被关了」。

**世代说明**：t6 起（当前哈希 `t6`），停用逻辑迁入 `routeExtras[i].enabled`，旧版依赖
`routeOverrides` 键的方式在**新序列下不再写入该键**。因此「键仍在」只对≤BC7BC505 的旧哈希成立。

**qf-a 补丁效果**：实测「每次重写都带 `enabled`」**能消除本次错位面**；「固化默认启用」是另一类设计权衡，
不应当作「不解决本缺陷」的理由。

> ⚠️ **切勿采用「重写时补写 `enabled`」的修法**：它把「默认启用」固化成条目字段，
> 并可能**覆盖 `routeOverrides` 里用户的显式停用** —— 那是把状态来源从「一个」变成「两个」，正是 F1 的成因。
> 正确方向是**位置锚定迁移**（见下），与 v3 对 `custom.proxies` 的做法对齐。

**评估：不阻塞本次发布。** 触发条件较窄 —— 需同时满足
①内置源有 **≥2 条** extra；②停用的是**非首条**；③再**删除它前面**的条目。
后续任务应做**位置锚定迁移**（给 extra 路由加 `extraIndex`，状态按位置回查条目本身），
即可与 v3 对自定义代理的处理完全对齐、彻底消除本限制。

后果不只是「丢失」，而是**转移到错误的行**：停用 A、删 A 后，**从未停用的 B 会突然被停用**。

规避方法：

- 操作前先在设置里把目标条目改为「启用」，或
- 完成删除后重新设置一次（关闭再打开该条目的代理开关）。

以上断言全部通过。回归脚本见 `test-v0.3.mjs`，重跑命令：
`DSH_HOME=D:/dsh-1 node test-v0.3.mjs all`

### 已知限制 F3'（测试覆盖缺口）—— **已补（套件侧）**

变异测试（删掉 `runEngine` 两处运行时停用判断）曾暴露：

```
test-v0.4-ui.mjs  → 38 通过 / 0 失败   🔴 零判别力
test-v3-model.mjs → 25 通过 / 1 失败   ❌ V3-5c 抓到
```

⇒ 当时**`test-v0.4-ui.mjs` 对运行时停用机制无判别力**，`V3-5c` 是唯一护栏。

**已补**：把运行时正对照（**正对照 + 运行时 fetch 拦截**）并入两套在册套件：

- `test-v3-model.mjs`：`V3-9a`（正对照）/ `V3-9b`（停用项未被请求）
- `test-v0.4-ui.mjs`：`U12a`（正对照）/ `U12b`（停用项未被请求）

**正对照为什么必须有**：先证明「启用的那条确实被请求了」，否则「停用项没被请求」
可能只是仪器根本没走到该引擎（两边都没命中也会显示"通过"）。
t13 落地时正对照**当场抓到一次真实的测试自身缺陷** —— 初版用例把配置写进 `search` 的
`_ui` 入参，而引擎注册读的是**磁盘配置**，于是请求静默落到 `bing`，被正对照逮住。

### 已知限制 F1（设计债：含 `-` 类目会错位）

`custom-<catId>-<n>` 解析在代码里**三处重复**（约 L1070-1071、L1639-1641、L1648），
依赖「catId 不含 `-`」**隐式约定**。当前四类目（code/pkg/model/web）均无 `-` ⇒ **不可达**；
将来加含 `-` 类目会**三处同时静默错位**。这是已知设计债，已计划修复，本次不动代码。

### 已知限制 F2（越界 routeOverrides 键残留）—— **未修，计划发布后处理**

磁盘上「`custom-` 前缀但对应源/代理序号已不存在」的键（如 `custom-code-5|代理 1`，
只有 1 个源）**永久残留、无 GC**。计划在 `normaliseUiState` 加清理，
并在 `loadUiState` 检测到**确实丢弃了键**时回写磁盘（仅内存清理的话，下次读盘键又会回来）。

🔴 **清理时只清 `custom-` 前缀**：内置源追加入口（`routeExtras`）的停用状态至今依赖 `routeOverrides`，
误删会直接打断该功能 —— `V3-8` / `U11d-f` 是专门锁这条边界的回归用例。

### 真宿主验证（headless，模型真调工具）

mock 直调 `execute` 只能证明业务逻辑对，不证明**工具边界**对 —— 这里翻过一次车：
v0.3.1 首次真宿主冒烟发现**每次成功调用都被宿主拒绝**
（`value is not lossless JSON`，因为干净成功时返回了 `notes: undefined`，
嵌套 undefined 被 stringify 丢键 → 与原值不一致）。

修复后复验（headless，宿主内工具边界 3/3 通过）：

```
a) repo / "dsh plugin"    usedEngines=[GitHub+GitLab 命中]  routes=api.github.com 直连、gitlab.com 直连
b) pkg / "wechat"         usedEngines=[npm/crates/Packagist/NuGet/RubyGems/HuggingFace]
                          routes=各源直连，仅 HuggingFace→hf-mirror.com
c) npmmirror / "react"    =「npm 引擎 + npmmirror 镜像入口」，返回 react/react-is/react-dom
三次均无 degraded / notes，无 "value is not lossless JSON"
```

> 规矩（已写进 `dsh-plugin-dev` §14.6）：**工具输出必须能无损往返 JSON，
> 不确定就别放字段，绝不写 `: undefined`**；测试脚本里要替宿主把这道门
> （深度找 `undefined` + JSON 往返比对），并保留一条"真宿主内模型真调工具"的冒烟。


`dsh-web-search-free` 装好后会把 web 通道指向自己，而它的可用性判断是
「配置里有没有至少一个 Key」——没填 Key 时 `available()` 恒为 false，
表现就是**装了插件之后搜索反而用不了**，很容易被误判成「网络连不上」。

本插件的 `available()` 恒为 true，且默认引擎（Bing CN、百度）直连可达，
不依赖任何外部服务与凭据。

## 实测（本机，直连无代理）

```
直连 / 无代理（等同 dsh 运行环境）
available(search) = true
sources = 8, content chars = 1458
  [1] DeepSeek 2026 最新模型怎么选：V4 Pro、V4 Flash 与 ...
      https://www.aifreeapi.com/zh/posts/deepseek-models-2026
      ...（带完整摘要）

web_fetch
chars = 6005  truncated = false
```

## 安装

插件目录放到 dsh 能解析的位置，并在 profile 里登记为 bundle：

1. 复制 `dsh-websearch-direct/` 到 `harness\profiles\web\node_modules\`
2. 编辑 `harness\profiles\web\package.json`：
   - `dependencies` 加 `"dsh-websearch-direct": "0.1.0"`
   - `dsh.profile.bundles` **追加** `"dsh-websearch-direct"`
   - **同时移除**其他搜索插件的 bundle 行（`dsh-web-search-free`、
     `dsh-free-web-search` 等），否则它们会和本插件抢同一个 `web` 通道；
     若那个插件加载失败，整个插件树会崩，dsh 直接起不来
3. 重启 DSH Desktop

> 安装脚本见 `install.mjs`，会完成上述 1、2 两步并自动备份 `package.json`。
> 改完必须重启 dsh，bundle patch 只在启动时组合。

## 为什么"零依赖"是关键

dsh 处于 developer preview，`@deepseek-ai/dsh-*` 的 API **会破坏性变更**。
只要插件 import 了这些包，就可能在某次 dsh 升级后直接加载失败——而且
**`--dump-config` 看不出来**（它只组合配置树，不 import 插件代码），
必须真的 `import()` 一次才会暴露。

本插件的策略是**依赖全部可选**，并且用一条多基址解析链去找它们：

```js
// 顺序尝试：插件自身位置 → 当前工作目录 → 正在启动的 profile（从 argv 读 --profile）
//           → $DSH_HOME/profiles/node_modules
createRequire(base).resolve('@deepseek-ai/schemastery')
```

因为 `import('@deepseek-ai/x')` 是从**导入文件自身所在目录**往上找 `node_modules`，
正常安装（`profiles/<p>/node_modules/<pkg>/`）没问题，但**链接/挂载进来的插件会全部解析不到**。

拿不到时的降级：

- 拿不到 `schemastery` → **不导出 `Config`**（见下），设置页里看不到表单，搜索照常
- 拿不到 `dsh-tools` → 跳过 `web_search_engine` 注册，原生 `web_search` 的
  **自动路由依然生效**（路由在 seam 层，不依赖工具）

> ⚠️ **不能拿普通对象冒充 `Config`。** Cordis 的解析是
> ```js
> if (!runtime.Config) return config
> const result = runtime.Config['~standard'].validate(config)   // 标准 schema 协议
> ```
> 所以导出一个「没带 `~standard` 的默认值对象」，会让 `.validate` 变成对 `undefined`
> 取方法 —— **整棵插件树直接崩**，和"优雅降级"正好相反。
> 正确做法是干脆**不导出 `Config`**（导出 `undefined` 即可），Cordis 会把配置原样透传，
> `apply` 里自己 merge 默认值。这个 bug 是在 headless 测试实例里实测出来的。

## 配置项（设置 → 插件 → websearch-direct，也可直接用默认值）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `proxyUrl` | 空（直连） | 填 `http://127.0.0.1:7890` 之类的代理后，海外端点才可用 |
| `engineOrder` | `bing, baidu, duckduckgo` | 引擎轮询顺序，前一个失败自动换下一个 |
| `autoRoute` | true | 识别到代码意图 → `repo`，依赖包意图 → `pkg` |
| `routePolicy` | `auto` | 同一源的多个入口谁先试。`auto`：按引擎实测情况（直连可用就先直连，本机实测直连不可达的如 HuggingFace 先走镜像）；`direct-first` / `accel-first`：全局强制 |
| `repoEngines` | github, gitlab, codeberg, gitea, gitee | `repo` 合并包含哪些源 |
| `pkgEngines` | npm, crates, packagist, nuget, rubygems, huggingface | `pkg` 合并包含哪些源 |
| `githubToken` | 空 | 可选，只用于提高 GitHub API 频率上限。**只发给 `api.github.com` 直连入口**，不会随请求发给第三方加速代理 |
| `giteeToken` | 空 | Gitee 搜索 API 必需，未配置时 `gitee` 引擎自动跳过 |
| `enableGithubMirrors` | true | 抓 `raw.githubusercontent.com` / `github.com` 失败时自动改用加速镜像重试 |
| `maxResults` | 8 | 每次返回条数 |
| `timeoutMs` | 15000 | 单请求超时 |
| `compositeMemberMs` | 12000 | 组合引擎中单个成员的上限，超时则该成员被放弃并记入 `failures` |
| `fetchMaxChars` | 20000 | 抓取正文上限 |
| `enableFetch` | true | 是否允许 `web_fetch`。**严格解析**：`false` / `'false'` / `'0'` / `'no'` / `'off'` 都算关闭 |

### 凭据不会被转发给第三方

第三方加速代理会看到整条请求。所以 `githubToken` 只挂到 `tier 0`（权威直连）
入口上；走加速入口时一律匿名（宁可撞匿名限流，也不把 PAT 交给无关第三方）。
测试里用无效 token 做了取证：直连入口命中 401（证明 token 确实带上了），
随后加速入口匿名成功（证明 token 没外流）。

### 关于代理

dsh 是你手动启动的桌面应用，**不会继承** WorkBuddy 注入的
`HTTP_PROXY` / `HTTPS_PROXY`（我这边的 agent 有，所以能联网，dsh 没有）。
所以 dsh 默认是纯直连。不配代理也能用（Bing CN、百度、各代码/包站点直连可达，
本插件的路由表就是照"国内直连可达"筛的）；想用 DuckDuckGo 之类的海外端点再填 `proxyUrl`。

> ⚠️ 代理解析链有两个已修的真坑，改动这块代码前请先读 `dist/index.js` 顶部的注释：
> 1. `undici` 的解析结果**缓存的是 Promise 而不是结果** —— 早先的写法在
>    `await` 之前就置了「已尝试」标志，组合引擎并发发起请求时，后到的调用
>    拿到还没赋值的 `null`，于是「undici 不存在」被当成结论，整条代理链静默失效。
>    只在「一次搜索里并发多个 HTTP 请求」时现形，串行测试抓不到。
> 2. `ProxyAgent` 和 `fetch` 必须来自**同一个** undici 实例。跨实例的
>    `new ProxyAgent()` 交给全局 `fetch` 会被拒（`TypeError: fetch failed`）。

## 文件

```
dsh-websearch-direct/
  package.json           # dsh 插件声明（bundle patch 指向 cordis.patch.yml）
  cordis.patch.yml       # 把 web seam 的 search/fetch provider 指向本插件
  dist/index.js          # 插件主体（引擎表 + 路由执行层 + 组合合并）
  dist/index.v0.2.js.bak # v0.2 备份，便于对比
  test-v0.3.mjs          # 验证脚本：engines | composite | fixes | routes | all
  probe-routes.mjs       # 路由可用性实测（含"换个查询词结果会变"的内容校验）
  probe-ua.mjs           # UA × 端点矩阵
  probe-proxy.mjs        # 代理 dispatcher 取证
  install.mjs            # 安装脚本
```

跑验证：

```bash
DSH_HOME=D:/dsh-1 node test-v0.3.mjs all
```
