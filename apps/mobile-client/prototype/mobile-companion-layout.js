/* Complete frontend journey. All business facts belong to the local demo store. */
(() => {
  const { Store, clone, id, paragraph } = window.MOBILE_DEMO_DATA;
  const { Motion, reconcile, localRect, panelPlacement, frames, clamp } = window.MOBILE_DEMO_MOTION;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const extras = {
    eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' }], ['circle', { cx:12, cy:12, r:3 }]],
    'eye-off': [['path', { d: 'm3 3 18 18M10.5 5.1A12 12 0 0 1 22 12a18 18 0 0 1-4 4.5M14 18.8C6.5 20 2 12 2 12a18 18 0 0 1 4-4.5M10 10a3 3 0 0 0 4 4' }]],
    pencil: [['path', { d: 'm15 4 5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16l-1 4Z' }]],
    'log-out': [['path', { d: 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4' }]],
    menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'm16 16 5 5' }]],
    mic: [['rect', { x: 9, y: 2, width: 6, height: 12, rx: 3 }], ['path', { d: 'M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' }]],
    send: [['path', { d: 'm21 3-6.5 18-4-7.5L3 9.5 21 3ZM10.5 13.5 21 3' }]],
    play: [['path', { d: 'm8 5 11 7-11 7V5Z' }]],
    pause: [['path', { d: 'M9 5v14M15 5v14' }]],
    signal: [['path', { d: 'M4 20v-3M9 20v-7M14 20V9M19 20V4' }]],
    wifi: [['path', { d: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01' }]],
    offline: [['path', { d: 'm3 3 18 18M2 8a16 16 0 0 1 5-3M13 4a16 16 0 0 1 9 4M5 12a11 11 0 0 1 5-2M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01' }]],
    headphone: [['path', { d: 'M4 15v-3a8 8 0 0 1 16 0v3' }], ['rect', { x: 2, y: 14, width: 5, height: 7, rx: 2 }], ['rect', { x: 17, y: 14, width: 5, height: 7, rx: 2 }]],
    image: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 9, cy: 10, r: 1.6 }], ['path', { d: 'm4 18 5-5 4 4 3-2 4 4' }]],
    camera: [['rect', { x: 3, y: 6, width: 18, height: 14, rx: 2 }], ['path', { d: 'M8 6l2-3h4l2 3' }], ['circle', { cx: 12, cy: 13, r: 4 }]],
    monitor: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M9 20h6M12 16v4' }]],
    folder: [['path', { d: 'M3 7h6l2-3h8a2 2 0 0 1 2 2v13H3V7Z' }]],
    lock: [['rect', { x: 4, y: 10, width: 16, height: 11, rx: 3 }], ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]],
    shield: [['path', { d: 'M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3Z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
    download: [['path', { d: 'M12 3v12m0 0 4-4m-4 4-4-4' }], ['path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }]],
  };
  function icon(name) {
    const nodes = window.NOTEBOOK_ICONS[name] || extras[name] || window.NOTEBOOK_ICONS['file-text'];
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}></${tag}>`).join('')}</svg>`;
  }
  const portrait = '<span class="portrait"><img src="mobile-companion-character.png" alt="蓝发伴星的完整半身形象"></span>';
  const blockText = block => block.type === 'table' ? block.rows.map(row => row.join('：')).join('；') : block.text;
  const noteText = note => note.blocks.map(blockText).join('\n\n');
  const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const dateOf = value => new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  const spaceName = space => space === 'home' ? '我的书房' : '共读书房';
  const sheetRow = (action, ico, title, subtitle = '', attrs = '') => `<button class="sheet-row" data-action="${action}" ${attrs}>${icon(ico)}<span>${esc(title)}${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</span>${icon('chevron-right')}</button>`;
  const SAMPLE = { name: '一张增长曲线', url: 'mobile-companion-sample.svg', sample: true };
  const GRAPH_BLOCKS = [paragraph('先读坐标，再看形状', '横轴表示观察次数，纵轴表示数量。图中的四个数据点依次是 10、20、40、70。线向上走，说明数量增加。'), paragraph('比较相邻两次的增加量', '从第 1 次到第 2 次增加 10，从第 2 次到第 3 次增加 20，从第 3 次到第 4 次增加 30。在等间隔观察下，这三个增加量依次变大。'), paragraph('不要只凭“向上”判断', '向上只表示数量增加。要判断增长是否加快，需要比较相同时间间隔内的增加量，还要核对坐标、单位和采样条件。')];
  let storage;
  try { storage = window.localStorage; } catch { storage = null; }
  const accounts = new window.MOBILE_DEMO_ACCOUNT.Accounts(storage, window.sessionStorage);
  const store = new Store(storage, accounts.businessKey, !accounts.user?.sample);
  class MobileApp {
    constructor(root) {
      this.root = root;
      this.centers = new window.MOBILE_DEMO_CENTERS.Centers(this, accounts, store, {esc,icon,row:sheetRow,portrait,spaceName});
      this.ui = { view: { type: 'chat' }, stack: [], space: 'home', drafts: {}, positions: {}, filter: 'notes', query: '', selectedBlock: null, context: null, attachment: null, lastNoteId: 'note-history', comparePane: 'after' };
      try { const saved = JSON.parse(sessionStorage.getItem(this.uiStorageKey) || 'null'); if (saved?.drafts) Object.assign(this.ui, saved); delete this.ui.conversationId; if (!['notes','images'].includes(this.ui.filter)) this.ui.filter = 'notes'; } catch { /* optional session memory */ }
      if (['reader','compare','archive'].includes(this.ui.view.type) && !this.routeReadable) this.ui.view = { type: 'chat' };
      if (!accounts.user) { this.ui.view = {type:'login'}; this.ui.stack=[]; this.ui.positions[this.key]=0; }
      else if (['login','register'].includes(this.ui.view.type)) this.ui.view = {type:'chat'};
      this.sheet = null; this.offline = false; this.keyboard = false; this.jobs = new Map(); this.player = null; this.audioToken = 0; this.mirrorId = this.ui.lastNoteId; this.pending = null; this.followConversation = true; this.newContent = false;
      if (this.ui.view.type === 'chat' && this.ui.positions[this.key] === undefined) this.nextScroll = 'bottom';
      this.panelStack = []; this.motion = new Motion(root); this.routeSnapshots = new Map();
      root.innerHTML = '<div class="app-surface"></div><div class="modal-host" hidden><div class="scrim" data-action="dismiss-panels" aria-hidden="true"></div><section class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title"></section></div><input id="image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="选择本机图片"><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="选择账户头像"><input id="camera-file" type="file" accept="image/*" capture="environment" hidden aria-label="拍摄图片">';
      this.surface = root.querySelector('.app-surface'); this.panelHost = root.querySelector('.modal-host'); this.panelBox = root.querySelector('.sheet');
      this.scene = new window.MOBILE_DEMO_SCENE.Scene(this, accounts, store, {esc,icon});
      this.applyAccountPreferences();
      this.updateSizeClasses();
      this.render(); this.renderMirror(); this.bind();
      this.resizeObserver = new ResizeObserver(() => { if (this.updateSizeClasses()) this.render(); });
      this.resizeObserver.observe(root);
      store.subscribe(() => { this.scene.observe(); this.render(); this.renderMirror(); });
      window.addEventListener('pagehide', () => { this.scene.dispose(); this.stopAudio(false); this.saveUI(); });
      document.addEventListener('visibilitychange', () => { if (document.hidden) { this.scene.suspend(); this.stopAudio(false); } this.scene.sync(); });
    }
    get conversation() { return store.activeConversation(this.ui.space); }
    get key() { return `${this.ui.space}:${this.ui.view.type}:${this.ui.view.id || 'thread'}${this.ui.view.type==='chat' ? ':'+(this.scene?.mode || (accounts.user?.preferences.chatLayout==='history'?'history':'scene')) : ''}`; }
    get routeReadable() { return this.ui.view.type === 'archive' ? store.conversation(this.ui.view.id)?.space === this.ui.space : Boolean(store.note(this.ui.view.id)); }
    get detail() { return ['reader', 'compare', 'image', 'archive', 'history', 'review'].includes(this.ui.view.type) || (this.centers.active && !this.centers.auth); }
    get uiStorageKey() { return `astella-mobile-demo-ui-v4:${accounts.user?.id || 'guest'}`; }
    applyAccountPreferences() { const scale=accounts.user?.preferences.textScale || 1; this.root.style.setProperty('--text-scale',scale); document.querySelector('#text-size').value=String(scale); }
    leaveAccount() {
      this.scene.stop(); this.saveUI();
      for(const timers of this.jobs.values()) timers.forEach(clearTimeout); this.jobs.clear(); this.stopAudio(false);
      for(const task of store.data.tasks) if(task.status==='running'){task.status='paused';task.stage='退出时暂停';}store.commit();
    }
    activateAccount() {
      this.scene.stop(); this.scene.reply=''; this.scene.lastMessage=null;this.scene.textOpen=null;
      this.closeSheet(false); this.stopAudio(false); this.keyboard=false; this.pending=null;this.pendingEdit=null;
      this.motion.finish(); this.routeSnapshots.clear();this.root.querySelectorAll('.route-ghost').forEach(el=>el.remove());this.renderedKey=null;
      store.activate(accounts.businessKey,!accounts.user?.sample);
      if(accounts.user?.sharedAccess && !store.note('note-shared')) { store.data.notes.push(clone(window.MOBILE_DEMO_DATA.seed().notes.find(n=>n.id==='note-shared'))); }
      this.ui={view:{type:accounts.user?'chat':'login'},stack:[],space:'home',drafts:{},positions:{},filter:'notes',query:'',selectedBlock:null,context:null,attachment:null,lastNoteId:accounts.user?.sample?'note-history':null,comparePane:'after'};
      try{const saved=JSON.parse(sessionStorage.getItem(this.uiStorageKey)||'null');if(accounts.user && saved?.drafts){Object.assign(this.ui,saved);this.ui.view={type:'chat'};this.ui.stack=[];}}catch{}
      this.followConversation=true;this.newContent=false;this.nextScroll=accounts.user?'bottom':null;this.mirrorId=this.ui.lastNoteId;this.applyAccountPreferences();store.commit();this.render();this.renderMirror();
    }
    resumeFromCenter() { this.tab('chat');this.nextScroll='bottom';this.followConversation=true;this.render(); }
    get draftKey() { return this.sheet?.type === 'ask' ? `ask:${this.sheet.context.noteId || this.sheet.context.assetId}` : `chat:${this.ui.space}`; }
    get activeTask() { return store.data.tasks.find(t => t.status === 'running' && t.space === this.ui.space && t.conversationId === this.conversation.id); }
    get visibleNotes() { return store.data.notes.filter(n => n.space === this.ui.space).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
    saveUI() { try { sessionStorage.setItem(this.uiStorageKey, JSON.stringify(this.ui)); } catch { /* files may exceed session quota */ } }
    captureScroll() {
      const page = this.root.querySelector('.page-scroll');
      if (page) this.ui.positions[page.dataset.viewKey] = page.scrollTop;
    }
    render() {
      this.captureScroll();
      const active = document.activeElement;
      const focusId = this.root.contains(active) ? active?.id : null;
      // A keyed node that survives the patch can still be moved, and a move blurs it,
      // so identity — not just the id attribute — has to carry focus across a render.
      const sameNode = !focusId && active?.isConnected && this.root.contains(active) ? active : null;
      const selection = active?.selectionStart;
      const selectionEnd = active?.selectionEnd;
      const selectionDirection = active?.selectionDirection;
      const oldKey = this.renderedKey;
      const routeChanged = oldKey && oldKey !== this.key;
      const oldPage = this.surface.querySelector('.page-scroll');
      const oldRect = oldPage?.getBoundingClientRect();
      const oldCurrent = oldPage && this.motion.capture(oldPage);
      if (oldPage) oldPage.style.transform='';
      const oldSegments = new Map([...this.surface.querySelectorAll('.segmented-indicator')].map(el=>[el.dataset.nodeKey,el.getBoundingClientRect()]));
      const oldIndicator = this.surface.querySelector('.tab-indicator');
      const indicatorRect = oldIndicator?.getBoundingClientRect();
      if (oldIndicator) this.motion.capture(oldIndicator);
      this.surface.querySelectorAll('.segmented-indicator').forEach(el=>this.motion.cancel(el));
      const previousMessages = new Set([...this.root.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId));
      let outgoing;
      if (routeChanged && oldPage) {
        this.routeSnapshots.set(oldKey, {node:oldPage.cloneNode(true),scroll:oldPage.scrollTop});
        if(this.routeSnapshots.size>12)this.routeSnapshots.delete(this.routeSnapshots.keys().next().value);
        outgoing = this.visualClone(oldPage, 'route-ghost');
        outgoing.style.cssText = `position:absolute;left:0;top:0;width:${oldRect.width}px;height:${oldRect.height}px;`;
        outgoing.scrollTop = oldPage.scrollTop;
      }
      const type = this.ui.view.type;
      this.root.dataset.detail = String(this.detail); this.root.dataset.screen = type;this.root.dataset.utility=String(this.centers.active);
      this.root.dataset.dialogue=this.scene.mode;
      this.root.classList.toggle('meeting', false);
      this.root.classList.toggle('keyboard-on', this.keyboard);
      // A fixed 244px band leaves only ~146px of reading window on a 640px phone.
      this.root.style.setProperty('--keyboard', this.keyboard ? `${Math.round(clamp(this.root.clientHeight * .32, 200, 244))}px` : '0px');
      const task = this.activeTask;
      const state = this.player ? (this.player.paused ? '暂停了' : '陪你听') : task ? ({ image: '在读图', create: '在整理', edit: '在修改', voice: '在记录' }[task.kind] || '在看') : this.detail ? '陪你读' : '我在';
      reconcile(this.surface, `<div class="status-bar" data-node-key="status" aria-hidden="true"><span>9:41</span><span class="status-icons">${icon('signal')}${icon('wifi')}<i class="battery"></i></span></div>
        ${this.centers.active ? this.centers.header() : `<header class="topbar" data-node-key="header"><button class="icon-button glass top-left" data-action="${this.detail ? 'back' : 'menu'}" aria-label="${this.detail ? '返回上一页' : '打开菜单'}">${icon(this.detail ? 'arrow-left' : 'menu')}</button>
        ${type==='chat' ? this.scene.modeMarkup() : `<button class="identity ${task ? 'busy' : ''}" data-action="companion" aria-label="进入伴星中心">${portrait}<span class="identity-copy glass"><strong>${esc(accounts.user?.companion.name || '伴星')}</strong><i></i><span>${state}</span></span></button>`}
        <button class="space-button glass" data-action="spaces">${spaceName(this.ui.space)}${icon('chevron-down')}</button></header>`}
        ${this.offline ? `<div class="network-banner" role="status">${icon('offline')}暂时离线 · 已有内容可读，草稿会保留</div>` : ''}
        <div class="viewport" data-node-key="viewport"><section class="page-scroll ${this.centers.active ? 'utility-scroll' : this.detail ? 'reader-scroll' : type==='chat' && this.scene.mode==='scene' ? 'scene-scroll' : ''}" data-node-key="page" data-view-key="${esc(this.key)}" aria-label="${({ chat: '当前对话', notes: '手记内容', stuff: '手边事项', reader: '笔记正文', compare: '修改对照', image: '图片详情', archive: '以前的交流', history: '版本与来处', review: '回想这一篇' })[type] || window.MOBILE_DEMO_CENTERS.TITLES[type]}">${this.body()}</section>${type === 'chat' && this.scene.mode==='history' && this.newContent ? '<button class="new-content glass" data-action="jump-latest">有新内容 · 回到最新</button>' : ''}</div>
        <div class="bottom-area" data-node-key="bottom">${this.footer()}<div class="home-indicator" aria-hidden="true"><span></span></div></div>${this.keyboard ? this.keyboardMarkup() : ''}`);
      this.surface.inert = !!this.sheet;
      const page = this.surface.querySelector('.page-scroll');
      page.scrollTop = this.nextScroll === 'bottom' ? page.scrollHeight : this.ui.positions[this.key] || 0; this.nextScroll = null;
      page.classList.toggle('content-cut', page.scrollTop > 8);
      this.renderPanel();
      const keepFocus = focusId ? this.root.querySelector(`#${focusId}`) : sameNode;
      if (keepFocus && !keepFocus.closest('[inert]')) {
        keepFocus.focus({ preventScroll: true });
        if (typeof selection === 'number' && keepFocus.setSelectionRange) keepFocus.setSelectionRange(selection, selectionEnd, selectionDirection);
      }
      this.root.querySelectorAll('.composer textarea').forEach(el => this.grow(el));
      if (this.centers.active && document.activeElement?.matches('input,textarea,select') && document.activeElement.closest('.page-scroll') === page) {
        const field=document.activeElement.getBoundingClientRect(), bounds=page.getBoundingClientRect();
        if(field.bottom>bounds.bottom-8)page.scrollTop+=field.bottom-bounds.bottom+8;
        else if(field.top<bounds.top+8)page.scrollTop-=bounds.top+8-field.top;
      }
      if (type === 'chat' && this.scene.mode==='history' && this.followConversation) page.scrollTop = page.scrollHeight;
      const indicator = this.surface.querySelector('.tab-indicator');
      if (indicator && indicatorRect && !this.motion.off) {
        const final = indicator.getBoundingClientRect();
        const delta = indicatorRect.left - final.left;
        if (Math.abs(delta) > 1) this.motion.play(indicator, frames(p => ({ transform: `translateX(${delta*(1-p)}px) scaleX(${1+.12*Math.sin(Math.PI*clamp(p,0,1))})` })), { duration: 470 });
      }
      this.surface.querySelectorAll('.segmented-indicator').forEach(el=>{const previous=oldSegments.get(el.dataset.nodeKey);if(!previous)return;const next=el.getBoundingClientRect();if(Math.abs(previous.left-next.left)>1)this.motion.play(el,frames(p=>({transform:`translateX(${(previous.left-next.left)*(1-p)}px)`})),{duration:380});});
      if (routeChanged && outgoing) {
        this.root.querySelectorAll('.route-ghost').forEach(el => el.remove());
        const viewport = this.surface.querySelector('.viewport'); viewport.append(outgoing);
        const transition = this.routeTransition || { kind: 'push', direction: 1 };
        if (transition.kind !== 'back') viewport.insertBefore(outgoing, page);
        const direction = transition.direction || 1;
        const width = viewport.clientWidth;
        const entering = transition.kind === 'back' ? -width*.24 : transition.kind === 'tab' ? direction*width*.16 : width;
        this.motion.play(page, frames(p => ({ transform: `translateX(${entering*(1-p)}px)`, opacity: transition.kind === 'tab' ? .4+.6*clamp(p,0,1) : 1 })), { duration: transition.kind === 'tab' ? 360 : 470 });
        const matrix = new DOMMatrix(oldCurrent.transform === 'none' ? undefined : oldCurrent.transform);
        const exiting = transition.kind === 'back' ? width : transition.kind === 'tab' ? -direction*width*.16 : -width*.24;
        this.motion.play(outgoing, frames((p, t) => ({ transform: `translateX(${matrix.e+(exiting-matrix.e)*p}px)`, opacity: transition.kind === 'back' ? 1 : 1-clamp(t*3,0,1) })), { duration: transition.kind === 'tab' ? 360 : 470, done: () => outgoing.remove() });
      } else if (oldCurrent && this.motion.running.has(page) === false && oldCurrent.transform !== 'none') this.motion.settle(page, oldCurrent);
      if (oldKey) this.root.querySelectorAll('[data-message-id]').forEach(el => {
        if (!previousMessages.has(el.dataset.messageId)) this.motion.play(el, frames(p => ({ transform: `translateY(${18*(1-p)}px) scale(${.96+.04*p})`, opacity: clamp(p,0,1) })), { duration: 420 });
      });
      if (routeChanged && this.detail) { const heading=page.querySelector('h1'); if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});} }
      this.routeTransition = null; this.renderedKey = this.key;
      this.scene.sync(); this.syncControls(); this.saveUI();
      document.querySelector('#metrics').textContent = `${Math.round(this.root.getBoundingClientRect().width)} × ${Math.round(this.root.getBoundingClientRect().height)}`;
    }
    visualClone(node, className) {
      const copy = node.cloneNode(true); copy.classList.add(className); copy.inert = true; copy.setAttribute('aria-hidden', 'true');
      copy.removeAttribute('id'); copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      copy.querySelectorAll('label[for]').forEach(el => el.removeAttribute('for'));
      copy.querySelectorAll('[data-action],[data-message-id]').forEach(el => { el.removeAttribute('data-action'); el.removeAttribute('data-message-id'); });
      copy.removeAttribute('data-node-key'); copy.querySelectorAll('[data-node-key]').forEach(el => el.removeAttribute('data-node-key'));
      copy.dataset.ghost = className;
      if (className === 'route-ghost') copy.classList.remove('page-scroll');
      return copy;
    }
    triggerRect(button = this.trigger) {
      const root = this.root.getBoundingClientRect();
      if (button?.isConnected) return localRect(button.getBoundingClientRect(), root);
      return this.lastTriggerRect || { x: root.width/2-22, y: root.height-80, width: 44, height: 44 };
    }
    renderPanel() {
      const host = this.panelHost, box = this.panelBox;
      if (!this.sheet) {
        if (!this.renderedPanel) return;
        const old = this.renderedPanel; this.renderedPanel = null;
        box.inert = true; host.style.pointerEvents = 'none';
        this.motion.play(host.querySelector('.scrim'), [{opacity:1}, {opacity:0}], {duration:260});
        this.motion.dismiss(box, old.origin, this.panelLayout, () => { if (!this.sheet) { host.hidden = true; box.style.transform=''; box.replaceChildren(); } });
        return;
      }
      const panel = this.sheet;
      panel.uid ||= id('panel'); panel.origin ||= this.triggerRect();
      const changed = this.renderedPanel?.uid !== panel.uid;
      const wasHidden = host.hidden;
      const oldVisualRect = !wasHidden ? localRect(box.getBoundingClientRect(), this.root.getBoundingClientRect()) : null;
      const current = !wasHidden && this.motion.capture(box);
      box.style.transform='';
      box.querySelectorAll(':scope > .panel-page-ghost').forEach(el => el.remove());
      const previousPage = changed && box.firstElementChild ? this.visualClone(box.firstElementChild, 'panel-page-ghost') : null;
      const oldScroll = changed ? panel.scroll || 0 : box.querySelector('.sheet-content')?.scrollTop || 0;
      host.hidden = false; host.style.pointerEvents = ''; box.inert = false;
      box.dataset.panel = panel.type; box.dataset.depth = this.panelStack.length;
      box.className = `sheet ${['menu','spaces','attach'].includes(panel.type) ? 'glass' : 'paper-panel'} ${panel.type === 'ask' ? 'ask-sheet' : ''}`;
      reconcile(box, this.sheetMarkup());
      const size = {width:this.root.clientWidth, height:this.root.clientHeight};
      const width = panelPlacement(panel.type, panel.origin, size, 200).width;
      box.style.width = `${width}px`; box.style.height = ''; box.style.maxHeight = `${size.height-76}px`;
      const height = Math.min(box.scrollHeight, panel.type === 'ask' ? size.height*.76 : size.height-76);
      const layout = panelPlacement(panel.type, panel.origin, size, height);
      box.style.left = `${layout.x}px`; box.style.top = `${layout.y}px`; box.style.height = `${layout.height}px`;
      const content = box.querySelector('.sheet-content');
      if (content) content.scrollTop = this.sheetToBottom ? content.scrollHeight : oldScroll; this.sheetToBottom = false;
      if (changed) {
        box.dataset.origin = `${Math.round(panel.origin.x)},${Math.round(panel.origin.y)}`;
        // A child grows from the selected row. Returning retraces the existing container.
        const from = this.panelDirection === 'back' && oldVisualRect ? oldVisualRect : wasHidden ? panel.origin : this.panelDirection === 'push' ? panel.origin : oldVisualRect || panel.origin;
        this.motion.rect(box, from, layout, {opacity: wasHidden ? .12 : .7, duration:460});
        if (previousPage) {
          previousPage.style.cssText = 'position:absolute;inset:0;pointer-events:none;'; box.append(previousPage);
          const direction = this.panelDirection === 'back' ? -1 : 1;
          this.motion.play(previousPage, frames(p => ({transform:`translateX(${-direction*70*p}px)`, opacity:1-clamp(p*1.4,0,1)})), {duration:340, done:()=>previousPage.remove()});
        }
        const page = box.querySelector('.sheet-page');
        this.motion.play(page, frames(p => ({transform:`translateX(${(this.panelDirection === 'back' ? -28 : 28)*(1-p)}px)`, opacity:clamp(p*1.3,0,1)})), {duration:360});
        this.motion.play(host.querySelector('.scrim'), [{opacity: wasHidden ? 0 : 1}, {opacity:1}], {duration:240});
      } else if (oldVisualRect && (Math.abs(oldVisualRect.height-layout.height)>2 || Math.abs(oldVisualRect.y-layout.y)>2)) this.motion.rect(box, oldVisualRect, layout, {opacity:1,duration:360});
      else if (current && current.transform !== 'none') this.motion.settle(box, current);
      this.renderedPanel = {uid:panel.uid, origin:panel.origin}; this.panelLayout = layout; this.panelDirection = null;
    }
    body() {
      if(this.centers.active)return this.centers.body();
      switch (this.ui.view.type) {
        case 'notes': return this.notesBody();
        case 'stuff': return this.stuffBody();
        case 'reader': return this.readerBody();
        case 'compare': return this.compareBody();
        case 'image': return this.imageBody();
        case 'archive': return this.archiveBody();
        case 'history': return this.historyBody();
        case 'review': return this.reviewBody();
        default: return this.scene.mode==='scene' ? this.scene.body() : this.chatBody();
      }
    }
    chatBody() {
      const messages = this.conversation.messages;
      // Older threads sit above the live one: scrolling up reads as going back in time.
      const earlier = store.data.conversations.filter(c => c.space === this.ui.space && c.status === 'archived' && c.messages.length)
        .map(c => `<button class="continue-line" data-action="open-conversation" data-id="${esc(c.id)}">${icon('history')}<span><small>更早的交流 · 只读</small><strong>${esc(c.title)}</strong></span>${icon('chevron-right')}</button>`).join('');
      const consent = !store.data.consent ? '<div class="state-note"><strong>书房可以先读。</strong>发送前需要你同意 AI 读取材料与执行操作。<button data-action="consent-info">查看说明</button></div>' : '';
      const readonly = this.ui.space === 'shared' ? '<div class="state-note">这是只读空间。你可以阅读、问知识；新增和修改笔记需要作者权限。</div>' : '';
      if (!messages.length) return `${earlier}${consent}${readonly}<div class="welcome"><h1>今天想弄懂什么？</h1><p>拍下一页，或说一句想法。<br>想留下时，再叫我整理成笔记。</p><div class="welcome-actions"><button data-action="sample-image">${icon('image')}递一张示例图片</button><button data-action="voice">${icon('mic')}记一句想法</button></div><p class="welcome-hint">你已有的笔记，在下面的“手记”里。</p></div>`;
      const currentMessage = [...messages].reverse().find(m => m.noteId || m.assetId);
      const currentNote = store.note(currentMessage?.noteId);
      const currentAsset = store.data.assets.find(a => a.id === currentMessage?.assetId);
      const currentObject = currentNote || currentAsset;
      const editPrompt = currentNote?.blocks.length === 1 ? '把第一段改成表格' : '把第二段改成表格';
      return `${earlier}${consent}${readonly}${currentObject ? `<button class="continue-line" data-action="${currentNote ? 'open-note' : 'open-image'}" data-id="${esc(currentObject.id)}">${icon(currentNote ? 'book-open' : 'image')}<span><small>这次交流的${currentNote ? '笔记' : '图片'}</small><strong>${esc(currentNote?.title || currentAsset.name)}</strong></span>${icon('chevron-right')}</button>` : ''}
        <p class="date-line">同一份交流 · 手机与桌面</p>${messages.map(m => this.messageMarkup(m)).join('')}
        <div class="thread-quick"><button data-action="prompt" data-text="整理成一篇笔记">整理成笔记</button><button data-action="prompt" data-text="${editPrompt}">${editPrompt.slice(1)}</button><button data-action="sample-image">递示例图片</button></div>`;
    }
    messageMarkup(message) {
      const assetReference = store.data.assets.find(a => a.id === message.assetReferenceId);
      const quote = message.quote ? `<div class="message-quote">《${esc(store.note(message.noteId)?.title || '当前材料')}》 · ${esc(message.quote)}</div>` : assetReference ? `<div class="message-quote">围绕图片 · ${esc(assetReference.name)}</div>` : '';
      const asset = store.data.assets.find(a => a.id === message.assetId);
      const task = store.data.tasks.find(t => t.id === message.taskId);
      if (message.role === 'user') return `<article class="message mine" data-message-id="${esc(message.id)}">${quote}<div class="user-bubble">${asset ? `<button class="image-preview" data-action="open-image" data-id="${esc(asset.id)}" aria-label="查看${esc(asset.name)}"><img src="${esc(asset.url)}" alt="${esc(asset.name)}"></button>` : ''}${esc(message.text)}</div>${task && !['succeeded', 'stopped'].includes(task.status) ? this.taskMarkup(task, true) : ''}${task?.status === 'stopped' ? '<p class="status-inline">已停止，未保存新内容。</p>' : ''}</article>`;
      const note = store.note(message.noteId);
      return `<article class="message" data-message-id="${esc(message.id)}"><div class="message-meta"><span>${esc(accounts.user?.companion.name || '伴星')}</span><span>${esc(message.time)}</span>${message.source ? `<span>· ${esc(message.source)}</span>` : ''}</div><p class="assistant-text">${esc(message.text)}</p>${note ? this.delivery(note, message.action) : ''}<div class="message-actions"><button data-action="play-message" data-id="${esc(message.id)}" aria-label="朗读这条回复">${icon('headphone')}听这一段</button>${message.action === 'edit' ? `<button data-action="compare" data-id="${esc(note?.id)}">${icon('list-tree')}看修改对照</button>` : ''}</div></article>`;
    }
    delivery(note, action, nodeKey = '') {
      const label = action === 'edit' ? '已更新 · 原来的笔记' : action === 'create' ? '已保存 · 我的书房' : '查阅的笔记';
      return `<button class="delivery" ${nodeKey ? `data-node-key="${nodeKey}"` : ''} data-action="open-note" data-id="${esc(note.id)}"><span class="delivery-cover">${icon('book-open')}</span><span><small>${label}</small><strong>${esc(note.title)}</strong><em>第 ${note.version} 版 · 保存于 ${time(note.updatedAt)}<i class="artifact-id">${esc(note.id.replace(/^note-/, ''))}</i></em></span>${icon('chevron-right')}</button>`;
    }
    notesBody() {
      const query = this.ui.query.trim().toLowerCase();
      const notes = this.visibleNotes.filter(n => `${n.title}${noteText(n)}`.toLowerCase().includes(query));
      const assets = store.data.assets.filter(a => a.space === this.ui.space && a.name.toLowerCase().includes(query));
      let list;
      if (this.ui.filter === 'images') list = assets.map(a => `<button class="image-list-row" data-action="open-image" data-id="${esc(a.id)}"><img src="${esc(a.url)}" alt=""><span><strong>${esc(a.name)}</strong><small>${a.sample ? '示例图片' : '本机图片'} · ${time(a.createdAt)}</small></span></button>`).join('');
      else list = notes.map(n => `<button class="note-row" data-action="open-note" data-id="${esc(n.id)}"><span class="book-cover ${esc(n.color)}">${icon('book-open')}<small>${esc(n.category)}</small></span><span><strong>${esc(n.title)}</strong><p>${esc(n.subtitle)}</p><small>${esc(n.source)} · 第 ${n.version} 版</small>${this.evidenceMark(n.id)}</span>${icon('chevron-right')}</button>`).join('');
      return `<div class="section-title"><div><h1>手记</h1><p>已经留下的，随时回来读。</p></div><span>${this.visibleNotes.length} 篇笔记</span></div><label class="search">${icon('search')}<input id="note-search" value="${esc(this.ui.query)}" placeholder="找笔记、图片或一句话" aria-label="搜索手记"></label>
        <div class="filters" aria-label="手记类型"><span class="segmented-indicator" data-node-key="filter-indicator" style="--segment: ${['notes','images'].indexOf(this.ui.filter)};--segments:2" aria-hidden="true"></span>${[['notes', '笔记'], ['images', '图片']].map(([key, name]) => `<button data-action="filter" data-filter="${key}" class="${this.ui.filter === key ? 'active' : ''}" aria-pressed="${this.ui.filter === key}">${name}</button>`).join('')}</div><div class="list-label"><span>${spaceName(this.ui.space)}</span><span>${query ? '搜索结果' : '按最近更新'}</span></div>${list || `<div class="empty">${icon(query ? 'search' : 'book-open')}<p>${query ? '没有找到，可以换个词试试。' : '这里还没有内容。\n想留下时，告诉伴星整理成笔记。'}</p></div>`}`;
    }
    stuffBody() {
      const tasks = store.data.tasks.filter(t => t.space === this.ui.space);
      const active = tasks.filter(t => !['succeeded', 'stopped'].includes(t.status));
      const done = tasks.filter(t => t.status === 'succeeded').slice(0, 3);
      const note = store.note(this.ui.lastNoteId);
      const due = store.dueRecalls(this.ui.space);
      const reviews = due.length ? `<div class="list-label"><span>今天想回看的</span><span>${due.length} 篇到期</span></div>` + due.slice(0, 3).map(item => `<button class="review-card level-${item.level || 'none'}" data-action="start-review" data-id="${esc(item.note.id)}"><i aria-hidden="true"></i><span><strong>${esc(item.note.title)}</strong><small>${esc(item.reason)}</small></span>${icon('chevron-right')}</button>`).join('') : '';
      return `<div class="section-title"><div><h1>手边</h1><p>现在交给她的，和准备继续的。</p></div><span>${active.length} 件待处理</span></div>${active.map(t => this.taskMarkup(t)).join('')}${!active.length ? `<div class="empty">${icon('check')}<p>没有等待处理的事。<br>你可以安心读一会儿。</p></div>` : ''}${reviews}${note?.space === this.ui.space ? `<div class="list-label"><span>这台设备最近打开</span></div>${this.delivery(note, 'read', 'recent-read')}` : ''}${done.length ? '<div class="list-label"><span>刚刚完成</span><span>完整过程在对话里</span></div>' + done.map(t => `<button class="continue-line" data-node-key="done-${esc(t.id)}" data-action="${t.receipt ? 'open-note' : 'task-conversation'}" data-id="${esc(t.receipt?.noteId || t.id)}">${icon('check')}<span><strong>${esc(t.title)}</strong><small>${esc(t.stage)}</small></span>${icon('chevron-right')}</button>`).join('') : ''}`;
    }
    taskMarkup(task, compact = false) {
      const error = ['failed', 'conflict', 'unknown', 'paused'].includes(task.status);
      const status = { running: '正在做', failed: '这次没完成', conflict: '需要核对新版', unknown: '等待核对保存', paused: '可以继续', succeeded: '已完成' }[task.status];
      const actions = task.status === 'running' ? `<button data-action="stop-task" data-id="${esc(task.id)}">停止这件事</button>` : task.status === 'unknown' ? `<button data-action="resolve-task" data-id="${esc(task.id)}">核对保存结果</button>` : task.status === 'conflict' ? `<button data-action="open-note" data-id="${esc(task.payload.noteId)}">看最新版</button><button data-action="retry-task" data-id="${esc(task.id)}">按新版重新调整</button>` : `<button data-action="retry-task" data-id="${esc(task.id)}">${task.status === 'paused' ? '继续这件事' : '重试这件事'}</button>`;
      return `<div class="task-card ${error ? 'error' : ''} ${compact ? 'compact-task' : ''}" data-task-id="${esc(task.id)}"><div class="task-top">${error ? icon('circle-help') : '<i></i>'}${status}</div><h3>${esc(task.title)}</h3><p>${esc(task.error || task.stage)}</p><div class="task-actions">${actions}</div></div>`;
    }
    blockMarkup(block, index, { selectable = true } = {}) {
      const selected = this.ui.selectedBlock === block.id;
      return `<section class="note-block ${selected ? 'selected' : ''} ${this.player?.blockId === block.id ? 'playing' : ''}" data-block-id="${esc(block.id)}"><h2>${esc(block.heading || `第 ${index + 1} 段`)}</h2>${selectable ? `<button class="block-tool" data-action="select-block" data-id="${esc(block.id)}" aria-label="引用第 ${index + 1} 段">${icon('message-square-text')}</button>` : ''}${block.type === 'table' ? `<div class="table-wrap"><table><thead><tr>${block.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p>${esc(block.text)}</p>`}</section>`;
    }
    readerBody() {
      const note = store.note(this.ui.view.id);
      if (!note || note.space !== this.ui.space) return '<div class="empty">这篇笔记当前不可读。</div>';
      return `<article class="paper"><div class="paper-meta">${icon(note.space === 'shared' ? 'lock' : 'book-open')}<span>${esc(note.category)} · ${esc(note.source)}</span><span>第 ${note.version} 版</span></div><h1>${esc(note.title)}</h1><p class="paper-subtitle">${esc(note.subtitle)}</p><button class="version-strip" data-action="note-history" data-id="${esc(note.id)}">${icon('history')}<span><b>第 ${note.version} 版</b> · 保存于 ${time(note.updatedAt)}<i class="artifact-id">${esc(note.id.replace(/^note-/, ''))}</i><em>${note.history.length ? `${note.history.length} 次改动可回看` : '还没有改过'} · 版本与来处</em></span>${icon('chevron-right')}</button>${this.evidenceBand(note.id)}<button class="listen-line" data-action="play-note" data-id="${esc(note.id)}"><span>${icon('headphone')}听伴星读这篇</span>${icon('chevron-right')}</button>${note.blocks.map((b, i) => this.blockMarkup(b, i)).join('')}<p class="note-end">读完一段，也可以先停在这里。<br>讲解与浏览不会自动记作掌握。</p><div class="paper-bottom"><button data-action="ask">${icon('message-square-text')} 问这篇笔记</button>${note.history.length ? `<button data-action="compare" data-id="${esc(note.id)}">看最近修改</button>` : ''}<button data-action="export-note" data-id="${esc(note.id)}">${icon('download')} 带走这一篇</button></div></article>`;
    }
    compareBody() {
      const note = store.note(this.ui.view.id);
      const before = note?.history.at(-1);
      if (!before) return '<div class="empty">这篇笔记还没有修改记录。</div>';
      const blocks = this.ui.comparePane === 'before' ? before.blocks : note.blocks;
      return `<article class="paper"><div class="paper-meta">${icon('check')}已保存 · ${spaceName(note.space)}</div><h1>这次改了什么</h1><p class="compare-intro">《${esc(note.title)}》<br>${esc(before.summary)}，更新的是原来的笔记。</p><div class="compare-tabs" aria-label="修改对照"><span class="segmented-indicator" data-node-key="compare-indicator" style="--segment:${this.ui.comparePane === 'before' ? 0 : 1};--segments:2" aria-hidden="true"></span><button data-action="compare-pane" data-pane="before" class="${this.ui.comparePane === 'before' ? 'active' : ''}" aria-pressed="${this.ui.comparePane === 'before'}">修改前 · 第 ${before.version} 版</button><button data-action="compare-pane" data-pane="after" class="${this.ui.comparePane === 'after' ? 'active' : ''}" aria-pressed="${this.ui.comparePane === 'after'}">修改后 · 第 ${note.version} 版</button></div><p class="change-label">${icon('check')}${this.ui.comparePane === 'after' ? '这是已经保存的正文' : '保留修改前的原文，供你核对'}</p><div class="compare-content">${blocks.map((b, i) => this.blockMarkup(b, i, { selectable: false })).join('')}</div><div class="paper-bottom"><button data-action="open-current-note">回到笔记正文</button><button data-action="ask">继续调整</button></div></article>`;
    }
    imageBody() {
      const asset = store.data.assets.find(a => a.id === this.ui.view.id && a.space === this.ui.space);
      if (!asset) return '<div class="empty">这张图片当前不可读。</div>';
      return `<article class="paper"><div class="paper-meta">${icon('image')}${asset.sample ? '示例图片' : '你递来的图片'} · ${time(asset.createdAt)}</div><h1>${esc(asset.name)}</h1><div class="image-preview"><img src="${esc(asset.url)}" alt="${esc(asset.name)}"></div><p class="image-caption">${asset.sample ? '四次观察的数量是 10、20、40、70。讲解只围绕这张图。' : '原图完整保留在这一轮里；这一版还没有读图，不会照着文件名猜内容。'}</p><div class="paper-bottom"><button data-action="ask-image">问这张图片</button></div></article>`;
    }
    evidenceLabel(level) { return { seen: '只看过', practiced: '练过', independent: '能独立用' }[level] || '还没有学习记录'; }
    evidenceMark(noteId) {
      const last = store.latestRecall(noteId);
      return last ? `<span class="evidence-mark"><i class="level-${esc(last.level)}" aria-hidden="true"></i>${this.evidenceLabel(last.level)}</span>` : '';
    }
    evidenceBand(noteId) {
      const records = store.recallFor(noteId);
      const last = records.at(-1);
      return `<div class="evidence-band level-${last?.level || 'none'}"><i aria-hidden="true"></i><span><strong>${this.evidenceLabel(last?.level)}</strong>${records.length ? `<small>${records.length} 条记录 · 最近 ${dateOf(last.at)}</small>` : '<small>读几遍都不算，得你自己说一遍</small>'}</span>${records.length ? `<button class="text-action" data-action="start-review" data-id="${esc(noteId)}">再回想一次</button>` : ''}</div>`;
    }
    reviewBody() {
      const note = store.note(this.ui.view.id);
      if (!note || note.space !== this.ui.space) return '<div class="empty">这篇笔记当前不可读。</div>';
      const step = this.ui.reviewStep || 'recall';
      const block = note.blocks.find(b => b.id === this.ui.review?.blockId) || note.blocks[0];
      const head = `<div class="paper-meta">${icon('history')}回想这一篇</div><h1>${esc(note.title)}</h1>`;
      if (step === 'recall') return `<article class="paper">${head}<p class="archive-note">先别看正文。用自己的话说一遍，说错了也没关系——这一步只是让你知道自己卡在哪。</p><div class="review-prompt">${icon('book-open')}<span>用你自己的话说清：<strong>${esc(block.heading)}</strong></span></div><textarea id="review-answer" class="review-answer" aria-label="用自己的话说明" placeholder="说给伴星听，不用组织得多好">${esc(this.ui.review?.answer || '')}</textarea><div class="paper-bottom"><button class="primary" data-action="review-reveal" data-id="${esc(block.id)}">对一下原文</button></div></article>`;
      if (step === 'compare') return `<article class="paper">${head}<div class="review-said"><small>你刚才说的</small><p>${esc(this.ui.review?.answer || '（空着，直接跳过了）')}</p></div><div class="review-origin"><small>原文这一段</small><h3>${esc(block.heading)}</h3><p>${esc(blockText(block))}</p></div><p class="archive-note">这算到哪一档？只有你自己能定，伴星不替你判。</p><div class="level-picker"><button data-action="review-record" data-id="${esc(note.id)}" data-block="${esc(block.id)}" data-level="seen"><i class="level-seen" aria-hidden="true"></i><span><strong>看过</strong><small>又读了一遍，还没说出来</small></span></button><button data-action="review-record" data-id="${esc(note.id)}" data-block="${esc(block.id)}" data-level="practiced"><i class="level-practiced" aria-hidden="true"></i><span><strong>练过</strong><small>自己说出来了，可能还要看原文</small></span></button><button data-action="review-record" data-id="${esc(note.id)}" data-block="${esc(block.id)}" data-level="independent"><i class="level-independent" aria-hidden="true"></i><span><strong>能独立用</strong><small>不看书也能拿去解题、讲给别人</small></span></button></div></article>`;
      const last = store.latestRecall(note.id);
      return `<article class="paper">${head}<p class="review-done">${icon('check')}<span>已经记进这一篇：${this.evidenceLabel(last?.level)} · 第 ${note.version} 版</span></p><p class="archive-note">要不要排进长期复习？排进来以后会按这一档的间隔再来问你，不排就停在这里。</p><div class="review-exit"><button class="primary" data-action="review-plan" data-id="${esc(note.id)}" data-long="1">排进长期复习</button><button class="secondary" data-action="review-plan" data-id="${esc(note.id)}" data-long="0">这次先不排</button></div></article>`;
    }
    historyBody() {
      const note = store.note(this.ui.view.id);
      if (!note) return '<div class="empty">这篇笔记当前不可读。</div>';
      const line = (version, savedAt, summary, current) => `<div class="history-line${current ? ' current' : ''}"><i aria-hidden="true"></i><div><strong>第 ${version} 版${current ? ' · 正在读' : ''}</strong><p>${esc(summary)}</p><small>${esc(time(savedAt))} · ${esc(dateOf(savedAt))}</small></div>${current ? '' : `<button class="text-action" data-action="compare-version" data-id="${esc(note.id)}" data-version="${version}">看这一版</button>`}</div>`;
      return `<article class="paper"><div class="paper-meta">${icon('history')}版本与来处</div><h1>${esc(note.title)}</h1><p class="archive-note">每一版改了什么、什么时候保存，都留在这里。正文由谁写、由伴星改，用的是同一个身份。</p>${line(note.version, note.updatedAt, note.history.length ? '当前版本（最近一次写入的结果）' : '初稿，尚未修改', true)}${[...note.history].reverse().map(h => line(h.version, h.savedAt, h.summary, false)).join('')}<div class="paper-bottom"><button data-action="export-note" data-id="${esc(note.id)}">${icon('download')} 带走这一篇（含版本记录）</button></div></article>`;
    }
    noteMarkdown(note) {
      const body = note.blocks.map(b => `## ${b.heading}\n\n${blockText(b)}`).join('\n\n');
      const history = note.history.length ? note.history.map(h => `- 第 ${h.version} 版 · ${h.savedAt} · ${h.summary}`).join('\n') : '- 尚无历史版本';
      const recall = store.recallFor(note.id);
      const evidence = recall.length ? recall.map(r => `- ${r.at} · ${({ seen: '看过', practiced: '练过', independent: '能独立用' })[r.level]}${r.longTerm ? '（排进长期复习）' : ''}${r.answer ? ` · 原话：${r.answer}` : ''}`).join('\n') : '- 还没有学习记录';
      return `# ${note.title}\n\n> ${note.subtitle}\n\n- 对象身份：${note.id}\n- 空间：${spaceName(note.space)}\n- 分类与来源：${note.category} · ${note.source}\n- 当前：第 ${note.version} 版 · ${note.updatedAt}\n\n${body}\n\n## 版本记录\n\n${history}\n\n## 学习记录\n\n${evidence}\n`;
    }
    download(filename, text, mime) {
      try {
        const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
        const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
      } catch { return false; }
    }
    exportNote(noteId) {
      const note = store.note(noteId); if (!note) return this.toast('这篇笔记当前不可读。');
      this.download(`${note.title}-第${note.version}版.md`, this.noteMarkdown(note), 'text/markdown')
        ? this.toast('已导出正文、来源与版本记录。') : this.toast('这台浏览器不允许本机保存，可以换系统浏览器再试。');
    }
    exportSpace() {
      const notes = this.visibleNotes;
      if (!notes.length) return this.toast('这个书房还没有笔记。');
      const text = `# ${spaceName(this.ui.space)} · ${notes.length} 篇笔记\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n${notes.map(n => this.noteMarkdown(n)).join('\n\n---\n\n')}\n`;
      this.download(`${spaceName(this.ui.space)}-笔记整包.md`, text, 'text/markdown')
        ? this.toast(`已导出 ${notes.length} 篇，含每篇的版本记录。`) : this.toast('这台浏览器不允许本机保存，可以换系统浏览器再试。');
    }
    archiveBody() {
      const thread = store.conversation(this.ui.view.id);
      if (!thread || thread.space !== this.ui.space) return '<div class="empty">这段交流在当前书房不可读。</div>';
      return `<article class="paper"><div class="paper-meta">${icon('history')}以前的交流 · ${thread.messages.length} 条</div><h1>${esc(thread.title)}</h1><p class="archive-note">这条已经收好了，只读。想接着问，带一句回当前交流。</p>${thread.messages.map(m => `<div class="archive-line${m.role === 'user' ? ' mine' : ''}"><div class="message-meta"><span>${m.role === 'user' ? esc(accounts.user?.displayName || '你') : esc(accounts.user?.companion.name || '伴星')}</span><span>${esc(m.time)} · ${m.device === 'desktop' ? '电脑' : '手机'}</span></div><p>${esc(m.text)}</p><button class="text-action" data-action="quote-archive" data-id="${esc(m.id)}">带这段接着问</button></div>`).join('')}</article>`;
    }
    composerMarkup(key, context = false) {
      const value = this.ui.drafts[key] || '';
      return `<form class="composer" data-draft-key="${esc(key)}"><button class="icon-button" type="button" data-action="${context ? 'close-sheet' : 'attach'}" aria-label="${context ? '收起提问' : '递材料'}">${icon(context ? 'chevron-down' : 'plus')}</button><textarea id="${context ? 'ask-input' : 'chat-input'}" data-draft-key="${esc(key)}" rows="1" placeholder="${context ? '想问或改哪里…' : '说点什么…'}" aria-label="${context ? '围绕当前内容提问' : '给伴星的消息'}">${esc(value)}</textarea>${context ? '' : `<button class="icon-button" type="button" data-action="voice" aria-label="开始语音聊天演示">${icon('mic')}</button>`}<button class="icon-button send" type="submit" aria-label="发送消息" ${!value.trim() && !(!context && this.ui.attachment) ? 'disabled' : ''}>${icon('send')}</button></form>`;
    }
    footer() {
      if(this.centers.active)return '';
      if (this.player) return `<div class="tray glass">${this.playerMarkup()}${!this.detail ? this.navMarkup() : ''}</div>`;
      if (this.ui.view.type === 'archive') return `<div class="detail-dock glass"><button class="detail-ask" data-action="archive-to-thread">${icon('message-square-text')}<span>回当前交流<small>接着这一轮往下问</small></span></button></div>`;
      if (this.ui.view.type === 'review') return `<div class="detail-dock glass"><button class="detail-ask" data-action="tab" data-tab="stuff">${icon('folder')}<span>回手边<small>这一步随时可以再回来</small></span></button></div>`;
      if (this.ui.view.type === 'history') return `<div class="detail-dock glass"><button class="detail-ask" data-action="back">${icon('book-open')}<span>回正文<small>这一版改了什么已经记下</small></span></button></div>`;
      if (this.detail) return `<div class="detail-dock glass"><button class="detail-ask" data-action="${this.ui.view.type === 'image' ? 'ask-image' : 'ask'}">${icon('message-square-text')}<span>${this.ui.selectedBlock ? '问这一段' : this.ui.view.type === 'image' ? '问这张图片' : '问这篇笔记'}<small>${this.ui.selectedBlock ? '带上选中的原文' : this.ui.space === 'shared' ? '只读书房，问知识可以' : '提问或修改，保留当前内容'}</small></span></button><button class="icon-button" data-action="${this.ui.view.type === 'image' ? 'ask-image' : 'play-note'}" data-id="${esc(this.ui.view.id)}" aria-label="${this.ui.view.type === 'image' ? '解释图片' : '朗读当前笔记'}">${icon(this.ui.view.type === 'image' ? 'lightbulb' : 'headphone')}</button></div>`;
      if (this.ui.view.type !== 'chat') return `<div class="navigation-tray glass" data-node-key="navigation">${this.navMarkup()}</div>`;
      if(this.scene.active || (this.scene.mode==='scene' && !this.scene.textVisible)) return `${this.scene.dock()}<div class="navigation-tray glass" data-node-key="navigation">${this.navMarkup()}</div>`;
      const attachment = this.ui.attachment;
      const ref = this.ui.context && store.note(this.ui.context.noteId);
      const assetRef = this.ui.context && store.data.assets.find(a => a.id === this.ui.context.assetId);
      const archiveRef = this.ui.context && !ref && !assetRef && store.conversation(this.ui.context.conversationId);
      return `<div class="composer-tray glass" data-node-key="composer-tray">${attachment ? `<div class="draft-reference"><img src="${esc(attachment.url)}" alt=""><span>${esc(attachment.name)} · 待发送</span><button data-action="remove-attachment" aria-label="移除图片">${icon('x')}</button></div>` : ref || assetRef || archiveRef ? `<div class="draft-reference">${icon(ref ? 'book-open' : archiveRef ? 'history' : 'image')}<span>${ref ? `《${esc(ref.title)}》` : assetRef ? esc(assetRef.name) : `以前聊过的 · ${esc(archiveRef.title)}`}${this.ui.context.quote ? ' · 已带原文' : ''}</span><button data-action="remove-reference" aria-label="移除内容引用">${icon('x')}</button></div>` : ''}${this.composerMarkup(`chat:${this.ui.space}`)}</div>${this.scene.mode==='scene' ? '<button class="scene-return" data-action="scene-return">回到伴星</button>' : ''}<div class="navigation-tray glass" data-node-key="navigation">${this.navMarkup()}</div>`;
    }
    navMarkup() {
      const count = store.data.tasks.filter(t => t.space === this.ui.space && !['succeeded', 'stopped'].includes(t.status)).length;
      return `<nav class="tabbar" role="tablist" aria-label="主要分区"><span class="tab-indicator" data-node-key="tab-indicator" style="left:calc(${['chat','stuff','notes'].indexOf(this.ui.view.type)} * (100% - 4px) / 3 + 2px)" aria-hidden="true"></span>${[['chat', '对话', 'message-square-text'], ['stuff', '手边', 'folder'], ['notes', '手记', 'book-open']].map(([key, label, ico]) => `<button role="tab" tabindex="${this.ui.view.type === key ? 0 : -1}" aria-selected="${this.ui.view.type === key}" data-action="tab" data-tab="${key}">${icon(ico)}<span>${label}</span>${key === 'stuff' && count ? `<i class="tab-badge">${count}</i>` : ''}</button>`).join('')}</nav>`;
    }
    playerMarkup() {
      return `<div class="player"><button class="icon-button" data-action="pause-audio" aria-label="${this.player.paused ? '继续朗读' : '暂停朗读'}">${icon(this.player.paused ? 'play' : 'pause')}</button><div><strong>${esc(this.player.title)}</strong><div class="progress"><i style="width:${Math.round(this.player.index / this.player.parts.length * 100)}%"></i></div><small>${this.player.paused ? '已暂停' : '正在朗读'} · 第 ${this.player.index + 1} 段 / ${this.player.parts.length} 段</small></div><button class="icon-button" data-action="interrupt-audio" aria-label="停止朗读并提问">${icon('message-square-text')}</button><button class="icon-button" data-action="stop-audio" aria-label="结束朗读">${icon('x')}</button></div>`;
    }
    keyboardMarkup() {
      return `<div class="keyboard" aria-label="键盘布局占位"><small>键盘占位 · 正在回复的内容保持可读</small>${['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map(row => `<div class="key-row">${[...row].map(k => `<button data-action="key" data-key="${k}">${k}</button>`).join('')}</div>`).join('')}<div class="key-row"><button data-action="key" data-key="">123</button><button class="space" data-action="key" data-key=" ">空格</button><button class="done" data-action="close-keyboard">完成</button></div></div>`;
    }
    sheetMarkup() {
      const { type } = this.sheet;
      let title = '', body = '', bottom = '';
      if (type === 'ask') {
        const context = this.sheet.context;
        const note = store.note(context.noteId);
        const asset = store.data.assets.find(a => a.id === context.assetId);
        title = '和伴星聊这一处';
        const results = this.conversation.messages.filter(m => this.sheet.messageIds.includes(m.id));
        body = `<div class="ask-reference"><strong>《${esc(note?.title || asset?.name || '当前内容')}》${context.noteVersion ? ` · 第 ${context.noteVersion} 版` : ''}</strong><p>${esc(context.quote || '提问会带上当前内容；原文仍在后面。')}</p></div><div class="ask-results">${results.map(m => this.messageMarkup(m)).join('')}</div>`;
        const editPrompt = context.blockId ? '把这一段改成表格' : note?.blocks.length === 1 ? '把第一段改成表格' : '把第二段改成表格';
        bottom = `<div class="thread-quick"><button data-action="prompt" data-text="用一个例子讲讲这一段">用例子讲讲</button>${note ? `<button data-action="prompt" data-text="${editPrompt}">${editPrompt.slice(1)}</button>` : `<button data-action="prompt" data-text="整理成一篇笔记">整理成笔记</button>`}</div>${this.composerMarkup(this.draftKey, true)}`;
      } else if (type === 'attach') {
        title = '递材料给她';
        body = '<p class="sheet-copy">图片会跟这一轮提问放在一起。想整理成笔记时，再告诉她。</p>' + sheetRow('pick-image', 'image', '从相册选一张', '在本机预览，不上传') + sheetRow('camera', 'camera', '拍下眼前这一页', '支持相机的设备可直接拍照') + sheetRow('sample-image', 'lightbulb', '试试示例图片', '读图、讲解、整理成笔记') + sheetRow('choose-note', 'book-open', '引用已有笔记', '选一篇，带到这次交流');
      } else if (type === 'choose-note') {
        title = this.pendingEdit ? '你想改哪一篇？' : '选一篇已有笔记';
        body = this.visibleNotes.map(n => sheetRow('choose-note-item', 'book-open', n.title, `第 ${n.version} 版`, `data-id="${esc(n.id)}"`)).join('') || '<p class="sheet-copy">这里还没有笔记，可以先让伴星整理一篇。</p>';
      } else if (type === 'consent') {
        title = '把哪些事交给伴星';
        body = `<p class="sheet-copy">你的选择应用于账号。你可以先读书房；允许后，伴星才能阅读递来的材料，并按你的要求创建和修改。</p><div class="consent-list"><p>${icon('image')}发送的文字、所带原文和图片会交给外部模型服务处理。</p><p>${icon('mic')}语音转写可以先编辑再保存，不采集原声。</p><p>${icon('lock')}笔记默认私有，写入仍受空间权限和版本核对约束。</p><p>${icon('shield')}阅读与讲解不自动创建笔记，也不自动记作掌握。</p></div><button class="primary" data-action="${store.data.consent && !this.pending ? (this.panelStack.length ? 'panel-back' : 'close-sheet') : 'accept-consent'}">${store.data.consent && !this.pending ? '知道了，回到刚才' : this.pending ? '同意并发送这一条' : '同意并开始'}</button><button class="secondary" data-action="${store.data.consent && !this.pending ? 'revoke-consent' : 'decline-consent'}">${store.data.consent && !this.pending ? '撤回 AI 使用同意' : '先只读书房'}</button>`;
      } else if (type === 'spaces') {
        title = '去哪个书房';
        const sharedCount = store.data.notes.filter(n => n.space === 'shared').length;
        body = sheetRow('switch-space', 'book-open', '我的书房', `${this.visibleNotes.length} 篇笔记 · 可以阅读和修改`, 'data-space="home"') + ((accounts.user?.sample || accounts.user?.sharedAccess) ? sheetRow('switch-space', 'lock', '共读书房', `${sharedCount} 篇共读 · 只能读`, 'data-space="shared"') : '');
      } else if (type === 'logout') {
        title='退出这个账号？';body='<p class="sheet-copy">笔记、聊天和伴星设定会保留。下次登录这个账号，可以接着用；正在处理的任务会暂停。</p><button class="primary" data-action="confirm-logout">退出登录</button><button class="secondary" data-action="close-sheet">继续留在书房</button>';
      } else if (type === 'menu') {
        title = spaceName(this.ui.space);
        body = `<button class="menu-account" data-action="profile">${this.centers.avatar()}<span><strong>${esc(accounts.user.displayName)}</strong><small>个人中心</small></span>${icon('chevron-right')}</button>` + sheetRow('companion','sparkles','伴星中心','她的表达、记忆与日记') + sheetRow('settings', 'settings-2', '设置', '阅读、朗读与 AI 使用');
      }
      return `<div class="sheet-page" data-node-key="sheet-page"><div class="sheet-head">${this.panelStack.length ? `<button class="icon-button" data-action="panel-back" aria-label="返回上一级面板">${icon('arrow-left')}</button>` : ''}<h2 id="sheet-title">${title}</h2><button class="icon-button" data-action="close-sheet" aria-label="${this.panelStack.length ? '关闭所有面板' : '关闭面板'}">${icon('x')}</button></div><div class="sheet-content">${body}</div>${bottom}</div>`;
    }
    renderMirror() {
      if(!accounts.user){document.querySelector('#desktop-mirror').innerHTML='<div class="mirror-page"><h3>请先登录</h3><p>登录后才展示这个账号的笔记和聊天。</p></div>';return;}
      const notes = this.visibleNotes;
      const note = store.note(this.mirrorId)?.space === this.ui.space ? store.note(this.mirrorId) : notes[0];
      if (note) this.mirrorId = note.id;
      const latest = this.conversation.messages.at(-1);
      document.querySelector('#desktop-mirror').innerHTML = `<div class="mirror-top"><i></i><i></i><i></i><span>${spaceName(this.ui.space)}</span></div><div class="mirror-list">${notes.slice(0, 5).map(n => `<button class="mirror-note ${n.id === note?.id ? 'selected' : ''}" data-mirror-note="${esc(n.id)}">${icon('book-open')}${esc(n.title)}<small>第 ${n.version} 版</small></button>`).join('') || '<p class="sheet-copy">还没有笔记。</p>'}</div>${note ? `<div class="mirror-page"><h3>${esc(note.title)}</h3><p>${esc(noteText(note).slice(0, 180))}</p><p class="mirror-meta">${esc(note.source)} · 已保存 ${time(note.updatedAt)} · 同一对象</p><button data-desktop-edit="${esc(note.id)}" ${this.ui.space !== 'home' ? 'disabled' : ''}>从桌面补充一句，再看手机正文</button></div>` : ''}<div class="mirror-chat"><strong>同一份聊天 · ${this.conversation.messages.length} 条消息</strong><p>${esc(latest?.text || '你的下一句会在这里出现。')}</p></div>`;
    }
    navigate(view, { replace = false } = {}) {
      this.scene.stop();
      this.captureScroll(); this.stopAudio(false); this.closeSheet(false); this.keyboard = false;
      if (!replace) this.ui.stack.push({ view: clone(this.ui.view), selectedBlock: this.ui.selectedBlock, focus: this.trigger?.dataset.action ? { ...this.trigger.dataset } : null });
      this.routeTransition = {kind:'push'}; this.ui.view = view; this.ui.selectedBlock = null; this.render();
    }
    tab(type) {
      if (this.ui.view.type === type && !this.detail) return this.closeSheet();
      this.scene.stop();
      const direction = ['chat','stuff','notes'].indexOf(type) - ['chat','stuff','notes'].indexOf(this.ui.view.type);
      this.captureScroll(); this.stopAudio(false); this.closeSheet(false); this.keyboard = false;
      this.routeTransition = {kind:'tab',direction:Math.sign(direction)||1};
      this.ui.view = { type }; this.ui.stack = []; this.ui.selectedBlock = null;
      this.render();
    }
    back() {
      this.scene.stop(); this.captureScroll(); this.stopAudio(false);
      const previous = this.ui.stack.pop();
      this.ui.view = previous?.view || { type: 'chat' }; this.ui.selectedBlock = previous?.selectedBlock || null;
      this.closeSheet(false); this.keyboard = false; this.routeTransition = {kind:'back'}; this.render();
      const focus = previous?.focus;
      const trigger = focus && [...this.surface.querySelectorAll('[data-action]')].find(el => el.dataset.action === focus.action && (!focus.id || el.dataset.id === focus.id));
      (trigger || this.surface.querySelector('.top-left'))?.focus({preventScroll:true});
    }
    openNote(noteId) {
      const note = store.note(noteId);
      if (!note || note.space !== this.ui.space) return this.toast('这篇笔记在当前书房不可读。');
      this.ui.lastNoteId = note.id; this.mirrorId = note.id;
      if (this.ui.view.type === 'reader' && this.ui.view.id === note.id) return this.closeSheet();
      this.navigate({ type: 'reader', id: note.id }); this.renderMirror();
    }
    currentContext() {
      if (this.ui.view.type === 'image') return { assetId: this.ui.view.id };
      const note = store.note(this.ui.view.id);
      if (!note) return this.ui.context || null;
      const block = note.blocks.find(b => b.id === this.ui.selectedBlock);
      return { noteId: note.id, noteVersion: note.version, blockId: block?.id, quote: block ? blockText(block) : undefined };
    }
    openAsk() {
      const context = this.currentContext(); if (!context) return;
      this.stopAudio(false); this.keyboard = false; this.closeSheet(false);
      this.openSheet('ask', { context: clone(context), messageIds: [] });
      this.root.querySelector('#ask-input')?.focus({ preventScroll: true });
    }
    openSheet(type, extra = {}) {
      this.captureScroll(); this.keyboard = false;
      if (this.sheet?.type === type) return;
      if (this.sheet) { this.sheet.scroll = this.panelBox.querySelector('.sheet-content')?.scrollTop || 0; this.panelStack.push(this.sheet); }
      else { this.panelStack = []; this.returnFocus = this.trigger?.dataset.action ? { ...this.trigger.dataset } : null; }
      this.sheet = { type, uid:id('panel'), origin:this.triggerRect(), ...extra }; this.panelDirection = this.panelStack.length ? 'push' : 'open';
      this.render(); this.panelBox.querySelector('.sheet-head .icon-button')?.focus({ preventScroll: true });
    }
    panelBack() {
      if (!this.panelStack.length) return this.closeSheet();
      if (this.sheet.type === 'consent') this.pending = null;
      const child = this.sheet; this.sheet = this.panelStack.pop(); this.pendingEdit = null; this.panelDirection = 'back'; this.render();
      const row = [...this.panelBox.querySelectorAll('[data-action]')].find(el => el.dataset.action === child.type || (child.type === 'consent' && el.dataset.action === 'consent-info'));
      (row || this.panelBox.querySelector('.sheet-head .icon-button'))?.focus({preventScroll:true});
    }
    closeSheet(render = true) {
      if (this.sheet?.type === 'consent') this.pending = null;
      this.sheet = null; this.panelStack = []; this.pendingEdit = null;
      if (render) {
        this.render(); const data = this.returnFocus;
        const trigger = data && [...this.surface.querySelectorAll('[data-action]')].find(el => el.dataset.action === data.action && (!data.id || el.dataset.id === data.id));
        trigger?.focus({preventScroll:true});
      }
    }
    attachSample() { this.scene.stop();this.scene.textOpen=true;this.ui.context = null; this.ui.attachment = clone(SAMPLE); this.ui.drafts[`chat:${this.ui.space}`] ||= '讲讲这张图，为什么增长越来越快？'; this.closeSheet(false); if (this.detail || this.ui.view.type !== 'chat') this.tab('chat'); else this.render(); }
    async attachFile(file) {
      if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif|heic|heif)$/.test(file.type) && !/\.(png|jpe?g|webp|heic|heif)$/i.test(file.name)) return this.toast('请选择一张图片。PDF 和 Word 读取在后续版本接入。');
      if (file.size > 2 * 1024 * 1024) return this.toast('这里最多预览 2 MB 图片，换一张小一点的。');
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }).catch(() => null);
      if (!url) return this.toast('图片没有读到，原来的草稿还在。');
      const readable = await new Promise(resolve => { const preview = new Image(); preview.onload = () => resolve(preview.naturalWidth > 0); preview.onerror = () => resolve(false); preview.src = url; });
      if (!readable) return this.toast('这台浏览器暂时打不开这张图片。请换 PNG、JPEG 或 WebP，原来的草稿还在。');
      this.scene.stop();this.scene.textOpen=true;this.ui.context = null; this.ui.attachment = { name: file.name, url, sample: false }; this.closeSheet(false); this.tab('chat');
    }
    send(text, options = {}) {
      const key = options.key || this.draftKey;
      text = (text ?? this.ui.drafts[key] ?? '').trim();
      const context = options.context || (this.sheet?.type === 'ask' ? this.sheet.context : this.ui.context);
      const attachment = key.startsWith('chat:') ? this.ui.attachment : null;
      // Callers may already have closed the panel, so every early exit has to repaint
      // or the dismissed sheet keeps holding the surface inert.
      const blocked = message => { if (message) this.toast(message); this.render(); };
      if (!text && !attachment) return blocked();
      if (this.offline) return blocked('还没有发出。文字、引用和图片都保留，恢复网络后再发。');
      if (!store.data.consent) { this.pending = { text, options: { ...options, key, context }, returnSheet: this.sheet?.type === 'ask' ? clone(this.sheet) : null }; return this.openSheet('consent'); }
      if (this.activeTask) return blocked('这件事还在做。可以先停止它，再交代新的操作；草稿没有清除。');
      let kind = options.kind || (/把.+改|改成|改为|修改|^改|补一个|追加|补充|删除第/.test(text) ? 'edit' : /整理.*笔记|写.*笔记|新建|新增|记下|保存.*笔记|成.*笔记/.test(text) ? 'create' : attachment ? 'image' : 'explain');
      let target = context?.noteId && store.note(context.noteId);
      const named = this.visibleNotes.find(n => text.includes(n.title)); if (named) target = named;
      if (kind === 'edit' && !target) {
        const last = [...this.conversation.messages].reverse().find(m => m.noteId && store.note(m.noteId)?.space === this.ui.space);
        target = store.note(last?.noteId);
      }
      if (kind === 'edit' && !target) { this.pendingEdit = { text, options: { ...options, key } }; return this.openSheet('choose-note'); }
      if (['create', 'edit', 'voice'].includes(kind) && this.ui.space !== 'home') return blocked('这个书房只读，可以继续问知识；保存和修改需要作者权限。');
      let assetId = context?.assetId;
      if (attachment) { const asset = store.addAsset({ ...attachment, space: this.ui.space }); assetId = asset.id; }
      if (!assetId && kind === 'create') assetId = [...this.conversation.messages].reverse().find(m => m.assetId)?.assetId;
      const payload = { text: text || '帮我看看这张图片', noteId: target?.id || context?.noteId, expectedVersion: context?.noteVersion || target?.version, blockId: context?.blockId, quote: context?.quote, assetId, voiceText: options.voiceText };
      const mode = document.querySelector('#failure-mode').value;
      document.querySelector('#failure-mode').value = 'none';
      if (this.sheet?.type === 'ask') this.sheet.messageIds ||= [];
      const requestTitle = { image: '读你递来的图片', create: '整理成一篇笔记', edit: `调整《${target?.title || '当前笔记'}》`, voice: '留下刚才的想法', explain: '讲清这一处' }[kind];
      this.ui.drafts[key] = ''; if (attachment) this.ui.attachment = null;
      this.followConversation = true; this.newContent = false;
      if (!this.detail) { if (this.ui.view.type !== 'chat') this.routeTransition = {kind:'tab',direction:-1}; this.ui.view = { type: 'chat' }; this.ui.stack = []; this.nextScroll = 'bottom'; }
      const task = store.startTask({ kind, title: requestTitle, conversationId: this.conversation.id, space: this.ui.space, payload, mode });
      const message = store.message(this.conversation.id, { role: 'user', text: payload.text, noteId: payload.noteId, noteVersion: payload.expectedVersion, quote: payload.quote, assetId: attachment ? assetId : undefined, assetReferenceId: !attachment ? assetId : undefined, taskId: task.id });
      if (this.sheet?.type === 'ask') { this.sheet.messageIds.push(message.id); this.sheetToBottom = true; }
      if(options.voiceText && this.scene.voice.phase==='listening')this.scene.voice.wait(task.id);
      this.runTask(task); if (this.ui.view.type === 'chat') this.nextScroll = 'bottom'; this.render();
      if (kind !== 'voice') this.root.querySelector(this.sheet?.type === 'ask' ? '#ask-input' : '#chat-input')?.focus({preventScroll:true});
      return task;
    }
    runTask(task) {
      store.updateTask(task.id, { status: 'running', progress: 18, stage: task.kind === 'image' ? '正在查看图片' : task.kind === 'edit' ? '正在核对目标与版本' : '正在整理这次要求', error: null });
      const timers = [];
      timers.push(setTimeout(() => { if (task.status === 'running') store.updateTask(task.id, { progress: 64, stage: ['create', 'voice'].includes(task.kind) ? '正文已准备，等待保存' : task.kind === 'edit' ? '改动已准备，等待保存' : '正在准备讲解' }); }, 650));
      timers.push(setTimeout(() => this.execute(task), 1550));
      this.jobs.set(task.id, timers);
    }
    execute(task) {
      if (task.status !== 'running') return;
      this.jobs.delete(task.id);
      if (this.offline) return store.updateTask(task.id, { status: 'paused', error: '网络断开，这件事还没有保存。恢复后可以继续。' });
      if (!store.data.consent) return store.updateTask(task.id, { status: 'paused', error: 'AI 使用同意已撤回。没有继续执行，已有内容仍保留。' });
      if (task.mode === 'failed') { task.mode = 'none'; return store.updateTask(task.id, { status: 'failed', error: '这次执行中断，尚未写入。原内容保留，可以重试。' }); }
      try {
        let receipt = null;
        if (task.kind === 'create' || task.kind === 'voice') {
          const prepared = this.prepareNote(task);
          receipt = store.createNote({ requestId: task.id, ...prepared, space: task.space });
        } else if (task.kind === 'edit') {
          const note = store.note(task.payload.noteId);
          if (task.mode === 'conflict') { store.desktopEdit(note.id); task.mode = 'none'; }
          const changed = this.prepareEdit(note, task.payload);
          receipt = store.editNote({ requestId: task.id, noteId: note.id, expectedVersion: task.payload.expectedVersion, ...changed });
        }
        if (receipt && task.mode === 'unknown') return store.updateTask(task.id, { status: 'unknown', error: '保存回执没有回来，结果还不能确定。先核对，不再创建或写一次。' });
        this.finishTask(task, receipt);
      } catch (error) { store.updateTask(task.id, { status: error.code === 'CONFLICT' ? 'conflict' : 'failed', error: error.message }); }
    }
    prepareNote(task) {
      const { payload } = task;
      if (task.kind === 'voice') return { title: '一句随手记', subtitle: '刚才说过的话，照原意留在这里', blocks: [paragraph('刚才的想法', payload.voiceText || payload.text)], source: '语音转写' };
      const asset = store.data.assets.find(a => a.id === payload.assetId);
      if (asset?.sample) return { title: '怎样读一张增长图', subtitle: '从坐标与增加量，判断增长是否加快', blocks: clone(GRAPH_BLOCKS), source: '来自示例图片', assetId: asset.id };
      const note = store.note(payload.noteId) || store.note([...store.conversation(task.conversationId).messages].reverse().find(m => m.noteId)?.noteId);
      // Organising the same note twice must not stack another suffix onto the title.
      if (note) return { title: `${note.title.replace(/ · 随身整理$/, '')} · 随身整理`, subtitle: note.subtitle, blocks: clone(note.blocks), source: `整理自《${note.title}》` };
      const messages = store.conversation(task.conversationId).messages;
      const previous = [...messages].reverse().find(m => m.role === 'user' && !/整理.*笔记|新增.*笔记|记下/.test(m.text));
      return { title: '一份随手笔记', blocks: [paragraph('留下的内容', previous?.text || payload.text)], source: asset ? '附本机图片，尚未识图' : '来自这次交流', assetId: asset?.id };
    }
    prepareEdit(note, payload) {
      if (!note) throw new Error('这篇笔记当前不可读。');
      const blocks = clone(note.blocks);
      const index = payload.text.includes('第一段') ? 0 : payload.text.includes('第二段') ? 1 : Math.max(0, blocks.findIndex(b => b.id === payload.blockId));
      const target = blocks[index];
      if (/追加|补一个|补充/.test(payload.text)) { blocks.push(paragraph('补充的理解', '可以先比较“谁决定由谁任职”，再比较“出现问题时向谁负责”。用这两个问题回到原文核对具体关系。')); return { blocks, summary: '在末尾补充一个理解例子' }; }
      if (!target) throw new Error('这篇没有指定的段落。原文保留，请选一段再调整。');
      if (/删除/.test(payload.text)) { if (blocks.length < 2) throw new Error('这篇只剩一段，请说明希望保留什么。'); blocks.splice(index, 1); return { blocks, summary: `删除第 ${index + 1} 段` }; }
      if (!/表格/.test(payload.text)) throw new Error('这一版会改三种：把一段改成表格、删掉一段、补一个例子。别的改法要等模型接入，这次没有写入。');
      const sentences = blockText(target).split(/[。；]/).filter(Boolean);
      blocks[index] = { id: target.id, type: 'table', heading: target.heading, headers: ['要点', '原文里的意思'], rows: sentences.map((sentence, i) => [`${i + 1}`, sentence]) };
      return { blocks, summary: `将第 ${index + 1} 段整理成表格` };
    }
    finishTask(task, receipt) {
      store.updateTask(task.id, { status: 'succeeded', progress: 100, stage: receipt ? '保存已核对' : '讲解已完成', error: null, receipt });
      if (task.replyMessageId) return;
      const note = receipt && store.note(receipt.noteId);
      const asset = store.data.assets.find(a => a.id === task.payload.assetId);
      let text;
      if (note) text = task.kind === 'edit' ? '已经改好了，保存的是原来的那篇笔记。你可以读更新后的正文，也可以看看修改前后的差别。' : task.kind === 'voice' ? '这句话留下了。我只保留了你确认的内容，没有替你补写。' : '已经整理成笔记，保存在你的书房里。现在打开就能读，也可以继续让我改。';
      else if (asset?.sample) text = '先看坐标：四次观察的数量是 10、20、40、70。\n\n相邻两次分别增加 10、20、30。观察间隔相同，增加量依次变大，所以这段示例呈现增长加快。\n\n不过，“线向上”本身只说明数量在增加；判断是否加快，还要比较等间隔里的增加量。';
      else if (asset) text = '图片已经留在这一轮里，可以打开看原图。这一版还没有读图，我不会照着文件名猜内容。想看完整个流程，可以递那张示例曲线。';
      else {
        const sourceNote = store.note(task.payload.noteId) || this.visibleNotes.find(n => task.payload.text.includes(n.title));
        const selected = sourceNote?.blocks.find(b => b.id === task.payload.blockId);
        if (sourceNote?.id === 'note-history' || sourceNote?.title.includes('世袭')) text = '可以把这段想成两个问题：这个职位由谁决定？出了问题向谁负责？\n\n如果地方官员由中央任免，中央就可以通过任命、考核和撤换管理地方。一个人能否继续任职，与中央的决定有关。回到原文，再看“人员来源”和“责任关系”是不是都对上了。';
        else if (sourceNote) text = `这一处先看：${blockText(selected || sourceNote.blocks[0])}\n\n你可以用自己的话复述关键关系，再对照原文看看有没有遗漏。`;
        else if (/分封制|郡县制/.test(task.payload.text)) text = '先看两个问题：官员从哪里来，又对谁负责。分封制下，身份与封地通常由家族继承；郡县制下，地方官员由中央任命和考核。中央可以调任、考核和撤换官员，所以责任关系更直接。';
        else if (task.payload.text.includes('熵')) text = '先从微观状态开始：同一种宏观状态，可能对应很多种微观排列。学习熵时，要明确系统与条件，不能只用日常的“乱”来代替定义。';
        else text = '这次交流已经留下。可以接着找笔记、读原文，或者让我把刚才聊的整理成一篇笔记。';
      }
      if(!receipt && !asset && accounts.user?.companion){
        const buddy=accounts.user.companion;
        if(buddy.detail==='brief')text=text.split('\n\n')[0];
        else if(buddy.detail==='detailed')text+='\n\n读完可以用自己的话复述一次，再回到材料核对。';
        if(buddy.style==='direct')text='先说重点：'+text;
        const memory=buddy.remember && accounts.memories(task.space).find(m=>m.enabled && m.kind==='preference');
        if(memory)text+='\n\n按你确认的学习偏好：'+memory.text;
      }
      if (asset && !note && task.conversationId === this.conversation.id && task.space === this.ui.space) this.ui.context = { assetId: asset.id };
      if (note && task.conversationId === this.conversation.id && task.space === this.ui.space) {
        this.ui.lastNoteId = note.id; this.ui.context = { noteId: note.id, noteVersion: note.version }; this.mirrorId = note.id;
        if (this.sheet?.type === 'ask' && this.sheet.context.noteId === note.id) {
          this.sheet.context.noteVersion = note.version;
          const latestBlock = note.blocks.find(b => b.id === this.sheet.context.blockId);
          if (latestBlock) this.sheet.context.quote = blockText(latestBlock);
        }
      }
      const reply = store.message(task.conversationId, { role: 'assistant', taskId:task.id, text, noteId: note?.id, assetId: asset?.id, action: receipt?.kind, source: note ? '保存已核对' : task.payload.noteId ? '对照当前原文' : undefined });
      store.updateTask(task.id, { replyMessageId: reply.id });
      if (this.sheet?.type === 'ask' && task.conversationId === this.conversation.id) { this.sheet.messageIds.push(reply.id); this.sheetToBottom = true; }
      if (this.ui.view.type === 'chat' && task.conversationId === this.conversation.id) {
        if (this.followConversation) this.nextScroll = 'bottom'; else this.newContent = true;
      }
      this.render(); this.renderMirror();
      if (store.storageError) this.toast('浏览器存储已满，本次内容只保留在当前页面。');
    }
    stopTask(taskId) {
      const task = store.data.tasks.find(t => t.id === taskId); if (!task || task.status !== 'running') return;
      for (const timer of this.jobs.get(taskId) || []) clearTimeout(timer); this.jobs.delete(taskId);
      store.updateTask(taskId, { status: 'stopped', stage: '已停止，尚未写入' }); this.toast('这件事停下了，原来的笔记和交流仍保留。');
    }
    retryTask(taskId) {
      const task = store.data.tasks.find(t => t.id === taskId); if (!task) return;
      if (this.offline) return this.toast('先恢复网络，要求和材料仍保留。');
      if (!store.data.consent) return this.openSheet('consent');
      if (this.activeTask) return this.toast('请先等当前这件事完成。');
      if (task.status === 'conflict') { const note = store.note(task.payload.noteId); task.payload.expectedVersion = note.version; }
      task.mode = 'none'; task.attempts++; this.runTask(task);
    }
    resolveTask(taskId) {
      if (this.offline) return this.toast('恢复网络后再核对，当前不重复写入。');
      const task = store.data.tasks.find(t => t.id === taskId);
      const receipt = store.resolve(taskId);
      if (receipt && task) { this.finishTask(task, receipt); this.toast('核对到了同一份保存结果，没有重复创建。'); }
      else this.toast('尚未取得保存结果，继续保留这件事。');
    }
    switchSpace(space) {
      // A refused switch has no render to lean on, so put the lab checkbox back.
      if(!accounts.user || (space==='shared' && !accounts.user.sample && !accounts.user.sharedAccess)){ this.toast('这个账号没有共读书房的访问权限。'); this.syncControls(); return; }
      if (space === this.ui.space) return this.closeSheet();
      this.scene.stop();this.scene.reply='';this.scene.result=null;this.scene.caption='';this.scene.lastMessage=store.activeConversation(space).messages.at(-1)?.id;
      this.captureScroll(); this.stopAudio(false); this.closeSheet(false);
      this.ui.spaceDrafts ||= {};
      this.ui.spaceDrafts[this.ui.space] = { context: this.ui.context, attachment: this.ui.attachment };
      const resumed = this.ui.spaceDrafts[space];
      this.ui.space = space; this.ui.view = { type: 'chat' }; this.ui.stack = []; this.ui.context = resumed?.context || null; this.ui.attachment = resumed?.attachment || null; this.ui.selectedBlock = null; this.ui.query = '';
      this.render(); this.renderMirror();
    }
    playParts(parts, title) {
      if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return this.toast('这台浏览器暂时无法朗读，文字仍可以阅读。');
      this.stopAudio(false);
      this.scene.stop();
      const token = this.audioToken;
      this.player = { parts, title, index: 0, paused: false, blockId: parts[0].id };
      const next = () => {
        if (token !== this.audioToken || !this.player) return;
        const part = parts[this.player.index]; this.player.blockId = part.id;
        const utterance = new SpeechSynthesisUtterance(part.text); utterance.lang = 'zh-CN'; utterance.rate = .95;
        const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith('zh')); if (voice) utterance.voice = voice;
        utterance.onstart=()=>{if(token!==this.audioToken || !this.player)return;this.scene.speaking=true;this.scene.caption=this.scene.short(part.text);this.scene.boundaryAt=performance.now();this.scene.paint();};
        utterance.onboundary=()=>{if(token===this.audioToken)this.scene.boundaryAt=performance.now();};
        utterance.onend = () => { if (token !== this.audioToken || !this.player) return;this.scene.speaking=false;this.scene.model.setLevel(0); if (++this.player.index < parts.length) next(); else this.stopAudio(); };
        utterance.onerror = () => { if (token === this.audioToken) { this.stopAudio(); this.toast('朗读没有启动，可以继续读文字或换浏览器声音。'); } };
        utterance.rate=accounts.user?.preferences.speechRate || 1;
        speechSynthesis.speak(utterance); this.render();
      };
      next();
    }
    playNote(noteId) { const note = store.note(noteId); if (note && note.space === this.ui.space) this.playParts(note.blocks.map(b => ({ id: b.id, text: `${b.heading}。${blockText(b)}` })), note.title); }
    stopAudio(render = true) { if(this.player && this.scene){this.scene.speaking=false;this.scene.caption='';this.scene.model.setLevel(0);}this.audioToken++; if ('speechSynthesis' in window) speechSynthesis.cancel(); this.player = null;this.scene?.syncFlow(); if (render) this.render(); }
    grow(area) {
      // Read the CSS limits so larger text has a full line before scrolling.
      const style = getComputedStyle(area);
      const minimum = parseFloat(style.minHeight) || 44;
      const maximum = parseFloat(style.maxHeight) || (this.keyboard ? 60 : 92);
      area.style.height = `${minimum}px`;
      area.style.height = `${Math.min(maximum, Math.max(minimum, area.scrollHeight))}px`;
    }
    syncControls() {
      document.querySelector('#offline-toggle').checked = this.offline;
      document.querySelector('#readonly-toggle').checked = this.ui.space === 'shared';
      document.querySelector('#consent-toggle').checked = !store.data.consent;
      document.querySelector('#keyboard-toggle').checked = this.keyboard;
    }
    toast(text) { this.root.querySelector('.toast')?.remove(); const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.textContent = text; this.root.append(el); clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => el.remove(), 3900); }
    reset(empty = false) {
      this.scene.stop();this.scene.reply='';this.scene.lastMessage=null;this.scene.textOpen=null;
      for (const timers of this.jobs.values()) timers.forEach(clearTimeout); this.jobs.clear(); this.stopAudio(false);
      this.closeSheet(false); this.routeSnapshots.clear(); this.offline = false; this.keyboard = false; this.pending = null;
      this.followConversation = true; this.newContent = false; this.nextScroll = 'bottom';
      this.ui = { view: { type: 'chat' }, stack: [], space: 'home', drafts: {}, positions: {}, filter: 'notes', query: '', selectedBlock: null, context: null, attachment: null, lastNoteId: empty ? null : 'note-history', comparePane: 'after' };
      this.mirrorId = this.ui.lastNoteId; store.reset(empty); this.render(); this.renderMirror();
    }
    bind() {
      this.root.addEventListener('click', e => { const button = e.target.closest('[data-action]'); if (!button || this.suppressClick) return; this.trigger = button; this.lastTriggerRect = this.triggerRect(button); this.action(button.dataset.action, button); });
      this.bindGestures();
      this.root.addEventListener('pointerdown', e => { const button = e.target.closest('button'); if (button && !button.disabled) { this.pressed = button; this.motion.press(button); } });
      const release = () => { if (this.pressed?.isConnected) this.motion.press(this.pressed, true); this.pressed = null; };
      this.root.addEventListener('pointerup',release); this.root.addEventListener('pointercancel',release);
      this.root.addEventListener('submit', e => { e.preventDefault(); if(e.target.dataset.centerForm){this.centers.submit(e.target);return;} if(e.target.dataset.draftKey)this.send(undefined, { key: e.target.dataset.draftKey }); });
      this.root.addEventListener('input', e => {
        if(this.centers.input(e.target))return;
        if (e.target.matches('.composer textarea')) { const key = e.target.dataset.draftKey; this.ui.drafts[key] = e.target.value; this.grow(e.target); e.target.closest('form').querySelector('.send').disabled = !e.target.value.trim() && !(key.startsWith('chat:') && this.ui.attachment); this.saveUI(); }
        if (e.target.id === 'note-search') { this.ui.query = e.target.value; this.render(); }
      });
      this.root.addEventListener('change', e => { if(this.centers.change(e.target))return; if (e.target.matches('input[type=file]')) this.attachFile(e.target.files?.[0]); });
      this.root.addEventListener('scroll', e => {
        if (!e.target.matches?.('.page-scroll')) return;
        this.ui.positions[e.target.dataset.viewKey] = e.target.scrollTop;
        e.target.classList.toggle('content-cut', e.target.scrollTop > 8);
        if (this.ui.view.type === 'chat' && this.scene.mode==='history') {
          const rect=this.root.getBoundingClientRect();
          if (`${Math.round(rect.width)},${Math.round(rect.height)}` !== this.actualSize) return;
          this.followConversation = e.target.scrollHeight - e.target.clientHeight - e.target.scrollTop < 80;
          if (this.followConversation) { this.newContent = false; this.root.querySelector('.new-content')?.remove(); }
        }
      }, true);
      this.root.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (this.scene.active) this.scene.action('voice-end'); else if (this.sheet) this.panelBack(); else if (this.player) this.stopAudio(); else if (this.keyboard) { this.keyboard = false; this.render(); } else if (this.detail) this.back(); }
        if (e.key === 'Tab' && this.sheet) {
          const elements = [...this.root.querySelectorAll('.sheet button:not(:disabled), .sheet textarea, .sheet input')].filter(el => el.offsetHeight > 0);
          const first = elements[0], last = elements.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      });
      document.querySelector('#desktop-mirror').addEventListener('click', e => {
        const choose = e.target.closest('[data-mirror-note]'); if (choose) { this.mirrorId = choose.dataset.mirrorNote; this.renderMirror(); }
        const edit = e.target.closest('[data-desktop-edit]'); if (edit) { store.desktopEdit(edit.dataset.desktopEdit); this.toast('桌面已经更新，手机显示同一篇最新版。'); }
      });
      document.querySelector('#device-size').addEventListener('change', e => { const [w, h] = e.target.value.split(',').map(Number); this.setSize(w, h); });
      document.querySelector('#text-size').addEventListener('change', e => {this.root.style.setProperty('--text-scale', e.target.value);this.render();});
      document.querySelector('#offline-toggle').addEventListener('change', e => { this.offline = e.target.checked; this.render(); });
      document.querySelector('#readonly-toggle').addEventListener('change', e => this.switchSpace(e.target.checked ? 'shared' : 'home'));
      document.querySelector('#consent-toggle').addEventListener('change', e => { store.data.consent = !e.target.checked; store.commit(); });
      document.querySelector('#keyboard-toggle').addEventListener('change', e => { this.keyboard = e.target.checked; this.render(); if (this.keyboard && this.ui.view.type === 'chat') this.root.querySelector('.page-scroll').scrollTop = this.root.querySelector('.page-scroll').scrollHeight; });
      document.querySelector('#motion-toggle').addEventListener('change', e => { this.root.classList.toggle('motion-off', e.target.checked); if (e.target.checked) this.motion.finish(); this.scene.sync(); });
      document.querySelector('#glass-toggle').addEventListener('change', e => this.root.classList.toggle('no-glass', !e.target.checked));
      document.querySelector('#preview-flow').addEventListener('click', () => this.scene.flow.replayEntry());
      document.querySelector('#first-run').addEventListener('click', () => this.reset(true));
      document.querySelector('#reset-demo').addEventListener('click', () => this.reset());
      window.addEventListener('storage', e => {
        if (e.key !== store.key || !e.newValue) return;
        try { const next = JSON.parse(e.newValue); if (next?.schema !== 5) return; store.data = next; this.render(); this.renderMirror(); this.toast('另一个窗口改过了，这份数据已经同步。'); } catch { /* a write from a different tab may be mid-flight */ }
      });
    }
    bindGestures() {
      this.root.addEventListener('pointerdown', e => {
        if (e.button !== 0 || this.motion.off) return;
        const rect = this.root.getBoundingClientRect();
        const panelDrag = this.sheet && e.target.closest('.sheet-head') && !e.target.closest('button');
        const edgeBack = !this.sheet && this.detail && e.clientX-rect.left < 26 && !e.target.closest('button,input,textarea');
        if (!panelDrag && !edgeBack) return;
        this.gesture = {type:panelDrag?'panel':'back', x:e.clientX,y:e.clientY,at:performance.now(),id:e.pointerId, started:false};
      });
      this.root.addEventListener('pointermove', e => {
        const g = this.gesture; if (!g || g.id !== e.pointerId) return;
        const delta = g.type === 'back' ? e.clientX-g.x : e.clientY-g.y;
        const cross = g.type === 'back' ? e.clientY-g.y : e.clientX-g.x;
        if (!g.started && Math.abs(cross)>12 && Math.abs(cross)>Math.abs(delta)) {this.gesture=null;return;}
        if (delta<5 && !g.started) return;
        if (!g.started) {
          g.started=true;this.root.setPointerCapture(e.pointerId);this.motion.cancel(g.type==='back'?this.surface.querySelector('.page-scroll'):this.panelBox);
          if(g.type==='back') {
            const previous=this.ui.stack.at(-1)?.view;
            const saved=previous && this.routeSnapshots.get(`${this.ui.space}:${previous.type}:${previous.id||'thread'}`);
            if(saved) {
              const viewport=this.surface.querySelector('.viewport');this.root.querySelectorAll('.route-ghost').forEach(el=>el.remove());
              g.preview=this.visualClone(saved.node,'route-ghost');g.preview.style.cssText=`position:absolute;left:0;top:0;width:${viewport.clientWidth}px;height:${viewport.clientHeight}px;`;
              viewport.insertBefore(g.preview,this.surface.querySelector('.page-scroll'));g.preview.scrollTop=saved.scroll;
            }
          }
        }
        g.delta=Math.max(0,delta); const node=g.type==='back'?this.surface.querySelector('.page-scroll'):this.panelBox;
        node.style.transform = g.type==='back'?`translateX(${g.delta}px)`:`translateY(${g.delta*.85}px)`;
        if(g.preview) {g.preview.style.transform=`translateX(${-this.root.clientWidth*.24+g.delta*.24}px)`;g.preview.style.opacity=String(.65+.35*clamp(g.delta/this.root.clientWidth,0,1));}
        e.preventDefault();
      });
      const end = (e, cancelled=false) => {
        const g=this.gesture;if (!g || g.id!==e.pointerId) return;this.gesture=null;
        if (!g.started) return;
        if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
        this.suppressClick=true; setTimeout(()=>{this.suppressClick=false;},0);
        const node=g.type==='back'?this.surface.querySelector('.page-scroll'):this.panelBox;
        const current=this.motion.capture(node);g.preview?.remove();
        const commit=!cancelled && (g.delta>(g.type==='back'?this.root.clientWidth*.28:90) || (g.delta>35 && g.delta/(performance.now()-g.at)>.55));
        if (commit) {node.style.transform=current.transform;if(g.type==='back')this.back();else this.panelBack();}
        else {node.style.transform='';this.motion.settle(node,current);}
      };
      this.root.addEventListener('pointerup',e=>end(e)); this.root.addEventListener('pointercancel',e=>end(e,true));
      this.root.addEventListener('keydown',e=>{
        const selected=e.target.closest('[role="tab"]'); if (!selected || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
        e.preventDefault(); const tabs=[...this.surface.querySelectorAll('[role="tab"]')]; let index=tabs.indexOf(selected);
        index=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
        this.tab(tabs[index].dataset.tab);this.surface.querySelector(`[data-tab="${tabs[index].dataset.tab}"]`)?.focus({preventScroll:true});
      });
    }
    updateSizeClasses() {
      const {width,height}=this.root.getBoundingClientRect();const geometry=`${Math.round(width)},${Math.round(height)}`;
      this.root.classList.toggle('narrow',width<360);this.root.classList.toggle('short',height<=720);
      if(this.actualSize===geometry)return false;this.actualSize=geometry;return true;
    }
    setSize(width, height) { this.root.style.setProperty('--device-w', `${width}px`); this.root.style.setProperty('--device-h', `${height}px`); this.updateSizeClasses(); this.render(); }
    action(action, button) {
      if(this.centers.action(action,button))return;
      if(!accounts.user && !['back','close-sheet','dismiss-panels','panel-back'].includes(action))return;
      const data = button.dataset;
      if(action==='dialogue-mode')return this.scene.setMode(data.mode);
      if(action==='scene-return'){this.scene.textOpen=false;this.keyboard=false;return this.render();}
      if(this.scene.action(action))return;
      switch (action) {
        case 'tab': return this.tab(data.tab);
        case 'jump-latest': this.followConversation = true; this.newContent = false; this.nextScroll = 'bottom'; return this.render();
        case 'back': return this.back();
        case 'menu': case 'spaces': case 'attach': return this.openSheet(action);
        case 'close-sheet': case 'dismiss-panels': return this.closeSheet();
        case 'panel-back': return this.panelBack();
        case 'menu-notes': this.ui.filter = 'notes'; return this.tab('notes');
        case 'filter': this.ui.filter = data.filter; return this.render();
        case 'open-note': return this.openNote(data.id);
        case 'open-current-note': {
          const previous = this.ui.stack.at(-1)?.view;
          if (previous?.type === 'reader' && previous.id === this.ui.view.id) return this.back();
          return this.navigate({ type: 'reader', id: this.ui.view.id }, { replace: true });
        }
        case 'compare': this.ui.comparePane = 'after'; return this.navigate({ type: 'compare', id: data.id });
        case 'compare-pane': {const direction=data.pane==='after'?1:-1;this.ui.comparePane = data.pane;this.render();const content=this.surface.querySelector('.compare-content');if(content)this.motion.play(content,frames(p=>({transform:`translateX(${direction*16*(1-p)}px)`,opacity:.3+.7*clamp(p,0,1)})),{duration:330});return;}
        case 'select-block': this.ui.selectedBlock = this.ui.selectedBlock === data.id ? null : data.id; return this.render();
        case 'ask': case 'ask-image': return this.openAsk();
        case 'open-image': return this.navigate({ type: 'image', id: data.id });
        case 'prompt': this.scene.stop();this.scene.textOpen=true;this.ui.drafts[this.draftKey] = [this.ui.drafts[this.draftKey],data.text].filter(Boolean).join('\n\n'); this.render(); return this.root.querySelector(this.sheet?.type === 'ask' ? '#ask-input' : '#chat-input')?.focus({ preventScroll: true });
        case 'sample-image': return this.attachSample();
        case 'pick-image': return this.root.querySelector('#image-file').click();
        case 'camera': return this.root.querySelector('#camera-file').click();
        case 'remove-attachment': this.ui.attachment = null; return this.render();
        case 'remove-reference': this.ui.context = null; return this.render();
        case 'choose-note': this.pendingEdit = null; return this.openSheet('choose-note');
        case 'choose-note-item': {
          const note = store.note(data.id); const pending = this.pendingEdit;if(!pending)this.scene.stop();
          this.ui.context = { noteId: note.id, noteVersion: note.version };
          this.closeSheet(false);
          if (pending) return this.send(pending.text, { ...pending.options, context: this.ui.context });
          this.scene.textOpen=true;this.tab('chat');return this.root.querySelector('#chat-input')?.focus({preventScroll:true});
        }
        case 'archive-to-thread': return this.tab('chat');
        case 'quote-archive': {
          const thread = store.conversation(this.ui.view.id); const message = thread?.messages.find(m => m.id === data.id);
          if (!message) return this.toast('这条消息已经不在了。');
          this.ui.context = { conversationId: thread.id, noteId: message.noteId, quote: message.text.slice(0, 120) };
          this.tab('chat'); this.renderMirror();
          return this.root.querySelector('#chat-input')?.focus({ preventScroll: true });
        }
        case 'start-review': this.ui.reviewStep = 'recall'; this.ui.review = { noteId: data.id, blockId: null, answer: this.ui.review?.noteId === data.id ? this.ui.review.answer : '' }; return this.navigate({ type: 'review', id: data.id });
        case 'review-reveal': { const area = this.root.querySelector('#review-answer'); this.ui.review = { ...(this.ui.review || {}), noteId: this.ui.view.id, blockId: data.id, answer: (area?.value || '').trim() }; this.ui.reviewStep = 'compare'; return this.render(); }
        case 'review-record': {
          try {
            store.recordRecall({ noteId: data.id, blockId: data.block, level: data.level, answer: this.ui.review?.answer });
            this.ui.reviewStep = 'plan'; return this.render();
          } catch (error) { return this.toast(error.message); }
        }
        case 'review-plan': {
          const record = store.recallFor(data.id).at(-1);
          if (record) record.longTerm = data.long === '1';
          store.commit(); this.ui.reviewStep = null; this.ui.review = null;
          this.toast(data.long === '1' ? `已排进长期复习，${Store.nextGap(record?.level)} 天后再来回想这一篇。` : '这次只记下结果，不排进长期复习。');
          this.tab('stuff');
          return;
        }
        case 'note-history': return this.navigate({ type: 'history', id: data.id });
        case 'compare-version': { this.ui.comparePane = 'before'; this.ui.selectedBlock = null; this.navigate({ type: 'compare', id: data.id }); return this.toast(`已定位到第 ${data.version} 版，右边是现在的正文。`); }
        case 'export-note': return this.exportNote(data.id);
        case 'export-space': return this.exportSpace();
        case 'open-conversation': return this.navigate({ type: 'archive', id: data.id });
        case 'task-conversation': { const task = store.data.tasks.find(t => t.id === data.id); const thread = store.conversation(task?.conversationId); return thread?.status === 'archived' ? this.navigate({ type: 'archive', id: thread.id }) : this.tab('chat'); }
        case 'stop-task': return this.stopTask(data.id);
        case 'retry-task': return this.retryTask(data.id);
        case 'resolve-task': return this.resolveTask(data.id);
        case 'consent-info': return this.openSheet('consent');
        case 'accept-consent': { const pending = this.pending; if (!pending && this.panelStack.length) { store.data.consent=true; this.panelBack(); return store.commit(); } this.closeSheet(false); this.sheet = pending?.returnSheet || null; store.data.consent = true; store.commit(); if (pending) return this.send(pending.text, pending.options); return; }
        case 'decline-consent': { const pending = this.pending; if (!pending && this.panelStack.length) return this.panelBack(); this.closeSheet(false); this.sheet = pending?.returnSheet || null; this.render();return this.root.querySelector(this.sheet?.type==='ask'?'#ask-input':'#chat-input')?.focus({preventScroll:true}); }
        case 'revoke-consent': store.data.consent = false; store.commit(); return this.closeSheet();
        case 'switch-space': return this.switchSpace(data.space);
        case 'toggle-motion': this.root.classList.toggle('motion-off'); if (this.motion.off) this.motion.finish(); document.querySelector('#motion-toggle').checked = this.root.classList.contains('motion-off'); return this.render();
        case 'play-note': return this.playNote(data.id);
        case 'play-message': { const message = this.conversation.messages.find(m => m.id === data.id); if (message) return this.playParts([{ text: message.text }], '伴星的这一段回复'); return; }
        case 'pause-audio': if (!this.player) return; this.player.paused = !this.player.paused;this.scene.speaking=!this.player.paused;this.scene.model.setLevel(0); if (this.player.paused) speechSynthesis.pause(); else speechSynthesis.resume(); return this.render();
        case 'stop-audio': return this.stopAudio();
        case 'interrupt-audio': this.stopAudio(false); if (this.detail) return this.openAsk(); this.render(); return this.root.querySelector('#chat-input')?.focus({ preventScroll: true });
        case 'close-keyboard': this.keyboard = false; return this.render();
        case 'key': this.ui.drafts[`chat:${this.ui.space}`] = (this.ui.drafts[`chat:${this.ui.space}`] || '') + data.key; return this.render();
      }
    }
  }
  const app = new MobileApp(document.querySelector('#device'));
  window.mobileDemo = { app, store, accounts, SAMPLE, GRAPH_BLOCKS };
})();
