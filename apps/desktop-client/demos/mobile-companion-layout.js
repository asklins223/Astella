/* Standalone layout review. No server writes, AI, microphone or audio requests. */
(() => {
  const escaped = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const extraIcons = {
    plus:[['path',{d:'M12 5v14M5 12h14'}]],
    menu:[['path',{d:'M4 6h16M4 12h16M4 18h16'}]],
    more:[['circle',{cx:5,cy:12,r:1}],['circle',{cx:12,cy:12,r:1}],['circle',{cx:19,cy:12,r:1}]],
    mic:[['rect',{x:9,y:2,width:6,height:12,rx:3}],['path',{d:'M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8'}]],
    send:[['path',{d:'m21 3-6.5 18-4-7.5L3 9.5 21 3ZM10.5 13.5 21 3'}]],
    pause:[['path',{d:'M9 5v14M15 5v14'}]],
    play:[['path',{d:'m8 5 11 7-11 7V5Z'}]],
    wifi:[['path',{d:'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01'}]],
    signal:[['path',{d:'M4 20v-3M9 20v-7M14 20V9M19 20V4'}]],
    folder:[['path',{d:'M3 7h6l2-3h8a2 2 0 0 1 2 2v13H3V7Z'}]],
    camera:[['rect',{x:3,y:6,width:18,height:14,rx:2}],['path',{d:'M8 6l2-3h4l2 3'}],['circle',{cx:12,cy:13,r:4}]],
  };
  function icon(name) {
    const nodes = window.NOTEBOOK_ICONS[name] || extraIcons[name] || window.NOTEBOOK_ICONS['file-text'];
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${nodes.map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).map(([key,val])=>`${key}="${escaped(val)}"`).join(' ')}></${tag}>`).join('')}</svg>`;
  }
  const avatar = size => `<span class="avatar${size ? ` ${size}` : ''}"><img src="mobile-companion-character.png" alt="正在桌边记笔记的鲸鱼伴星"></span>`;
  const row = (action, ico, title) => `<button class="sheet-row" data-action="${action}">${icon(ico)}${title}${icon('chevron-right')}</button>`;
  const original = '郡县制下，官员由中央任免，管理行政区。与世袭的诸侯相比，官员的职务不由家族持续继承。这让中央对地方的组织与控制更直接。';
  class MobilePreview {
    constructor(root, options={}) {
      this.root=root; this.view=options.view||'chat'; this.keyboard=!!options.keyboard; this.mini=!!options.mini;
      this.draft=options.draft||''; this.tab='after'; this.sheet=''; this.audio=false; this.showDetails=false; this.sent=[]; this.positions={}; this.attachment=''; this.width=options.width||390;this.height=options.height||844;
      this.root.addEventListener('click', e=>this.click(e));
      this.root.addEventListener('submit',e=>{e.preventDefault();this.send();});
      this.root.addEventListener('input',e=>{if(e.target.matches('textarea')){this.draft=e.target.value;this.resizeInput(e.target);this.updateSend();this.measure();}});
      this.root.addEventListener('change',e=>{if(e.target.matches('input[type=file]')&&e.target.files[0]){this.attachment=e.target.files[0].name;this.sheet='';this.render();this.toast('文件仅加入本机演示草稿，没有上传。');}});
      this.root.addEventListener('keydown',e=>{if(e.key==='Escape'&&this.sheet){this.sheet='';this.render();this.root.querySelector('.identity').focus();}});
      this.resizeObserver=new ResizeObserver(()=>this.measure());this.resizeObserver.observe(root);this.render();
    }
    change(view) {
      this.positions[this.view]=this.root.querySelector('.content')?.scrollTop||0;
      this.mini=view==='mini';this.keyboard=view==='keyboard';this.view=view==='mini'?'chat':view==='keyboard'?'chat':view;
      this.sheet='';this.audio=false;
      if(view==='keyboard'&&!this.draft)this.draft='把这篇笔记的第二段改成表格，再补一个生活中的例子。';
      this.render();this.root.querySelector('.content').scrollTop=this.keyboard?this.root.querySelector('.content').scrollHeight:(this.positions[this.view]||0);
    }
    setSize(width,height) {this.width=width;this.height=height;this.root.style.setProperty('--device-w',`${width}px`);this.root.style.setProperty('--device-h',`${height}px`);this.root.classList.toggle('short-device',height<=720);const t=this.root.querySelector('textarea');if(t)this.resizeInput(t);this.measure();}
    updateSend(){const button=this.root.querySelector('.composer .send');if(button)button.disabled=!(this.draft.trim()||this.attachment);}
    resizeInput(el){el.style.height='38px';el.style.height=`${Math.min(this.keyboard&&this.height<=720?62:110,Math.max(38,el.scrollHeight))}px`;}
    render() {
      const oldScroll=this.root.dataset.view===this.view?(this.root.querySelector('.content')?.scrollTop||0):0;
      this.root.dataset.view=this.view;
      const content = this.view==='read'?this.read():this.view==='edit'?this.edit():this.view==='upload'?this.upload():this.chat();
      this.root.classList.toggle('mini',this.mini);this.root.classList.toggle('keyboard-on',this.keyboard);this.root.classList.toggle('listening',this.audio);this.root.classList.toggle('short-device',this.height<=720);
      this.root.style.setProperty('--device-w',`${this.width}px`);this.root.style.setProperty('--device-h',`${this.height}px`);
      this.root.innerHTML=`<div class="status-bar" aria-hidden="true"><span>9:41</span><span class="status-right">${icon('signal')}${icon('wifi')}<i class="battery"></i></span></div>
        <header class="topbar"><button class="icon-button" data-action="${this.view==='chat'?'menu':'back'}" aria-label="${this.view==='chat'?'打开菜单':'回到交流'}">${icon(this.view==='chat'?'menu':'arrow-left')}</button>
        <button class="identity" data-action="meet" aria-label="展开伴星入口">${avatar()}<span class="identity-copy"><strong>伴星</strong><small><i class="live-dot"></i>${this.view==='read'?'陪你读':'在你身边'}</small></span></button>
        <div class="top-actions">${this.mini?'<span class="capsule" aria-label="小程序宿主胶囊占位"><b>•••</b><i></i><span class="exit-ring"></span></span>':'<button class="icon-button" data-action="history" aria-label="对话手记">'+icon('history')+'</button>'}<button class="space-button" data-action="space">我的书房${icon('chevron-down')}</button></div></header>
        <section class="content" aria-label="${this.view==='read'?'笔记正文':'当前内容'}" tabindex="0">${content}</section>
        <footer class="bottom-panel">${this.audio?this.audioControls():this.composer()}</footer><div class="bottom-safe" aria-hidden="true"><span class="home-indicator"></span></div>
        ${this.keyboard?this.keyboardMarkup():''}${this.sheet?this.sheetMarkup():''}<input type="file" hidden accept=".pdf,.docx,.txt,.md,image/*" aria-label="选择本机文件">`;
      this.root.querySelector('.content').scrollTop=oldScroll;
      const textarea=this.root.querySelector('textarea');if(textarea)this.resizeInput(textarea);this.measure();
      if(this.sheet)this.root.querySelector('.sheet-heading button').focus({preventScroll:true});
    }
    composer(){return `${this.attachment?`<div class="attachment-draft">${icon('file-text')}<span>${escaped(this.attachment)}</span><button data-action="remove-file" aria-label="移除草稿附件">${icon('x')}</button></div>`:''}<form class="composer"><button class="icon-button" type="button" data-action="attach" aria-label="递材料">${icon('plus')}</button><div class="input-shell"><textarea rows="1" aria-label="和伴星说话" placeholder="${this.view==='read'?'问这篇笔记…':this.view==='edit'?'还想怎么改？':'和伴星说点什么…'}">${escaped(this.draft)}</textarea><button class="icon-button" type="button" data-action="voice" aria-label="语音输入">${icon('mic')}</button></div><button class="send" type="submit" aria-label="发送演示消息" ${!(this.draft.trim()||this.attachment)?'disabled':''}>${icon('send')}</button></form>`;}
    delivery(){return `<div class="note-delivery"><div class="saved">${icon('check')}已保存 · 我的书房</div><h3>世袭与任命</h3><p>两种地方治理方式的区别，和一个便于理解的例子。</p><button class="source-link" data-action="read">${icon('book-open')}打开笔记${icon('chevron-right')}</button></div>`;}
    chat(){return `<div class="date-line">今天 14:32 · 来自电脑</div><div class="message user"><div class="user-bubble">为什么郡县制更利于中央管理？</div></div><div class="message companion"><div class="byline">伴星</div><div class="inline-tool">${icon('check')}已读《中国古代史总揽》</div><div class="reply-paper"><p>可以先看：<strong>地方官员从哪里来，又由谁决定去留。</strong></p><p>分封制下，诸侯通常世袭，治理自己的封地。郡县制下，官员由中央任免，管理行政区。</p><p>因此，中央更容易调整地方的人事安排。关键不是名字变了，而是任命关系变了。</p><button class="source-link" data-action="read">${icon('file-text')}对照原文${icon('chevron-right')}</button></div></div><div class="message user"><div class="user-bubble">整理成一篇笔记，之后我想接着学。</div></div><div class="message companion"><div class="byline">伴星 · 14:35</div>${this.delivery()}</div>${this.sent.map(text=>`<div class="message user"><div class="user-bubble">${escaped(text)}</div></div><div class="message companion"><p>这条消息已加入本机演示记录。正式处理需要接入同一 Agent。</p></div>`).join('')}`;}
    read(){return `<article class="article"><div class="article-meta">${icon('book-open')}我的书房 · 笔记 v1</div><h1 class="article-title">从世袭到任命</h1><p class="lead">理解两种制度，先看官员从哪里来，再看他们对谁负责。</p><button class="listen-button" data-action="listen">${icon('play')}听伴星讲这篇</button><h2>地方治理，为什么要先看“人”？</h2><p>制度不是一个抽象的名字。它需要具体的人来治理一片地方：处理事务、组织资源，也向上承担责任。</p><p>要比较分封制和郡县制，可以先问两个问题：这个位置由谁得到？下一任又由谁决定？</p><div class="quote"><p>从“家族继承”转向“中央任免”，改变的是官员与地方、官员与中央之间的关系。</p></div><h2>分封制：位置与家族相连</h2><p>诸侯治理自己的封地，身份常由家族继承。这让地方具有较强的延续性，也意味着中央不能只通过一次人事调整来改变地方的治理者。</p><h2 class="spoken">郡县制：中央任免官员</h2><p class="spoken">郡县制下，官员由中央任免，管理行政区。职务与家族继承的关系减弱，中央可以通过任命来调整地方的人事安排。</p><div class="diagram"><span>中央</span><small>任命${icon('arrow-right')}</small><span>地方官员</span></div><h2>用一个例子想清楚</h2><p>想象一处地方需要更换治理者。如果这一位置属于世袭家族，更换治理者牵涉家族与封地；如果它是由中央任命的职务，中央就能沿职务关系另派官员。</p><p>这个例子用于帮助理解任命关系，并不意味着两种制度在每个时期都只有一种固定做法。进一步学习时，还要回到具体时代和材料。</p><h2>试着自己讲一遍</h2><p>不看前文，用两句话说明两种制度的区别。先讲官员怎么产生，再讲这个变化怎样影响中央与地方的关系。</p><button class="source-link" data-action="edit">${icon('notebook-pen')}让伴星把这一段整理为表格${icon('chevron-right')}</button></article>`;}
    upload(){return `<h1 class="page-heading">交给伴星的材料</h1><p class="edit-context">这一轮的文件、图片和处理进展。</p><div class="message user" style="margin-top:20px"><div class="user-bubble">读这份资料，再帮我整理成笔记。</div></div><div class="file-card"><div class="file-heading"><span class="file-icon">PDF</span><div class="file-name"><strong>古代制度与地方治理——阅读材料.pdf</strong><small>PDF · 2.4 MB · 已上传</small></div></div><div class="file-status">${icon('loader-circle')}<span>${this.stopped?'已停止后续处理':'正在解析文件'}</span><button data-action="stop">${this.stopped?'继续演示':'停止'}</button></div></div><p class="message">解析完成后，我会先读材料，再整理。当前文件还没有读完。</p><div class="file-card"><div class="file-heading"><span class="file-icon" style="background:#7ea790">JPG</span><div class="file-name"><strong>书页照片.jpg</strong><small>图片已就绪 · 原图保留</small></div></div><button class="source-link" data-action="photo">${icon('scan-text')}看看图片和所指区域${icon('chevron-right')}</button></div><button class="disclosure" data-action="details">${icon('list-tree')}做事经过${icon('chevron-down')}</button>${this.showDetails?'<div class="task-detail"><span>已接收文件（演示）</span><span>正文解析中（演示）</span><span>尚未创建笔记</span></div>':''}<div class="note-delivery"><div class="saved">${icon('book-open')}手边的内容</div><h3>世袭与任命</h3><p>可以先阅读已经保存的笔记，文件任务保持在这一轮。</p><button class="source-link" data-action="read">打开这篇${icon('chevron-right')}</button></div>`;}
    edit(){return `<p class="edit-context">你的要求：把第二段改成表格</p><div class="status-receipt">${icon('check')}${this.reverted?'演示正文已还原':'已保存 · 第二段已修改'}</div><h1 class="page-heading">两种制度的区别</h1><div class="tabs" aria-label="修改对照"><button data-action="after" class="${this.tab==='after'?'selected':''}" aria-pressed="${this.tab==='after'}">修改后</button><button data-action="before" class="${this.tab==='before'?'selected':''}" aria-pressed="${this.tab==='before'}">原文</button></div>${this.tab==='before'||this.reverted?`<article class="article"><p>${original}</p></article>`:'<div class="table-wrap"><table><thead><tr><th>制度</th><th>官员产生</th><th>管理方式</th></tr></thead><tbody><tr><td>分封制</td><td>世袭</td><td>诸侯治理</td></tr><tr><td>郡县制</td><td>中央任免</td><td>中央派官</td></tr></tbody></table></div>'}<div class="change-summary">关键变化：官员的任命更直接地掌握在中央手中。</div><button class="quiet-action" data-action="read">${icon('book-open')}回到整篇笔记${icon('chevron-right')}</button><button class="quiet-action" data-action="undo">${icon('rotate-ccw')}${this.reverted?'恢复演示修改':'撤回这次演示修改'}</button><p class="edit-context" style="margin-top:20px">修改保持在同一篇笔记里；原文和改动可以就近核对。</p>`;}
    audioControls(){return `<div class="audio-controls"><button class="send" data-action="pause" aria-label="${this.paused?'继续演示播放':'暂停演示播放'}">${icon(this.paused?'play':'pause')}</button><div class="audio-label">${this.paused?'已暂停':'正在讲：中央任免'}<span>00:18 / 01:02 · 演示</span></div><button class="ask" data-action="ask">我想问</button></div>`;}
    keyboardMarkup(){const keys=(chars,cls='')=>`<div class="key-row ${cls}">${chars.map(ch=>`<button data-key="${escaped(ch)}">${escaped(ch)}</button>`).join('')}</div>`;return `<div class="native-keyboard" aria-label="292px 系统键盘布局占位"><div class="suggestions"><span>任命</span><span>中央</span><span>继续</span></div>${keys('qwertyuiop'.split(''))}${keys('asdfghjkl'.split(''),'row-2')}${keys(['⇧',...'zxcvbnm'.split(''),'⌫'],'row-3')}<div class="key-row last-row"><button data-key="123">123</button><button data-key="中文">中文</button><button class="space-key" data-key=" ">空格</button><button class="done-key" data-action="close-keyboard">完成</button></div><div class="keyboard-bottom"><span>◎</span><span>♧</span></div><span class="keyboard-home"></span></div>`;}
    sheetMarkup(){let body='';let title='';if(this.sheet==='menu'){title='我的书房';body=row('upload','folder','手边材料与事项')+row('history','history','对话手记')+row('space','book-open','切换空间')+row('meet','sparkles','看看伴星');}else if(this.sheet==='history'){title='对话手记';body='<p>连续交流保留在同一份记录里。</p>'+row('back','message-square-text','今天 · 制度的演变')+row('upload','file-text','交给伴星的事')+row('read','book-open','刚保存的笔记');}else if(this.sheet==='attach'){title='递材料给伴星';body=row('pick-file','file-text','选择文件')+row('pick-file','camera','选择图片')+row('upload','folder','已有材料')+row('read','book-open','引用手边这篇');}else if(this.sheet==='space'){title='当前空间';body=row('close','check','我的书房')+'<p style="margin-top:16px">此布局稿不连接真实账号，不执行空间切换。</p>';}else if(this.sheet==='photo'){title='图片与所指区域';body='<p>原图、区域位置与问题在同一份草稿中。这里验证图片阅读入口，实际圈选能力仍需接入。</p>'+row('pick-file','camera','选择本机图片');}else {title='伴星';body=`<div class="meet">${avatar()}<div><h3>我在这里。</h3><p>想读哪一段，或把什么交给我？</p></div></div>`+row('back','message-square-text','回到我们的交流')+row('read','book-open','接着读这篇')+row('attach','plus','递一份材料');}return `<div class="sheet-host"><button class="scrim" data-action="close" aria-label="关闭展开页"></button><section class="sheet" role="dialog" aria-label="${title}"><div class="sheet-handle"></div><div class="sheet-heading"><h2>${title}</h2><button class="icon-button" data-action="close" aria-label="关闭">${icon('x')}</button></div>${body}</section></div>`;}
    click(e) {
      const key=e.target.closest('[data-key]');if(key){const value=key.dataset.key;if(value==='⌫')this.draft=this.draft.slice(0,-1);else if(value!=='⇧'&&value!=='123'&&value!=='中文')this.draft+=value;const t=this.root.querySelector('textarea');if(t){t.value=this.draft;this.resizeInput(t);this.updateSend();}return;}
      const button=e.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
      if(['menu','history','attach','space','meet','photo'].includes(action)){this.sheet=action;this.render();return;}
      if(['read','edit','upload'].includes(action)){this.change(action);return;}
      if(action==='back'){this.change('chat');return;}
      if(action==='close'){this.sheet='';this.render();return;}
      if(action==='pick-file'){this.root.querySelector('input[type=file]').click();return;}
      if(action==='remove-file'){this.attachment='';this.render();return;}
      if(action==='after'||action==='before'){this.tab=action;this.render();return;}
      if(action==='undo'){this.reverted=!this.reverted;this.render();this.toast('仅修改本机演示正文，没有业务写入。');return;}
      if(action==='details'){this.showDetails=!this.showDetails;this.render();return;}
      if(action==='stop'){this.stopped=!this.stopped;this.render();return;}
      if(action==='listen'){this.audio=true;this.paused=false;this.render();return;}
      if(action==='pause'){this.paused=!this.paused;this.render();return;}
      if(action==='ask'){this.audio=false;this.keyboard=true;this.render();this.root.querySelector('textarea').focus();return;}
      if(action==='close-keyboard'){this.keyboard=false;this.render();return;}
      if(action==='voice'){this.toast('此处只评审入口与占位，不启用麦克风。');}
    }
    send(){if(!(this.draft.trim()||this.attachment))return;this.sent.push(this.draft.trim()||`附件：${this.attachment}`);this.draft='';this.attachment='';this.view='chat';this.sheet='';this.render();this.root.querySelector('.content').scrollTop=this.root.querySelector('.content').scrollHeight;}
    toast(message){this.root.querySelector('.toast')?.remove();const div=document.createElement('div');div.className='toast';div.textContent=message;this.root.append(div);clearTimeout(this.toastTimer);this.toastTimer=setTimeout(()=>div.remove(),2500);}
    measure(){const rootRect=this.root.getBoundingClientRect();const rect=selector=>{const r=this.root.querySelector(selector)?.getBoundingClientRect();return r?{x:r.x-rootRect.x,y:r.y-rootRect.y,width:r.width,height:r.height,bottom:r.bottom-rootRect.y}:null;};this.metrics={viewport:{width:this.root.clientWidth,height:this.root.clientHeight},header:rect('.topbar'),status:rect('.status-bar'),content:rect('.content'),composer:rect('.bottom-panel'),keyboard:rect('.native-keyboard'),bodyScrollHeight:this.root.querySelector('.content')?.scrollHeight||0};this.root.dataset.contentHeight=String(Math.round(this.metrics.content?.height||0));if(this.onMeasure)this.onMeasure(this.metrics);}
  }
  const qs=new URLSearchParams(location.search);
  if(qs.has('board')){
    const second=qs.get('board')==='2';const cases=second?[{view:'upload',label:'材料处理',sub:'任务与长文件名'},{view:'edit',label:'修改与对照',sub:'原文切换可操作'},{view:'chat',mini:true,label:'小程序',sub:'角色与宿主胶囊各有位置'}]:[{view:'chat',label:'连续聊天',sub:'120px 角色 · 玻璃对话面'},{view:'chat',keyboard:true,draft:'把第二段改成表格，再补一个生活中的例子。',label:'键盘展开',sub:'角色随输入收拢 · 键盘占位'},{view:'read',label:'长文阅读',sub:'厚磨砂正文 · 可滚到底'}];
    const bench=document.getElementById('workbench');bench.className='workbench gallery';bench.innerHTML=`<header><div><p class="eyebrow">ASTELLA · 随身伴星</p><h1>${second?'递给伴星，接着看与学。':'玻璃里的书房，身边的伴星。'}</h1></div><p>真实 HTML / CSS · 390 × 844 · 本机交互样例</p></header><div class="gallery-grid">${cases.map((c,i)=>`<figure><div id="device-${i}" class="phone"></div><figcaption><span>${String(i+(second?4:1)).padStart(2,'0')} ${c.label}</span><small>${c.sub}</small></figcaption></figure>`).join('')}</div>`;
    window.mobilePreviews=cases.map((c,i)=>new MobilePreview(document.getElementById(`device-${i}`),c));window.mobilePreviews.forEach(p=>{if(p.keyboard)p.root.querySelector('.content').scrollTop=p.root.querySelector('.content').scrollHeight;});
  } else {
    const preview=new MobilePreview(document.getElementById('device'));window.mobilePreview=preview;
    preview.onMeasure=metrics=>{document.getElementById('metrics').textContent=`正文可视高度 ${Math.round(metrics.content.height)}px · 顶栏 ${Math.round(metrics.header.height)}px · 输入 ${Math.round(metrics.composer.height)}px${metrics.keyboard?' · 键盘占位 '+Math.round(metrics.keyboard.height)+'px':''}`;};preview.measure();
    document.querySelectorAll('.lab-views button[data-view]').forEach(button=>button.addEventListener('click',()=>{preview.change(button.dataset.view);document.querySelectorAll('.lab-views button[data-view]').forEach(b=>b.classList.toggle('active',b===button));document.getElementById('keyboard-toggle').checked=preview.keyboard;}));
    document.getElementById('device-size').addEventListener('change',e=>preview.setSize(...e.target.value.split(',').map(Number)));
    document.getElementById('text-size').addEventListener('change',e=>preview.root.style.setProperty('--text-scale',e.target.value));
    document.getElementById('keyboard-toggle').addEventListener('change',e=>{preview.keyboard=e.target.checked;preview.render();});
    document.getElementById('glass-toggle').addEventListener('change',e=>preview.root.classList.toggle('no-blur',!e.target.checked));
  }
})();
