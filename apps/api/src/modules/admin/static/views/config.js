/* ============================================================
   视图 · 模型配置（主从）
   ------------------------------------------------------------
   左列表是平台清单（名字 + 密钥状态），右详情是**被选中平台**的编辑表单；
   保存/放弃/导出常驻页头带——改到一半不用滚回底部找按钮。

   编辑器按「补丁」工作：每个输入对着配置里的一个具体字段，保存时只提交
   被改过的字段（PUT /admin/api/config 是补丁合并）。明文密钥不属于"可表达"
   的字段——面板从来看不见它，所以也永远不会被写回去（服务端原地保留）。

   能力开关（LEARNING_RUN_ENABLED 这类）是**环境变量**，改它要改 compose 再
   重启；面板只展示实际生效值，不给假开关。
   ============================================================ */

import { api } from "../api-client.js";
import { el, bindTabList, section, codeTag, badge, toast } from "../ui.js";

export const view = {
  title: "模型配置", eyebrow: "MODEL CONNECTIONS",
  lede: "管理模型服务与能力映射，让每次调用都有清晰的去向。",
  load: loadConfig,
};

/** 视图内草稿状态：切走再切回来时**保留**未保存的改动（与设置页的习惯一致，
 *  草稿不因切视图而丢）；锁定清空（app.js 调用 resetDraft）。 */
let draft = null;
let dirty = false;
let lastSelectedPlatform = null;

/** 锁定/换令牌时清掉草稿：它属于上一个会话的上下文。 */
export function resetDraft() {
  draft = null;
  dirty = false;
}

function snapshotToDraft(snapshot) {
  return {
    platforms: Object.fromEntries((snapshot.platforms ?? []).map((platform) => [platform.id, {
      type: platform.type,
      baseUrl: platform.baseUrl ?? "",
      // 明文密钥显示为空并锁住：它不回浏览器，也不该被面板写坏。
      apiKey: platform.apiKey.mode === "env-ref" ? `\${${platform.apiKey.envVar}}` : "",
      apiKeyLocked: platform.apiKey.mode === "literal-redacted",
      apiKeyMode: platform.apiKey.mode,
      options: platform.options,
      model: platform.model,
      // 模型档案（2026-10-06 配置重设计）：只展示，不编辑；保存时原样保留。
      models: platform.models,
      usedByCapabilities: platform.usedByCapabilities,
      original: {
        baseUrl: platform.baseUrl ?? "",
        apiKey: platform.apiKey.mode === "env-ref" ? `\${${platform.apiKey.envVar}}` : "",
      },
    }])),
    capabilities: Object.fromEntries((snapshot.capabilities ?? []).map((capability) => [capability.capability, {
      // 服务端给的人话名要带进草稿：表格里显示中文而不是 agent_turn 这种代号。
      label: capability.label ?? null,
      platform: capability.platform,
      model: capability.model,
      resolvable: capability.resolvable,
      problem: capability.problem,
      original: { platform: capability.platform, model: capability.model },
    }])),
    tts: snapshot.tts,
  };
}

/** 草稿 → 只包含改动的补丁。 */
function draftToPatch(current) {
  const patch = {};
  const platforms = {};
  for (const [id, platform] of Object.entries(current.platforms)) {
    const fields = {};
    if (platform.baseUrl !== platform.original.baseUrl) {
      fields.baseUrl = platform.baseUrl.trim() === "" ? null : platform.baseUrl.trim();
    }
    if (!platform.apiKeyLocked && platform.apiKey !== platform.original.apiKey) {
      fields.apiKey = platform.apiKey.trim() === "" ? null : platform.apiKey.trim();
    }
    if (Object.keys(fields).length > 0) platforms[id] = fields;
  }
  if (Object.keys(platforms).length > 0) patch.platforms = platforms;

  const capabilities = {};
  for (const [name, capability] of Object.entries(current.capabilities)) {
    const mapping = { platform: capability.platform, model: capability.model };
    const changed = capability.platform !== capability.original.platform
      || capability.model !== capability.original.model;
    if (changed) capabilities[name] = mapping;
  }
  if (Object.keys(capabilities).length > 0) patch.capabilities = capabilities;
  return patch;
}

function keyBadge(platform) {
  if (platform.apiKeyLocked) return badge("密钥写死在文件里", "warn");
  if (platform.apiKeyMode === "unset") return badge("不需要密钥", "neutral");
  if (platform.apiKey && platform.apiKey.includes("${")) return badge("引用环境变量", "ok");
  return badge("字面密钥", "warn");
}

