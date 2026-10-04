/* ============================================================
   视图 · 模型配置
   ------------------------------------------------------------
   这页在可写部署里是**编辑器**，在只读部署里是**说明页**——两种状态都
   如实呈现，不做"看着能点、点了报错"的假控件。

   编辑器按「补丁」的思路工作：
     - 每个输入都对着配置里的一个具体字段（baseUrl / apiKey / model…）；
     - 保存时只提交**被改过的字段**（PUT /admin/api/config 是补丁合并）；
     - 明文密钥不属于"可表达"的字段——面板从来看不见它，所以它也永远不会
       被面板写回去（服务端在磁盘上原地保留）。输入框显示的要么是 `${VAR}`
       引用，要么是"写死在文件里（不改动）"。

   能力开关（LEARNING_RUN_ENABLED 这类）是**环境变量**，改它要改 compose 再
   重启；面板只展示实际生效值，不给假开关。
   ============================================================ */

import { api } from "../api-client.js";
import { el, section, codeTag, badge, toast } from "../ui.js";

export const view = {
  title: "模型配置",
  lede: "每种功能由哪家模型服务、哪个模型来回答。密钥不经过浏览器——这里只看它引用了哪个环境变量、有没有配好。",
  load: loadConfig,
};

/** 视图内草稿状态：切走再切回来时**保留**未保存的改动（与设置页的习惯一致，
 *  草稿不因切视图而丢）；锁定清空（app.js 调用 resetDraft）。 */
