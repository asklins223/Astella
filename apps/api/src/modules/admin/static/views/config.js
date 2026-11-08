/* 视图 · 模型配置（v5，从零重写：用途优先，只读给读数、可写才给表单） */
import { api } from "../api-client.js";
import { el, table, bindTabList, emptyState, codeTag, badge, toast } from "../ui.js";

export const view = {
  title: "模型配置", eyebrow: "MODEL CONNECTIONS",
  lede: "看清每个用途此刻用的是哪个服务商的哪个模型。",
  load: loadConfig,
};

const PROVIDER_LABELS = { openai_compatible: "OpenAI 兼容", mimo_responses: "MiMo Responses", siliconflow: "硅基流动", local_embedding: "本地向量", mock: "测试桩" };
const TTS_FIELDS = { model: "模型", voice: "音色", format: "格式", sampleRate: "采样率", workspaceId: "工作区", instruction: "风格指令", rate: "语速" };
const TTS_ENGINES = { qwen: "通义千问", edge: "Edge 语音" };
const TABS = [{ id: "capabilities", label: "用途" }, { id: "providers", label: "服务商" }];

let draft = null;
let dirty = false;
let activeTab = "capabilities";
let lastCapability = null;
let lastProvider = null;
let capabilityFilter = "";
let providerFilter = "";

export function resetDraft() { draft = null; dirty = false; }

function snapshotToDraft(snapshot) {
  return {
    platforms: Object.fromEntries((snapshot.platforms ?? []).map((platform) => [platform.id, {
      id: platform.id,
      type: platform.type,
      typeLabel: platform.typeLabel ?? null,
      baseUrl: platform.baseUrl ?? "",
      apiKey: platform.apiKey.mode === "env-ref" ? `\${${platform.apiKey.envVar}}` : "",
      apiKeyLocked: platform.apiKey.mode === "literal-redacted",
      apiKeyMode: platform.apiKey.mode,
      options: platform.options,
      models: platform.models,
      usedByCapabilities: platform.usedByCapabilities,
      original: { baseUrl: platform.baseUrl ?? "", apiKey: platform.apiKey.mode === "env-ref" ? `\${${platform.apiKey.envVar}}` : "" },
    }])),
    capabilities: Object.fromEntries((snapshot.capabilities ?? []).map((capability) => [capability.capability, {
      label: capability.label ?? null,
      platform: capability.platform,
      model: capability.model,
      reasoningEffort: capability.reasoningEffort ?? null,
      resolvable: capability.resolvable,
      problem: capability.problem,
      original: { platform: capability.platform, model: capability.model },
    }])),
    tts: snapshot.tts,
  };
}

function draftToPatch(current) {
  const patch = {};
  const platforms = {};
  for (const [id, platform] of Object.entries(current.platforms)) {
    const fields = {};
    if (platform.baseUrl !== platform.original.baseUrl) fields.baseUrl = platform.baseUrl.trim() === "" ? null : platform.baseUrl.trim();
    if (!platform.apiKeyLocked && platform.apiKey !== platform.original.apiKey) fields.apiKey = platform.apiKey.trim() === "" ? null : platform.apiKey.trim();
    if (Object.keys(fields).length > 0) platforms[id] = fields;
  }
  if (Object.keys(platforms).length > 0) patch.platforms = platforms;
  const capabilities = {};
  for (const [name, capability] of Object.entries(current.capabilities)) {
    // 能力映射整体替换，思考档必须随行，否则改一次服务商就降档。
    if (capability.platform === capability.original.platform && capability.model === capability.original.model) continue;
    capabilities[name] = { platform: capability.platform, model: capability.model, ...(capability.reasoningEffort ? { reasoningEffort: capability.reasoningEffort } : {}) };
  }
  if (Object.keys(capabilities).length > 0) patch.capabilities = capabilities;
  return patch;
}

const typeLabel = (platform) => platform?.typeLabel ?? PROVIDER_LABELS[platform?.type] ?? platform?.type ?? "未知类型";
const envVar = (apiKey) => /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(apiKey ?? "").trim())?.[1] ?? null;
const tokens = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "未声明";
  if (value >= 1_000_000) return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
};

