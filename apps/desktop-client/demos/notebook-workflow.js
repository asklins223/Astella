(() => {
  "use strict";
  const STORAGE_KEY = "study.notebook-folio-demo.v4";
  const $ = (id) => document.getElementById(id);
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => '<i data-icon="' + name + '"></i>';
  const action = (name, label, extra = "") => '<button class="text-action" data-action="' + name + '" ' + extra + ">" + label + "</button>";
  const button = (name, label, primary = false, extra = "") => '<button class="button' + (primary ? " primary" : "") + '" data-action="' + name + '" ' + extra + ">" + label + "</button>";
  const noteHTML = `<p data-block="opening">不赶进度，专注打磨。IndexTTS 2.5 希望让<mark data-note-anchor="a1">同一个声音跨越语言</mark>，在换一种语言表达时，仍然保留原来的声音身份与自然语气。</p>
    <h2 id="languages" data-block="languages">一个声音，多种语言</h2>
    <p data-block="language-body">中、英、日、西、阿五种语言的零样本配音，是这次发布的重要方向。零样本不是“没有样本”，而是不需要为每一个新声音单独训练一套模型。</p>
    <blockquote data-block="voice-identity">换了语言，听起来仍然像同一个人在说话。</blockquote>
    <h2 id="speed" data-block="speed">快一点，也自然一点</h2>
    <p data-block="speed-body">与上一代相比，新版着重优化推理路径，让语音生成更快。但<mark data-note-anchor="a2">速度与自然度要放在一起看</mark>：语气、情绪与停顿，都会影响最终听感。</p>
    <h3 id="expression" data-block="expression">语气与节奏</h3>
    <p data-block="expression-body">同一句话，即使文字完全一样，不同的停顿和重音也可能传达不同的意思。跨语言时，不只要把词读出来，还要照顾表达方式。</p>
    <h3 id="tradeoff" data-block="tradeoff">怎样判断效果</h3>
    <p data-block="tradeoff-body">把速度和自然度一起做好，才更接近实际可用。比较时可以固定同一段内容与参考声音，分别记录生成等待时间、身份一致性和语气是否自然。</p>
    <h2 id="takeaway" data-block="takeaway">读完，留下什么</h2>
    <p data-block="takeaway-body">阅读发布说明时，要分开看公开能力、演示样例和自己真正试出的效果。能力列表回答“能做什么”，实际对照回答“在我的场景里做得怎样”。</p>
    <p data-block="closing">这篇笔记先保留两个问题：声音身份是怎样被保留下来的？速度变快之后，哪些听感仍值得单独检查？</p>`;
  const draftTemplates = [
    { id: "d1", title: "零样本，究竟省掉了什么？", color: "#b9d3ad", ink: "#304e39", relation: "从「多种语言」接着读", block: "language-body", reviewed: false, selected: false, saved: false, evidence: "原文延伸", html: "<h2>不是完全没有样本</h2><p>零样本通常意味着不用为这个新声音单独训练。仍然需要参考材料，帮助系统知道目标声音是什么样的。</p><h2>省掉的是额外训练</h2><p>可以把它理解为：换一个说话人时，不必重新制作一套专门的模型。参考声音的质量、时长和内容，依然可能影响结果。</p><blockquote>“无需单独训练”与“无需提供参考”不是一回事。</blockquote>" },
    { id: "d2", title: "快与自然，怎样一起比较？", color: "#a5ced4", ink: "#2c545a", relation: "从「速度与自然度」接着读", block: "speed-body", reviewed: false, selected: false, saved: false, evidence: "原文延伸", html: "<h2>先把比较条件固定</h2><p>同一份文本、同一个参考声音、相同的运行环境，比单看一个速度数字更容易判断变化。</p><h2>分别记录两个维度</h2><p>等待时间是一个维度；停顿、重音、情绪和声音身份是另一个维度。它们不能用一个“更好”替代。</p><h2>留下可以再看的证据</h2><p>保存样例与当时的条件，下一次升级后可以沿用同样的对照。一次满意的试听，还不等于所有场景都稳定。</p>" },
    { id: "d3", title: "换了语言，还是同一个人吗？", color: "#edb093", ink: "#653c2b", relation: "从「声音身份」继续追问", block: "voice-identity", reviewed: false, selected: false, saved: false, evidence: "待核对资料", html: "<h2>声音身份与表达方式</h2><p>音色让人辨认是谁；语气和节奏帮助表达一句话的意思。跨语言时，两者都可能发生变化。</p><h2>一个值得继续查的问题</h2><p>不同语言的音系、重音和节奏不一样。系统怎样把同一声音带过去，而不是把原语言的节奏也机械搬过去？</p><blockquote>这是一条继续查资料的方向，不是原文已经给出的技术结论。</blockquote>" }
  ];
  function seed() {
    return {
      schema: 4, motion: "full", scenario: "normal", tocPinned: true,
      note: { title: "IndexTTS 2.5 让声音跨越语言", html: noteHTML, version: 3 },
      versions: { 2: { title: "IndexTTS：同一个声音", html: '<h2 id="old-voice" data-block="old-voice">声音身份</h2><p data-block="old-body">同一个声音在换语言后，仍然需要保留可以辨认的声音身份。</p>' }, 3: { title: "IndexTTS 2.5 让声音跨越语言", html: noteHTML } },
      noteDraft: null, overview: { version: 3, status: "ready", lead: "一个声音跨越语言；生成更快，也要把自然表达留下来。", points: [
        { text: "支持多种语言的零样本配音。声音身份与所说语言，可以分开理解。", block: "language-body", label: "多种语言" },
        { text: "推理速度不是唯一目标。停顿、情绪和重音同样影响自然度。", block: "speed-body", label: "速度与自然度" },
        { text: "发布能力、演示样例与自己的实际对照，是不同的证据。", block: "takeaway-body", label: "怎样判断效果" }
      ] }, overviews: {},
      drafts: structuredClone(draftTemplates), draftVersion: 3,
      saved: [
        { id: "s1", title: "从参考声音到零样本配音", color: "#93b68b", version: 1, originVersion: 3, html: "<h2>参考与训练</h2><p>参考声音提供目标身份。是否还需要专门训练，是另一个问题。</p><p>这篇从 IndexTTS 2.5 的多语言笔记延伸而来。</p>" },
        { id: "s2", title: "语音里的停顿也在表达", color: "#9bbfc8", version: 1, originVersion: 3, html: "<h2>停顿不只是空白</h2><p>停顿改变句子的分组、强调与语气。对照语音效果时，节奏值得单独听一遍。</p>" }
      ],
      annotations: [
        { id: "a1", version: 3, block: "opening", quote: "同一个声音跨越语言", text: "可以把“声音身份”与“说什么语言”分开看。换语言以后，你仍能辨认是同一个人；不是把音色换成另一位说话人。", personal: false, revision: 1 },
        { id: "a2", version: 3, block: "speed-body", quote: "速度与自然度要放在一起看", text: "我的理解：不能只盯着快了多少，还要听停顿和情绪有没有变得机械。之后可以用同一段文本做对照。", personal: true, revision: 1 }
      ],
      recalls: [], jobs: {}, positions: {}, annotationDrafts: {}, headingSerial: 0, taskSerial: 0,
      history: [
        { id: "h1", type: "overview", version: 3, time: "今天 12:07", text: "五种语言的零样本配音，以及速度与自然度的改善。" },
        { id: "h2", type: "annotation", version: 3, time: "今天 11:42", text: "速度与自然度要放在一起看", annotationId: "a2" },
        { id: "h3", type: "annotation", version: 2, time: "昨天 18:26", text: "当时的笔记：同一个声音在换语言后仍需要保留身份。", quote: "同一个声音在换语言后，仍然需要保留可以辨认的声音身份。" }
      ]
    };
  }
  function readState() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data?.schema === 4 && data.note && data.versions && Array.isArray(data.overview?.points) && Array.isArray(data.annotations) && Array.isArray(data.drafts) && Array.isArray(data.history) && data.jobs) return data;
    } catch {}
    return seed();
  }
  let state = readState();
  let view = "reader";
  let detail = null;
  let tocOpen = innerWidth > 1100 && state.tocPinned;
  let tocSuspended = false;
  let readingVersion = null;
  let overviewVersion = null;
  let draftId = null;
  let relatedId = null;
  let recallId = null;
  let draftEditing = false;
  let selectedRange = null;
  let sideOpener = null;
  let sideEpoch = 0;
  let receiptTimer;
  let hoverTimer;
  let keyboardInput = false;
  let renderedKey = "";
  let scrollTimer;
  let historyFilter = "all";
  const jobTimers = new Map();
  const animationHandles = new Map();

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { $("edit-status").textContent = "本机暂存不可用 · 当前窗口仍保留草稿"; }
  }
  function paintIcons(root = document) {
    for (const placeholder of root.querySelectorAll("[data-icon]")) {
      const nodes = window.NOTEBOOK_ICONS?.[placeholder.dataset.icon];
      if (!nodes) continue;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [key,value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) svg.setAttribute(key, value);
      for (const [tag,attrs] of nodes) {
        const node = document.createElementNS(svg.namespaceURI, tag);
        for (const [key,value] of Object.entries(attrs)) node.setAttribute(key, value);
        svg.append(node);
      }
      placeholder.replaceWith(svg);
    }
  }
  function motionAllowed() {
    return state.motion !== "off" && !keyboardInput && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }
  function animate(element, frames, duration = 220, key = element.id) {
    animationHandles.get(key)?.cancel();
    if (!motionAllowed() || typeof element.animate !== "function") return null;
    const handle = element.animate(frames, { duration: state.motion === "lite" ? 120 : duration, easing: "cubic-bezier(.23,1,.32,1)" });
    animationHandles.set(key, handle);
    handle.finished.catch(() => {}).finally(() => { if (animationHandles.get(key) === handle) animationHandles.delete(key); });
    return handle;
  }
  function receipt(text) {
    clearTimeout(receiptTimer);
    $("receipt").innerHTML = icon("check") + "<span>" + escape(text) + "</span>";
    $("receipt").hidden = false;
    paintIcons($("receipt"));
    animate($("receipt"), [{ opacity: 0, transform: "translate(-50%,8px)" }, { opacity: 1, transform: "translate(-50%,0)" }], 180);
    receiptTimer = setTimeout(() => { $("receipt").hidden = true; }, 3300);
  }
  function safeHTML(html, removeAnchors = false) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const allowed = new Set(["P","H2","H3","UL","OL","LI","STRONG","B","EM","I","BLOCKQUOTE","BR","MARK","SPAN"]);
    for (const node of [...doc.body.querySelectorAll("*")]) {
      if (["SCRIPT","STYLE","IFRAME","OBJECT","IMG","SVG","FORM"].includes(node.tagName)) { node.remove(); continue; }
      if (!allowed.has(node.tagName) || (removeAnchors && node.tagName === "MARK")) { node.replaceWith(...node.childNodes); continue; }
      for (const attr of [...node.attributes]) {
        if (!["id","data-block","data-note-anchor"].includes(attr.name) || (removeAnchors && attr.name === "data-note-anchor")) node.removeAttribute(attr.name);
      }
    }
    return doc.body.innerHTML;
  }
  function currentNote() {
    const version = readingVersion ?? state.note.version;
    return { ...(state.versions[version] ?? state.note), version };
  }
  function activeDraft() { return state.drafts.find((draft) => draft.id === draftId); }
  function rememberFocus(root) {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    const keys = ["action","source","value","selectDraft","annotation","format"];
    return { id: active.id, tag: active.tagName, data: Object.fromEntries(keys.filter((key) => active.dataset?.[key] !== undefined).map((key) => [key,active.dataset[key]])), start: active.selectionStart, end: active.selectionEnd };
  }
  function restoreFocus(root, snapshot) {
    if (!snapshot) return;
    const candidates = [...root.querySelectorAll("button,input,textarea,select,[contenteditable]")];
    let target = snapshot.id ? candidates.find((node) => node.id === snapshot.id) : candidates.find((node) => node.tagName === snapshot.tag && Object.keys(snapshot.data).length > 0 && Object.entries(snapshot.data).every(([key,value]) => node.dataset[key] === value));
    if (target?.disabled || !target) {
      const fallback = ({ hint: "reveal", reveal: "self-report", "new-recall": "reveal" })[snapshot.data.action];
      target = fallback ? candidates.find((node) => node.dataset.action === fallback && !node.disabled) : null;
    }
    target?.focus({ preventScroll: true });
    if (target?.setSelectionRange && typeof snapshot.start === "number") {
      try { target.setSelectionRange(snapshot.start, snapshot.end); } catch {}
    }
  }
  function normalizeEditorHeadings(root) {
    const used = new Set();
    for (const heading of root.querySelectorAll("h2,h3")) {
      let id = heading.dataset.block || heading.id;
      if (!id || used.has(id)) {
        do { state.headingSerial = (state.headingSerial ?? 0) + 1; id = "editing-heading-" + state.headingSerial; } while (used.has(id));
      }
      heading.dataset.block = id;
      heading.id = id;
      used.add(id);
    }
  }
  function viewKey() { return view + "-" + (view === "draft" ? draftId : (view === "related" ? relatedId : (view === "recall" ? recallId : (view === "overview" ? overviewVersion ?? state.overview.version : currentNote().version)))); }
  function addHistory(type, text, extra = {}) {
    state.history.unshift({ id: "h-" + Date.now() + "-" + state.history.length, type, version: state.note.version, time: "刚刚", text, ...extra });
    persist();
  }
  function syncChrome() {
    $("room").dataset.motion = state.motion;
    document.documentElement.dataset.motion = state.motion;
    $("folio").dataset.view = view;
    $("folio").dataset.toc = String(tocOpen && !tocSuspended);
    const compact = innerWidth <= 1100;
    $("index-leaf").inert = !tocOpen || tocSuspended || (compact && !!detail);
    $("leaf").inert = compact && (tocOpen || !!detail);
    document.querySelector('[data-action="toc"]').setAttribute("aria-expanded", String(tocOpen && !tocSuspended));
    $("pin-button").disabled = compact;
    $("pin-button").setAttribute("aria-pressed", String(state.tocPinned));
    $("pin-button").setAttribute("aria-label", state.tocPinned ? "取消固定目录" : "固定目录");
    $("pin-button").dataset.tip = compact ? "紧凑窗口按需打开" : (state.tocPinned ? "取消固定" : "固定目录");
    $("pin-button").innerHTML = icon(state.tocPinned ? "pin" : "pin-off");
    $("back-button").hidden = view === "reader" && !readingVersion;
    $("leaf-context").textContent = ({ reader: readingVersion ? "旧版正文" : "正在阅读", overview: "这篇的速看", recall: "回想这篇", expansion: "往外学", draft: "拓展草稿", related: "衍生笔记", editor: "正在编辑" })[view];
    $("editor-tools").hidden = view !== "editor" && !(view === "draft" && draftEditing);
    $("edit-button").hidden = !["reader","draft"].includes(view) || (view === "draft" && !!activeDraft()?.saved);
    $("edit-button").disabled = !!readingVersion || (view === "draft" && (pending("commit") || pending("expansion")));
    $("edit-button").innerHTML = icon(draftEditing ? "check" : "square-pen") + "<span>" + (draftEditing ? "完成编辑" : (view === "reader" && state.noteDraft ? "继续编辑" : "编辑")) + "</span>";
    $("edit-button").classList.toggle("primary", view === "reader" && !readingVersion && !detail?.writing);
    for (const tab of document.querySelectorAll(".ribbon")) {
      tab.setAttribute("aria-pressed", String(tab.dataset.action === view || (tab.dataset.action === "expansion" && view === "draft")));
    }
    document.querySelector('[data-action="history"]').setAttribute("aria-expanded", String(detail?.type === "history"));
    document.querySelector(".index-page").textContent = "笔记 v" + (view === "related" ? state.saved.find((note) => note.id === relatedId)?.version : currentNote().version);
    paintIcons();
  }
  function renderTOC() {
    const root = document.createElement("div");
    root.innerHTML = view === "editor" ? state.noteDraft?.html ?? state.note.html : (view === "draft" ? activeDraft()?.html ?? "" : (view === "related" ? state.saved.find((note) => note.id === relatedId)?.html ?? "" : currentNote().html));
    const headings = [...root.querySelectorAll("h2,h3")];
    $("toc").innerHTML = '<button data-action="jump" data-block="top" aria-current="location"><span class="toc-number">00</span><span>开篇</span></button>' +
      headings.map((node,index) => '<button data-action="jump" data-block="' + escape(node.dataset.block || node.id || "heading-" + index) + '" data-level="' + node.tagName.slice(1) + '"><span class="toc-number">' + String(index + 1).padStart(2,"0") + "</span><span>" + escape(node.textContent) + "</span></button>").join("");
  }
  function titleBlock(title, version) {
    return '<h1 class="page-title" tabindex="-1">' + escape(title) + '</h1><div class="note-meta"><span class="version-tag">' + icon("bookmark") + "v" + version + "</span>" +
      action("sources", icon("file-text") + (state.scenario === "no-source" ? "没有来源" : "来源资料 · 2")) +
      action("relations", icon("sprout") + "衍生笔记 · " + state.saved.length) + "</div>";
  }
  function renderReader() {
    const note = currentNote();
    $("page-content").innerHTML = titleBlock(note.title, note.version) +
      (readingVersion ? '<div class="old-version">当时的笔记 v' + readingVersion + " · 当前版本 v" + state.note.version + "</div>" : "") +
      '<article class="prose" id="prose">' + safeHTML(note.html) + '</article><div class="reading-end">这一页，到这里</div>';
    for (const mark of $("prose").querySelectorAll("[data-note-anchor]")) {
      const annotation = state.annotations.find((item) => item.id === mark.dataset.noteAnchor && item.version === note.version);
      if (!annotation) { mark.replaceWith(...mark.childNodes); continue; }
      const trigger = document.createElement("button");
      trigger.className = "annotation-anchor";
      trigger.dataset.annotation = annotation.id;
      trigger.setAttribute("aria-label", "查看批注：" + annotation.quote);
      trigger.setAttribute("aria-expanded", String(detail?.annotationId === annotation.id));
      trigger.innerHTML = escape(mark.textContent) + "<sup>" + (state.annotations.indexOf(annotation) + 1) + "</sup>";
      mark.replaceWith(trigger);
    }
    if (readingVersion) setTray("历史版本 · 只读", button("reader", "回到当前版本", true));
    else setTray();
  }
  function progressHTML(title, key, subtitle) {
    return '<section class="progress-state" role="status"><h2>' + escape(title) + '</h2><p>' + escape(subtitle) + '</p><div class="progress-line"></div>' + action("cancel-job", "取消", 'data-job="' + key + '"') + "</section>";
  }
  function failureHTML(title, key) {
    return '<section class="error-state"><h3>' + escape(title) + "</h3><p>示例失败状态。原文与已有结果仍在。</p>" + button("retry-job", "重试", false, 'data-job="' + key + '"') + "</section>";
  }
  function pending(key) { return ["queued","running"].includes(state.jobs[key]?.status); }
  function renderOverview() {
    const job = state.jobs.overview;
    const overview = state.overviews?.[overviewVersion] ?? state.overview;
    const version = overview.version;
    $("page-content").innerHTML = '<h1 class="page-title" tabindex="-1">先抓住这篇的三件事</h1><div class="note-meta"><span class="version-tag">笔记 v' + version + '</span></div>' +
      (pending("overview") ? progressHTML("正在整理这篇", "overview", "示例任务 · 可以返回正文继续读") : "") +
      (job?.status === "failed" ? failureHTML("这次没整理好", "overview") : "") +
      (version !== state.note.version ? '<p class="old-version">这张速看来自 v' + version + "。正文已改为 v" + state.note.version + "。</p>" : "") +
      '<p class="overview-lead">' + escape(overview.lead) + '</p><ol class="overview-points">' +
      overview.points.map(({text,block,label},i) => '<li><span class="point-number">' + (i+1) + '</span><div><p>' + escape(text) + "</p>" + action("overview-origin", icon("arrow-right") + "原句 · " + escape(label), 'data-block="' + escape(block) + '" data-version="' + version + '"') + "</div></li>").join("") + "</ol>";
    setTray("本机示例 · " + overview.points.length + " 处要点", action("generate-overview", pending("overview") ? "正在整理…" : "整理这一版", pending("overview") ? "disabled" : "") + button("reader", "回到正文", true));
  }
  function getRecall(forceNew = false) {
    let record = forceNew ? null : state.recalls.find((item) => item.id === recallId);
    if (record) return record;
    record = forceNew ? null : state.recalls.findLast((item) => item.version === currentNote().version);
    if (!record) {
      const note = currentNote();
      const container = document.createElement("div"); container.innerHTML = safeHTML(note.html);
      const blocks = [...container.querySelectorAll("p[data-block]")];
      const used = state.recalls.filter((item) => item.version === note.version).map((item) => item.block);
      const block = used.length === 0 ? blocks.find((node) => node.dataset.block === "speed-body") ?? blocks[0] : blocks.find((node) => !used.includes(node.dataset.block)) ?? blocks[state.recalls.length % Math.max(1,blocks.length)];
      let heading = block?.previousElementSibling;
      while (heading && !["H2","H3"].includes(heading.tagName)) heading = heading.previousElementSibling;
      const speedQuestion = block?.dataset.block === "speed-body";
      record = { id: "r-" + Date.now() + "-" + state.recalls.length, version: note.version, block: block?.dataset.block ?? "top", question: speedQuestion ? "这一版为什么同时关心速度与自然度？" : (heading?.textContent ?? note.title) + "：这一段最想说明什么？", quote: block?.textContent ?? note.title, hint: speedQuestion ? "分别想想：等待时关心什么，听到声音后又关心什么。" : "先想这一节的主题，再回忆它强调的区别。", hinted: false, revealed: false, selfReport: null };
      state.recalls.push(record);
      addHistory("recall", record.question, { version: record.version, recallId: record.id });
    }
    recallId = record.id; persist(); return record;
  }
  function renderRecall() {
    const record = getRecall();
    $("folio").dataset.revealed = String(record.revealed);
    $("page-content").innerHTML = '<h1 class="page-title" tabindex="-1">先在心里想想</h1><div class="note-meta"><span class="version-tag">笔记 v' + record.version + '</span></div>' +
      (record.version !== state.note.version ? '<p class="old-version">回看当时的 v' + record.version + "，不会替换当前笔记。</p>" : "") +
      '<div class="recall-question">' + escape(record.question) + '</div><div class="recall-tools">' +
      action("hint", record.hinted ? "线索已展开" : "给一点线索", record.hinted ? "disabled" : "") +
      button("reveal", record.revealed ? "对照已展开" : icon("book-open") + "翻开对照", !record.revealed, record.revealed ? "disabled" : "") + "</div>" +
      (record.hinted ? '<p class="hint">' + escape(record.hint) + "</p>" : "") +
      (record.revealed ? '<section class="answer-fold" id="answer-fold"><p class="page-kicker">当时的原文</p><p class="prose">' + escape(record.quote) + "</p>" + action("recall-origin", "回到这一段", 'data-block="' + escape(record.block) + '" data-version="' + record.version + '"') +
        '<div class="self-report">' + ["想起来了","想起一部分","还需重看"].map((value) => button("self-report", value, false, 'data-value="' + value + '" aria-pressed="' + String(record.selfReport === value) + '"')).join("") + "</div></section>" : "");
    setTray(record.selfReport ? "你的自述：" + record.selfReport : "自己想 · 不计分", (record.revealed ? action("new-recall", "再想一处") : "") + button("reader", "回到正文"));
  }
  function renderExpansion() {
    const key = "expansion";
    const selected = state.drafts.filter((draft) => draft.selected && !draft.saved);
    $("page-content").innerHTML = '<h1 class="page-title" tabindex="-1">有些问题，值得接着读</h1>' +
      (pending(key) ? progressHTML("正在找相关方向", key, "示例任务 · 草稿不会自动进入笔记架") : "") +
      (state.jobs[key]?.status === "failed" ? failureHTML("这次没写好草稿", key) : "") +
      (state.draftVersion !== state.note.version ? '<p class="old-version">这些草稿从笔记 v' + state.draftVersion + "长出；当前正文 v" + state.note.version + "。</p>" : "") +
      '<div class="draft-grid">' + state.drafts.map((draft,index) => '<article class="draft-book" data-draft="' + draft.id + '" data-selected="' + draft.selected + '" data-saved="' + draft.saved + '">' +
        '<span class="draft-state">' + (draft.saved ? "已收下 · 演示" : (draft.reviewed ? "已读草稿" : "未读草稿")) + " · " + draft.evidence + '</span><h2>' + escape(draft.title) + '</h2><p>' + escape(draft.relation) + "</p>" +
        action("open-draft", icon("book-open") + "翻开", 'data-id="' + draft.id + '"') +
        '<label class="draft-choice">' + (draft.saved ? '<span class="success-stamp">' + icon("check") + "已收下 · 演示</span>" : '<input type="checkbox" data-select-draft="' + draft.id + '" ' + (draft.selected ? "checked " : "") + (pending("commit") || pending("expansion") ? "disabled" : "") + '>待收下') + "</label></article>").join("") +
      '</div><div class="saved-count">' + icon("sprout") + action("relations", "从这里已长出 " + state.saved.length + " 篇笔记") + "</div>";
    for (const card of $("page-content").querySelectorAll(".draft-book")) {
      const draft = state.drafts.find((item) => item.id === card.dataset.draft);
      card.style.setProperty("--book-color", draft.color);
      card.style.setProperty("--book-ink", draft.ink);
    }
    const saving = pending("commit");
    setTray(saving ? icon("loader-circle") + "正在收下 · 本机演示" : (state.jobs.commit?.status === "failed" ? "<strong>这次没收下</strong>草稿与选择仍在" : "<strong>待收下 " + selected.length + " 篇</strong>未选中的仍是草稿"), action("generate-expansion", pending(key) ? "正在生成…" : "换些方向", pending(key) || saving ? "disabled" : "") +
      button("commit", saving ? "正在收下…" : "收下 " + selected.length + " 篇", true, selected.length === 0 || saving || pending(key) ? "disabled" : "") +
      (state.jobs.commit?.status === "failed" ? action("retry-job", "提交重试", 'data-job="commit"') : ""));
  }
  function renderDraft() {
    const draft = activeDraft();
    if (!draft) { view = "expansion"; renderExpansion(); return; }
    const index = state.drafts.indexOf(draft);
    $("page-content").innerHTML = '<div class="draft-nav">' + action("expansion", icon("arrow-left") + "所有草稿") + '<div class="inline-tools"><button class="icon-button" data-action="previous-draft" aria-label="上一篇草稿" ' + (index === 0 ? "disabled" : "") + '>' + icon("arrow-left") + '</button><span>' + (index+1) + " / " + state.drafts.length + '</span><button class="icon-button" data-action="next-draft" aria-label="下一篇草稿" ' + (index === state.drafts.length-1 ? "disabled" : "") + ">" + icon("arrow-right") + "</button></div></div>" +
      (draftEditing ? '<input class="editor-title" id="draft-title" aria-label="草稿标题" value="' + escape(draft.title) + '">' : '<h1 class="page-title" tabindex="-1">' + escape(draft.title) + "</h1>") +
      '<div class="draft-origin">' + escape(draft.relation) + " · " + escape(draft.evidence) + " · 笔记 v" + state.draftVersion + " " + action("draft-origin", "看原句", 'data-block="' + draft.block + '"') + "</div>" +
      '<article class="prose' + (draftEditing ? " editor-body" : "") + '" id="draft-body" ' + (draftEditing ? 'contenteditable="true" role="textbox" aria-label="草稿正文" aria-multiline="true"' : "") + ">" + safeHTML(draft.html) + "</article>";
    setTray(draft.saved ? "已收下 · 演示笔记" : "草稿 · 笔记 v" + state.draftVersion, (draft.saved ? "" : '<label class="single-draft-choice"><input type="checkbox" data-select-draft="' + draft.id + '" ' + (draft.selected ? "checked " : "") + (pending("commit") || pending("expansion") ? "disabled" : "") + ">选入待收下</label>") + button("expansion", "返回草稿"));
  }
  function renderRelated() {
    const note = state.saved.find((item) => item.id === relatedId);
    if (!note) { setView("reader"); return; }
    $("page-content").innerHTML = '<h1 class="page-title" tabindex="-1">' + escape(note.title) + '</h1><div class="draft-origin">本机示例 · 笔记 v' + note.version + " · 来源：IndexTTS 2.5，v" + note.originVersion + " " + action("reader", "返回原笔记") + '</div><article class="prose">' + safeHTML(note.html) + "</article>";
    setTray("关系已保留在本机演示", button("relations", "其他衍生笔记") + button("reader", "回原笔记", true));
  }
  function renderEditor() {
    if (!state.noteDraft) state.noteDraft = { title: state.note.title, html: safeHTML(state.note.html, true) };
    $("page-content").innerHTML = '<input class="editor-title" id="note-title" aria-label="笔记标题" value="' + escape(state.noteDraft.title) + '"><div class="note-meta"><span class="version-tag">笔记 v' + state.note.version + '</span><span>编辑草稿</span></div>' +
      '<article class="prose editor-body" id="note-body" contenteditable="true" role="textbox" aria-label="笔记正文" aria-multiline="true">' + safeHTML(state.noteDraft.html, true) + "</article>";
    setTray("仅保留本机草稿 · 尚未生成新版本", action("discard-edit", "放弃修改") + button("reader", "稍后再改") + button("save-note", icon("save") + "留成新版本", true));
    persist();
  }
  function setTray(status = "", actions = "") {
    $("action-tray").hidden = !status && !actions;
    $("action-tray").innerHTML = '<div class="tray-status">' + status + '</div><div class="tray-actions">' + actions + "</div>";
  }
  function renderLeaf(keepScroll = false) {
    const focus = rememberFocus($("leaf"));
    const scroll = $("leaf-scroll").scrollTop;
    ({ reader: renderReader, overview: renderOverview, recall: renderRecall, expansion: renderExpansion, draft: renderDraft, related: renderRelated, editor: renderEditor })[view]();
    for (const [index, heading] of [...$("page-content").querySelectorAll("h2,h3")].entries()) {
      if (!heading.dataset.block && !heading.id) heading.dataset.block = "heading-" + index;
    }
    syncChrome();
    renderTOC();
    renderedKey = viewKey();
    state.positions ??= {};
    if (keepScroll) $("leaf-scroll").scrollTop = scroll;
    else $("leaf-scroll").scrollTop = state.positions[renderedKey] ?? 0;
    paintIcons();
    updateReadPosition();
    restoreFocus($("leaf"), focus);
  }
  function setView(next, options = {}) {
    state.positions ??= {};
    if (renderedKey) state.positions[renderedKey] = $("leaf-scroll").scrollTop;
    persist();
    hideHover(); hideSelection();
    if (next === "reader" && !options.keepVersion) readingVersion = null;
    if (next !== "draft") draftEditing = false;
    view = next;
    if (innerWidth <= 1100) tocOpen = false;
    closeSide(false);
    renderLeaf();
    animate($("page-content"), [{ opacity: .4, transform: "translateX(10px) rotateY(-4deg)" }, { opacity: 1, transform: "translateX(0) rotateY(0)" }], 220);
    $("page-content").querySelector("h1")?.focus({ preventScroll: true });
  }
  function sourceContent() {
    if (state.scenario === "source-failed") return '<section class="error-state"><h3>来源暂时没读到</h3><p>不是空资料。正文仍然可以读。</p>' + button("retry-sources", "重新读取") + "</section>";
    if (state.scenario === "no-source") return "<p>这篇笔记暂时没有关联来源。</p>";
    const source = detail.source ?? "original";
    return '<div class="source-tabs" role="tablist" aria-label="来源类型"><button id="source-tab-original" data-action="source-tab" data-source="original" role="tab" aria-controls="source-panel" tabindex="' + (source === "original" ? "0" : "-1") + '" aria-selected="' + (source === "original") + '">原始材料</button><button id="source-tab-supplement" data-action="source-tab" data-source="supplement" role="tab" aria-controls="source-panel" tabindex="' + (source === "supplement" ? "0" : "-1") + '" aria-selected="' + (source === "supplement") + '">补充资料</button></div><section id="source-panel" role="tabpanel" aria-labelledby="source-tab-' + source + '">' +
      (source === "original" ? '<div class="source-item">' + icon("file-text") + '<div><h3>IndexTTS 2.5 发布说明</h3><p>关联材料 · 72 个片段 · 示例</p>' + action("source-excerpt", detail.materialOpen ? "收起片段" : "翻开材料片段", 'aria-expanded="' + Boolean(detail.materialOpen) + '"') + '</div></div><div class="source-excerpt" ' + (detail.materialOpen ? "" : "hidden") + '><p class="page-kicker">材料片段 · 01</p><blockquote>支持多种语言的零样本配音，同时继续改善速度与情绪表达。</blockquote><a class="source-address" href="https://github.com/index-tts/index-tts" target="_blank" rel="noopener noreferrer">IndexTTS 官方项目' + icon("external-link") + "</a></div>" :
      '<div class="source-item">' + icon("file-text") + '<div><h3>IndexTTS 2 技术报告</h3><p>论文 · arXiv · 补充参考</p><a class="source-address" href="https://arxiv.org/abs/2506.21619" target="_blank" rel="noopener noreferrer">打开技术报告</a></div></div><p class="side-byline">补充参考 · 非原笔记引用材料</p>') + "</section>";
  }
  function relationContent() {
    return '<p class="page-kicker">已收下 · 双向关系 · 本机示例</p>' + state.saved.map((note) => '<button class="relation-link" data-action="open-related" data-id="' + escape(note.id) + '"><span class="relation-spine" data-color="' + note.color + '"></span><span><strong>' + escape(note.title) + "</strong><small>笔记 v" + note.version + " · 从原笔记 v" + note.originVersion + "长出</small></span></button>").join("") +
      '<div class="side-byline">' + state.drafts.filter((draft) => !draft.saved).length + " 篇草稿仍未收下</div>" + action("expansion", icon("sprout") + "看看待收下的草稿");
  }
  const typeNames = { overview: "速看", recall: "回想", annotation: "批注", expansion: "衍生笔记", version: "笔记版本" };
  function historyContent() {
    const entries = state.history.filter((entry) => historyFilter === "all" || entry.type === historyFilter);
    return '<select class="history-filter" id="history-filter" aria-label="筛选学习记录"><option value="all">全部记录</option>' + Object.entries(typeNames).map(([value,label]) => '<option value="' + value + '" ' + (historyFilter === value ? "selected" : "") + ">" + label + "</option>").join("") + '</select><ol class="timeline">' +
      entries.map((entry) => '<li><time>' + escape(entry.time) + '</time><strong>' + typeNames[entry.type] + " · 笔记 v" + entry.version + '</strong><p>' + escape(entry.text) + "</p>" + action("open-history", "翻开当时的记录", 'data-id="' + entry.id + '"') + "</li>").join("") + "</ol>" + (entries.length ? "" : "<p>这个分类还没有记录。</p>");
  }
  function annotationContent() {
    const item = state.annotations.find((annotation) => annotation.id === detail.annotationId);
    if (!item) return '<blockquote>' + escape(detail.quote ?? "") + "</blockquote><p>来自当时的笔记原文，未挂靠到新版。</p>";
    const key = "annotation-" + item.id;
    return '<blockquote>' + escape(item.quote) + "</blockquote>" +
      (pending(key) ? progressHTML("正在讲这句", key, "示例任务 · 原句保持可读") : "") +
      (state.jobs[key]?.status === "failed" ? failureHTML("这次没讲清楚", key) : "") +
      (item.text ? "<p>" + escape(item.text) + "</p>" : "") +
      (detail.writing ? '<label for="annotation-writing">写下自己的想法</label><textarea id="annotation-writing" placeholder="我对这句的理解…">' + escape(state.annotationDrafts?.[item.id] ?? item.comment ?? (item.personal ? item.text : "")) + "</textarea>" + button("save-annotation", "留在这句旁", true) : '<div class="side-actions">' + action("write-annotation", item.comment ? "编辑想法" : "写下想法") + (item.personal ? "" : action("rephrase", "换种说法", pending(key) ? "disabled" : "")) + "</div>") +
      (item.comment && !detail.writing ? '<h3>我的想法</h3><p>' + escape(item.comment) + "</p>" : "") +
      '<div class="side-byline">' + (item.personal ? "我的批注" : "演示解释") + " · 笔记 v" + item.version + " · 解释 " + item.revision + "</div>" +
      action("annotation-origin", icon("arrow-left") + "回到原句", 'data-block="' + escape(item.block) + '" data-version="' + item.version + '"');
  }
  function renderSide() {
    if (!detail) return;
    const focus = rememberFocus($("side-leaf"));
    $("side-leaf").dataset.type = detail.type;
    $("side-title").textContent = ({ annotation: "这一处批注", sources: "来源资料", relations: "衍生笔记", history: "学习记录" })[detail.type];
    $("side-body").innerHTML = ({ annotation: annotationContent, sources: sourceContent, relations: relationContent, history: historyContent })[detail.type]();
    for (const spine of $("side-body").querySelectorAll("[data-color]")) spine.style.setProperty("--relation-color", spine.dataset.color);
    $("side-leaf").hidden = false;
    $("side-leaf").inert = false;
    $("folio").dataset.side = "true";
    for (const trigger of document.querySelectorAll(".annotation-anchor")) trigger.setAttribute("aria-expanded", String(trigger.dataset.annotation === detail.annotationId));
    syncChrome();
    paintIcons($("side-leaf"));
    const annotationPrimary = detail.type === "annotation" && detail.writing;
    if (annotationPrimary) $("edit-button").classList.remove("primary");
    restoreFocus($("side-leaf"), focus);
  }
  function openSide(next, opener = document.activeElement) {
    if (detail?.type === next.type && detail.annotationId === next.annotationId && !next.writing && !next.source && !next.quote) { closeSide(); return; }
    sideEpoch++;
    animationHandles.get("side-leaf")?.cancel();
    detail = next;
    sideOpener = opener;
    if (innerWidth < 1500 && tocOpen) { tocSuspended = true; }
    hideHover(); hideSelection();
    renderSide();
    animate($("side-leaf"), [{ opacity: .3, transform: "translateX(16px) rotateY(-3deg)" }, { opacity: 1, transform: "translateX(0) rotateY(0)" }], 220);
    $("side-leaf").focus({ preventScroll: true });
  }
  function closeSide(withMotion = true) {
    if (!detail && $("side-leaf").hidden) return;
    const epoch = ++sideEpoch;
    detail = null;
    tocSuspended = false;
    const finish = () => {
      if (epoch !== sideEpoch) return;
      $("side-leaf").hidden = true;
      $("side-leaf").inert = true;
      $("folio").dataset.side = "false";
      syncChrome();
    };
    $("side-leaf").inert = true;
    const handle = withMotion && innerWidth > 1100 ? animate($("side-leaf"), [{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(16px)" }], 160) : null;
    if (handle) handle.finished.then(finish, finish); else finish();
    for (const trigger of document.querySelectorAll(".annotation-anchor")) trigger.setAttribute("aria-expanded", "false");
    if (withMotion) (sideOpener?.isConnected ? sideOpener : document.querySelector('[data-action="toc"]')).focus({ preventScroll: true });
  }
  function jump(block, version = null) {
    if (!["reader","editor","draft","related"].includes(view) || (version && version !== currentNote().version && view !== "related")) {
      readingVersion = version && version !== state.note.version ? version : null;
      setView("reader", { keepVersion: true });
    }
    if (innerWidth <= 1100 || !state.tocPinned) tocOpen = false;
    closeSide(false);
    syncChrome();
    const root = $("page-content");
    const target = block === "top" ? root.querySelector("h1,input") : [...root.querySelectorAll("[data-block],h2,h3")].find((node) => node.dataset.block === block || node.id === block);
    if (!target) { receipt("这处内容在当前版本里找不到，请回看当时的笔记。"); return; }
    target.scrollIntoView?.({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" });
    target.classList.add("located");
    setTimeout(() => target.classList.remove("located"), 1500);
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    updateReadPosition(block);
  }
  function updateReadPosition(block) {
    if (block) {
      for (const item of $("toc").querySelectorAll("button")) item.setAttribute("aria-current", item.dataset.block === block ? "location" : "false");
      const heading = [...$("toc").querySelectorAll("button")].find((item) => item.dataset.block === block);
      $("reading-position").textContent = "正在读 · " + (heading?.querySelector("span:last-child")?.textContent ?? "原句");
      return;
    }
    const headings = [...$("page-content").querySelectorAll("h2,h3")];
    const top = $("leaf-scroll").getBoundingClientRect().top;
    const current = headings.filter((node) => node.getBoundingClientRect().top < top + 100).at(-1);
    updateReadPosition(current?.dataset.block ?? current?.id ?? "top");
  }
  function runJob(key, type, payload = {}) {
    if (pending(key)) return;
    clearTimeout(jobTimers.get(key));
    const old = state.jobs[key];
    if (type === "overview" && !payload.overview) {
      const root = document.createElement("div"); root.innerHTML = safeHTML(state.note.html);
      const paragraphs = [...root.querySelectorAll("p[data-block]")].filter((node) => node.textContent.trim()).slice(0,3);
      payload.overview = { version: state.note.version, status: "ready", lead: state.note.version === 3 ? seed().overview.lead : "这一版，先留下这几处原文。", points: state.note.version === 3 ? seed().overview.points : paragraphs.map((node,i) => ({ text: node.textContent, block: node.dataset.block, label: "第 " + (i+1) + " 处" })) };
    }
    state.taskSerial = (state.taskSerial ?? 0) + 1;
    state.jobs[key] = { type, key, token: old?.status === "failed" ? old.token : type + "-" + Date.now() + "-" + state.taskSerial, status: "running", version: payload.version ?? state.note.version, deadline: Date.now() + 1800, payload };
    persist();
    scheduleJob(key);
    refreshForJob(key);
  }
  function scheduleJob(key) {
    clearTimeout(jobTimers.get(key));
    const job = state.jobs[key];
    if (!job || !pending(key)) return;
    const token = job.token;
    jobTimers.set(key, setTimeout(() => finishJob(key, token), Math.max(20,job.deadline - Date.now())));
  }
  function finishJob(key, token) {
    const job = state.jobs[key];
    if (!job || job.token !== token || !pending(key)) return;
    if (state.scenario === "generation-failed") {
      job.status = "failed"; persist(); refreshForJob(key); receipt("示例任务失败，已有内容没有被替换。"); return;
    }
    job.status = "ready";
    if (job.type === "overview") {
      state.overview = job.payload.overview;
      state.overviews[state.overview.version] = structuredClone(state.overview);
      overviewVersion = null;
    }
    if (job.type === "expansion") {
      state.drafts = structuredClone(draftTemplates); state.draftVersion = job.version;
      if (job.version !== 3) {
        const root = document.createElement("div"); root.innerHTML = safeHTML(state.versions[job.version]?.html ?? "");
        const blocks = [...root.querySelectorAll("p[data-block]")];
        state.drafts.forEach((draft,i) => { draft.block = blocks[i % Math.max(1,blocks.length)]?.dataset.block ?? "top"; draft.evidence = "演示草稿 · 待核对"; });
      }
    }
    if (job.type === "annotation") {
      const item = state.annotations.find((annotation) => annotation.id === job.payload.id);
      if (item) {
        item.text = job.payload.rephrase ? "换个角度：像同一个人换语言说话。词和句式变了，但你仍希望听出是那个人，并保留自然的停顿与情绪。" : "先把这句话拆成它关心的对象和变化：谁保持不变，什么发生变化，再回到这段上下文一起看。这是演示解释，不是模型生成结果。";
        if (job.payload.rephrase) item.revision++;
      }
    }
    if (job.type === "commit") {
      for (const snapshot of job.payload.drafts) {
        const draft = state.drafts.find((item) => item.id === snapshot.id);
        if (!draft || draft.saved) continue;
        state.saved.push({ id: "saved-" + snapshot.id + "-" + job.token, title: snapshot.title, html: safeHTML(snapshot.html), color: snapshot.color, version: 1, originVersion: job.version });
        draft.saved = true; draft.selected = false;
      }
      addHistory("expansion", "收下 " + job.payload.ids.length + " 篇衍生笔记 · 本机演示", { version: job.version });
    }
    persist();
    refreshForJob(key);
    if (job.type === "commit" && view === "expansion") {
      for (const stamp of document.querySelectorAll(".success-stamp")) animate(stamp, [{ opacity: 0, transform: "scale(1.05)" }, { opacity: 1, transform: "scale(1)" }], 180, stamp.parentElement.parentElement.dataset.draft);
    }
    receipt(job.type === "commit" ? "已收下 " + job.payload.ids.length + " 篇 · 仅保留在本机演示" : "示例结果已就绪");
  }
  function refreshForJob(key) {
    if ((key === "overview" && view === "overview") || ((key === "expansion" || key === "commit") && ["expansion","draft"].includes(view))) renderLeaf(true);
    if (detail?.type === "annotation" && key === "annotation-" + detail.annotationId) renderSide();
    if (detail?.type === "relations" && key === "commit") renderSide();
  }
  function cancelJob(key) {
    const job = state.jobs[key];
    if (!job || !pending(key)) return;
    job.status = "cancelled";
    clearTimeout(jobTimers.get(key));
    persist(); refreshForJob(key); receipt("已取消这次示例任务");
  }
  function hideHover() { clearTimeout(hoverTimer); $("annotation-preview").hidden = true; }
  function showHover(trigger) {
    const item = state.annotations.find((annotation) => annotation.id === trigger.dataset.annotation);
    if (!item || !item.text || detail?.annotationId === item.id) return;
    const preview = $("annotation-preview");
    preview.innerHTML = "<strong>" + (item.personal ? "我的批注" : "解释") + " · v" + item.version + "</strong><p>" + escape(item.text.slice(0,80)) + (item.text.length > 80 ? "…" : "") + "</p>";
    preview.hidden = false;
    const bounds = trigger.getBoundingClientRect();
    preview.style.left = Math.max(12,Math.min(bounds.left,innerWidth - (preview.offsetWidth || 275) - 12)) + "px";
    preview.style.top = Math.max(12,Math.min(bounds.bottom + 8,innerHeight - (preview.offsetHeight || 120) - 12)) + "px";
    animate(preview, [{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], 140);
  }
  function hideSelection() { $("selection-tools").hidden = true; selectedRange = null; }
  function captureSelection() {
    if (view !== "reader" || readingVersion) return;
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { hideSelection(); return; }
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const block = container.closest?.("[data-block]");
    if (!block || !$("prose")?.contains(block) || container.closest?.(".annotation-anchor")) { hideSelection(); return; }
    const quote = selection.toString().trim();
    if (!quote || quote.length > 1500) { hideSelection(); return; }
    selectedRange = { range: range.cloneRange(), quote, block: block.dataset.block, version: state.note.version };
    const tools = $("selection-tools");
    tools.hidden = false;
    const bounds = range.getBoundingClientRect?.() ?? block.getBoundingClientRect();
    tools.style.left = Math.max(10,Math.min(bounds.left,innerWidth - (tools.offsetWidth || 250) - 10)) + "px";
    tools.style.top = Math.max(10,Math.min(bounds.bottom + 8,innerHeight - 58)) + "px";
    paintIcons(tools);
  }
  function createAnnotation(personal) {
    const snapshot = selectedRange;
    if (!snapshot || snapshot.version !== state.note.version || !snapshot.range.startContainer.isConnected) { hideSelection(); receipt("选区已变化，请重新选择原句。"); return; }
    const id = "a-" + Date.now() + "-" + state.annotations.length;
    const mark = document.createElement("mark"); mark.dataset.noteAnchor = id;
    try {
      mark.append(snapshot.range.extractContents()); snapshot.range.insertNode(mark);
      for (const trigger of $("prose").querySelectorAll(".annotation-anchor")) {
        const existing = document.createElement("mark"); existing.dataset.noteAnchor = trigger.dataset.annotation;
        existing.textContent = state.annotations.find((item) => item.id === trigger.dataset.annotation)?.quote ?? trigger.textContent;
        trigger.replaceWith(existing);
      }
      state.note.html = safeHTML($("prose").innerHTML);
      state.versions[state.note.version] = { title: state.note.title, html: state.note.html };
      state.annotations.push({ id, version: snapshot.version, block: snapshot.block, quote: snapshot.quote, text: "", personal, revision: 1 });
      persist(); renderLeaf(true);
      getSelection()?.removeAllRanges();
      openSide({ type: "annotation", annotationId: id, writing: personal });
      if (!personal) runJob("annotation-" + id, "annotation", { id, version: snapshot.version });
    } catch { receipt("这段选区暂时无法定位，请只选同一段里的文字。"); }
    hideSelection();
  }
  function commitNote() {
    const draft = state.noteDraft;
    if (!draft || !draft.title.trim()) { receipt("给这篇笔记留一个标题。"); $("note-title")?.focus(); return; }
    const version = state.note.version + 1;
    const doc = new DOMParser().parseFromString(safeHTML(draft.html, true), "text/html");
    [...doc.body.querySelectorAll("h2,h3,p,blockquote")].forEach((node,index) => {
      node.dataset.block = "v" + version + "-block-" + index;
      if (node.tagName.startsWith("H")) node.id = node.dataset.block;
    });
    state.note = { title: draft.title.trim(), html: doc.body.innerHTML, version };
    state.versions[version] = { title: state.note.title, html: state.note.html };
    state.noteDraft = null;
    addHistory("version", "留成新版本 v" + version + " · 本机演示", { version });
    persist(); setView("reader"); receipt("已留成 v" + version + " · 旧批注仍在旧版");
  }
  function openHistory(id) {
    const entry = state.history.find((item) => item.id === id);
    if (!entry) return;
    if (entry.type === "recall") { recallId = entry.recallId; setView("recall"); return; }
    if (entry.type === "overview") { overviewVersion = entry.version; setView("overview"); return; }
    if (entry.type === "expansion") { setView("expansion"); return; }
    readingVersion = entry.version === state.note.version ? null : entry.version;
    setView("reader", { keepVersion: true });
    if (entry.type === "annotation") {
      const annotation = state.annotations.find((item) => item.id === entry.annotationId);
      if (annotation) jump(annotation.block, annotation.version);
      openSide({ type: "annotation", annotationId: entry.annotationId, quote: entry.quote, version: entry.version });
    }
  }
  function reset() {
    for (const timer of jobTimers.values()) clearTimeout(timer);
    jobTimers.clear();
    state = seed(); state.overviews[3] = structuredClone(state.overview); readingVersion = null; overviewVersion = null; recallId = null; draftId = null; relatedId = null; draftEditing = false;
    tocOpen = innerWidth > 1100;
    persist(); setView("reader");
    $("motion-setting").value = state.motion; $("scenario-setting").value = state.scenario;
    receipt("演示已重置");
  }
  const actions = {
    reader: () => setView("reader"),
    overview: () => { overviewVersion = null; setView("overview"); addHistory("overview", "翻开三处要点", { version: state.overview.version }); },
    recall: () => { recallId = null; setView("recall"); },
    "new-recall": () => { getRecall(true); renderLeaf(); },
    expansion: () => setView("expansion"),
    edit: () => { if (view === "draft") { draftEditing = !draftEditing; renderLeaf(true); if (draftEditing) $("draft-title").focus(); } else setView("editor"); },
    "save-note": commitNote,
    "discard-edit": () => { state.noteDraft = null; persist(); setView("reader"); },
    toc: () => { tocOpen = !tocOpen; if (tocOpen) closeSide(false); syncChrome(); if (tocOpen) { animate($("index-leaf"), [{ opacity: .4, transform: "translateX(-12px)" }, { opacity: 1, transform: "translateX(0)" }], 200); $("toc").querySelector("button")?.focus(); } },
    "close-toc": () => { tocOpen = false; syncChrome(); document.querySelector('[data-action="toc"]').focus(); },
    "pin-toc": () => { if (innerWidth <= 1100) return; state.tocPinned = !state.tocPinned; persist(); syncChrome(); receipt(state.tocPinned ? "目录已固定" : "目录改为按需打开"); },
    jump: (target) => jump(target.dataset.block),
    sources: (target) => openSide({ type: "sources" }, target),
    relations: (target) => openSide({ type: "relations" }, target),
    history: (target) => openSide({ type: "history" }, target),
    "close-side": () => closeSide(),
    "source-tab": (target) => { detail.source = target.dataset.source; renderSide(); },
    "source-excerpt": () => { detail.materialOpen = !detail.materialOpen; renderSide(); },
    "retry-sources": () => { state.scenario = "normal"; $("scenario-setting").value = "normal"; persist(); renderSide(); receipt("示例来源已恢复"); },
    "open-related": (target) => { relatedId = target.dataset.id; setView("related"); },
    "open-history": (target) => openHistory(target.dataset.id),
    "overview-origin": (target) => jump(target.dataset.block, Number(target.dataset.version)),
    "recall-origin": (target) => { readingVersion = Number(target.dataset.version) === state.note.version ? null : Number(target.dataset.version); setView("reader", { keepVersion: true }); jump(target.dataset.block, Number(target.dataset.version)); },
    "annotation-origin": (target) => { readingVersion = Number(target.dataset.version) === state.note.version ? null : Number(target.dataset.version); setView("reader", { keepVersion: true }); jump(target.dataset.block, Number(target.dataset.version)); },
    hint: () => { getRecall().hinted = true; persist(); renderLeaf(true); },
    reveal: () => { getRecall().revealed = true; persist(); renderLeaf(true); animate($("answer-fold"), [{ opacity: 0, transform: "translateY(-5px) rotateX(-8deg)" }, { opacity: 1, transform: "translateY(0) rotateX(0)" }], 220); },
    "self-report": (target) => { getRecall().selfReport = target.dataset.value; persist(); renderLeaf(true); receipt("已记下你的自述 · 不评分"); },
    "generate-overview": () => runJob("overview", "overview"),
    "generate-expansion": () => { if (pending("commit")) return; if (state.drafts.some((draft) => !draft.saved && (draft.selected || draft.edited)) && !confirm("换方向会替换未收下的草稿。继续吗？")) return; runJob("expansion", "expansion"); },
    "open-draft": (target) => { draftId = target.dataset.id; activeDraft().reviewed = true; persist(); setView("draft"); },
    "previous-draft": () => { const index = state.drafts.indexOf(activeDraft()); if (index > 0) { draftId = state.drafts[index-1].id; activeDraft().reviewed = true; persist(); renderLeaf(); } },
    "next-draft": () => { const index = state.drafts.indexOf(activeDraft()); if (index < state.drafts.length-1) { draftId = state.drafts[index+1].id; activeDraft().reviewed = true; persist(); renderLeaf(); } },
    "draft-origin": (target) => { const version = state.draftVersion; readingVersion = version === state.note.version ? null : version; setView("reader", { keepVersion: true }); jump(target.dataset.block, version); },
    commit: () => { if (pending("expansion")) return; const drafts = state.drafts.filter((draft) => draft.selected && !draft.saved).map(({id,title,html,color}) => ({id,title,html,color})); if (drafts.length) runJob("commit", "commit", { ids: drafts.map((draft) => draft.id), drafts, version: state.draftVersion }); },
    "cancel-job": (target) => cancelJob(target.dataset.job),
    "retry-job": (target) => { const job = state.jobs[target.dataset.job]; if (job) runJob(job.key, job.type, { ...job.payload, version: job.version }); },
    "explain-selection": () => createAnnotation(false),
    "annotate-selection": () => createAnnotation(true),
    "write-annotation": () => { detail.writing = true; renderSide(); $("annotation-writing")?.focus(); },
    "save-annotation": () => { const item = state.annotations.find((annotation) => annotation.id === detail.annotationId); const text = $("annotation-writing").value.trim(); if (!text) { receipt("写下一点想法再留下。"); return; } if (item.personal) item.text = text; else item.comment = text; if (state.annotationDrafts) delete state.annotationDrafts[item.id]; detail.writing = false; addHistory("annotation", item.quote, { version: item.version, annotationId: item.id }); persist(); renderSide(); receipt("已留在原句旁 · 本机演示"); document.querySelector('[data-action="write-annotation"]')?.focus(); },
    rephrase: () => { const item = state.annotations.find((annotation) => annotation.id === detail.annotationId); runJob("annotation-" + item.id, "annotation", { id: item.id, rephrase: true, version: item.version }); },
    companion: () => { $("companion-bubble").hidden = !$("companion-bubble").hidden; if (!$("companion-bubble").hidden) animate($("companion-bubble"), [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], 180); },
    "close-companion": () => { $("companion-bubble").hidden = true; },
    settings: () => { $("motion-setting").value = state.motion; $("scenario-setting").value = state.scenario; $("settings-dialog").showModal(); },
    reset
  };
  document.addEventListener("pointerdown", () => { keyboardInput = false; });
  document.addEventListener("keydown", (event) => {
    keyboardInput = true;
    const tab = event.target.closest?.('.source-tabs [role="tab"]');
    if (tab && ["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) {
      event.preventDefault();
      const source = event.key === "Home" ? "original" : (event.key === "End" ? "supplement" : (tab.dataset.source === "original" ? "supplement" : "original"));
      detail.source = source; renderSide(); $("source-tab-" + source)?.focus(); return;
    }
    if (event.key === "Escape" && !$("settings-dialog").open) {
      if (!$("selection-tools").hidden) { hideSelection(); return; }
      if (detail) { closeSide(); event.preventDefault(); return; }
      if (tocOpen && !state.tocPinned) { actions["close-toc"](); event.preventDefault(); return; }
      if (view !== "reader" || readingVersion) { setView("reader"); event.preventDefault(); }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && view === "editor") { event.preventDefault(); commitNote(); }
  });
  document.addEventListener("click", (event) => {
    const annotation = event.target.closest("[data-annotation]");
    if (annotation) { openSide({ type: "annotation", annotationId: annotation.dataset.annotation }, annotation); return; }
    const target = event.target.closest("[data-action]");
    if (target && !target.disabled) actions[target.dataset.action]?.(target);
    const format = event.target.closest("[data-format]");
    if (format && document.execCommand) {
      const commands = { bold: ["bold"], heading: ["formatBlock","h2"], list: ["insertUnorderedList"] };
      const [command,value] = commands[format.dataset.format];
      document.execCommand(command, false, value);
      document.querySelector(".editor-body")?.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-select-draft]")) {
      const draft = state.drafts.find((item) => item.id === target.dataset.selectDraft);
      if (!draft || draft.saved || pending("commit") || pending("expansion")) return;
      draft.selected = target.checked; persist(); renderLeaf(true);
      document.querySelector('[data-select-draft="' + draft.id + '"]')?.focus();
    }
    if (target.id === "motion-setting") { state.motion = target.value; for (const animation of animationHandles.values()) animation.cancel(); persist(); syncChrome(); }
    if (target.id === "scenario-setting") { state.scenario = target.value; persist(); if (detail) renderSide(); }
    if (target.id === "history-filter") { historyFilter = target.value; renderSide(); $("history-filter").focus(); }
  });
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "note-title") state.noteDraft.title = target.value;
    if (target.id === "note-body") {
      normalizeEditorHeadings(target);
      state.noteDraft.html = safeHTML(target.innerHTML, true); renderTOC();
    }
    if (target.id === "draft-title") { activeDraft().title = target.value; activeDraft().edited = true; }
    if (target.id === "draft-body") {
      normalizeEditorHeadings(target);
      activeDraft().html = safeHTML(target.innerHTML, true); activeDraft().edited = true; renderTOC();
    }
    if (target.id === "annotation-writing" && detail?.annotationId) { state.annotationDrafts ??= {}; state.annotationDrafts[detail.annotationId] = target.value; }
    if (["note-title","note-body","draft-title","draft-body","annotation-writing"].includes(target.id)) persist();
  });
  document.addEventListener("paste", (event) => {
    if (!event.target.closest("[contenteditable]")) return;
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (document.execCommand) document.execCommand("insertText", false, text);
  });
  document.addEventListener("pointerover", (event) => {
    const trigger = event.target.closest("[data-annotation]");
    if (trigger && window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showHover(trigger), 180); }
  });
  document.addEventListener("pointerout", (event) => { if (event.target.closest("[data-annotation]") && !event.target.closest("[data-annotation]").contains(event.relatedTarget)) hideHover(); });
  document.addEventListener("focusin", (event) => { const trigger = event.target.closest("[data-annotation]"); if (trigger) showHover(trigger); });
  document.addEventListener("focusout", (event) => { if (event.target.closest("[data-annotation]")) hideHover(); });
  $("selection-tools").addEventListener("mousedown", (event) => event.preventDefault());
  $("editor-tools").addEventListener("mousedown", (event) => event.preventDefault());
  document.addEventListener("mouseup", (event) => { if (!event.target.closest(".selection-tools")) captureSelection(); });
  document.addEventListener("keyup", (event) => { if (event.key === "Shift") captureSelection(); });
  $("leaf-scroll").addEventListener("scroll", () => {
    hideHover(); hideSelection(); updateReadPosition();
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { if (renderedKey) { state.positions[renderedKey] = $("leaf-scroll").scrollTop; persist(); } }, 150);
  }, { passive: true });
  window.addEventListener("resize", () => { if (innerWidth <= 1100) tocOpen = false; else if (state.tocPinned) tocOpen = true; tocSuspended = !!detail && innerWidth < 1500; syncChrome(); hideHover(); hideSelection(); });
  window.matchMedia?.("(prefers-reduced-motion: reduce)").addEventListener?.("change", () => { for (const animation of animationHandles.values()) animation.cancel(); });
  renderLeaf();
  state.overviews ??= {};
  state.overviews[state.overview.version] ??= structuredClone(state.overview);
  persist();
  for (const key of Object.keys(state.jobs)) scheduleJob(key);
  window.NotebookDemo = { get state() { return state; }, get view() { return view; }, get detail() { return detail; }, reset, safeHTML };
})();