async function loadConfig(ctx) {
  const [snapshot, overview] = await Promise.all([
    api("/config"),
    api("/overview").catch(() => null),
  ]);
  if (!ctx.isActive()) return el("div");
  const writable = snapshot.writable && snapshot.exists;

  // 外部（另一个标签页/手工编辑）变更后，旧草稿不再对应磁盘现状：
  // mtime 变了就丢弃未保存草稿，避免拿着旧基底提交补丁。
  if (draft && draft.basedOnMtime && snapshot.configFileMtime && draft.basedOnMtime !== snapshot.configFileMtime) {
    draft = null;
    dirty = false;
  }
  if (!draft) {
    draft = snapshotToDraft(snapshot);
    draft.basedOnMtime = snapshot.configFileMtime;
    dirty = false;
  }

  /* ── 常驻页头的动作（保存/放弃/导出/重读）── */
  const saveButton = el("button", {
    class: "btn btn--sm btn--primary", type: "button", disabled: !dirty,
    onclick: async () => {
      saveButton.disabled = true;
      try {
        const patch = draftToPatch(draft);
        if (Object.keys(patch).length === 0) {
          toast("没有改动需要保存");
          markClean();
          return;
        }
        const result = await api("/config", { method: "PUT", body: JSON.stringify(patch) });
        draft = snapshotToDraft(result.snapshot);
        draft.basedOnMtime = result.snapshot.configFileMtime;
        markClean();
        toast("已保存。重启服务后新配置生效。", "ok");
        await ctx.reload();
      } catch (error) {
        toast(error.message, "bad");
        saveButton.disabled = false;
      }
    },
  }, el("span", { text: "保存改动" }));

  const dirtyFlag = el("span", { class: "dirty-flag", text: "未保存", hidden: !dirty });
  function markDirty() {
    dirty = true;
    dirtyFlag.hidden = false;
    saveButton.disabled = !writable;
  }
  function markClean() {
    dirty = false;
    dirtyFlag.hidden = true;
    saveButton.disabled = true;
  }

  const resetButton = el("button", {
    class: "btn btn--sm", type: "button", text: "放弃", hidden: !writable,
    onclick: () => { draft = null; dirty = false; ctx.reload(); },
  });
  const exportButton = el("button", {
    class: "btn btn--sm", type: "button", text: "导出 JSON",
    onclick: () => exportConfig(snapshot),
  });
  const rereadButton = el("button", {
    class: "btn btn--sm", type: "button", text: "重新读取",
    onclick: () => { draft = null; dirty = false; ctx.reload(); },
  });
  ctx.setHeadActions?.(saveButton, dirtyFlag, resetButton, exportButton, rereadButton);
  ctx.setHeadExtra?.();

  if (dirty) saveButton.disabled = !writable;

  const wrap = el("div", {});

  /* ── 状态横幅 ── */
  wrap.append(
    el("div", { class: `banner banner--${writable ? "ok" : "warn"}` },
      el("span", {},
        writable
          ? "这个部署的配置目录可写：改动保存后需要重启服务才会生效。"
          : `面板只能看，不能写：${snapshot.readOnlyReason ?? (snapshot.exists ? "配置文件不可写。" : "配置文件不存在。")} 要改配置请编辑文件后重启服务。`,
      ),
    ),
  );

  /* ── 配置问题（有问题先看问题）── */
  if (snapshot.issues.length > 0) {
    wrap.append(section("配置问题", `${snapshot.issues.length} 处`, el("ul", { class: "issue-list" },
      ...snapshot.issues.map((issue) =>
        el("li", { class: "issue", dataset: { blocking: String(issue.blocking) } },
          codeTag(issue.path || "(root)"),
          el("span", { text: issue.message }),
        )),
    )));
  }
  if (snapshot.unresolvedEnvRefs.length > 0) {
    wrap.append(el("div", { class: "banner banner--warn" },
      el("span", {},
        `有 ${snapshot.unresolvedEnvRefs.length} 个密钥没配：${snapshot.unresolvedEnvRefs.join("、")}。这些模型服务现在用不了，调用会失败。`,
      ),
    ));
  }

  /* ── 模型服务商：主从 ── */
  const platformIds = Object.keys(draft.platforms);
  const list = el("div", { class: "list", role: "tablist", "aria-label": "模型服务商" });
  const detail = el("div", { class: "detail" });
  let selected = Math.max(0, platformIds.indexOf(lastSelectedPlatform));

  const rowNodes = platformIds.map((id, index) => {
    const row = el("button", {
      class: "list-row", type: "button", role: "tab",
      "aria-pressed": "false",
      onclick: () => select(index),
    },
      el("span", { class: "list-row__name", text: id }),
      el("span", { class: "list-row__nums" },
        draft.platforms[id].usedByCapabilities.length > 0
          ? el("span", { class: "dim", text: `被 ${draft.platforms[id].usedByCapabilities.length} 项使用` })
          : el("span", { class: "dim", text: "未使用" }),
      ),
    );
    return row;
  });
  list.append(...rowNodes);
  ctx.onCleanup(bindTabList(list, detail, "platforms"));
  const search = el("input", { class: "field__input list-search", type: "search", placeholder: "筛选模型服务商…", "aria-label": "筛选模型服务商" });
  const noMatch = el("p", { class: "empty", text: "没有匹配的服务商", hidden: true });
  search.addEventListener("input", () => {
    const needle = search.value.trim().toLowerCase();
    rowNodes.forEach((node, i) => node.hidden = !platformIds[i].toLowerCase().includes(needle));
    noMatch.hidden = rowNodes.some((node) => !node.hidden);
  });
  const navigator = el("div", { class: "navigator" }, search, list, noMatch);

  function select(index) {
    selected = index;
    lastSelectedPlatform = platformIds[index];
    rowNodes.forEach((node, i) => node.setAttribute("aria-pressed", String(i === index)));
    paintPlatform(platformIds[index]);
  }

  function paintPlatform(id) {
    const platform = draft.platforms[id];
    if (!platform) return;

    const baseUrlInput = el("input", {
      class: "field__input field__input--mono", type: "text", spellcheck: "false",
      id: "platform-base-url", value: platform.baseUrl, placeholder: "https://…",
      disabled: !writable,
      oninput: (event) => { platform.baseUrl = event.target.value; markDirty(); },
    });
    const apiKeyInput = el("input", {
      class: "field__input field__input--mono", type: "text", spellcheck: "false",
      id: "platform-key-source", value: platform.apiKey,
      placeholder: platform.apiKeyLocked ? "（写死在文件里，不显示也不改动）" : "${ENV_VAR}",
      disabled: !writable || platform.apiKeyLocked,
      oninput: (event) => { platform.apiKey = event.target.value; markDirty(); },
    });

    detail.replaceChildren(...[
      el("div", { class: "detail__head" },
        el("div", {},
          el("div", { class: "detail__title", text: id }),
          el("div", { class: "dim", style: "font-size:11.5px;margin-top:3px", text: platform.usedByCapabilities.length > 0 ? `被 ${platform.usedByCapabilities.join("、")} 使用` : "目前没有任何功能用它" }),
        ),
        el("div", { class: "row", style: "gap:6px" },
          badge(platform.type, "info"),
          keyBadge(platform),
        ),
      ),
      el("div", { class: "cfg-item u-mt-14" },
        el("div", { class: "field" },
          el("label", { class: "field__label", for: "platform-base-url", text: "接口地址" }),
          baseUrlInput,
          platform.apiKeyLocked
            ? el("div", { class: "field__note", text: "该平台密钥以明文写在文件里；面板不读它，保存时也不会碰它。" })
            : null,
        ),
        el("div", { class: "field" },
          el("label", { class: "field__label", for: "platform-key-source", text: "密钥来源" }),
          apiKeyInput,
          el("div", { class: "field__note", text: platform.apiKeyLocked ? "要换成环境变量引用，先在文件里手动替换一次。" : "留空表示不需要密钥；写 ${VAR} 表示从环境变量读取。" }),
        ),
      ),
      platform.options
        ? el("div", { class: "dim", style: "font-size:11.5px;margin-top:12px" },
            `provider 选项（不在面板编辑）：${JSON.stringify(platform.options)}`)
        : null,
      platform.models
        ? el("div", { class: "dim", style: "font-size:11.5px;margin-top:12px" },
            `模型档案（不在面板编辑）：${Object.entries(platform.models).map(([model, profile]) => {
              const bits = [];
              if (profile?.contextWindowTokens) bits.push(`窗口 ${profile.contextWindowTokens}`);
              if (profile?.maxOutputTokens) bits.push(`输出 ${profile.maxOutputTokens}`);
              if (profile?.vision) bits.push("识图");
              if (profile?.reasoning?.default) bits.push(`推理默认 ${profile.reasoning.default}`);
              if (profile?.temperature) bits.push(`温度参数 ${profile.temperature}`);
              return bits.length > 0 ? `${model}（${bits.join(" · ")}）` : model;
            }).join("；")}`)
        : null,
    ].filter(Boolean));
  }

  if (platformIds.length > 0) {
    wrap.append(section("模型服务商", writable ? "选中后编辑 · 保存常驻页头" : `只读 · 要改：编辑 ${snapshot.path}`,
      el("div", { class: "split" }, navigator, detail)));
    select(selected);
  } else {
    wrap.append(section("模型服务商", "0 个", el("div", { class: "empty" },
      el("strong", { text: "配置里没有任何平台" }),
      "新增平台请直接编辑配置文件。")));
  }

  /* ── 能力 → 模型 ── */
  const capabilityNames = Object.keys(draft.capabilities);
  wrap.append(section("每种功能用哪个模型", writable ? "编辑后点保存" : `只读 · 要改：编辑 ${snapshot.path}`,
    el("div", { class: "table table__scroll" },
      el("table", {},
        el("thead", {}, el("tr", {},
          el("th", { text: "功能" }),
          el("th", { text: "服务商" }),
          el("th", { text: "模型" }),
          el("th", { text: "状态" }),
        )),
        el("tbody", {},
          ...capabilityNames.map((name) => {
            const capability = draft.capabilities[name];
            const selectEl = el("select", {
              class: "field__input", "aria-label": `${capability.label ?? name}的服务商`,
              disabled: !writable,
              onchange: (event) => { capability.platform = event.target.value; markDirty(); },
            }, ...platformIds.map((id) => {
              const option = el("option", { value: id, text: id });
              if (id === capability.platform) option.selected = true;
              return option;
            }));
            if (!platformIds.includes(capability.platform)) {
              const option = el("option", { value: capability.platform, text: `${capability.platform}（未定义）` });
              option.selected = true;
              selectEl.prepend(option);
            }
            const modelInput = el("input", {
              class: "field__input field__input--mono", type: "text", spellcheck: "false",
              "aria-label": `${capability.label ?? name}的模型`, value: capability.model, placeholder: "model id",
              disabled: !writable,
              oninput: (event) => { capability.model = event.target.value; markDirty(); },
            });
            const blockingIssue = snapshot.issues.find((issue) => issue.blocking && issue.path?.startsWith(`capabilities.${name}`));
            return el("tr", {},
              el("td", {},
                el("span", { text: capability.label ?? name }),
                capability.label ? el("div", { class: "dim", style: "font-size:11px" }, codeTag(name)) : null,
              ),
              el("td", { style: "min-width:170px" }, selectEl),
              el("td", { style: "min-width:220px" }, modelInput),
              el("td", {},
                badge(blockingIssue ? "配置待修复" : capability.resolvable ? "映射已解析" : "使用兜底", blockingIssue ? "bad" : capability.resolvable ? "ok" : "warn"),
                (blockingIssue || capability.problem) ? el("div", { class: "dim", style: "font-size:11px;margin-top:4px", text: blockingIssue?.message ?? capability.problem }) : null,
              ),
            );
          }),
        ),
      ),
    ),
  ));

  /* ── 能力开关（环境变量，只读）── */
  if (overview?.capabilities?.length) {
    wrap.append(section("现在能用哪些功能", "改这个要改环境变量并重启",
      el("div", { class: "caps" },
        ...overview.capabilities.map((capability) =>
          el("div", { class: "cap" },
            el("div", { class: "cap__head" },
              el("span", { class: "cap__name", text: capability.label }),
              badge(capability.enabled ? "可用" : "未启用", capability.enabled ? "ok" : "neutral"),
            ),
            el("div", { class: "cap__detail", text: capability.detail }),
            el("div", { class: "cap__code" }, codeTag(capability.key)),
          )),
      )));
  }

  /* ── TTS（只读展示：JSON 结构，改它请用文件）── */
  if (draft.tts) {
    wrap.append(section("语音合成", `只读 · 要改：编辑 ${snapshot.path}`,
      el("pre", { class: "code-block", text: JSON.stringify(draft.tts, null, 2) })));
  }

  wrap.append(el("div", { class: "u-mt-14" },
    el("span", { class: "path-note", text: snapshot.path })));

  return wrap;
}

/** 把当前快照导出成 JSON 文件（apiKey 只会是 ${ENV} 引用，永不含明文）。 */
async function exportConfig(snapshot) {
  const payload = {
    platforms: Object.fromEntries(
      (snapshot.platforms ?? []).map((p) => [
        p.id,
        {
          type: p.type,
          ...(p.apiKey.mode === "env-ref" ? { apiKey: `\${${p.apiKey.envVar}}` } : {}),
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(p.models ? { models: p.models } : {}),
          ...(p.options ? { options: p.options } : {}),
        },
      ]),
    ),
    capabilities: Object.fromEntries(
      (snapshot.capabilities ?? []).map((c) => [c.capability, {
        platform: c.platform,
        model: c.model,
      }]),
    ),
    ...(snapshot.tts ? { tts: snapshot.tts } : {}),
  };

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = el("a", { href: url, download: "ai-platforms.json" });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast("已导出 ai-platforms.json");
  } catch {
    // 兜底：下载被环境挡住时至少能复制到剪贴板。
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制到剪贴板");
    } catch {
      toast("导出失败：浏览器既不给下载也不给剪贴板", "bad");
    }
  }
}