function keyState(platform, unresolved) {
  if (platform.apiKeyLocked) return { tone: "warn", text: "密钥写死在文件里", source: "写死在配置文件里", status: "写死在配置文件里" };
  const variable = envVar(platform.apiKey);
  if (variable) {
    const resolved = !unresolved.includes(variable);
    return { tone: resolved ? "ok" : "bad", text: resolved ? "密钥已注入" : "密钥未注入", source: variable, status: resolved ? "已注入" : "未注入" };
  }
  if (platform.apiKeyMode === "unset") return { tone: "", text: "不需要密钥", source: "不需要密钥", status: "不需要密钥" };
  return { tone: "warn", text: "字面密钥", source: "写死在配置文件里", status: "字面密钥" };
}

function capabilityStatus(capability, snapshot, code, platform) {
  const blocking = snapshot.issues.find((issue) => issue.blocking && issue.path?.startsWith(`capabilities.${code}`));
  if (blocking) return { tone: "bad", text: "配置待修复", detail: blocking.message };
  if (!platform) return { tone: "bad", text: "服务商未定义", detail: `配置里没有 "${capability.platform}"` };
  if (capability.resolvable) return { tone: "ok", text: "映射已解析", detail: null };
  return { tone: "warn", text: "使用兜底", detail: capability.problem ?? null };
}

const route = (nodes) => {
  const children = [];
  nodes.forEach((node, index) => {
    if (index > 0) children.push(el("span", { class: "k-route__link", "aria-hidden": "true" }));
    children.push(el("div", { class: "k-route__node" },
      el("em", { text: node.key }),
      el("strong", { class: node.mono ? "is-mono" : "", text: node.value }),
      el("span", { text: node.note ?? "" }),
    ));
  });
  return el("div", { class: "k-route" }, ...children);
};

const strip = (items) => el("div", { class: "k-strip" }, ...items.map(([key, value, tone]) => el("div", { class: "k-strip__item" },
  el("em", { text: key }), el("strong", { class: tone ? `is-${tone}` : "", text: value }),
)));

function specsTable(platform, currentModel) {
  const entries = Object.entries(platform?.models ?? {});
  if (entries.length === 0) return emptyState("没有模型档案", `服务商 ${platform?.id ?? ""} 没有声明 models；调用仍可进行，只是面板读不到这些信息。`);
  return el("div", { class: "k-specs" }, ...entries.map(([model, profile]) => {
    const info = profile && typeof profile === "object" ? profile : {};
    const reasoning = info.reasoning && typeof info.reasoning === "object" ? info.reasoning : null;
    const levels = Array.isArray(reasoning?.levels) ? reasoning.levels : [];
    const chips = [
      `上下文 ${tokens(info.contextWindowTokens)}`, `输出 ${tokens(info.maxOutputTokens)}`,
      info.vision === true ? "识图" : "不支持识图",
      reasoning?.default ? `思考 ${reasoning.default}${levels.length ? `（${levels.length} 档）` : ""}` : "思考 —",
      info.protocol ? `协议 ${info.protocol}` : null, info.temperature ? `温度 ${info.temperature}` : null,
    ].filter(Boolean);
    return el("div", { class: `k-spec${model === currentModel ? " is-current" : ""}` },
      el("div", { class: "k-spec__head" }, el("b", { text: model }), model === currentModel ? el("i", { text: "当前使用" }) : null),
      el("div", { class: "k-chips" }, ...chips.map((text) => el("span", { class: "k-chip", text }))),
    );
  }));
}

function ttsCards(tts) {
  const engine = String(tts.engine ?? "");
  const engines = Object.entries(tts).filter(([name, value]) => name !== "engine" && value && typeof value === "object" && !Array.isArray(value));
  return el("div", { class: "k-engines" }, ...engines.map(([name, config]) => el("div", { class: `k-engine${name === engine ? " is-current" : ""}` },
    el("div", { class: "k-engine__head" }, el("span", { class: "k-engine__name", text: TTS_ENGINES[name] ?? name }), name === engine ? el("span", { class: "k-engine__now", text: "当前引擎" }) : null),
    el("dl", {}, ...Object.entries(config).flatMap(([key, value]) => [
      el("dt", { text: TTS_FIELDS[key] ?? key }),
      el("dd", { text: value !== null && typeof value === "object" ? JSON.stringify(value) : String(value) }),
    ])),
  )));
}

