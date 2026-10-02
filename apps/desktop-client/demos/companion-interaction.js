/* Local review adapter. No AI calls, microphone, speech playback, storage or business writes. */
(() => {
  const $ = (id) => document.getElementById(id);
  const root = $("demo");
  const { escape,icon,referenceText,explanation,longExplanation,draftReference,renderBlock,plainBlock } = window.COMPANION_DEMO_CONTENT;
  document.querySelectorAll("[data-icon]").forEach((node) => { node.outerHTML = icon(node.dataset.icon); });
  const state = { scene:"chat",phase:"idle",voice:"closed",voiceVersion:0,voiceResume:false,sideOpen:false,activeExtra:null,quoted:false,draft:"",messages:[],epoch:0,sceneEpoch:0,nextId:0,filter:"all",search:"",turn:null,quiet:false,unread:0,voiceRestore:false,replyPaused:false,pointerReading:false };
  const animations = new Map(), timers = new Set(), auxiliaryTimers = new Set();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const ease = getComputedStyle(root).getPropertyValue("--hud-ease-out").trim();
  let receiptTimer = 0, replyTimer = 0, savedScroll = 0, imageReturnFocus = null, pointerPosition = null;
  const busy = () => state.phase !== "idle";
  const recordMode = () => root.dataset.chatMode === "record";
  const blocks = () => state.messages.flatMap((message) => message.blocks);
  const findBlock = (id) => blocks().find((block) => block.id === id);
  const lifetime = window.COMPANION_DEMO_LIFECYCLE.create({ onExpire:expirePapers });
  const compactDesk = matchMedia("(max-width:740px), (max-height:480px)");
  function syncLifetimes() {
    const entries = blocks().filter((block) => !block.dismissed).map((block) => ({ id:block.id,signature:`${block.type}:${block.state || "ready"}`,duration:window.COMPANION_DEMO_LIFECYCLE.lifetimeFor(block) }));
    if (!recordMode() && !$("input-bubble").hidden) entries.push({ id:"input",signature:"input",duration:90000 });
    if (state.voice !== "closed") entries.push({ id:"voice",signature:state.voice,duration:90000 });
    if (state.phase === "idle" && !$("reply-bubble").hidden && !$("reply-bubble").dataset.exiting) entries.push({ id:"reply",signature:state.messages.at(-1)?.id,duration:1200 });
    lifetime.update(entries);
  }
  function expirePapers(ids) {
    let papers = false;
    for (const id of ids) {
      if (id === "input") { setUserOpen(false); continue; }
      if (id === "reply") { closeReply(); continue; }
      if (id === "voice") {
        state.voiceResume = state.voice === "preview";
        if ($("voice-bubble").contains(document.activeElement)) $("voice-button").focus({ preventScroll:true });
        hideVoice(false); continue;
      }
      const block = findBlock(id); if (!block) continue;
      if (block.type === "image" && $("image-viewer").open && imageReturnFocus?.dataset.block === id) {
        $("image-viewer").close(); $("records-button").focus({ preventScroll:true });
      }
      block.dismissed = true; papers = true;
      const el = $(`light-${id}`);
      if (el) {
        if (el.contains(document.activeElement)) $("records-button").focus({ preventScroll:true });
        el.inert = true;
        animate(el,[{ opacity:1,transform:"none" },{ opacity:0,transform:`translateX(${root.dataset.seat === "left" ? -24 : 24}px) scale(.9)` }],240);
      }
    }
    if (papers) {
      if (root.dataset.motion === "off") renderExtras();
      else auxiliaryLater(renderExtras,root.dataset.motion === "lite" ? 150 : 240);
    }
  }
  function later(fn,ms,epoch = state.epoch) {
    const timer = setTimeout(() => { timers.delete(timer); if (epoch === state.epoch) fn(); },ms);
    timers.add(timer); return timer;
  }
  function auxiliaryLater(fn,ms) {
    const epoch = state.sceneEpoch;
    const timer = setTimeout(() => { auxiliaryTimers.delete(timer); if (epoch === state.sceneEpoch) fn(); },ms);
    auxiliaryTimers.add(timer); return timer;
  }
  function animate(element,frames,duration = 560,delay = 0) {
    if (!element || root.dataset.motion === "off") return;
    animations.get(element)?.cancel();
    const animation = element.animate(root.dataset.motion === "lite" ? [{ opacity:.6 },{ opacity:1 }] : frames.map((frame) => ({ easing:ease,...frame })), { duration:root.dataset.motion === "lite" ? 150 : duration,delay,easing:"linear" });
    animations.set(element,animation);
    animation.finished.catch(() => {}).finally(() => { if (animations.get(element) === animation) animations.delete(element); });
  }
  function pop(element) { animate(element,[{ opacity:0,transform:"translateY(48px) scale(.78)" },{ opacity:1,transform:"translateY(-10px) scale(1.09)",offset:.58 },{ opacity:1,transform:"translateY(4px) scale(.98)",offset:.82 },{ opacity:1,transform:"none" }]); }
  function receipt(text) {
    clearTimeout(receiptTimer); $("receipt").textContent = text; $("receipt").hidden = false;
    receiptTimer = setTimeout(() => { $("receipt").hidden = true; },3200);
  }
  function setMotion() {
    const mode = reduced.matches ? "off" : $("motion").value;
    root.dataset.motion = mode;
    $("motion-note").textContent = reduced.matches ? "跟随系统 · 减少动效" : ({ full:"灵动 · 纸签弹出、抽页、确认与角色回应",lite:"轻量 · 保留状态反馈",off:"动效关闭 · 保留全部操作" })[mode];
    if (mode !== "full") { animations.forEach((animation) => animation.cancel()); animations.clear(); $("burst").replaceChildren(); }
    window.dispatchEvent(new CustomEvent("companion-demo-motion",{ detail:mode }));
  }
  function sync() {
    root.dataset.phase = state.phase;
    $("send-button").disabled = busy() || state.voice !== "closed" || !state.draft.trim();
    $("bubble-send").disabled = $("send-button").disabled;
    $("stop-button").hidden = !busy(); $("send-button").hidden = busy();
    $("turn-status").hidden = !busy() || state.quiet || (state.phase === "replying" && !$("reply-bubble").hidden);
    $("reply-stop").hidden = state.phase !== "replying";
    $("compose-note").textContent = busy() ? "小鲸正在回复 · 可以先写下一句" : "Enter 发送 · Shift + Enter 换行";
    $("voice-button").disabled = busy();
    $("composer").querySelector('[data-action="voice"]').disabled = busy();
    $("voice-button").setAttribute("aria-expanded",String(state.voice !== "closed"));
    $("talk-button").setAttribute("aria-expanded",String(!$("input-bubble").hidden && !recordMode()));
    $("proposal-count").textContent = String(blocks().filter((block) => block.type === "proposal" && block.state === "pending").length);
    const hasSide = blocks().some((block) => !block.dismissed && block.type !== "tool");
    const sideBlocks = blocks().filter((block) => !block.dismissed && block.type !== "tool");
    if (!sideBlocks.some((block) => block.id === state.activeExtra)) state.activeExtra = sideBlocks.at(-1)?.id || null;
    root.dataset.sidePage = state.sideOpen && hasSide ? "extras" : "note";
    $("open-side").hidden = !hasSide; $("side-count").textContent = String(sideBlocks.length);
    $("notebook").inert = recordMode() || (compactDesk.matches && state.sideOpen && hasSide);
    $("light-extras").querySelectorAll(".companion-extra").forEach((el) => { el.dataset.active = String(el.dataset.blockId === state.activeExtra); });
    $("side-dock").hidden = state.quiet || recordMode() || !hasSide;
    $("tool-extras").hidden = state.quiet || recordMode() || state.voice !== "closed";
    $("extras-nav").hidden = !hasSide;
    root.dataset.extras = String(!$("side-dock").hidden);
    root.style.setProperty("--composer-height",`${$("journal").querySelector(".companion-history__compose-area").offsetHeight}px`);
    fitBubbles();
    syncLifetimes();
  }
  function fitBubbles() {
    const dock = $("light-dock"), styles = getComputedStyle(dock);
    const tools = $("tool-extras");
    const available = $("light-slot").clientHeight-parseFloat(styles.paddingTop)-parseFloat(styles.paddingBottom)-(tools.hidden || !tools.childElementCount ? 0 : tools.offsetHeight+parseFloat(getComputedStyle(tools).marginBottom));
    const reply = $("reply-bubble"), body = $("reply-body");
    if (!reply.hidden && !recordMode()) {
      const chrome = reply.offsetHeight-body.offsetHeight;
      const budget = available-chrome-parseFloat(getComputedStyle(reply).marginBottom)-4;
      reply.style.setProperty("--reply-body-budget",`${Math.max(24,Math.floor(budget))}px`);
    }
    const voice = $("voice-bubble");
    voice.style.setProperty("--voice-budget",`${Math.max(90,Math.floor(available-parseFloat(getComputedStyle(voice).marginBottom)-2))}px`);
    $("more-panel").style.setProperty("--settings-budget",`${Math.max(90,$("character").offsetTop-16)}px`);
  }
  function setDraft(value) { state.draft = value; $("message-input").value = value; $("bubble-input").value = value; sync(); }
  function setQuoted(value) {
    state.quoted = value;
    for (const id of ["quote","bubble-quote"]) { $(id).hidden = !value; $(id).innerHTML = value ? draftReference() : ""; }
  }
  function offsetWithin(element,container) {
    let top = 0;
    for (let node = element; node && node !== container; node = node.offsetParent) top += node.offsetTop;
    return top;
  }
  function revealInDock(element) {
    const dock = element.closest("#light-extras") || $("light-dock"), top = offsetWithin(element,dock);
    const styles = getComputedStyle(dock), headroom = parseFloat(styles.paddingTop), footroom = parseFloat(styles.paddingBottom);
    if (top < dock.scrollTop+headroom || top+element.offsetHeight > dock.scrollTop+dock.clientHeight-footroom) dock.scrollTop = Math.max(0,top-headroom);
  }
  function setUserOpen(open,focus = false) {
    $("input-bubble").hidden = !open;
    sync();
    if (open) { revealInDock($("input-bubble")); if (focus) $("bubble-input").focus({ preventScroll:true }); pop($("input-bubble")); }
    else if ($("input-bubble").contains(document.activeElement)) $("talk-button").focus({ preventScroll:true });
  }
  function setJournal(open,focus = false) {
    if (!open) savedScroll = $("message-list").scrollTop;
    root.dataset.chatMode = open ? "record" : "bubble"; root.dataset.journal = String(open);
    $("journal").dataset.open = String(open); $("journal").inert = !open; $("notebook").inert = open;
    $("records-button").setAttribute("aria-expanded",String(open));
    for (const id of ["input-bubble","reply-bubble","side-dock","tool-extras","turn-status"]) $(id).inert = open;
    if (open) {
      renderMessages(); $("message-list").scrollTop = savedScroll;
      animate($("journal"),[{ opacity:0,transform:"translateX(110px) scale(.9)" },{ opacity:1,transform:"translateX(-8px) scale(1.025)",offset:.65 },{ opacity:1,transform:"none" }],560);
      if (focus) $("message-input").focus({ preventScroll:true });
    } else if ($("journal").contains(document.activeElement)) $("talk-button").focus({ preventScroll:true });
    sync();
  }
  function setMore(open,focus = true) {
    $("more-panel").dataset.open = String(open); $("more-panel").inert = !open; $("more-button").setAttribute("aria-expanded",String(open));
    if (open) { pop($("more-panel")); $("quiet-toggle").focus({ preventScroll:true }); }
    else if (focus) $("more-button").focus({ preventScroll:true });
  }
  function setSearch(open,focus = false) {
    $("search-row").hidden = !open; $("search-row").inert = !open;
    $("search-button").setAttribute("aria-expanded",String(open));
    if (!open) { state.search = ""; $("search-input").value = ""; }
    renderMessages();
    if (focus) (open ? $("search-input") : $("message-input")).focus({ preventScroll:true });
  }
  function captureFocus(container) {
    const element = document.activeElement;
    if (!container.contains(element) || element === container) return null;
    const article = element.closest("[data-block-id],[data-message-id]");
    return article ? { element,block:article.dataset.blockId,message:article.dataset.messageId,action:element.dataset.action,summary:element.tagName === "SUMMARY" ? [...article.querySelectorAll("summary")].indexOf(element) : -1 } : null;
  }
  function restoreFocus(container,snapshot) {
    if (!snapshot || snapshot.element.isConnected) return;
    const article = snapshot.block ? container.querySelector(`[data-block-id="${snapshot.block}"]`) : container.querySelector(`[data-message-id="${snapshot.message}"]`);
    if (!article) { if (container === $("message-list")) container.focus({ preventScroll:true }); return; }
    const target = (snapshot.action && article.querySelector(`[data-action="${snapshot.action}"]`)) || (snapshot.summary >= 0 && article.querySelectorAll("summary")[snapshot.summary]) || article.querySelector(".companion-extra__outcome") || article;
    if (!target.matches("button,summary,input,textarea,a")) target.setAttribute("tabindex","-1");
    target.focus({ preventScroll:true });
  }
  function detailsState(container) {
    return new Set([...container.querySelectorAll(".companion-extra")].flatMap((article) => [...article.querySelectorAll("details")].map((details,index) => details.open ? `${article.dataset.blockId}-${index}` : "").filter(Boolean)));
  }
  function restoreDetails(container,open) {
    container.querySelectorAll(".companion-extra").forEach((article) => article.querySelectorAll("details").forEach((details,index) => { details.open = open.has(`${article.dataset.blockId}-${index}`); }));
  }
  function renderExtras(newId = null) {
    let focused = false;
    for (const id of ["tool-extras","light-extras"]) {
      const container = $(id), open = detailsState(container), dock = id === "tool-extras" ? $("light-dock") : container;
      const top = dock.scrollTop, focus = captureFocus(container); focused ||= Boolean(focus);
      container.innerHTML = blocks().filter((block) => !block.dismissed && (id === "tool-extras" ? block.type === "tool" : block.type !== "tool")).map((block) => renderBlock(block,"light")).join("");
      restoreDetails(container,open); dock.scrollTop = top; restoreFocus(container,focus);
    }
    if (newId && findBlock(newId)?.type !== "tool" && !focused) { state.activeExtra = newId; state.sideOpen = true; }
    const labels = { quote:["file-text","引用"],tool:["sparkles","工具"],proposal:["bookmark","确认"],image:["image","图片"],diagram:["arrow-right","图解"],card:["bookmark","卡片"],nav:["book-open","笔记"],error:["x","重试"] };
    const byType = new Map(); blocks().filter((block) => !block.dismissed && block.type !== "tool").forEach((block) => byType.set(block.type,block));
    $("extras-nav").innerHTML = [...byType.values()].map((block) => `<button class="text-action" data-action="jump-extra" data-block="${block.id}" aria-label="定位${escape(block.label)}">${icon(labels[block.type][0])}${labels[block.type][1]}</button>`).join("");
    $("extras-nav").hidden = !byType.size || state.quiet;
    renderMessages(); sync();
    if (newId && !state.quiet && !recordMode()) {
      const el = $(`light-${newId}`); if (!el) return;
      if (!focused) revealInDock(el);
      if (findBlock(newId)?.type === "tool") animate(el,[{ opacity:.1,transform:"translateX(24px)" },{ opacity:1,transform:"none" }],240);
      else pop(el);
    }
  }
  function messageHtml(message) {
    const prefix = message.role === "user" ? "你" : "小鲸";
    return `<article class="companion-record companion-record--${message.role}" data-message-id="${message.id}"><header class="companion-record__meta"><span class="companion-record__avatar">${icon(message.role === "user" ? "user" : "sparkles")}</span><strong>${prefix}${message.voice ? " · 语音" : ""}</strong><time>${message.time}</time></header><div class="companion-record__body" data-message-body="${message.id}">${escape(message.text)}</div>${message.state === "thinking" ? `<div class="companion-record__process" role="status"><span class="companion-record__dots" aria-hidden="true"><i></i><i></i><i></i></span>正在想…</div>` : ""}${message.blocks.map((block) => renderBlock(block,"record")).join("")}${message.state === "done" ? `<div class="companion-record__actions"><button class="text-action" data-action="copy" data-message="${message.id}">${icon("copy")}复制文字</button></div>` : ""}</article>`;
  }
  function renderMessages() {
    const list = $("message-list"), top = list.scrollTop, open = detailsState(list), follow = isLatestVisible(), focus = captureFocus(list);
    const filtered = state.messages.filter((message) => (!state.search || `${message.text} ${message.blocks.map(plainBlock).join(" ")}`.toLowerCase().includes(state.search.toLowerCase())) && (state.filter !== "proposal" || message.blocks.some((block) => block.type === "proposal" && block.state === "pending")));
    list.innerHTML = filtered.length ? filtered.map(messageHtml).join("") : `<div class="companion-record__empty">${icon("message-circle")}<h3>${state.search ? "没找到这句话" : state.filter === "proposal" ? "没有待确认的动作" : "第一句话，从这里开始"}</h3><p>${state.search ? "换个词试试，引用和工具结果也能查找。" : "可以聊笔记，也可以只是说说今天。"}</p>${!state.search && state.filter === "all" ? `<div class="companion-record__suggestions"><button class="button" data-action="starter">我还是分不清 Query 和 Key</button></div>` : ""}</div>`;
    restoreDetails(list,open); list.scrollTop = top; restoreFocus(list,focus);
    if (follow && recordMode() && !focus) scrollToLatest(); else updateLatest();
  }
  function latestContent() { return $("message-list").lastElementChild?.querySelector(".companion-extra:last-of-type,.companion-record__process") || $("message-list").lastElementChild?.querySelector(".companion-record__body"); }
  function isLatestVisible() {
    const target = latestContent(); if (!target) return true;
    const a = target.getBoundingClientRect(), b = $("message-list").getBoundingClientRect();
    return a.bottom > b.top+8 && a.top < b.bottom-8;
  }
  function updateLatest() { $("latest").hidden = isLatestVisible() || state.filter !== "all" || Boolean(state.search); $("latest-label").textContent = state.unread ? `${state.unread} 条新消息 · 回到最新` : "回到最新"; }
  function scrollToLatest() {
    const target = latestContent(); if (!target) return;
    const list = $("message-list"), top = offsetWithin(target,list);
    list.scrollTop = Math.max(0,target.offsetHeight > list.clientHeight ? top : top+target.offsetHeight-list.clientHeight+10);
    state.unread = 0; updateLatest();
  }
  function message(role,text = "",extra = {}) {
    const entry = { id:`m${++state.nextId}`,role,text,blocks:[],state:"done",time:new Intl.DateTimeFormat("zh-CN",{ hour:"2-digit",minute:"2-digit",hour12:false }).format(new Date()),...extra };
    state.messages.push(entry); state.unread++; renderMessages(); return entry;
  }
  function addBlock(turn,type,props) {
    const block = { id:`b${++state.nextId}`,type,turn:turn.id,dismissed:false,...props };
    turn.blocks.push(block); renderExtras(block.id); return block;
  }
  function closeReply(animated = true) {
    clearTimeout(replyTimer); replyTimer = 0;
    const el = $("reply-bubble");
    if (el.hidden) return;
    if (el.contains(document.activeElement)) $("talk-button").focus({ preventScroll:true });
    if (!animated || root.dataset.motion === "off" || state.quiet) { animations.get(el)?.cancel(); delete el.dataset.exiting; el.hidden = true; syncLifetimes(); return; }
    el.dataset.exiting = "true";
    animate(el,[{ opacity:1,transform:"none" },{ opacity:0,transform:"translateY(24px) scale(.9)" }],280);
    const epoch = state.epoch;
    replyTimer = setTimeout(() => { if (epoch === state.epoch && state.phase === "idle") { el.hidden = true; delete el.dataset.exiting; syncLifetimes(); } },root.dataset.motion === "lite" ? 150 : 280);
  }
  function replyPause(value) {
    if (state.replyPaused === value) return;
    state.replyPaused = value;
    if (value) {
      lifetime.activity("reply");
      if (state.phase === "idle") $("reply-note").textContent = "阅读中 · 稍后收起";
    } else if (state.phase === "idle") $("reply-note").textContent = "即将收起";
  }
  function startReply(turn,text,after) {
    state.phase = "replying"; turn.state = "replying"; state.turn = turn;
    const chars = Array.from(text); let count = 0;
    $("reply-body").textContent = ""; $("reply-body").scrollTop = 0;
    $("reply-note").textContent = "正在回复…";
    state.pointerReading = false; state.replyPaused = $("reply-bubble").contains(document.activeElement);
    clearTimeout(replyTimer); $("reply-bubble").hidden = state.quiet;
    if (!state.quiet && !recordMode()) { pop($("reply-bubble")); revealInDock($("reply-bubble")); }
    renderMessages(); sync(); if (!state.quiet && !recordMode()) revealInDock($("reply-bubble"));
    function step() {
      const body = $("reply-body"), follow = body.scrollHeight-body.scrollTop-body.clientHeight < 8;
      count = Math.min(chars.length,count+3); turn.text = chars.slice(0,count).join(""); body.textContent = turn.text;
      if (follow && !state.replyPaused) body.scrollTop = body.scrollHeight;
      const recordBody = document.querySelector(`[data-message-body="${turn.id}"]`); if (recordBody) recordBody.textContent = turn.text;
      if (count < chars.length) { later(step,70); return; }
      state.phase = "idle"; turn.state = "done"; state.turn = null;
      $("reply-note").textContent = state.replyPaused ? "阅读中" : "即将收起";
      $("reply-announcement").textContent = `小鲸：${text}`;
      renderMessages(); sync(); after?.(); if (state.replyPaused) lifetime.activity("reply");
    }
    step();
  }
  function imageLoad(block,recover = false) {
    block.state = "loading"; renderExtras();
    const epoch = state.sceneEpoch, image = new Image();
    image.onload = () => { if (epoch !== state.sceneEpoch) return; block.state = "ready"; renderExtras(block.id); };
    image.onerror = () => { if (epoch !== state.sceneEpoch) return; block.state = "error"; renderExtras(); };
    image.src = state.scene === "image-error" && !recover ? "companion-demo-intentionally-unavailable.svg" : "companion-interaction-image.svg";
  }
  function richResult(turn,kind) {
    if (["complete","references"].includes(kind)) addBlock(turn,"quote",{ label:"引用原文 · 注意力机制",text:referenceText });
    if (["complete","proposal"].includes(kind)) addBlock(turn,"proposal",{ label:"等你确认 · 收下卡片",state:"pending",description:"把这段理解整理成 1 张「Query / Key / Value」学习卡，收进当前笔记。" });
    if (["complete","image","image-error"].includes(kind)) imageLoad(addBlock(turn,"image",{ label:"返回图片 · 注意力示意图",state:"loading" }));
    if (kind === "more") {
      addBlock(turn,"diagram",{ label:"过程示意 · 三步理解",steps:["Query 带着问题","与 Key 比较相关程度","按权重汇总 Value"] });
      addBlock(turn,"card",{ label:"卡片 · 自己说一次",front:"为什么最终汇总的是 Value？",back:"Key 用来比较相关程度，Value 才包含参与结果的内容。" });
      addBlock(turn,"nav",{ label:"相关笔记入口" });
    }
  }
  function send(text,options = {}) {
    if (busy() || !text.trim()) return;
    state.quiet = false; $("quiet-toggle").checked = false; $("light-extras").hidden = false;
    const kind = options.kind || "chat";
    const own = options.retry ? state.messages.find((entry) => entry.id === options.retry) : message("user",text,{ voice:Boolean(options.voice) });
    if (!options.retry && state.quoted) own.blocks.push({ id:`b${++state.nextId}`,type:"quote",label:"你引用的原文",text:referenceText,turn:own.id,dismissed:true });
    if (!options.retry) { setDraft(""); setQuoted(false); setUserOpen(false); }
    closeReply(false); hideVoice(false);
    const turn = message("assistant","",{ state:"thinking",userId:own.id });
    state.turn = turn; state.phase = "thinking"; $("turn-status-text").textContent = "小鲸正在想…"; sync();
    let tool = null;
    if (["complete","tools","error"].includes(kind)) {
      later(() => {
        tool = addBlock(turn,"tool",{ label:"工具过程",state:"running",steps:[{ label:"读取笔记原文",state:"running" },{ label:"整理相关内容",state:"running" }],detail:"输入：当前笔记的选中段落。结果：Query / Key / Value 的定义与关联解释。" });
        $("turn-status-text").textContent = "正在查阅这段笔记…";
      },300);
    }
    later(() => {
      if (kind === "error") {
        if (tool) { tool.state = "failed"; tool.steps.forEach((step) => { step.state = "failed"; }); }
        state.phase = "idle"; turn.state = "error"; state.turn = null;
        addBlock(turn,"error",{ label:"这次回复中断了",text:"演示连接中断。你的消息已保留，可以在这里重试。" }); sync(); return;
      }
      if (tool) { tool.state = "done"; tool.steps.forEach((step) => { step.state = "done"; }); renderExtras(); }
      const response = kind === "long" ? longExplanation : ["complete","proposal"].includes(kind) ? "我把原文和图片放到身边的附页里了。\n\n卡片由你决定是否收下，确认框会一直等你。其他纸签稍后自动收起，手记里仍能找到。" : kind === "image" || kind === "image-error" ? "我把关系画成了一张示意图，放在身边的图片气泡里。可以放大查看，稍后会自动收起。" : kind === "references" ? "这次解释来自你选中的原文。引用放在身边，可以直接回到笔记核对；稍后会自动收起。" : text.includes("累") ? "那就先缓一缓。你已经读到这里了，我们不用急着把每个概念都弄明白。" : explanation;
      startReply(turn,response,() => richResult(turn,kind));
      window.dispatchEvent(new CustomEvent("companion-demo-mood",{ detail:"happy" }));
    },1100);
  }
  function cancelTurn() {
    state.epoch++; timers.forEach(clearTimeout); timers.clear(); clearTimeout(replyTimer);
    if (state.turn) {
      state.turn.state = "stopped"; state.turn.text ||= "这一次停在这里。";
      state.turn.blocks.filter((block) => block.type === "tool" && block.state === "running").forEach((block) => { block.state = "cancelled"; block.steps.forEach((step) => { if (step.state === "running") step.state = "cancelled"; }); });
    }
    state.phase = "idle"; state.turn = null; closeReply(false); renderExtras(); sync();
  }
  function hideVoice(restore = true) {
    state.voiceVersion++;
    state.voice = "closed"; $("voice-bubble").hidden = true; $("voice-bubble").dataset.phase = "closed";
    if (restore && state.voiceRestore && !recordMode()) setUserOpen(true,true);
    else if (restore) (recordMode() ? $("message-input") : $("voice-button")).focus({ preventScroll:true });
    sync();
  }
  function startVoice() {
    if (busy()) return;
    state.quiet = false; $("quiet-toggle").checked = false;
    if (state.voice === "closed") state.voiceRestore = !$("input-bubble").hidden;
    if (state.voiceResume) { state.voiceResume = false; setUserOpen(false); showVoicePreview($("voice-transcript").value); return; }
    setUserOpen(false); state.voice = "recording"; state.voiceVersion++;
    $("voice-bubble").hidden = false; $("voice-bubble").dataset.phase = "recording";
    $("voice-live").hidden = false; $("voice-title").textContent = "在听你说…";
    $("voice-note").textContent = "演示 · 麦克风未开启";
    $("voice-transcript").hidden = true; $("voice-transcript").value = "";
    $("voice-finish").hidden = false; $("voice-finish").disabled = false; $("voice-again").hidden = true; $("voice-send").hidden = true;
    sync(); pop($("voice-bubble")); revealInDock($("voice-bubble")); $("voice-finish").focus({ preventScroll:true });
  }
  function finishVoice() {
    if (state.voice !== "recording") return;
    state.voice = "transcribing"; $("voice-bubble").dataset.phase = state.voice;
    const version = state.voiceVersion;
    $("voice-title").textContent = "正在转成文字…"; $("voice-finish").disabled = true;
    later(() => {
      if (state.voice !== "transcribing" || version !== state.voiceVersion) return;
      showVoicePreview("我还是分不清 Query 和 Key，能再用书架举个例子吗？");
    },800);
  }
  function showVoicePreview(text) {
    state.voice = "preview"; $("voice-bubble").hidden = false; $("voice-bubble").dataset.phase = state.voice; $("voice-live").hidden = true;
    $("voice-transcript").hidden = false; $("voice-transcript").value = text;
    $("voice-note").textContent = "示例转写 · 可修改后发送";
    $("voice-finish").hidden = true; $("voice-again").hidden = false; $("voice-send").hidden = false;
    $("voice-send").disabled = !text.trim(); sync(); pop($("voice-bubble")); revealInDock($("voice-bubble")); $("voice-transcript").focus({ preventScroll:true });
  }
  function resetScene(kind) {
    lifetime.clear(); state.voiceResume = false; state.sideOpen = false; state.activeExtra = null;
    state.sceneEpoch++; auxiliaryTimers.forEach(clearTimeout); auxiliaryTimers.clear();
    cancelTurn(); state.messages = []; state.scene = kind; state.search = ""; state.filter = "all"; state.quiet = kind === "quiet"; state.replyPaused = false;
    root.dataset.scene = kind; $("quiet-toggle").checked = state.quiet; setSearch(false);
    setMore(false,false); hideVoice(false); setJournal(false); setDraft(""); setQuoted(false); closeReply(false);
    document.querySelectorAll("[data-scene]").forEach((button) => button.setAttribute("aria-pressed",String(button.dataset.scene === kind)));
    document.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-pressed",String(button.dataset.filter === "all")));
    $("seat-state").textContent = state.quiet ? "安静陪读" : "陪你读这一篇";
    $("demo-hint").textContent = state.quiet ? "伴星仍在；安静陪读收起主动气泡，保留小图标。" : "工具在回复上方；附页放在身侧。待确认保留，其余自动收起，手记里仍能找到。";
    renderExtras(); $("light-dock").scrollTop = 0; setUserOpen(!state.quiet);
    if (kind === "voice") { startVoice(); return; }
    const prompts = { complete:"请引用这段原文，查阅笔记，给我一张图，再准备一张需要我确认的学习卡。",references:"请引用这段原文解释 Query 和 Key。",tools:"帮我查查笔记里 Query、Key 和 Value 的关系。",proposal:"把这段理解整理成学习卡，我确认以后再收下。",image:"给我看一张 Query、Key 与 Value 的示意图。",long:"详细说说 Query、Key 和 Value，各举个例子。",error:"帮我查阅这段笔记。","image-error":"给我看一张示意图。",more:"给我过程图、练习卡和相关笔记入口。" };
    if (prompts[kind]) { setQuoted(["complete","references"].includes(kind)); send(prompts[kind],{ kind }); }
  }
  function choose(block,accepted) {
    if (!block || block.state !== "pending") return;
    if (!accepted) { block.state = "rejected"; block.label = "学习卡 · 已拒绝"; renderExtras(); return; }
    block.state = "confirming"; block.label = "学习卡 · 正在确认"; renderExtras();
    auxiliaryLater(() => {
      block.state = "accepted"; block.label = "学习卡 · 已确认"; renderExtras();
      const el = $(`${recordMode() ? "record" : "light"}-${block.id}`);
      animate(el,[{ transform:"scale(.86)" },{ transform:"scale(1.08)",offset:.6 },{ transform:"none" }],480);
      receipt("演示确认完成 · 没有写入真实学习卡");
    },700);
  }
  function goToSource() {
    setJournal(false);
    const source = $("source-text"), list = $("note-scroll"), a = source.getBoundingClientRect(), b = list.getBoundingClientRect();
    list.scrollTop += a.top-b.top-15; source.dataset.highlight = "true";
    source.setAttribute("tabindex","-1"); source.focus({ preventScroll:true });
    later(() => { source.dataset.highlight = "false"; },2500);
  }
  function touch() {
    if (busy()) return;
    state.quiet = false; $("quiet-toggle").checked = false;
    const turn = message("assistant"); startReply(turn,"我在这里呀。读到哪里了，随时叫我。" );
    animate($("character"),[{ transform:"none" },{ transform:"translateY(-24px) rotate(-3deg) scale(1.08)",offset:.4 },{ transform:"translateY(5px) scale(.97)",offset:.75 },{ transform:"none" }],560);
    $("burst").replaceChildren();
    if (root.dataset.motion === "full") {
      for (let i=0;i<5;i++) { const star = document.createElement("span"); star.className = "companion-seat__spark"; star.innerHTML = icon("sparkles"); $("burst").append(star); const x = (i-2)*40;
        animate(star,[{ opacity:0,transform:"translate(0,20px) scale(.5)" },{ opacity:1,transform:`translate(${x}px,-45px) scale(1.15)`,offset:.5 },{ opacity:0,transform:`translate(${x*1.5}px,-85px) scale(.7)` }],950,i*60); }
      later(() => $("burst").replaceChildren(),1400);
    }
    window.dispatchEvent(new CustomEvent("companion-demo-mood",{ detail:"happy" }));
  }
  root.addEventListener("click",(event) => {
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    if (button.dataset.scene) { resetScene(button.dataset.scene); return; }
    if (button.dataset.filter) { state.filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((entry) => entry.setAttribute("aria-pressed",String(entry.dataset.filter === state.filter))); renderMessages(); return; }
    const block = findBlock(button.dataset.block);
    switch (button.dataset.action) {
      case "bubble-chat": { const wasRecord = recordMode(); setJournal(false); setUserOpen(wasRecord || $("input-bubble").hidden,true); break; }
      case "records": setJournal(true,true); scrollToLatest(); break;
      case "close-journal": setJournal(false); break;
      case "close-input": setUserOpen(false); break;
      case "close-reply": closeReply(false); $("turn-status-text").textContent = "小鲸正在回复…"; sync(); break;
      case "more": setMore($("more-panel").dataset.open !== "true"); break;
      case "quote": if (!recordMode()) setUserOpen(true,true); setQuoted(true); break;
      case "unquote": setQuoted(false); break;
      case "source": goToSource(); break;
      case "latest": scrollToLatest(); break;
      case "search": setSearch($("search-row").hidden,true); break;
      case "voice": if (button.id === "voice-again") state.voiceResume = false; if (state.voice === "closed" || button.id === "voice-again") startVoice(); else hideVoice(); break;
      case "finish-voice": finishVoice(); break;
      case "cancel-voice": hideVoice(); break;
      case "send-voice": { const text = $("voice-transcript").value, draft = state.draft; if (state.voice === "preview" && text.trim()) { state.voiceResume = false; send(text,{ voice:true }); setDraft(draft); } break; }
      case "stop": cancelTurn(); receipt("已停止这次回复 · 消息保留在手记里"); break;
      case "touch": touch(); break;
      case "replay": touch(); document.querySelectorAll(".companion-hud__action").forEach((el,index) => animate(el,[{ transform:"translateY(26px) scale(.65)" },{ transform:"translateY(-8px) scale(1.14)",offset:.65 },{ transform:"none" }],460,index*90)); break;
      case "dismiss-extra": if (block) { block.dismissed = true; renderExtras(); $("talk-button").focus({ preventScroll:true }); } break;
      case "open-extras": state.sideOpen = true; sync(); $("light-extras").focus({ preventScroll:true }); break;
      case "back-note": state.sideOpen = false; sync(); $("note-scroll").focus({ preventScroll:true }); break;
      case "jump-extra": if (block) { state.sideOpen = true; state.activeExtra = block.id; sync(); const el = $(`light-${block.id}`); if (el) { revealInDock(el); el.setAttribute("tabindex","-1"); el.focus({ preventScroll:true }); lifetime.activity(block.id); } } break;
      case "confirm": choose(block,true); break;
      case "decline": choose(block,false); break;
      case "retry": { const failed = state.messages.find((entry) => entry.id === button.dataset.message); const own = state.messages.find((entry) => entry.id === failed?.userId); if (own) send(own.text,{ retry:own.id,kind:"tools" }); break; }
      case "retry-tool": if (block) { block.state = "running"; block.steps.forEach((step) => { step.state = "running"; }); renderExtras(); auxiliaryLater(() => { block.state = "done"; block.steps.forEach((step) => { step.state = "done"; }); renderExtras(); },1000); } break;
      case "retry-image": if (block) imageLoad(block,true); break;
      case "open-image": imageReturnFocus = button; $("image-viewer").showModal(); break;
      case "close-image": $("image-viewer").close(); break;
      case "starter": setDraft("我还是分不清 Query 和 Key"); (recordMode() ? $("message-input") : $("bubble-input")).focus({ preventScroll:true }); break;
      case "copy": { const entry = state.messages.find((item) => item.id === button.dataset.message); if (entry) navigator.clipboard.writeText(entry.text).then(() => receipt("已复制消息文字"),() => receipt("本机预览无法使用剪贴板，请选择文字复制")); break; }
    }
  });
  for (const id of ["message-input","bubble-input"]) {
    $(id).addEventListener("input",() => setDraft($(id).value));
    $(id).addEventListener("keydown",(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(state.draft); } });
  }
  for (const id of ["composer","bubble-composer"]) $(id).addEventListener("submit",(event) => { event.preventDefault(); send(state.draft); });
  $("voice-transcript").addEventListener("input",() => { $("voice-send").disabled = !$("voice-transcript").value.trim(); });
  $("image-viewer").addEventListener("close",() => { if (imageReturnFocus?.isConnected) imageReturnFocus.focus({ preventScroll:true }); });
  $("search-input").addEventListener("input",() => { state.search = $("search-input").value; renderMessages(); });
  $("message-list").addEventListener("scroll",updateLatest);
  root.addEventListener("pointerdown",(event) => { pointerPosition = { x:event.clientX,y:event.clientY }; });
  root.addEventListener("pointermove",(event) => {
    const moved = (pointerPosition && (pointerPosition.x !== event.clientX || pointerPosition.y !== event.clientY)) || event.movementX || event.movementY;
    pointerPosition = { x:event.clientX,y:event.clientY };
    if (moved) paperActivity(event);
    if (!moved || $("reply-bubble").hidden) return;
    state.pointerReading = $("reply-bubble").contains(event.target);
    replyPause(state.pointerReading || $("reply-bubble").contains(document.activeElement));
  },{ passive:true });
  function paperActivity(event) {
    const paper = event.target.closest("#input-bubble,#voice-bubble,#reply-bubble,.companion-extra");
    if (!paper || paper.closest("#message-list")) return;
    const id = paper.dataset.blockId || ({ "input-bubble":"input","voice-bubble":"voice","reply-bubble":"reply" })[paper.id];
    lifetime.activity(id);
  }
  for (const event of ["pointerdown","wheel","keydown","input","focusin"]) root.addEventListener(event,paperActivity,{ passive:event === "wheel" });
  $("reply-bubble").addEventListener("pointerleave",() => { state.pointerReading = false; replyPause($("reply-bubble").contains(document.activeElement)); });
  $("reply-body").addEventListener("wheel",() => { state.pointerReading = true; replyPause(true); },{ passive:true });
  $("reply-bubble").addEventListener("focusin",() => replyPause(true));
  $("reply-bubble").addEventListener("focusout",(event) => { if (!$("reply-bubble").contains(event.relatedTarget)) replyPause(state.pointerReading); });
  $("quiet-toggle").addEventListener("change",() => { state.quiet = $("quiet-toggle").checked; if (state.quiet) { setUserOpen(false); closeReply(false); hideVoice(false); } $("light-extras").hidden = state.quiet; $("extras-nav").hidden = state.quiet || !blocks().some((block) => !block.dismissed); $("seat-state").textContent = state.quiet ? "安静陪读" : "陪你读这一篇"; sync(); });
  $("character-size").addEventListener("input",() => window.dispatchEvent(new CustomEvent("companion-demo-size",{ detail:Number($("character-size").value)/100 })));
  $("seat-side").addEventListener("change",() => { root.dataset.seat = $("seat-side").value; sync(); });
  $("motion").addEventListener("change",setMotion); reduced.addEventListener("change",setMotion);
  document.addEventListener("visibilitychange",() => lifetime.setHidden(document.hidden));
  compactDesk.addEventListener("change",sync);
  window.addEventListener("pagehide",() => lifetime.clear(),{ once:true });
  document.addEventListener("keydown",(event) => {
    if (event.key !== "Escape" || $("image-viewer").open) return;
    if ($("more-panel").dataset.open === "true") setMore(false);
    else if (state.voice !== "closed") hideVoice();
    else if (!$("search-row").hidden) setSearch(false,true);
    else if (recordMode()) setJournal(false);
    else if (!$("input-bubble").hidden) setUserOpen(false);
    else closeReply(false);
  });
  new ResizeObserver(sync).observe($("journal").querySelector(".companion-history__compose-area"));
  const bubbleBudget = new ResizeObserver(fitBubbles); bubbleBudget.observe($("light-slot")); bubbleBudget.observe($("character"));
  bubbleBudget.observe($("tool-extras"));
  lifetime.setHidden(document.hidden); setMotion(); resetScene("chat");
})();