let draft = null;
let dirty = false;

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
      options: platform.options,
      model: platform.model,
      visionModel: platform.visionModel,
      embeddingModel: platform.embeddingModel,
      usedByCapabilities: platform.usedByCapabilities,
      original: {
        baseUrl: platform.baseUrl ?? "",
        apiKey: platform.apiKey.mode === "env-ref" ? `\${${platform.apiKey.envVar}}` : "",
      },
    }])),
    capabilities: Object.fromEntries((snapshot.capabilities ?? []).map((capability) => [capability.capability, {
      platform: capability.platform,
      model: capability.model,
      visionModel: capability.visionModel,
      embeddingModel: capability.embeddingModel,
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
    if (capability.visionModel) mapping.visionModel = capability.visionModel;
    if (capability.embeddingModel) mapping.embeddingModel = capability.embeddingModel;
    const changed = capability.platform !== capability.original.platform
      || capability.model !== capability.original.model;
    if (changed) capabilities[name] = mapping;
  }
  if (Object.keys(capabilities).length > 0) patch.capabilities = capabilities;
  return patch;
}

async function loadConfig(ctx) {
  const [snapshot, overview] = await Promise.all([
    api("/config"),
    api("/overview").catch(() => null),
  ]);
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

  const wrap = el("div", {});
  const saveBar = el("div", { class: "actions" });
  const dirtyFlag = el("span", { class: "dirty-flag", text: "有未保存的改动", hidden: !dirty });
  function markDirty() {
    dirty = true;
    dirtyFlag.hidden = false;
    saveButton.disabled = false;
  }
  function markClean() {
    dirty = false;
    dirtyFlag.hidden = true;
    saveButton.disabled = true;
  }

  /* ── 状态横幅 ── */
  wrap.append(
    el("div", { class: `banner banner--${writable ? "ok" : "warn"}` },
      el("span", { class: "banner__icon", text: writable ? "✓" : "!" }),
      el("span", {},
        writable
          ? "这个部署的配置目录可写：下面的改动会保存到配置文件，之后需要重启服务才会生效（面板会提醒你）。"
          : `面板只能看，不能写：${snapshot.readOnlyReason ?? (snapshot.exists ? "配置文件不可写。" : "配置文件不存在。")} 要改配置请编辑 ${snapshot.path} 后重启服务。`,
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
      el("span", { class: "banner__icon", text: "!" }),
      el("span", {},
        `有 ${snapshot.unresolvedEnvRefs.length} 个密钥没配：`,
        snapshot.unresolvedEnvRefs.join("、"),
        "。这些模型服务现在用不了，调用会失败。",
      ),
    ));
  }

  /* ── 能力开关（环境变量，只读）── */
  if (overview?.capabilities?.length) {
    wrap.append(section("现在能用哪些功能", "改这个要改环境变量并重启",
      el("div", { class: "grid grid--wide" },
        ...overview.capabilities.map((capability) =>
          el("div", { class: "panel" },
            el("div", { class: "stat__label" },
              el("span", { text: capability.label }),
              badge(capability.enabled ? "可用" : "未启用", capability.enabled ? "on" : "off"),
            ),
            el("div", { class: "stat__hint", text: capability.detail }),
            el("div", { class: "u-mt-10" }, codeTag(capability.key)),
          )),
      )));
  }

  /* ── 模型服务商（可编辑：baseUrl / apiKey 引用）── */
  const platformRows = [];
  for (const [id, platform] of Object.entries(draft.platforms)) {
    const baseUrlInput = el("input", {
      class: "field__input", type: "text", spellcheck: "false",
      value: platform.baseUrl, placeholder: "https://…",
      disabled: !writable,
      oninput: (event) => { platform.baseUrl = event.target.value; markDirty(); },
    });
    const apiKeyInput = el("input", {
      class: "field__input", type: "text", spellcheck: "false",
      value: platform.apiKey,
      placeholder: platform.apiKeyLocked ? "（写死在文件里，不显示也不改动）" : "${ENV_VAR}",
      disabled: !writable || platform.apiKeyLocked,
      oninput: (event) => { platform.apiKey = event.target.value; markDirty(); },
    });
    platformRows.push(
      el("div", { class: "cfg-item" },
        el("div", { class: "cfg-item__id" },
          el("div", { class: "cfg-item__name", text: id }),
          el("div", { class: "cfg-item__badges" },
            badge(platform.type, "info"),
            badge(
              platform.apiKeyLocked ? "密钥写死在文件里"
                : platform.apiKey ? (platform.apiKey.includes("${") ? "引用环境变量" : "字面密钥")
                  : "不需要密钥",
              platform.apiKeyLocked ? "warn" : "off",
            ),
          ),
          el("div", {
            class: "cfg-item__note",
            text: platform.usedByCapabilities.length > 0
              ? `被 ${platform.usedByCapabilities.join("、")} 使用`
              : "目前没有任何功能用它",
          }),
        ),
        el("div", { class: "cfg-item__fields" },
          el("div", { class: "field" },
            el("label", { class: "field__label", text: "接口地址" }),
            baseUrlInput,
            platform.apiKeyLocked ? el("div", { class: "field__note", text: "该平台密钥以明文写在文件里；面板不读它，保存时也不会碰它。" }) : null,
          ),
          el("div", { class: "field" },
            el("label", { class: "field__label", text: "密钥来源" }),
            apiKeyInput,
            el("div", {
              class: "field__note",
              text: platform.apiKeyLocked
                ? "要换成环境变量引用，先在文件里手动替换一次。"
                : "留空表示不需要密钥；写 ${VAR} 表示从环境变量读取。",
            }),
          ),
        ),
      ),
    );
  }

  wrap.append(section("模型服务商",
    writable ? "编辑后点保存 · 增删平台请直接改文件" : `只读 · 要改：编辑 ${snapshot.path}`,
    ...platformRows));

  /* ── 能力 → 模型（可编辑：platform / model）── */
  const platformIds = Object.keys(draft.platforms);
  const capabilityRows = [];
  for (const [name, capability] of Object.entries(draft.capabilities)) {
    const select = el("select", {
      class: "field__input",
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
      select.prepend(option);
    }
    const modelInput = el("input", {
      class: "field__input", type: "text", spellcheck: "false",
      value: capability.model, placeholder: "model id",
      disabled: !writable,
      oninput: (event) => { capability.model = event.target.value; markDirty(); },
    });
    capabilityRows.push(
      el("div", { class: "cfg-item" },
        el("div", { class: "cfg-item__id" },
          el("div", { class: "cfg-item__name", text: name }),
          el("div", { class: "cfg-item__badges" },
            badge(capability.resolvable ? "当前可用" : "会用兜底", capability.resolvable ? "on" : "warn"),
          ),
          capability.problem ? el("div", { class: "cfg-item__note", text: capability.problem }) : null,
        ),
        el("div", { class: "cfg-item__fields" },
          el("div", { class: "field" },
            el("label", { class: "field__label", text: "服务商" }),
            select,
          ),
          el("div", { class: "field" },
            el("label", { class: "field__label", text: "模型" }),
            modelInput,
            capability.visionModel ? el("div", { class: "field__note", text: `视觉模型：${capability.visionModel}（不改动）` }) : null,
            capability.embeddingModel ? el("div", { class: "field__note", text: `嵌入模型：${capability.embeddingModel}（不改动）` }) : null,
          ),
        ),
      ),
    );
  }

  wrap.append(section("每种功能用哪个模型",
    writable ? "编辑后点保存" : `只读 · 要改：编辑 ${snapshot.path}`,
    ...capabilityRows));

  /* ── TTS（保持只读展示：JSON 结构，改它请用文件）── */
  if (draft.tts) {
    wrap.append(section("语音合成", `只读 · 要改：编辑 ${snapshot.path}`,
      el("div", { class: "panel" },
        el("pre", { class: "mono u-m-0", style: "white-space:pre-wrap;margin:0", text: JSON.stringify(draft.tts, null, 2) }),
      )));
  }

  /* ── 动作 ── */
  const saveButton = el("button", {
    class: "btn btn--primary", type: "button", disabled: !dirty,
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

  const resetButton = el("button", {
    class: "btn", type: "button", hidden: !writable,
    onclick: () => { draft = null; dirty = false; ctx.reload(); },
  }, el("span", { text: "放弃改动" }));

  const exportButton = el("button", {
    class: "btn", type: "button", text: "导出 JSON",
    onclick: () => exportConfig(snapshot),
  });

  const rereadButton = el("button", {
    class: "btn", type: "button", text: "重新读取",
    onclick: () => { draft = null; dirty = false; ctx.reload(); },
  });

  saveBar.append(saveButton, resetButton, exportButton, rereadButton, dirtyFlag,
    el("span", { class: "path-note", text: snapshot.path }));

  if (!writable) {
    saveBar.querySelectorAll("button").forEach((button) => {
      if (button.textContent.includes("保存") || button.textContent.includes("放弃")) button.disabled = true;
    });
  }
  wrap.append(saveBar);

  return wrap;
}

/** 把当前快照导出成 JSON 文件（与旧版一致：apiKey 只会是 ${ENV} 引用）。 */
async function exportConfig(snapshot) {
  const payload = {
    platforms: Object.fromEntries(
      (snapshot.platforms ?? []).map((p) => [
        p.id,
        {
          type: p.type,
          ...(p.apiKey.mode === "env-ref" ? { apiKey: `\${${p.apiKey.envVar}}` } : {}),
          ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
          ...(p.options ? { options: p.options } : {}),
        },
      ]),
    ),
    capabilities: Object.fromEntries(
      (snapshot.capabilities ?? []).map((c) => [c.capability, {
        platform: c.platform,
        model: c.model,
        ...(c.visionModel ? { visionModel: c.visionModel } : {}),
        ...(c.embeddingModel ? { embeddingModel: c.embeddingModel } : {}),
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