async function exportConfig(snapshot) {
  const payload = {
    platforms: Object.fromEntries((snapshot.platforms ?? []).map((platform) => [platform.id, {
      type: platform.type,
      ...(platform.apiKey.mode === "env-ref" ? { apiKey: `\${${platform.apiKey.envVar}}` } : {}),
      ...(platform.baseUrl ? { baseUrl: platform.baseUrl } : {}),
      ...(platform.models ? { models: platform.models } : {}),
      ...(platform.options ? { options: platform.options } : {}),
    }])),
    capabilities: Object.fromEntries((snapshot.capabilities ?? []).map((capability) => [capability.capability, {
      platform: capability.platform, model: capability.model,
      ...(capability.reasoningEffort ? { reasoningEffort: capability.reasoningEffort } : {}),
    }])),
    ...(snapshot.tts ? { tts: snapshot.tts } : {}),
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = el("a", { href: url, download: "ai-platforms.json" });
    document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    toast("已导出 ai-platforms.json");
  } catch {
    try { await navigator.clipboard.writeText(text); toast("已复制到剪贴板"); }
    catch { toast("导出失败：浏览器既不给下载也不给剪贴板", "bad"); }
  }
}

function buildCapabilityPanel(panel, context) {
  const { writable, markDirty, snapshot } = context;
  const rows = Object.entries(draft.capabilities).map(([code, capability]) => ({ code, capability }))
    .sort((a, b) => (a.capability.label ?? a.code).localeCompare(b.capability.label ?? b.code, "zh-CN"));
  const list = el("div", { class: "k-nav", role: "tablist", "aria-label": "用途" });
  const detail = el("div", { class: "k-card k-detail" });
  const search = el("input", { class: "k-nav__search", type: "search", placeholder: "筛选用途：名称、服务商、模型…", value: capabilityFilter });
  const pick = (code) => { lastCapability = code; rows.forEach((row, index) => row.node.setAttribute("aria-pressed", String(row.code === code))); paint(code); };
  rows.forEach((row) => {
    const status = capabilityStatus(row.capability, snapshot, row.code, draft.platforms[row.capability.platform]);
    row.node = el("button", { class: "k-nav__item", type: "button", role: "tab", "aria-pressed": "false" },
      el("strong", { text: row.capability.label ?? row.code }),
      el("small", { text: `${row.capability.platform || "未指定"} · ${row.capability.model || "未指定模型"}` }),
      el("span", { class: "k-chips" }, el("span", { class: `k-pill${status.tone === "ok" ? " k-pill--ok" : status.tone === "warn" ? " k-pill--warn" : status.tone === "bad" ? " k-pill--bad" : ""}`, text: status.text })),
    );
    row.node.addEventListener("click", () => pick(row.code));
    list.append(row.node);
  });
  search.addEventListener("input", () => {
    capabilityFilter = search.value;
    const needle = search.value.trim().toLowerCase();
    rows.forEach((row) => {
      const text = [row.capability.label, row.code, row.capability.platform, row.capability.model].filter(Boolean).join(" ").toLowerCase();
      row.node.hidden = Boolean(needle) && !text.includes(needle);
    });
  });
  panel.append(el("div", { class: "k-split" }, el("div", {}, search, list), detail));
  ctx: {
    // 键盘：↑↓ 在用途间移动
    list.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const visible = rows.filter((row) => !row.node.hidden);
      if (visible.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, visible.findIndex((row) => row.code === lastCapability));
      const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
      pick(visible[next].code);
      visible[next].node.focus();
    });
  }

  function paint(code) {
    const row = rows.find((item) => item.code === code);
    if (!row) return;
    const capability = row.capability;
    const platform = draft.platforms[capability.platform] ?? null;
    const profile = platform?.models?.[capability.model] ?? null;
    const status = capabilityStatus(capability, snapshot, code, platform);
    const blocks = [
      el("div", { class: "k-detail__head" },
        el("div", {},
          el("div", { class: "k-chips" }, el("h2", { class: "k-detail__title", text: capability.label ?? code }), codeTag(code)),
          el("p", { class: "k-detail__sub", text: "这个用途由下面这条链承担；改它要保存并重启服务。" }),
        ),
        el("div", { class: "k-chips" }, el("span", { class: `k-pill${status.tone === "ok" ? " k-pill--ok" : status.tone === "warn" ? " k-pill--warn" : status.tone === "bad" ? " k-pill--bad" : ""}`, text: status.text })),
      ),
      route([
        { key: "用途", value: capability.label ?? code, note: code },
        { key: "服务商", value: capability.platform || "未指定", note: platform ? typeLabel(platform) : "未定义的服务商" },
        { key: "模型", value: capability.model || "未指定", note: profile ? "档案已声明" : "档案未声明", mono: true },
      ]),
      strip([
        ["思考档", capability.reasoningEffort ?? "跟随档案默认", capability.reasoningEffort ? "" : "dim"],
        ["上下文窗口", tokens(profile?.contextWindowTokens), profile?.contextWindowTokens ? "" : "dim"],
        ["输出上限", tokens(profile?.maxOutputTokens), profile?.maxOutputTokens ? "" : "dim"],
        ["识图", profile?.vision === true ? "支持" : "不支持"],
        ["调用状态", status.detail ?? status.text, status.tone === "ok" ? "ok" : status.tone],
      ]),
    ];
    if (writable) {
      const select = el("select", { class: "field__input", "aria-label": "用途使用的服务商" },
        ...Object.keys(draft.platforms).map((id) => {
          const option = el("option", { value: id, text: `${id} · ${typeLabel(draft.platforms[id])}` });
          if (id === capability.platform) option.selected = true;
          return option;
        }));
      if (!draft.platforms[capability.platform]) {
        const option = el("option", { value: capability.platform, text: `${capability.platform || "（空）"}（未定义）` });
        option.selected = true; select.prepend(option);
      }
      select.addEventListener("change", () => { capability.platform = select.value; markDirty(); paint(code); });
      const input = el("input", { class: "field__input field__input--mono", type: "text", spellcheck: "false", value: capability.model, placeholder: "model id", "aria-label": "用途使用的模型" });
      input.addEventListener("input", () => {
        capability.model = input.value;
        const value = detail.querySelector(".k-route__node:nth-of-type(3) strong");
        if (value) value.textContent = capability.model || "未指定";
        markDirty();
      });
      blocks.push(el("div", { class: "cfg-edit" },
        el("div", { class: "field" }, el("label", { class: "field__label", text: "服务商" }), select,
          el("div", { class: "field__note", text: "保存是整体替换这个用途的映射，思考档会自动带回。" })),
        el("div", { class: "field" }, el("label", { class: "field__label", text: "模型" }), input,
          el("div", { class: "field__note", text: "必须是该服务商 models 里声明过的模型。" })),
      ));
    }
    blocks.push(el("div", { class: "cfg-section" },
      el("div", { class: "k-sec" }, el("h2", { text: "模型档案" }), el("span", { text: platform ? `${platform.id} 声明的模型能力` : "服务商未定义" })),
      specsTable(platform ?? { id: capability.platform, models: {} }, capability.model),
    ));
    const siblings = rows.filter((other) => other.code !== code && other.capability.platform === capability.platform && other.capability.model === capability.model);
    if (siblings.length > 0) {
      blocks.push(el("div", { class: "cfg-section" },
        el("div", { class: "k-sec" }, el("h2", { text: "共用同一个模型的用途" }), el("span", { text: `${siblings.length} 个` })),
        el("div", { class: "k-chips" }, ...siblings.map((other) => el("span", { class: "k-pill", text: other.capability.label ?? other.code }))),
      ));
    }
    if (status.detail) blocks.push(el("p", { class: "k-hint", text: status.detail }));
    detail.replaceChildren(...blocks);
  }

  pick(rows.some((row) => row.code === lastCapability) ? lastCapability : rows[0]?.code);
}

