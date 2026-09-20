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
		apiKey: "API Key",
		apiKeyHint: "留空 = 免 Key 直连（默认）；填写后所有联网搜索使用此 Key。",
		apiKeySet: "已配置",
		apiKeyUnset: "未配置",
		apiKeyPlaceholderKeep: "已配置，留空保持不变",
		apiKeyPlaceholderEmpty: "输入 Key",
		clearKey: "清除",
		proxyTitle: "全局代理地址",
		proxyHint: "例如 http://127.0.0.1:7890。留空 = 不走全局代理。",
		direct: "直连",
		proxy: "代理",
		directUnit: " 个源 · 直连",
		proxyUnit: " 个源 · 代理",
		sourcesUnit: " 个源",
		addProxy: "＋ 代理网址",
		proxyUrlPlaceholder: "代理网址 https://…",
		noneYet: "暂无代理网址。",
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
			".wsd-entry{display:flex;align-items:center;gap:8px;padding:3px 0}",
			".wsd-entry .wsd-input{flex:1;min-width:0}",
			".wsd-type{flex:none;width:44px;text-align:center;font-size:11px;padding:2px 0;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-tertiary,#8b93a1)}",
			".wsd-type.proxy{border-color:rgba(48,150,90,.55);color:#2c9c5c}",
			".wsd-link{background:none;border:0;padding:0;font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;opacity:.6;white-space:nowrap}",
			".wsd-link:hover{opacity:1}",
			".wsd-linkbtn{font-size:11px}",
			".wsd-del{flex:none;width:18px;height:18px;line-height:16px;text-align:center;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l2,#e5e7eb);background:0 0;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary,#8b93a1);padding:0}",
			".wsd-del:hover{color:#c0392b;border-color:#c0392b}",
			".wsd-form{display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap}",
			".wsd-form input{font-size:12px}",
			".wsd-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;padding:5px 10px;font:inherit;font-size:12.5px}",
			".wsd-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-1px}",
			".wsd-status{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
			".wsd-status.err{color:#c0392b}",
			".wsd-tabs{display:flex;align-items:center;gap:4px;padding:8px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2,#e5e7eb);}",
			".wsd-tabbtn{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px;border:0.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;}",
			".wsd-tabbtn:hover{background:rgba(127,127,127,.08)}",
			".wsd-tabbtn.active{background:var(--dsw-alias-bg-info,#e6ecfd);color:var(--dsw-alias-brand-primary,#3b5bdb);font-weight:600;border-color:rgba(79,110,247,.35)}",
			".wsd-tabRight{margin-left:auto;display:flex;align-items:center;gap:8px;}",
			".wsd-scroll{max-height:400px;overflow-y:auto;margin:10px 0 4px;padding-right:4px;}",
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

	/** 入口行：[直连|代理 标记] + [可编辑网址输入框] + [启用开关(代理)] + [×]。 */
	function EntryRow(props) {
		var route = props.route;
		var st = useState(route.url);
		var val = st[0], setVal = st[1];
		var lastUrl = useRef(route.url);
		if (lastUrl.current !== route.url) {
			lastUrl.current = route.url;
			setVal(route.url);
		}
		var isProxy = route.type === "proxy";
		var enabled = route.enabled !== false;
		var submit = function () {
			var next = normUrl(val);
			if (next === route.url) return;
			props.onUrlSave(route, next);
		};
		return createElement("div", { className: "wsd-entry" },
			createElement("span", { className: "wsd-type" + (isProxy ? " proxy" : "") },
				isProxy ? TEXT.proxy : TEXT.direct),
			createElement(Input, {
				className: "wsd-input",
				value: val,
				placeholder: route.empty ? TEXT.proxyUrlPlaceholder : "",
				onChange: function (e) { setVal(e.target.value); },
				onBlur: submit,
				onKeyDown: function (e) { if (e.key === "Enter") e.target.blur(); },
				spellCheck: false,
			}),
			route.switchable
				? createElement(Switch, {
					checked: enabled,
					label: "启用此代理",
					title: "关闭后这条代理不参与搜索，配置保留，可随时再打开",
					onChange: function (v) { props.onSwitch(route, v); },
				})
				: null,
			route.removable
				? createElement("button", {
					className: "wsd-del",
					type: "button",
					title: "移除",
					onClick: function () { props.onRemove(route); },
				}, TEXT.remove)
				: null);
	}

	/** 源块：源名（+自定义源移除）+ 全部入口行 + ＋ 代理网址。 */
	function SourceBlock(props) {
		var src = props.source;
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

	/** 添加自定义源的内联表单：源名称 + 官方网址。 */
	function AddSourceForm(props) {
		var name = useState("");
		var nameVal = name[0], setName = name[1];
		var url = useState("");
		var urlVal = url[0], setUrl = url[1];
		var valid = !!normUrl(urlVal);
		var busy = useState(false);
		var busyVal = busy[0], setBusy = busy[1];
		var submit = function () {
			if (!valid || busyVal) return;
			setBusy(true);
			props.onAddSource({ name: nameVal.trim(), url: normUrl(urlVal), proxies: [] }, function () {
				setName(""); setUrl(""); setBusy(false);
			});
		};
		return createElement("div", { className: "wsd-form" },
			createElement(Input, {
				placeholder: TEXT.sourceName,
				value: nameVal,
				onChange: function (e) { setName(e.target.value); },
				style: { width: 150 },
			}),
			createElement(Input, {
				placeholder: TEXT.sourceUrl,
				value: urlVal,
				onChange: function (e) { setUrl(e.target.value); },
				style: { flex: 1, minWidth: 170 },
				onKeyDown: function (e) { if (e.key === "Enter") submit(); },
			}),
			createElement(Button, {
				size: "sm",
				variant: "primary",
				disabled: !valid || busyVal,
				onClick: submit,
			}, busyVal ? "…" : TEXT.save),
			createElement(Button, { size: "sm", onClick: props.onCancel }, TEXT.cancel));
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

		var dirty =
			keyVal.trim() !== "" ||
			clearFlag ||
			proxyVal !== (snapshot ? snapshot.proxyUrl || "" : "");

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

		var save = function () {
			setSaving(true);
			var body = { proxyUrl: proxyVal.trim() };
			if (clearFlag) body.clearApiKey = true;
			else if (keyVal.trim()) body.apiKey = keyVal.trim();
			return doPost(body)
				.then(function () {
					setKey(""); setKeyClear(false);
					load();
					afterSave();
				})
				.catch(function (e) { setError(TEXT.saveFailed + e.message); })
				.finally(function () { setSaving(false); });
		};

		var discard = function () {
			setKey(""); setKeyClear(false);
			setProxyDraft(snapshot ? snapshot.proxyUrl || "" : "");
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
		var catIdOf = function (src) {
			return src.id.replace(/^custom-/, "").replace(/-\d+$/, "");
		};
		var srcIndex = function (src) {
			return parseInt(src.id.slice(src.id.lastIndexOf("-") + 1), 10) - 1;
		};

		/* ---- 入口级操作：全部即时持久化 ---- */

		var onUrlSave = function (route, nextUrl) {
			var next = String(nextUrl || "").trim();
			var srcId = route.key.split("|")[0];
			if (route.custom) {
				// 自定义源：直连清空忽略；代理清空 = 移除
				var body = rebuildCustom(catIdOf({ id: srcId }), function (ordered) {
					var item = ordered[srcIndex({ id: srcId })];
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
				run(doPost(body));
				return;
			}
			if (route.removable) {
				// 内置源追加的代理入口（存 routeExtras）；清空 = 移除
				var urls = route.allRoutes.filter(function (r3) { return r3.key !== route.key; })
					.map(function (r3) { return { url: r3.url }; })
					.filter(function (r3) { return isHttpUrl(r3.url); });
				var m1 = {};
				m1[srcId] = urls;
				run(doPost({ routeExtras: m1 }));
				return;
			}
			var body2 = { routeOverrides: {} };
			if (isHttpUrl(next) && next !== route.defaultUrl) body2.routeOverrides[route.key] = { url: next };
			else body2.routeOverrides[route.key] = null;
			run(doPost(body2));
		};

		var onRemoveEntry = function (route) {
			if (!route.removable) return;
			var srcId = route.key.split("|")[0];
			if (route.custom) {
				var body = rebuildCustom(catIdOf({ id: srcId }), function (ordered) {
					var item = ordered[srcIndex({ id: srcId })];
					if (!item) return;
					var j = 0;
					for (var i2 = 0; i2 < route.allRoutes.length; i2++) {
						var r2 = route.allRoutes[i2];
						if (r2.tier !== 1) continue;
						if (r2.key === route.key) {
							item.proxies.splice(j, 1);
							return;
						}
						j++;
					}
				});
				run(doPost(body));
				return;
			}
			var urls = route.allRoutes.filter(function (r3) { return r3.key !== route.key; })
				.map(function (r3) { return { url: r3.url }; })
				.filter(function (r3) { return isHttpUrl(r3.url); });
			var m3 = {};
			m3[srcId] = urls;
			run(doPost({ routeExtras: m3 }));
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

		var onRemoveSource = function (src) {
			var body = rebuildCustom(catIdOf(src), function (ordered) {
				ordered.splice(srcIndex(src), 1);
			});
			run(doPost(body));
		};

		/** 代理行的蓝色滑动开关：停用 / 启用，即时生效（配置保留）。
		 *  自定义代理：启停状态写在条目本身（custom.proxies[proxyIndex].enabled，
		 *  按位置定位，删除其它代理导致 label 重排不影响）；内置源追加代理
		 *  仍走 routeOverrides（label 稳定，由 routeExtras 整体重写）。 */
		var onSwitch = function (route, enabled) {
			if (route.custom && typeof route.proxyIndex === 'number') {
				var engId = route.key.split("|")[0];
				var body = rebuildCustom(catIdOf({ id: engId }), function (ordered) {
					var item = ordered[srcIndex({ id: engId })];
					if (!item) return;
					var p = item.proxies[route.proxyIndex];
					if (p) { if (enabled) delete p.enabled; else p.enabled = false; }
				});
				run(doPost(body));
				return;
			}
			var body = { routeOverrides: {} };
			body.routeOverrides[route.key] = enabled ? { enabled: true } : { enabled: false };
			run(doPost(body));
		};

		/** ＋ 代理网址：统一加一条空位行（输入后落库，清空 = 移除）——
		 *  内置源与自定义源同交互。 */
		var onAddProxy = function (src) {
			if (src.custom) {
				var body = rebuildCustom(catIdOf(src), function (ordered) {
					var item = ordered[srcIndex(src)];
					if (item) item.proxies.push({ url: "" });
				});
				run(doPost(body));
				return;
			}
			var urls = src.routes.map(function (r2) { return { url: r2.url }; })
				.filter(function (r2) { return isHttpUrl(r2.url); });
			urls.push({ url: "" });
			var m2 = {};
			m2[src.id] = urls;
			run(doPost({ routeExtras: m2 }));
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
									state.status ? createElement("span", { className: "wsd-status" }, state.status) : null,
									state.error ? createElement("span", { className: "wsd-status err" }, state.error) : null,
									dirty && !state.saving ? createElement("span", { className: "wsd-tag" }, TEXT.dirty) : null))),

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
													return createElement(SourceBlock, {
														key: src.id,
														source: src,
														onUrlSave: onUrlSave,
														onSwitch: onSwitch,
														onRemoveEntry: onRemoveEntry,
														onRemoveSource: onRemoveSource,
														onAddProxy: onAddProxy,
													});
												}),
												adding === cat.id
													? createElement(AddSourceForm, {
														onAddSource: function (item, done) { onAddSource(cat.id, item, done); },
														onCancel: function () { setAdding(null); },
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
