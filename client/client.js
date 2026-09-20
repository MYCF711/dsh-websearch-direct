/**
 * dsh-websearch-direct — 浏览器半边（设置 → 插件 → 联网搜索（直连优先）卡片）
 *
 * v0.4.4 定稿版（用户预览稿拍板）：
 *   - 五个大类框，全部带下拉箭头标识（可点击展开/收起，展开旋转）
 *   - 代码仓库 = 各源直连入口（源名 + 直连标记 + 可编辑网址）
 *   - 代理仓库 = 独立大类，按网址类分组（GitHub / GitLab / 自定义源…），
 *     每组「＋ 代理网址」追加、每条可 × 移除、无代理的组显示「暂无代理网址」
 *   - 包管理 / 模型仓库 / 网页搜索：每源全部入口行内展示
 *   - 自定义源：源名称 + 官方网址建源，代理在代理仓库管理，源可移除
 *   - 外壳沿用 dshmarket 复刻的官方 PluginCard 视觉（--dsw-* 变量）
 */
window.__ModuleLoader__.load({ id: "dsh-websearch-direct", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;

	var react = require("react");
	var ui = require("@deepseek-ai/dsh-client-ui-primitives");

	var createElement = react.createElement;
	var useState = react.useState;
	var useEffect = react.useEffect;
	var useRef = react.useRef;

	var Input = ui.Input;
	var Button = ui.Button;
	var Switch = ui.Switch;

	var NS = "websearch-direct";
	var API = "/dsh-websearch-direct/api";

	/* ------------------------------------------------------------ 文案 */

	var TEXT = {
		title: "联网搜索（直连优先）",
		description: "免 Key 直连搜索与代码仓库聚合，不消耗模型 token。",
		/* 一级 tab 条（定稿见 preview/卡片交互预览_v3.html L194-195） */
		tabSources: "入口源管理",
		tabBasic: "基础设置",
		apiKey: "API Key",
		apiKeyHint: "留空 = 免 Key 直连（默认）；填写后所有联网搜索使用此 Key。",
		apiKeySet: "已配置",
		apiKeyUnset: "未配置",
		apiKeyPlaceholderKeep: "已配置，留空保持不变",
		apiKeyPlaceholderEmpty: "输入 Key",
		clearKey: "清除",
		proxyTitle: "全局代理地址",
		proxyHint: "例如 http://127.0.0.1:7890。留空 = 不走全局代理。",
		/* 机制徽章（定稿 B-R2）：由 tier 判定，**不用 route.type** ——
		   type 实为「是否走全局 ProxyAgent」的传输层设置（dist/index.js:1001），
		   用它标机制是误称。 */
		direct: "直连",
		accel: "加速",
		sourcesUnit: " 个源",
		addProxy: "＋ 代理网址",
		proxyUrlPlaceholder: "代理网址 https://…",
		/* D2：同源重复网址（用户裁定：红字提示 + 不可保存，只比同源） */
		dupUrl: "该网址与同源另一条入口重复",
		dupSummary: "存在重复网址，无法保存",
		removeSource: "移除源",
		addSource: "＋ 添加自定义源",
		sourceName: "源名称（如：哔哩哔哩）",
		sourceUrl: "官方网址 https://…",
		save: "保存",
		cancel: "取消",
		remove: "×",
		saving: "保存中…",
		discard: "放弃修改",
		resetAll: "恢复默认",
		resetAllConfirm: "确认恢复默认？",
		saved: "已保存，即时生效。",
		loadFailed: "配置加载失败：",
		saveFailed: "保存失败：",
		dirty: "未保存",
	};

	/* ------------------------------------------------------------ 样式 */

	function ensureStyle() {
		if (typeof document === "undefined") return;
		if (document.querySelector("style[data-wsd-card]")) return;
		var tag = document.createElement("style");
		tag.dataset.wsdCard = "1";
		tag.textContent = [
			".wsd-setCard{list-style:none;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;transition:border-color .16s,background .16s}",
			".wsd-setCard:hover{border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
			".wsd-setCardOpen{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
			".wsd-setHeader{appearance:none;-webkit-appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".wsd-setHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
			".wsd-setHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".wsd-setName{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}",
			".wsd-setDesc{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:1.5}",
			".wsd-setChevron{color:var(--dsw-alias-label-tertiary,#8b93a1);flex:none;transition:transform .16s;display:inline-flex}",
			".wsd-setChevronOpen{transform:rotate(180deg)}",
			".wsd-setBody{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin:0 16px;padding-bottom:8px}",
			".wsd-setRow{align-items:center;gap:12px;padding:12px 0;display:flex}",
			".wsd-setRow+.wsd-setRow{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}",
			".wsd-setLabelBox{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}",
			".wsd-setLabel{font-size:13px;line-height:20px}",
			".wsd-setHint{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:18px}",
			".wsd-setActions{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".wsd-tag{font-size:10.5px;padding:1px 7px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#8b93a1);white-space:nowrap}",
			".wsd-tag.on{border-color:rgba(48,150,90,.55);color:#2c9c5c}",
			".wsd-cat{border:0.5px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;overflow:hidden;margin-top:8px}",
			".wsd-cat-head{display:flex;align-items:center;gap:8px;width:100%;padding:9px 12px;background:none;border:0;cursor:pointer;font:inherit;text-align:left}",
			".wsd-cat-head:hover{background:rgba(127,127,127,.06)}",
			".wsd-chevron{transition:transform .16s;font-size:11px;opacity:.55;display:inline-block}",
			".wsd-cat-body{padding:4px 12px 10px}",
			".wsd-src-head{display:flex;align-items:center;gap:8px;padding:6px 0 2px}",
			".wsd-src-name{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#8b93a1);letter-spacing:.4px}",
			".wsd-entry{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0}",
			".wsd-entry .wsd-input{flex:1;min-width:0}",
			/* 机制徽章（用户裁定：**不可点击**，纯标识）。弹性宽度（预留四字）。 */
			".wsd-mech{flex:none;min-width:44px;padding:2px 9px;text-align:center;font-size:11px;line-height:16px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#8b93a1);background:transparent;font-family:inherit;cursor:default;user-select:none;transition:opacity .16s,border-color .16s,color .16s}",
			/* 「加速」档：语义绿按 R2 实测取值（亮 green-900 / 暗 green-100），不套 alias token */
			".wsd-mech.accel{border-color:var(--dsw-static-green-500,#22c55e);color:var(--dsw-static-green-900,#233c2c)}",
			/* 圆点开关（用户裁定④：改回来承载启停）。停用 ≠ 删除：只翻 enabled。 */
			".wsd-entry .wsd-switch{flex:none}",
			/* 停用态 = 整行降透明（条目与网址都保留）。 */
			".wsd-entryOff{opacity:.45}",
			/* D2/D3：红色小字提示（错误色取 R2 实测值：亮 red-900 / 暗 red-50） */
			".wsd-errText{font-size:11px;line-height:16px;color:var(--dsw-static-red-900,#570c0c);padding:2px 0 0 52px}",
			".wsd-input.invalid{border-color:var(--dsw-static-red-500,#ef4444)}",
			/* 警告珀（"默认走镜像" 徽标）：亮 amber-900 / 暗 amber-100 */
			".wsd-warnTag{border-color:var(--dsw-static-amber-500,#f59e0b);color:var(--dsw-static-amber-900,#27241f)}",
			".wsd-link{background:none;border:0;padding:0;font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;opacity:.6;white-space:nowrap}",
			".wsd-link:hover{opacity:1}",
			".wsd-linkbtn{font-size:11px}",
			".wsd-del{flex:none;width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l2,#e5e7eb);background:0 0;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:0}",
			".wsd-del:hover{color:var(--dsw-static-red-900,#570c0c);border-color:var(--dsw-static-red-500,#ef4444)}",
			".wsd-form{display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap}",
			".wsd-form input{font-size:12px}",
			".wsd-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:5px 10px;font:inherit;font-size:12.5px}",
			".wsd-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-1px}",
			".wsd-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
			".wsd-status.err{color:var(--dsw-static-red-900,#570c0c)}",
			".wsd-tabs{display:flex;align-items:center;gap:4px;padding:8px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e7eb);}",
			".wsd-tabbtn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;border:0.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;}",
			".wsd-tabbtn:hover{background:rgba(127,127,127,.08)}",
			/* G6：原用不存在的 --dsw-alias-bg-info（暗色对比度仅 1.13:1）；
			   改用实测存在的 bg-multi-select（亮 17.46 / 暗 15.38）。 */
			".wsd-tabbtn.active{background:var(--dsw-alias-bg-multi-select,#e6ecfd);color:var(--dsw-alias-brand-primary,#3b5bdb);font-weight:600;border-color:rgba(79,110,247,.35)}",
			".wsd-tabRight{margin-left:auto;display:flex;align-items:center;gap:8px;}",
			/* 语义色暗色分支：亮色极深 / 暗色极浅，两队最差 ≥11:1（R2 实测） */
			"@media (prefers-color-scheme:dark){.wsd-mech.accel{color:var(--dsw-static-green-100,#e6faed)}.wsd-errText,.wsd-status.err{color:var(--dsw-static-red-50,#fef2f2)}.wsd-warnTag{color:var(--dsw-static-amber-100,#fef5e7)}.wsd-del:hover{color:var(--dsw-static-red-50,#fef2f2)}}",
			/* G5.2：窄宽度换行 */
			".wsd-scroll{max-height:400px;overflow-y:auto;overflow-x:hidden;margin:10px 0 4px;padding-right:4px;}",
		].join("\n");
		document.head.appendChild(tag);
	}

	function isHttpUrl(v) {
		return /^https?:\/\//i.test(String(v || "").trim());
	}

	/** 网址规范化：无前缀的域名自动补 https://（如 www.bilibili.com）。 */
	function normUrl(v) {
		var t = String(v || "").trim();
		if (!t) return "";
		if (!/^https?:\/\//i.test(t)) {
			if (/^[\w.-]+\.[a-z]{2,}$/i.test(t) || /^[\w.-]+\.[a-z]{2,}\//i.test(t)) t = "https://" + t;
			else return "";
		}
		return t;
	}

	/* -------------------------------------------- 重复网址校验（单一判定处） */

	/**
	 * 同源重复网址判定 —— **全插件唯一的重复逻辑**，两条路径共用：
	 *   ① 内置源「＋ 代理网址」追加的 routeExtras 条目；
	 *   ② 自定义源建源 / 自定义代理条目。
	 *
	 * 用户裁定口径：**只比同一源内，跨源不比较**；重复 ⇒ 红字提示 + 禁止保存。
	 *
	 * 复数形式同时给出「重复键集合」与「是否本次提交被拦」，供渲染与提交前校验共用，
	 * 避免同一条规则在两处各写一份（写两份迟早漂移）。
	 *
	 * @param {Array} routes 该源的入口数组，元素需含 key 与 url（或 base）
	 * @returns {{dupKeys:Object, hasDup:boolean}}
	 */
	function findDuplicateUrls(routes) {
		var seen = Object.create(null);
		var dupKeys = Object.create(null);
		(Array.isArray(routes) ? routes : []).forEach(function (r) {
			if (!r) return;
			/* 空网址是「待填写」占位，不参与重复判定（否则新增的空行会互判重复） */
			var u = keyOfUrl(r.url !== undefined && r.url !== "" ? r.url : r.base);
			if (!u) return;
			if (seen[u]) { dupKeys[r.key] = true; seen[u].forEach(function (k) { dupKeys[k] = true; }); }
			else seen[u] = [];
			seen[u].push(r.key);
		});
		return { dupKeys: dupKeys, hasDup: Object.keys(dupKeys).length > 0 };
	}

	/** 单条网址是否与「同源其它入口」重复 —— 供新增输入栏做即时校验。 */
	function isDuplicateUrl(routes, key, url) {
		var u = keyOfUrl(url);
		if (!u) return false;
		var hit = false;
		(Array.isArray(routes) ? routes : []).forEach(function (r) {
			if (!r || r.key === key) return;
			var other = keyOfUrl(r.url !== undefined && r.url !== "" ? r.url : r.base);
			if (other && other === u) hit = true;
		});
		return hit;
	}

	/** 重复比较用的规范化键：trim + 小写（大小写与首尾空白不构成"不同网址"）。 */
	function keyOfUrl(v) {
		return String(v || "").trim().toLowerCase();
	}

	/* ---------------------------------------------------------- 组件 */

	/** 类目框：下拉箭头标识 + 可展开/收起。 */
	function CategoryBox(props) {
		var open = props.open;
		return createElement("div", { className: "wsd-cat" },
			createElement("button", {
				className: "wsd-cat-head",
				type: "button",
				onClick: function () { props.onToggle(!open); },
			},
				createElement("span", {
					className: "wsd-chevron",
					style: { transform: open ? "rotate(90deg)" : "none" },
				}, "▸"),
				createElement("span", { className: "wsd-setLabel", style: { flex: 1 } }, props.title),
				props.tag ? createElement("span", { className: "wsd-tag" }, props.tag) : null),
			open ? createElement("div", { className: "wsd-cat-body" }, props.children) : null);
	}

	/**
	 * 入口行（用户裁定 v0.4.11）：
	 *   [机制徽章 **纯标识，不可点**] + [网址：**恒为输入框**] + [圆点开关（switchable 时）] + [×]
	 *
	 * 三条用户裁定：
	 *   - 「直连和加速改成不可点击」⇒ 徽章回归纯标识（去掉 onClick / aria-pressed / onMechClick）。
	 *     被点也没有任何副作用，故不再需要「受约束切换」那套阻断与提示。
	 *   - 「网址改成之前那种在输入框的」⇒ 撤销「只读 span → 点击变编辑 / isEditing / onEdit / onCancelEdit」。
	 *   - 「把圆点开关改回来」⇒ 启停由独立圆点开关承载。
	 *
	 * 机制由 **tier** 判定（不是 route.type）。停用态用整行降透明表达，
	 * **不删条目、不清空网址**（停用 ≠ 删除）—— 开关只翻转 enabled。
	 */
	function EntryRow(props) {
		var route = props.route;
		var isDirect = route.tier === 0;
		var enabled = route.enabled !== false;
		var isDup = !!props.dupKeys[route.key];

		/* 网址输入框的取值来源（优先级）：
		 *   ① route.draft —— 用户正在输入的待提交草稿（由 Card 从 pending 投影出来）
		 *   ② route.url   —— 宿主快照的真实网址
		 *
		 * 🔴 为什么不再用「本地 useState 草稿 + isEditing」：
		 *   宿主按位置生成 key（`自定义代理 ${i+1}`），删掉中间条目后后续 key 前移、
		 *   与旧 key 复用；本地草稿会把上一行的内容显示到新行上（错位，t8 已踩过）。
		 *   现在 value 直接投影自「快照 + pending 草稿」这条**唯一数据源**，
		 *   输入即时可见，且不存在跨行复用。
		 */
		var val = route.draft !== undefined ? route.draft : (route.url !== undefined ? route.url : "");

		var badgeCls = "wsd-mech" + (isDirect ? "" : " accel");
		var badgeTitle = isDirect ? TEXT.direct : TEXT.accel;

		var row = createElement("div", { className: "wsd-entry" + (enabled ? "" : " wsd-entryOff") },
			/* 机制徽章：**纯标识**，不是按钮、无 onClick、无 aria-pressed。 */
			createElement("span", {
				className: badgeCls,
				title: badgeTitle,
			}, isDirect ? TEXT.direct : TEXT.accel),

			/* 网址：**恒为输入框**。输入即时写入草稿（乐观），失焦时落 pending 载荷。 */
			createElement(Input, {
				className: "wsd-input" + (isDup ? " invalid" : ""),
				value: val,
				placeholder: route.empty ? TEXT.proxyUrlPlaceholder : "",
				/* data-key：既是可观测标识（测试/排查用），也便于将来做行级定位 */
				"data-key": route.key,
				onChange: function (e) { props.onUrlDraft(route, e.target.value); },
				onBlur: function () { props.onUrlSave(route, val); },
				onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); },
				spellCheck: false,
			}),

			/* 圆点开关：承载启停（route.switchable 时才有）。**停用 ≠ 删除**。 */
			route.switchable
				? createElement(Switch, {
					checked: enabled,
					"data-key": route.key,
					"aria-label": (isDirect ? TEXT.direct : TEXT.accel) + "·" + (enabled ? "已启用" : "已停用"),
					onChange: function (next) { props.onSwitch(route, next); },
				})
				: null,

			route.removable
				? createElement("button", {
					className: "wsd-del",
					type: "button",
					title: "移除（会删除条目）",
					onClick: function () { props.onRemove(route); },
				}, TEXT.remove)
				: null);

		/* 行内红字提示：D2 同源重复（每条都提示）。
		   ⚠️ D2 **必须保留** —— 用户截图上的那条红字就是它生效的证据。 */
		if (!isDup) return row;
		return createElement("div", null, row, createElement("div", { className: "wsd-errText" }, TEXT.dupUrl));
	}

	/** 源块：源名（+自定义源移除）+ 全部入口行 + ＋ 代理网址。 */
	function SourceBlock(props) {
		var src = props.source;
		/* 重复判定走**唯一实现** findDuplicateUrls（模块级），两条路径共用 */
		var dup = findDuplicateUrls(src.routes);
		return createElement("div", { key: src.id },
			createElement("div", { className: "wsd-src-head" },
				createElement("span", { className: "wsd-src-name" }, src.label),
				src.custom
					? createElement("button", {
						className: "wsd-link",
						type: "button",
						onClick: function () { props.onRemoveSource(src); },
					}, TEXT.removeSource)
					: null),
			src.routes.map(function (route) {
				return createElement(EntryRow, {
					key: route.key,
					route: route,
					dupKeys: dup.dupKeys,
					allRoutes: src.routes,
					onUrlDraft: props.onUrlDraft,
					onUrlSave: props.onUrlSave,
					onSwitch: props.onSwitch,
					onRemove: props.onRemoveEntry,
				});
			}),
			createElement("div", { style: { padding: "2px 0 4px" } },
				createElement(Button, {
					size: "sm",
					className: "wsd-linkbtn",
					onClick: function () { props.onAddProxy(src); },
				}, TEXT.addProxy)));
	}

	/**
	 * 添加自定义源的内联表单：源名称 + 官方网址。
	 *
	 * 用户裁定（t8）：
	 *   - 「自定义不允许键入当前重复的网址」⇒ 同源内查重，重复则**可见拒绝 + 禁止提交**；
	 *   - 「自定义键应该弹出一个空的输入栏，而不是含有内容的」⇒ 初值恒为空；
	 *     提交成功/取消后**清空**，下次打开仍是空的（旧实现只在成功回调里清，
	 *     取消后再开仍留着上次输入 —— 这是用户看到「含有内容」的直接来源）。
	 */
	function AddSourceForm(props) {
		var name = useState("");
		var nameVal = name[0], setName = name[1];
		var url = useState("");
		var urlVal = url[0], setUrl = url[1];
		var busy = useState(false);
		var busyVal = busy[0], setBusy = busy[1];

		var norm = normUrl(urlVal);
		var valid = !!norm;
		/* 同源查重：走**唯一实现** isDuplicateUrl（与入口行共用，不写第二份判定）。
		   该表单新建的源尚无 routes，故与「同类目下已有自定义源的直连网址」比较。 */
		var dup = norm && props.existingUrls
			? props.existingUrls.some(function (u) { return keyOfUrl(u) === keyOfUrl(norm); })
			: false;
		var canSubmit = valid && !dup && !busyVal;

		var submit = function () {
			if (!canSubmit) return;
			setBusy(true);
			props.onAddSource({ name: nameVal.trim(), url: norm, proxies: [] }, function () {
				setName(""); setUrl(""); setBusy(false);
			});
		};
		/* 取消也必须清空 —— 否则再打开时输入栏"含有内容"（用户报的正是这个） */
		var cancel = function () {
			setName(""); setUrl(""); setBusy(false);
			props.onCancel();
		};
		return createElement("div", null,
			createElement("div", { className: "wsd-form" },
				createElement(Input, {
					placeholder: TEXT.sourceName,
					value: nameVal,
					onChange: function (e) { setName(e.target.value); },
					style: { width: 150 },
				}),
				createElement(Input, {
					className: "wsd-input" + (dup ? " invalid" : ""),
					placeholder: TEXT.sourceUrl,
					value: urlVal,
					onChange: function (e) { setUrl(e.target.value); },
					style: { flex: 1, minWidth: 170 },
					onKeyDown: function (e) { if (e.key === "Enter") submit(); },
				}),
				createElement(Button, {
					size: "sm",
					variant: "primary",
					/* 重复 ⇒ 禁用（用户：不允许键入当前重复的网址） */
					disabled: !canSubmit,
					onClick: submit,
				}, busyVal ? "…" : TEXT.save),
				createElement(Button, { size: "sm", onClick: cancel }, TEXT.cancel)),
			/* 可见反馈：重复时红字提示（不得静默丢输入） */
			dup ? createElement("div", { className: "wsd-errText", style: { paddingLeft: 0 } }, TEXT.dupUrl) : null);
	}

	/* ------------------------------------------------------------ 卡片 */

	function Card() {
		var st = useState(null);
		var snapshot = st[0], setSnapshot = st[1];
		var err = useState(null);
		var error = err[0], setError = err[1];
		var busy = useState(false);
		var saving = busy[0], setSaving = busy[1];
		var status = useState("");
		var statusMsg = status[0], setStatus = status[1];

		var keyDraft = useState("");
		var keyVal = keyDraft[0], setKey = keyDraft[1];
		var keyClear = useState(false);
		var clearFlag = keyClear[0], setKeyClear = keyClear[1];
		var proxyDraft = useState("");
		var proxyVal = proxyDraft[0], setProxyDraft = proxyDraft[1];

		var cardOpen = useState(false);
		var open = cardOpen[0], setOpen = cardOpen[1];
		var activeTab = useState("sources");
		var activeTabVal = activeTab[0], setActiveTab = activeTab[1];
		var openCats = useState({});
		var openCatsMap = openCats[0], setOpenCats = openCats[1];
		var adding = useState(null);
		var addingVal = adding[0], setAdding = adding[1];

		var confirmReset = useState(false);
		var confirming = confirmReset[0], setConfirming = confirmReset[1];
		var confirmTimer = useRef(null);

		var load = function () {
			fetch(API + "/config")
				.then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
				.then(function (data) {
					setSnapshot(data);
					setProxyDraft(data.proxyUrl || "");
					setError(null);
				})
				.catch(function (e) { setError(TEXT.loadFailed + e.message); });
		};
		useEffect(load, []);

		/* ★ 乐观渲染状态（必须**先于 `dirty`** 声明：dirty 要读它们）。
		 *
		 * 用户裁定①：点「＋ 代理网址」必须**立刻**出现可编辑空行。
		 * 根因回顾：旧实现只把新行写进 `pending.routeExtras`，而渲染只读宿主快照的
		 * `src.routes` ⇒ 界面不重绘，用户看到「添加代理无法生效」。
		 * 现在：新增行先落进本地 `optimistic` 并**参与渲染**，保存时才落盘。
		 * 元素形如 { srcId, custom, url, key }；key 用 `__opt__` 前缀与快照行区分。 */
		var opt = useState([]);
		var optimistic = opt[0], setOptimistic = opt[1];

		/* 网址草稿：`key -> 用户正在输入的字符串`（乐观显示，保存时落盘）。
		 * 它同时是「输入即时可见」与「待提交载荷」的唯一来源。 */
		var drafts = useState({});
		var urlDrafts = drafts[0], setUrlDrafts = drafts[1];

		/* ④ 必须在**乐观行/网址草稿**存在时也算「有未保存改动」——
		 * 否则用户点了「＋ 代理网址」、填好网址，「保存」却是灰的（点不下去）。
		 * 这是「添加代理无法生效」的第二半：光出现行还不够，还得能落盘。
		 * （optimistic / urlDrafts 在本函数靠后处 var 声明，故此处需防 undefined。） */
		var dirty =
			keyVal.trim() !== "" ||
			clearFlag ||
			proxyVal !== (snapshot ? snapshot.proxyUrl || "" : "") ||
			(!!optimistic && optimistic.length > 0) ||
			(!!urlDrafts && Object.keys(urlDrafts).length > 0) ||
			!!pending;

		var doPost = function (body) {
			return fetch(API + "/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
		};

		/* 提交前的统一重复校验：任一源内出现重复网址即禁止提交（D2）。
		   走的是**唯一实现** findDuplicateUrls，与渲染共用同一判定。
		   🔴 必须跑在**投影后的 routes**（快照 + 乐观行 + 网址草稿）上：
		      只看 snapshot 会漏掉用户刚敲进「＋ 代理网址」新行的重复网址
		      （实测：新行填成同源直连的网址后「保存」仍可点、且真的落盘了）。
		   ⚠️ D2 是用户明确要求保留的裁定，不得随其它清理一并删除。 */
		var hasAnyDuplicate = function () {
			var S = snapshot || { categories: [] };
			var hit = false;
			(S.categories || []).forEach(function (cat) {
				(cat.engines || []).forEach(function (src) {
					var rows = (typeof projectRoutes === "function") ? projectRoutes(src) : src.routes;
					if (findDuplicateUrls(rows).hasDup) hit = true;
				});
			});
			return hit;
		};

		var afterSave = function () {
			setStatus(TEXT.saved);
			setTimeout(function () { setStatus(""); }, 2500);
		};

		var run = function (p) {
			setSaving(true);
			return p.then(function () { load(); afterSave(); })
				.catch(function (e) { setError(TEXT.saveFailed + e.message); })
				.finally(function () { setSaving(false); });
		};

		/**
		 * ★ 提交时**以当前投影为准**重建入口载荷。
		 *
		 * 为什么不能只用 `pending`：pending 是**逐次操作**累积出来的，
		 * 而「＋ 代理网址」那一刻行还是空的（`{url:""}`）—— 用户随后才把网址敲进去。
		 * 若直接提交 pending，落盘的就是那个空条目（实测：载荷 `[{url:""}]`，
		 * 既丢了用户填的网址，又把空行写进配置）。
		 * ⇒ 保存时按每个源重新计算一次「乐观行 + 草稿 + 既有条目」的最终形态，
		 *   并且**过滤掉仍为空的乐观行**（占位行不落盘）。
		 */
		var buildEntryPayload = function () {
			var routeExtras = {};
			var custom = (pending && pending.custom) || {};
			(snapshot && snapshot.categories ? snapshot.categories : []).forEach(function (cat) {
				(cat.engines || []).forEach(function (src) {
					if (src.custom) return;                       // 自定义源走 custom 载荷
					var rows = commitRoutes(src).filter(function (r) { return r.removable; });
					var urls = rows
						.map(function (r) { return { url: r.url }; })
						.filter(function (r) { return isHttpUrl(r.url); });
					/* 与 pending 里的既有结果合并：只要该源在 pending 里出现过，
					   就以「投影」为准重新算一遍（投影里已包含既有条目与乐观行）。 */
					if (pending && pending.routeExtras[src.id]) routeExtras[src.id] = urls;
					else if (urls.length && hasOptimistic(src.id)) routeExtras[src.id] = urls;
				});
			});
			return { routeExtras: routeExtras, custom: custom };
		};
		var hasOptimistic = function (srcId) {
			return optimistic.some(function (o) { return o.srcId === srcId; });
		};

		/** 「保存」= 统一提交：Key / 全局代理 + 全部累积的入口行改动（批量语义）。 */
		var save = function () {
			if (hasAnyDuplicate()) {
				setError(TEXT.dupSummary);
				return;
			}
			setSaving(true);
			var body = { proxyUrl: proxyVal.trim() };
			if (clearFlag) body.clearApiKey = true;
			else if (keyVal.trim()) body.apiKey = keyVal.trim();
			/* 累积的入口行改动一并落盘：三组可选载荷按需带上 */
			if (pending) {
				if (Object.keys(pending.routeOverrides).length) body.routeOverrides = pending.routeOverrides;
			}
			var built = buildEntryPayload();
			if (Object.keys(built.routeExtras).length) body.routeExtras = built.routeExtras;
			if (Object.keys(built.custom).length) body.custom = built.custom;
			return doPost(body)
				.then(function () {
					setKey(""); setKeyClear(false);
					setPending(null);
					/* ★ 乐观行与本地草稿一并清空：随后 load() 取回的宿主快照才是唯一真相，
					   这样乐观行被真实行**替换**而不是叠加（不得出现重复行）。 */
					setOptimistic([]);
					setUrlDrafts({});
					load();
					afterSave();
				})
				.catch(function (e) { setError(TEXT.saveFailed + e.message); })
				.finally(function () { setSaving(false); });
		};

		/** 「放弃修改」：Key / 全局代理 / **全部累积的入口行改动** 一并还原。 */
		var discard = function () {
			setKey(""); setKeyClear(false);
			setProxyDraft(snapshot ? snapshot.proxyUrl || "" : "");
			setPending(null);
			/* ★ 乐观行与网址草稿一并还原（用户要求「放弃修改」能撤销刚加的行） */
			setOptimistic([]);
			setUrlDrafts({});
			setError(null); setStatus("");
		};

		var resetAll = function () {
			if (!confirming) {
				setConfirming(true);
				confirmTimer.current = setTimeout(function () { setConfirming(false); }, 4000);
				return;
			}
			clearTimeout(confirmTimer.current);
			setConfirming(false);
			setSaving(true);
			fetch(API + "/reset", { method: "POST" })
				.then(function () {
					setKey(""); setKeyClear(false);
					load();
					afterSave();
				})
				.catch(function (e) { setError(TEXT.saveFailed + e.message); })
				.finally(function () { setSaving(false); });
		};

		/* ---- 快照 → 视图 ---- */

		/** 自定义源原始结构重建（保持顺序），供增删改后整体回写。
		 *  v3：代理条目保留 enabled（启停状态存在条目本身）。 */
		var rebuildCustom = function (catId, mutate) {
			var cat = snapshot
				? (snapshot.categories.find(function (c) { return c.id === catId; }) || { engines: [] })
				: { engines: [] };
			var ordered = cat.engines.filter(function (e) { return e.custom; }).map(function (e) {
				var direct = "";
				var proxies = [];
				e.routes.forEach(function (r2) {
					if (r2.tier === 0) direct = r2.url;
					else if (isHttpUrl(r2.url)) {
						var entry = { url: r2.url };
						if (r2.enabled === false) entry.enabled = false;
						proxies.push(entry);
					}
				});
				return { name: e.label, url: direct, proxies: proxies };
			});
			if (mutate) mutate(ordered);
			var body = { custom: {} };
			body.custom[catId] = ordered;
			return body;
		};
		/**
		 * 从自定义源 id 解析类目 id。
		 *
		 * 🔴 只接受 `custom-<catId>-<n>` 形态。**非自定义源返回 ""**，
		 * 不再原样回吐 —— 旧写法 `.replace(/^custom-/,"").replace(/-\d+$/,"")`
		 * 对内置源（如 `bing`）两个正则都不匹配，会**静默返回 `bing`**，
		 * 于是 `rebuildCustom("bing")` 找不到类目、落到 `|| {engines:[]}`，
		 * 最终把 `custom:{"bing":[]}` 这种**垃圾键**写进配置且无任何提示。
		 * （当前 UI 上「移除源」仅对自定义源渲染，故这条路**潜伏未触发**；
		 *   但两个静默叠在一起，一旦复用就会污染配置 —— 故在此显式判定。）
		 */
		var catIdOf = function (src) {
			var id = String((src && src.id) || "");
			if (!/^custom-/.test(id)) return "";
			return id.replace(/^custom-/, "").replace(/-\d+$/, "");
		};
		var srcIndex = function (src) {
			return parseInt(src.id.slice(src.id.lastIndexOf("-") + 1), 10) - 1;
		};

		/* ---- 入口级操作：**累积待提交** + **乐观渲染**，点「保存」统一落盘 ---- */

		/* 用户裁定：入口行改动不再即时 POST。改网址 / 开关 / ＋代理 / ×移除
		   全部写进 pending 草稿，点「保存」一次性提交，「放弃修改」一并还原。
		   pending 为 null 表示「无待提交改动」。 */
		var pend = useState(null);
		var pending = pend[0], setPending = pend[1];

		/**
		 * 取当前 pending 的可写副本（无则新建）。
		 *
		 * 🔴 `custom` 必须**从宿主快照预置**该自定义源的完整条目列表（rebuildCustom 语义），
		 * 否则 `p.custom[catId]` 是空的 `[]`，`arr[srcIndex]` 取不到条目 ⇒
		 * 「开关 / 改网址 / 加代理」在自定义源上**静默什么都不做**
		 * （实测：sw-custom 的落盘载荷是 `{}`）。内置源不受影响（走 routeExtras/routeOverrides）。
		 */
		var withPending = function (mutate) {
			var next = pending
				? { routeOverrides: Object.assign({}, pending.routeOverrides),
					routeExtras: Object.assign({}, pending.routeExtras),
					custom: Object.assign({}, pending.custom) }
				: { routeOverrides: {}, routeExtras: {}, custom: {} };
			mutate(next);
			setPending(next);
		};

		/** 把某个自定义源的当前条目（快照 → custom 载荷形态）取出来，供写入路径使用。 */
		var customItemsOf = function (engId) {
			var catId = catIdOf({ id: engId });
			if (!catId || !snapshot) return null;
			var cat = (snapshot.categories || []).find(function (c) { return c.id === catId; });
			if (!cat) return null;
			var list = (cat.engines || []).filter(function (e) { return e.custom; }).map(function (e) {
				var direct = "";
				var proxies = [];
				(e.routes || []).forEach(function (r2) {
					if (r2.tier === 0) direct = r2.url;
					else if (isHttpUrl(r2.url)) {
						var entry = { url: r2.url };
						if (r2.enabled === false) entry.enabled = false;
						proxies.push(entry);
					}
				});
				return { name: e.label, url: direct, proxies: proxies };
			});
			return { catId: catId, list: list };
		};

		/** 网址输入：**只改本地草稿**（即时可见），pending 由落点（blur / 开关 / 加行）统一物化。 */
		var onUrlDraft = function (route, nextUrl) {
			setUrlDrafts(function (prev) {
				var next = Object.assign({}, prev);
				next[route.key] = String(nextUrl === undefined ? "" : nextUrl);
				return next;
			});
		};

		/**
		 * 落定某一条的网址（失焦时）。
		 *
		 * 「清空网址 = 移除该条」是本插件既有语义（宿主 dist 里 `item.proxies.splice`）。
		 * 而**开关**走的是另一条路（只翻 enabled，见 onSwitch），两者不得混淆。
		 */
		var onUrlSave = function (route, nextUrl) {
			var draft = urlDrafts[route.key];
			var next = String((draft !== undefined ? draft : nextUrl) || "").trim();
			var srcId = route.key.split("|")[0];
			if (route.custom) {
				withPending(function (p) {
					var engId = srcId;
					var seed = p.custom[catIdOf({ id: engId })] || (customItemsOf(engId) ? customItemsOf(engId).list.map(function (x) { return { name: x.name, url: x.url, proxies: x.proxies.map(function (y) { return Object.assign({}, y); }) }; }) : []); p.custom[catIdOf({ id: engId })] = seed; var arr = seed;
					var item = arr[srcIndex({ id: engId })];
					if (!item) return;
					if (route.tier === 0) {
						if (isHttpUrl(next)) item.url = next;
						return;
					}
					var j = 0;
					for (var i2 = 0; i2 < route.allRoutes.length; i2++) {
						var r2 = route.allRoutes[i2];
						if (r2.tier !== 1) continue;
						if (r2.key === route.key) {
							if (isHttpUrl(next)) item.proxies[j] = { url: next };
							else item.proxies.splice(j, 1);
							return;
						}
						j++;
					}
				});
				return;
			}
			if (route.removable) {
				withPending(function (p) {
					/* 乐观行（key 以 __opt__ 前缀）不在 allRoutes 里，它经由
					   「既有 removable 条目 + 乐观行」合成后整体回传。 */
					var own = route.allRoutes.filter(function (r3) { return r3.key !== route.key; });
					var optRows = own.filter(function (r3) { return r3.key.indexOf("__opt__") === 0; });
					var kept = own.filter(function (r3) { return r3.key.indexOf("__opt__") !== 0; });
					var urls = kept.map(function (r3) { return { url: r3.url }; })
						.filter(function (r3) { return isHttpUrl(r3.url); });
					if (isHttpUrl(next)) {
						/* 改写：替换该条（保持顺序） */
						urls = kept.map(function (r3) {
							return { url: r3.key === route.key ? next : r3.url };
						}).filter(function (r3) { return isHttpUrl(r3.url); });
					}
					optRows.forEach(function (r3) {
						if (isHttpUrl(r3.url)) urls.push({ url: r3.url });
					});
					p.routeExtras[srcId] = urls;
				});
				return;
			}
			withPending(function (p) {
				p.routeOverrides[route.key] = (isHttpUrl(next) && next !== route.defaultUrl)
					? { url: next } : null;
			});
		};

		var onRemoveEntry = function (route) {
			if (!route.removable) return;
			var srcId = route.key.split("|")[0];
			if (route.custom) {
				withPending(function (p) {
					var engId = srcId;
					var seed = p.custom[catIdOf({ id: engId })] || (customItemsOf(engId) ? customItemsOf(engId).list.map(function (x) { return { name: x.name, url: x.url, proxies: x.proxies.map(function (y) { return Object.assign({}, y); }) }; }) : []); p.custom[catIdOf({ id: engId })] = seed; var arr = seed;
					var item = arr[srcIndex({ id: engId })];
					if (!item) return;
					var j = 0;
					for (var i2 = 0; i2 < route.allRoutes.length; i2++) {
						var r2 = route.allRoutes[i2];
						if (r2.tier !== 1) continue;
						if (r2.key === route.key) { item.proxies.splice(j, 1); return; }
						j++;
					}
				});
				return;
			}
			withPending(function (p) {
				p.routeExtras[srcId] = route.allRoutes
					.filter(function (r3) { return r3.key !== route.key; })
					.map(function (r3) { return { url: r3.url }; })
					.filter(function (r3) { return isHttpUrl(r3.url); });
			});
		};

		var onAddSource = function (catId, item, done) {
			var body = rebuildCustom(catId, function (ordered) {
				var max = snapshot && snapshot.limits ? snapshot.limits.customMax : 8;
				if (ordered.length < max) ordered.push(item);
			});
			setSaving(true);
			doPost(body)
				.then(function () { load(); afterSave(); if (done) done(); })
				.catch(function (e) { setError(TEXT.saveFailed + e.message); if (done) done(); })
				.finally(function () { setSaving(false); });
		};

		/**
		 * 移除自定义源。
		 *
		 * 契约（t7-F1 修复）：**纳入 pending，不得即时 POST** ——
		 * 五类入口操作（改网址 / 开关 / ＋代理 / ×移除条目 / 移除源）一律累积待提交，
		 * 点「保存」统一落盘、「放弃修改」一并还原。
		 * 旧实现直接 `run(doPost(body))`，会让「移除源」在用户攒着其它改动时**单独立刻提交**，
		 * 造成部分落盘的困惑状态。
		 */
		var onRemoveSource = function (src) {
			if (!src || !src.custom) return;          // 仅自定义源可移除（与 UI 渲染条件一致）
			var catId = catIdOf(src);
			if (!catId) return;                        // id 非法 ⇒ 不产生任何写操作
			withPending(function (p) {
				var arr = (p.custom[catId] || []).slice();
				var i = srcIndex(src);
				if (i >= 0 && i < arr.length) arr.splice(i, 1);
				p.custom[catId] = arr;
			});
		};

		/**
		 * 圆点开关：停用 / 启用（用户裁定④「把圆点开关改回来」）。
		 *
		 * ★ 底线：**停用 ≠ 删除** —— 只翻转 `enabled`：
		 *   内置源 → `routeOverrides[key] = {enabled:false|true}`
		 *   自定义源 → `proxies[i].enabled = false`（启用则删掉该字段回默认）
		 * **绝不** `splice` 掉条目、**绝不**清空网址。宿主侧依据：
		 *   dist L1515/L1518/L1537 保留条目只标 false，runEngine 只过滤出请求。
		 * 对照：清空网址 = 移除（那条路只属于 onUrlSave）。
		 */
		var onSwitch = function (route, enabled) {
			var srcId = route.key.split("|")[0];
			if (route.custom && typeof route.proxyIndex === 'number') {
				withPending(function (p) {
					var engId = srcId;
					var seed = p.custom[catIdOf({ id: engId })] || (customItemsOf(engId) ? customItemsOf(engId).list.map(function (x) { return { name: x.name, url: x.url, proxies: x.proxies.map(function (y) { return Object.assign({}, y); }) }; }) : []); p.custom[catIdOf({ id: engId })] = seed; var arr = seed;
					var item = arr[srcIndex({ id: engId })];
					if (!item) return;
					var pp = item.proxies[route.proxyIndex];
					if (pp) { if (enabled) delete pp.enabled; else pp.enabled = false; }
				});
				return;
			}
			withPending(function (p) {
				p.routeOverrides[route.key] = enabled ? { enabled: true } : { enabled: false };
			});
		};

		/** ＋ 代理网址：① 立刻插一条乐观空行（用户裁定：点了必须马上看见），
		 *  ② 同时把 pending 载荷备好，保存时落盘。
		 *
		 *  🔴 内置源只许回传「用户自己加的那些入口」：宿主快照里 `removable===true`
		 *  且非自定义源的路由，就是 routeExtras 里的条目（宿主 uiSnapshot 的
		 *  `removable: !!r.extra || (isCustom && r.tier !== 0)`，`extra` 字段本身不外露）。
		 *  曾经写成「所有 http 路由」→ 每次点按钮都把内置直连/备用入口当成新 entry
		 *  回传一次 → 宿主重新追加 → 代理行成倍复制。 */
		var onAddProxy = function (src) {
			var optKey = "__opt__" + src.id + "|" + Date.now();
			/* ★ 乐观渲染：本地先加一行，界面**立即**重绘（不等保存、不等 load） */
			setOptimistic(function (prev) {
				return prev.concat([{ srcId: src.id, custom: !!src.custom, url: "", key: optKey }]);
			});
			if (src.custom) {
				withPending(function (p) {
					var engId = src.id;
					var seed = p.custom[catIdOf({ id: engId })] || (customItemsOf(engId) ? customItemsOf(engId).list.map(function (x) { return { name: x.name, url: x.url, proxies: x.proxies.map(function (y) { return Object.assign({}, y); }) }; }) : []); p.custom[catIdOf({ id: engId })] = seed; var arr = seed;
					var item = arr[srcIndex({ id: engId })];
					if (item) item.proxies.push({ url: "" });
				});
				return;
			}
			withPending(function (p) {
				/* 🔴 只回传「用户自己加的那些入口」（removable=true），
				   不能把内置直连/备用也算进去 —— 那会让宿主成倍追加（0.4.8 的坑）。 */
				var urls = src.routes
					.filter(function (r2) { return r2.removable; })
					.map(function (r2) { return { url: r2.url }; })
					.filter(function (r2) { return isHttpUrl(r2.url); });
				urls.push({ url: "" });
				p.routeExtras[src.id] = urls;
			});
		};

		/**
		 * ★ 把「乐观行 + 网址草稿 + 待提交的开关/网址覆盖」投影成**渲染用的 routes**。
		 *
		 * 这是修「添加代理无法生效」的关键：渲染不再只看宿主快照，
		 * 而是看「快照 + 本地草稿」——点了就看得见，输入就看得见。
		 * 保存后 `load()` 取回真实快照，本地草稿清空 ⇒ 乐观行被真实行替换，**不重复**。
		 */
		var projectRoutes = function (src) {
			var role = src.custom ? "custom" : "builtin";
			var rows = src.routes.map(function (r) {
				var out = Object.assign({}, r);
				var d = urlDrafts[r.key];
				if (d !== undefined) {
					out.draft = d;
					out.url = d;
				}
				/* 开关的乐观投影：停用立刻体现在整行降透明上 */
				if (out.enabled !== false && pending && pending.routeOverrides &&
					pending.routeOverrides[r.key] && pending.routeOverrides[r.key].enabled === false) {
					out.enabled = false;
				}
				return out;
			});
			optimistic.forEach(function (o) {
				if (o.srcId !== src.id) return;
				var d = urlDrafts[o.key];
				rows = rows.concat([{
					key: o.key,
					tier: 1,
					engineId: src.id,
					custom: !!src.custom,
					url: d !== undefined ? d : "",
					draft: d !== undefined ? d : "",
					defaultUrl: "",
					type: "proxy",
					enabled: true,
					switchable: true,
					removable: true,
					empty: true,
				}]);
			});
			void role;
			return rows;
		};

		/**
		 * ★ 保存载荷用的 routes：乐观行参与提交，**空网址的行一律不落盘**。
		 * （刚加还没填的空行只是 UI 占位；宿主不该收到空条目 —— 否则每次保存都会
		 *   多出一条垃圾。用户裁定：保存前填了才生效。）
		 */
		var commitRoutes = function (src) {
			var rows = projectRoutes(src).filter(function (r) {
				return r.key.indexOf("__opt__") !== 0 || isHttpUrl(r.url);
			});
			return rows;
		};

		/** 给入口行补全路由级信息（engineId/custom/allRoutes/proxyIndex），供保存时定位。 */
		var decorate = function (src) {
			return function (route) {
				return Object.assign({}, route, {
					engineId: src.id,
					custom: !!src.custom,
					allRoutes: src.routes,
					proxyIndex: route.proxyIndex,
				});
			};
		};

		if (error && !snapshot) {
			return createElement("div", { className: "wsd-setCard" },
				createElement("div", { className: "wsd-setHeader", style: { cursor: "default" } },
					createElement("div", { className: "wsd-setHeadText" },
						createElement("div", { className: "wsd-setName" }, TEXT.title),
						createElement("div", { className: "wsd-setDesc wsd-status err" }, error))));
		}

		/* 动作按钮行（官方排序：恢复默认最左 → 放弃修改 → 保存最右），两个 tab 各一份，置于内容右下角。
		   重建自 preview/卡片交互预览_v3.html 的定稿实现；handler 复用本组件已有的
		   resetAll / discard / save / confirming / setConfirming / statusMsg / error / saving。 */
		var dupBlocked = hasAnyDuplicate();

		var actionsRow = function () {
			return createElement("div", { className: "wsd-setActions" },
				statusMsg ? createElement("span", { className: "wsd-status", style: { marginRight: "auto" } }, statusMsg) : null,
				error ? createElement("span", { className: "wsd-status err", style: { marginRight: "auto" } }, error) : null,
				dupBlocked ? createElement("span", { className: "wsd-status err", style: { marginRight: "auto" } }, TEXT.dupSummary) : null,
				createElement(Button, {
					size: "sm",
					className: "wsd-btn",
					onClick: function () {
						if (!confirming) {
							setConfirming(true);
							if (confirmTimer.current) clearTimeout(confirmTimer.current);
							confirmTimer.current = setTimeout(function () { setConfirming(false); }, 4000);
							return;
						}
						if (confirmTimer.current) clearTimeout(confirmTimer.current);
						setConfirming(false);
						resetAll();
					},
				}, confirming ? TEXT.resetAllConfirm : TEXT.resetAll),
				createElement(Button, {
					size: "sm",
					className: "wsd-btn",
					onClick: function () { discard(); },
				}, TEXT.discard),
				createElement(Button, {
					size: "sm",
					variant: "primary",
					className: "wsd-btn primary",
					/* D2：存在重复网址时禁止保存（用户裁定：不可保存） */
					disabled: saving || !dirty || dupBlocked,
					onClick: function () { if (!saving && dirty && !dupBlocked) save(); },
				}, saving ? TEXT.saving : TEXT.save));
		};

		var catToggle = function (id) {
			setOpenCats(function (prev) {
				var next = Object.assign({}, prev);
				next[id] = !next[id];
				return next;
			});
		};

		/* 一级抽屉（官方 PluginCard 同款外壳） */
		return createElement("div", { className: open ? "wsd-setCard wsd-setCardOpen" : "wsd-setCard" },
			createElement("button", {
				className: "wsd-setHeader",
				type: "button",
				"aria-expanded": open,
				onClick: function () { setOpen(!open); },
			},
				createElement("div", { className: "wsd-setHeadText" },
					createElement("div", { className: "wsd-setName" }, TEXT.title),
					createElement("div", { className: "wsd-setDesc" }, TEXT.description)),
				createElement("span", { className: open ? "wsd-setChevron wsd-setChevronOpen" : "wsd-setChevron" },
					createElement(ui.IconChevronDownOutline14, { size: 14 }))),
			!open
				? null
				: createElement("div", { className: "wsd-setBody" },
					!snapshot
						? createElement("p", { className: "wsd-setHint", style: { padding: "12px 0" } }, "…")
						: createElement("div", null,

							/* 一级 tab 条：左 tab，右状态徽标 */
							createElement("div", { className: "wsd-tabs" },
								createElement("button", {
									className: "wsd-tabbtn" + (activeTabVal === "sources" ? " active" : ""),
									type: "button",
									onClick: function () { setActiveTab("sources"); },
								}, TEXT.tabSources),
								createElement("button", {
									className: "wsd-tabbtn" + (activeTabVal === "basic" ? " active" : ""),
									type: "button",
									onClick: function () { setActiveTab("basic"); },
								}, TEXT.tabBasic),
								createElement("div", { className: "wsd-tabRight" },
									statusMsg ? createElement("span", { className: "wsd-status" }, statusMsg) : null,
									error ? createElement("span", { className: "wsd-status err" }, error) : null,
									dirty && !saving ? createElement("span", { className: "wsd-tag" }, TEXT.dirty) : null))),

							/* ---- tab 内容：入口源管理 ---- */
							activeTabVal === "sources"
								? createElement("div", null,
									createElement("div", { className: "wsd-scroll" },
										snapshot.categories.map(function (cat) {
											return createElement(CategoryBox, {
												key: cat.id,
												title: cat.label,
												tag: cat.engines.length + TEXT.sourcesUnit,
												open: !!openCatsMap[cat.id],
												onToggle: function () { catToggle(cat.id); },
											},
												cat.engines.map(function (src) {
													/* ★ 渲染用的 routes = 「宿主快照 + 乐观行 + 网址草稿 + 开关草稿」投影。
													   这是修「添加代理无法生效」的关键：渲染不再只看宿主快照。
													   保存时用 commitRoutes（空网址的乐观行不落盘）。 */
													var viewSrc = Object.assign({}, src, {
														routes: projectRoutes(src).map(decorate(src)),
														commitRoutes: commitRoutes,
													});
													return createElement(SourceBlock, {
														key: src.id,
														/* 入口行必须带路由级信息（allRoutes/engineId/custom/proxyIndex）：
														   onUrlSave / onSwitch / onRemoveEntry 都按 route.allRoutes 定位。
														   SourceBlock 是顶层函数，看不到 Card 里的 decorate，故在此就地装饰。 */
														source: viewSrc,
														onUrlDraft: onUrlDraft,
														onUrlSave: onUrlSave,
														onSwitch: onSwitch,
														onRemoveEntry: onRemoveEntry,
														onRemoveSource: onRemoveSource,
														onAddProxy: onAddProxy,
													});
												}),
												addingVal === cat.id
													? createElement(AddSourceForm, {
														onAddSource: function (item, done) { onAddSource(cat.id, item, done); },
														onCancel: function () { setAdding(null); },
														/* 同源查重的比较基准：该**类目**下所有已有入口的网址
														   （含自定义源的直连与代理，含内置源与用户追加项）。
														   用户口径：同一源内比较，跨源不比。 */
														existingUrls: cat.engines.reduce(function (acc, e2) {
															(e2.routes || []).forEach(function (r2) {
																var u = r2.url !== undefined && r2.url !== "" ? r2.url : r2.base;
																if (u) acc.push(u);
															});
															return acc;
														}, []),
													})
													: createElement("div", { style: { padding: "6px 0 2px" } },
														createElement(Button, {
															size: "sm",
															className: "wsd-linkbtn",
															onClick: function () { setAdding(cat.id); },
														}, TEXT.addSource)));
										})),
									/* 动作按钮：右下角（恢复默认 → 放弃修改 → 保存） */
									actionsRow())
								/* ---- tab 内容：基础设置（官方字段模板） ---- */
								: createElement("div", null,

									createElement("div", { className: "wsd-setRow" },
										createElement("div", { className: "wsd-setLabelBox" },
											createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
												createElement("span", { className: "wsd-setLabel", style: { flex: 1 } }, TEXT.apiKey),
												createElement("span", { className: "wsd-tag" + (snapshot.apiKeySet ? " on" : "") },
													snapshot.apiKeySet ? TEXT.apiKeySet : TEXT.apiKeyUnset)),
											createElement(Input, {
												type: "password",
												value: keyVal,
												placeholder: snapshot.apiKeySet && !clearFlag ? TEXT.apiKeyPlaceholderKeep : TEXT.apiKeyPlaceholderEmpty,
												onChange: function (e) { setKey(e.target.value); setKeyClear(false); },
												className: "wsd-input",
												style: { width: "100%", marginTop: 6 },
												spellCheck: false,
											}),
											snapshot.apiKeySet
												? createElement("div", { style: { marginTop: 4 } },
													createElement(Button, {
														size: "sm",
														className: "wsd-linkbtn",
														onClick: function () { setKeyClear(!clearFlag); setKey(""); },
													}, clearFlag ? TEXT.discard : TEXT.clearKey))
												: null,
											createElement("div", { className: "wsd-setHint" }, TEXT.apiKeyHint))),

									createElement("div", { className: "wsd-setRow" },
										createElement("div", { className: "wsd-setLabelBox" },
											createElement("div", { className: "wsd-setLabel" }, TEXT.proxyTitle),
											createElement(Input, {
												type: "text",
												value: proxyVal,
												placeholder: "http://127.0.0.1:7890",
												onChange: function (e) { setProxyDraft(e.target.value); },
												className: "wsd-input",
												style: { width: "100%", marginTop: 6 },
												spellCheck: false,
											})),
										createElement("div", { className: "wsd-setHint" }, TEXT.proxyHint)),

									/* 动作按钮：右下角（恢复默认 → 放弃修改 → 保存） */
									actionsRow())));
	}

	/* ------------------------------------------------------- 原语守卫 */

	var REQUIRED_PRIMITIVES = ["Input", "Button", "IconChevronDownOutline14"];
	function missingPrimitives(mod) {
		return REQUIRED_PRIMITIVES.filter(function (name) { return mod[name] === undefined; });
	}

	/* ----------------------------------------------------------- 入口 */

	var name = "dsh-websearch-direct";
	var inject = ["slots"];

	function apply(ctx) {
		ensureStyle();
		var gaps = missingPrimitives(ui);
		if (gaps.length > 0) {
			console.warn("[dsh-websearch-direct] 宿主 ui-primitives 缺少 " + gaps.join(", ") + " — 设置卡片停用");
			return;
		}
		ctx.inject(["settingsScope"], function (scoped) {
			scoped.slots.inject("settings.plugin.item", function () {
				return scoped.slots.register({
					name: "settings.plugin.item",
					key: NS,
				}, function () { return createElement(Card); });
			});
		});
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