function buildProviderPanel(panel, context) {
  const { writable, markDirty, snapshot } = context;
  const unresolved = snapshot.unresolvedEnvRefs ?? [];
  const rows = Object.entries(draft.platforms).map(([id, platform]) => ({ id, platform })).sort((a, b) => a.id.localeCompare(b.id));
  const list = el("div", { class: "k-nav", role: "tablist", "aria-label": "服务商" });
  const detail = el("div", { class: "k-card k-detail" });
  const search = el("input", { class: "k-nav__search", type: "search", placeholder: "筛选服务商：名称、类型…", value: providerFilter });
  const pick = (id) => { lastProvider = id; rows.forEach((row) => row.node.setAttribute("aria-pressed", String(row.id === id))); paint(id); };
  rows.forEach((row) => {
    const keys = keyState(row.platform, unresolved);
    row.node = el("button", { class: "k-nav__item", type: "button", role: "tab", "aria-pressed": "false" },
      el("strong", { text: row.id }),
      el("small", { text: `${typeLabel(row.platform)} · ${row.platform.usedByCapabilities.length} 项用途` }),
      el("span", { class: "k-chips" }, el("span", { class: `k-pill${keys.tone === "ok" ? " k-pill--ok" : keys.tone === "warn" ? " k-pill--warn" : keys.tone === "bad" ? " k-pill--bad" : ""}`, text: keys.text })),
    );
    row.node.addEventListener("click", () => pick(row.id));
    list.append(row.node);
  });
  search.addEventListener("input", () => {
    providerFilter = search.value;
    const needle = search.value.trim().toLowerCase();
    rows.forEach((row) => {
      row.node.hidden = Boolean(needle) && ![row.id, row.platform.type, typeLabel(row.platform)].join(" ").toLowerCase().includes(needle);
    });
  });
  panel.append(el("div", { class: "k-split" }, el("div", {}, search, list), detail));

  function paint(id) {
    const row = rows.find((item) => item.id === id);
    if (!row) return;
    const platform = row.platform;
    const keys = keyState(platform, unresolved);
    const used = platform.usedByCapabilities;
    const blocks = [
      el("div", { class: "k-detail__head" },
        el("div", {},
          el("div", { class: "k-chips" }, el("h2", { class: "k-detail__title", text: platform.id }), badge(typeLabel(platform), "info")),
          el("p", { class: "k-detail__sub" }, codeTag(platform.type)),
        ),
        el("div", { class: "k-chips" },
          el("span", { class: `k-pill${keys.tone === "ok" ? " k-pill--ok" : keys.tone === "warn" ? " k-pill--warn" : keys.tone === "bad" ? " k-pill--bad" : ""}`, text: keys.text }),
          el("span", { class: `k-pill${used.length > 0 ? "" : " k-pill--warn"}`, text: used.length > 0 ? `被 ${used.length} 项使用` : "没有任何用途" }),
        ),
      ),
      route([
        { key: "服务商", value: platform.id, note: typeLabel(platform) },
        { key: "接口地址", value: platform.baseUrl || "未配置", note: platform.baseUrl ? "请求从这里出发" : "使用协议默认地址", mono: true },
        { key: "密钥", value: keys.status, note: keys.source },
      ]),
      strip([
        ["协议实现", `${platform.type} · ${typeLabel(platform)}`],
        ["被哪些用途使用", used.length > 0 ? used.join("、") : "没有任何用途"],
        ["模型档案", `${Object.keys(platform.models ?? {}).length} 个模型`],
      ]),
    ];
    if (writable) {
      const base = el("input", { class: "field__input field__input--mono", type: "text", spellcheck: "false", value: platform.baseUrl, placeholder: "https://…" });
      const key = el("input", { class: "field__input field__input--mono", type: "text", spellcheck: "false", value: platform.apiKey,
        placeholder: platform.apiKeyLocked ? "（写死在文件里，不显示也不改动）" : "${ENV_VAR}", disabled: platform.apiKeyLocked });
      base.addEventListener("input", () => { platform.baseUrl = base.value; markDirty(); });
      key.addEventListener("input", () => { platform.apiKey = key.value; markDirty(); });
      blocks.push(el("div", { class: "cfg-edit" },
        el("div", { class: "field" }, el("label", { class: "field__label", text: "接口地址" }), base),
        el("div", { class: "field" }, el("label", { class: "field__label", text: "密钥来源" }), key,
          el("div", { class: "field__note", text: platform.apiKeyLocked ? "要换成环境变量引用，先在文件里手动替换一次。" : "留空表示不需要密钥；写 ${VAR} 表示从环境变量读取。" })),
      ));
    }
    blocks.push(el("div", { class: "cfg-section" },
      el("div", { class: "k-sec" }, el("h2", { text: "模型档案" }), el("span", { text: `${Object.keys(platform.models ?? {}).length} 个模型` })),
      specsTable(platform),
    ));
    if (platform.options && Object.keys(platform.options).length > 0) {
      blocks.push(el("div", { class: "cfg-section" },
        el("div", { class: "k-sec" }, el("h2", { text: "provider 选项" }), el("span", { text: "网关怪癖：不在面板编辑" })),
        el("div", { class: "k-kv" }, ...Object.entries(platform.options).map(([name, value]) => el("div", { class: "k-kv__row" },
          el("span", { class: "k-kv__k", text: name }),
          el("span", { class: "k-kv__v", text: value !== null && typeof value === "object" ? JSON.stringify(value) : String(value) }),
        ))),
      ));
    }
    if (platform.model) blocks.push(el("p", { class: "k-hint", text: `旧版默认模型（已迁到用途映射）：${platform.model}` }));
    if (platform.apiKeyLocked) blocks.push(el("p", { class: "k-hint", text: "密钥以明文写在配置文件里：面板永远看不见它，也不会写回去。" }));
    detail.replaceChildren(...blocks);
  }

  pick(rows.some((row) => row.id === lastProvider) ? lastProvider : rows[0]?.id);
}

