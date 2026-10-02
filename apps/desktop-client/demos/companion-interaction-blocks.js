/* One content model renders into both lightweight bubbles and the conversation book. */
(() => {
  const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
  const extraIcons = {
    search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
    mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    plus:'<path d="M12 5v14M5 12h14"/>', square:'<rect x="5" y="5" width="14" height="14" rx="2"/>',
    "arrow-down":'<path d="M12 5v14m-7-7 7 7 7-7"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    "message-circle":'<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/>',
    image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 15-5-5L5 21"/>',
    loader:'<path d="M12 3a9 9 0 1 1-9 9"/>',
  };
  function icon(name) {
    const content = extraIcons[name] || (window.NOTEBOOK_ICONS[name] || []).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key,value]) => `${key}="${escape(value)}"`).join(" ")}/>`).join("");
    return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
  }
  const referenceText = "Query 表达当前想找什么，Key 用来判断是否相关，Value 是最终取回的内容。相关程度决定了每份内容在结果里占多少分量。";
  const explanation = "把它想成在书架上找书：Query 是你的问题，Key 是书名和目录，Value 是书里真正有用的内容。\n\n先比较相关程度，再按权重把内容汇总起来。不是只挑一本，而是让有关的内容贡献更多。";
  const longExplanation = `${explanation}\n\n① Query：带着问题去找\n“我想知道海洋为什么是蓝色的”就是这一次的 Query。相同的书架，问题不同，关注的内容也会不同。\n\n② Key：用线索判断相关\n书名和目录帮助你判断一本书是否与问题有关。Query 与每个 Key 比较，得到各自的相关程度。\n\n③ Value：读到真正的内容\n最后汇总的是内容，不是书名。相关程度越高，那份内容在结果中占的分量越大。\n\n试着换一个问题：“海豚怎么交流？” 同一个书架上的书，权重是不是又变了？\n\n四个容易混淆的地方\n• Query、Key、Value 不一定来自三个不同地方，通常由同一组输入经过不同的投影得到。\n• 权重并不是删除不相关内容，而是重新分配各份内容的贡献。\n• 一个词可以关注自己，也可以关注句子中的其他词。\n• 多头注意力让模型同时从不同的关系理解句子。\n\n这只是笔记中的概念解释。是否掌握，还需要你在新情境中自己使用它。`;
  function draftReference() {
    return `<div class="companion-reference"><div>${icon("file-text")}<details><summary>注意力机制 · 选中原文</summary><p>${escape(referenceText)}</p></details><button class="icon-button" type="button" data-action="unquote" aria-label="移除引用">${icon("x")}</button></div></div>`;
  }
  function closeButton(block, mode) {
    return mode === "light" ? `<button class="icon-button" data-action="dismiss-extra" data-block="${block.id}" aria-label="收起${escape(block.label)}">${icon("x")}</button>` : "";
  }
  function toolBody(block, mode) {
    const labels = { running:"进行中", done:"已完成", failed:"失败", cancelled:"已停止", waiting:"等你确认" };
    const steps = block.steps.map((step) => `<div class="companion-extra__tool-step" data-state="${step.state}">${icon(step.state === "done" ? "check" : step.state === "failed" ? "x" : "loader")}<span>${escape(step.label)} · ${labels[step.state]}</span></div>`).join("");
    const retry = block.state === "failed" ? `<button class="text-action" data-action="retry-tool" data-block="${block.id}">重试这个工具</button>` : "";
    if (mode === "light") return `<details class="companion-extra__tool-details"><summary>${icon("sparkles")}<span>工具过程</span><strong>${labels[block.state]}</strong></summary><div class="companion-extra__tool-body">${steps}<p>${escape(block.detail)}</p><p class="companion-extra__caption">本地演示过程 · 不执行真实工具</p>${retry}</div></details>`;
    return `${steps}<details><summary>查看工具过程与结果</summary><p>${escape(block.detail)}</p><p class="companion-extra__caption">本地演示过程 · 不执行真实工具</p></details>${retry}`;
  }
  function proposalBody(block) {
    const choices = block.state === "pending" ? `<div class="companion-extra__actions"><button class="text-action" data-action="decline" data-block="${block.id}">先不用</button><button class="button primary" data-action="confirm" data-block="${block.id}">${icon("check")}确认收下</button></div>`
      : `<div class="companion-extra__outcome" role="status">${icon(block.state === "accepted" ? "check" : block.state === "rejected" ? "x" : "loader")}${({ confirming:"正在确认…", accepted:"已确认 · 演示完成", rejected:"已拒绝 · 没有收下" })[block.state]}</div>`;
    return `<p>${escape(block.description)}</p><p class="companion-extra__caption">确认后才执行；此 Demo 只更新演示状态。</p>${choices}`;
  }
  function imageBody(block) {
    if (block.state === "loading") return `<p role="status">正在载入图片…</p>`;
    if (block.state === "error") return `<p role="status">这张图片暂时取不回来。</p><button class="text-action" data-action="retry-image" data-block="${block.id}">重新载入图片</button>`;
    return `<button class="companion-extra__image-button" data-action="open-image" data-block="${block.id}" aria-label="放大${escape(block.label)}"><img src="companion-interaction-image.svg" alt="Query 与三个 Key 比较相关程度，再按权重汇总 Value"></button><p class="companion-extra__caption">本地示例图片 · 点击放大</p>`;
  }
  function renderBlock(block, mode) {
    let body = "", glyph = "file-text", badge = "";
    if (block.type === "quote") body = `<blockquote>${escape(block.text)}</blockquote><button class="text-action" data-action="source">${icon("arrow-right")}回到引用原文</button>`;
    if (block.type === "tool") { body = toolBody(block,mode); glyph = "sparkles"; badge = `<span class="tag">${({ running:"执行中", done:"2 次工具", failed:"工具失败", cancelled:"已停止", waiting:"待确认" })[block.state]}</span>`; }
    if (block.type === "proposal") { body = proposalBody(block); glyph = "bookmark"; }
    if (block.type === "image") { body = imageBody(block); glyph = "image"; }
    if (block.type === "error") { body = `<p>${escape(block.text)}</p><button class="text-action" data-action="retry" data-message="${block.turn}">重新回复</button>`; glyph = "x"; }
    if (block.type === "diagram") { body = `<ol>${block.steps.map((step) => `<li>${escape(step)}</li>`).join("")}</ol>`; glyph = "arrow-right"; }
    if (block.type === "card") { body = `<p><strong>${escape(block.front)}</strong></p><details><summary>翻开看看</summary><p>${escape(block.back)}</p></details>`; glyph = "bookmark"; }
    if (block.type === "nav") { body = `<p>继续看当前笔记中的相关段落。</p><button class="text-action" data-action="source">${icon("arrow-right")}打开 Query / Key / Value</button>`; glyph = "book-open"; }
    const duration = window.COMPANION_DEMO_LIFECYCLE.lifetimeFor(block);
    const timing = mode === "light" && block.type !== "tool" ? `<p class="companion-extra__expiry">${Number.isFinite(duration) ? `${Math.round(duration/1000)} 秒后收起 · 手记保留` : "等你决定 · 不会自动收起"}</p>` : "";
    const header = block.type === "tool" && mode === "light" ? "" : `<header class="companion-extra__header">${icon(glyph)}<span>${escape(block.label)}</span>${badge}${closeButton(block,mode)}</header>`;
    return `<article class="companion-extra companion-extra--${block.type}" id="${mode}-${block.id}" data-block-id="${block.id}" data-kind="${block.type}" data-state="${block.state || "ready"}" aria-label="${escape(block.label)}">${header}${body}${timing}</article>`;
  }
  function plainBlock(block) { return [block.label,block.text,block.description,block.detail,block.front,block.back,...(block.steps || []).map((step) => typeof step === "string" ? step : step.label)].filter(Boolean).join(" "); }
  window.COMPANION_DEMO_CONTENT = { escape,icon,referenceText,explanation,longExplanation,draftReference,renderBlock,plainBlock };
})();