async function loadConfig(ctx) {
  const [snapshot, overview] = await Promise.all([api("/config"), api("/overview").catch(() => null)]);
  if (!ctx.isActive()) return el("div");
  const writable = snapshot.writable && snapshot.exists;
  const unresolved = snapshot.unresolvedEnvRefs ?? [];
  if (draft && draft.basedOnMtime && snapshot.configFileMtime && draft.basedOnMtime !== snapshot.configFileMtime) { draft = null; dirty = false; }
  if (!draft) { draft = snapshotToDraft(snapshot); draft.basedOnMtime = snapshot.configFileMtime; dirty = false; }

  const save = el("button", { class: "btn btn--sm btn--primary", type: "button", disabled: !dirty }, el("span", { text: "保存改动" }));
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const patch = draftToPatch(draft);
      if (Object.keys(patch).length === 0) { toast("没有改动需要保存"); markClean(); return; }
      const result = await api("/config", { method: "PUT", body: JSON.stringify(patch) });
      draft = snapshotToDraft(result.snapshot); draft.basedOnMtime = result.snapshot.configFileMtime;
      markClean(); toast("已保存。重启服务后新配置生效。"); await ctx.reload();
    } catch (error) { toast(error.message, "bad"); save.disabled = false; }
  });
  const flag = el("span", { class: "dirty-flag", text: "未保存", hidden: !dirty });
  const markDirty = () => { dirty = true; flag.hidden = false; save.disabled = !writable; };
  const markClean = () => { dirty = false; flag.hidden = true; save.disabled = true; };
  const reset = el("button", { class: "btn btn--sm", type: "button", text: "放弃", hidden: !writable });
  reset.addEventListener("click", () => { draft = null; dirty = false; ctx.reload(); });
  const exportBtn = el("button", { class: "btn btn--sm", type: "button", text: "导出 JSON" });
  exportBtn.addEventListener("click", () => exportConfig(snapshot));
  const reread = el("button", { class: "btn btn--sm", type: "button", text: "重新读取" });
  reread.addEventListener("click", () => { draft = null; dirty = false; ctx.reload(); });
  ctx.setHeadActions?.(save, flag, reset, exportBtn, reread);
  ctx.setHeadExtra?.();
  if (dirty) save.disabled = !writable;

  const wrap = el("div", {});
  wrap.append(el("div", { class: `banner banner--${writable ? "ok" : "warn"}` },
    el("span", {}, writable
      ? "这个部署的配置目录可写：改动保存后需要重启服务才会生效。"
      : `面板只能看，不能写：${snapshot.readOnlyReason ?? (snapshot.exists ? "配置文件不可写。" : "配置文件不存在。")} 要改配置请编辑文件后重启服务。`)));

  if (snapshot.issues.length > 0) {
    const blocking = snapshot.issues.filter((issue) => issue.blocking).length;
    const details = el("details", { class: "disclosure" },
      el("summary", {}, el("span", {}, "配置问题 ", badge(`${snapshot.issues.length} 处`, blocking > 0 ? "bad" : "warn"), blocking > 0 ? badge(`其中 ${blocking} 处阻塞`, "bad") : null), el("span", { class: "section__note", text: "点开看路径" })),
      el("div", { class: "disclosure__body" }, el("ul", { class: "issue-list" }, ...snapshot.issues.map((issue) =>
        el("li", { class: "issue", dataset: { blocking: String(issue.blocking) } }, codeTag(issue.path || "(root)"), el("span", { text: issue.message }))))),
    );
    details.open = blocking > 0;
    wrap.append(details);
  }
  if (unresolved.length > 0) wrap.append(el("div", { class: "banner banner--warn" },
    el("span", {}, `有 ${unresolved.length} 个密钥没配：${unresolved.join("、")}。这些模型服务现在用不了。`)));

  const capabilityPanel = el("div", { class: "config-panel", role: "tabpanel", id: "config-panel-capabilities" });
  const providerPanel = el("div", { class: "config-panel", role: "tabpanel", id: "config-panel-providers", hidden: true });
  const tabs = el("div", { class: "k-tabs", role: "tablist", "aria-label": "模型配置视图" });
  TABS.forEach((tab) => {
    const button = el("button", { class: "k-tabs__btn", type: "button", role: "tab", id: `config-tab-${tab.id}`, "aria-pressed": String(activeTab === tab.id), text: tab.label });
    button.addEventListener("click", () => setTab(tab.id));
    tabs.append(button);
  });
  function setTab(id) {
    activeTab = id;
    [...tabs.children].forEach((button) => button.setAttribute("aria-pressed", String(button.id === `config-tab-${id}`)));
    capabilityPanel.hidden = id !== "capabilities";
    providerPanel.hidden = id !== "providers";
  }
  const workspace = el("div", { class: "k-workspace" }, el("div", {}, tabs), capabilityPanel, providerPanel);

  if (Object.keys(draft.capabilities).length === 0) capabilityPanel.append(emptyState("配置里没有任何用途映射", "所有模型调用都没有去向了；要补请编辑配置文件。"));
  else buildCapabilityPanel(capabilityPanel, { writable, markDirty, snapshot });
  if (Object.keys(draft.platforms).length === 0) providerPanel.append(emptyState("配置里没有任何服务商", "模型调用无处可去；要加请编辑配置文件。"));
  else buildProviderPanel(providerPanel, { writable, markDirty, snapshot });
  setTab(activeTab);

  const reference = [];
  if (draft.tts) reference.push(el("div", { class: "k-card k-wrap" },
    el("div", { class: "k-sec" }, el("h2", { text: "语音合成" }), el("span", { text: "只读 · 改它要编辑配置文件" })), ttsCards(draft.tts)));
  if (overview?.capabilities?.length) reference.push(el("div", { class: "k-card k-wrap" },
    el("div", { class: "k-sec" }, el("h2", { text: "功能开关" }), el("span", { text: "改这些要改环境变量并重启" })),
    el("div", { class: "k-toggles" }, ...overview.capabilities.map((item) => el("div", { class: "k-toggle" },
      el("div", { class: "k-toggle__main" }, el("span", { class: "k-toggle__name", text: item.label }), el("span", { class: "k-toggle__detail", text: item.detail }), codeTag(item.key)),
      badge(item.enabled ? "可用" : "未启用", item.enabled ? "ok" : "neutral"),
    )))));
  // 语音合成与功能开关是低频的只读参考，不占与主详情等高的常驻右栏；
  // 主工作台吃满宽度，参考信息作为一条次级带排在它下面。
  wrap.append(workspace);
  if (reference.length > 0) wrap.append(el("div", { class: "k-ref" }, ...reference));
  wrap.append(el("p", { class: "k-hint" }, el("span", { class: "path-note", text: snapshot.path })));
  return wrap;
}
