/* Account and companion pages share the existing route/panel system. No separate chat. */
(() => {
  const TYPES = ['login','register','profile','profile-edit','settings','companion','personality','memories','memory-edit','diary','diary-entry'];
  const TITLES = { login:'登录', register:'创建账号', profile:'个人中心', 'profile-edit':'编辑资料', settings:'设置', companion:'伴星中心', personality:'她的表达', memories:'她记得的事', 'memory-edit':'修正记忆', diary:'我们的日记', 'diary-entry':'日记' };
  class Centers {
    constructor(app, accounts, store, helpers) { this.app=app; this.accounts=accounts; this.store=store; Object.assign(this,helpers); this.forms={}; this.error=null; this.busy=false; }
    get active() { return TYPES.includes(this.app.ui.view.type); }
    get auth() { return ['login','register'].includes(this.app.ui.view.type); }
    get user() { return this.accounts.user; }
    get buddy() { return this.user?.companion; }
    clear() { this.forms={}; this.error=null; this.busy=false; }
    open(type, extra={}) { this.forms={}; this.error=null; this.app.keyboard=false; this.app.navigate({type,...extra}); }
    avatar(user=this.user) { return `<span class="account-avatar">${user?.avatar ? `<img src="${this.esc(user.avatar)}" alt="账户头像">` : this.esc(user?.displayName?.slice(0,1) || '星')}</span>`; }
    header() {
      const type=this.app.ui.view.type;
      return `<header class="utility-header" data-node-key="header">${type==='login' ? '<span class="auth-brand"><i>✦</i>拾星笔记<small>ASTELLA</small></span>' : `<button class="icon-button glass top-left" data-action="${type==='register' ? 'auth-mode' : 'back'}" data-mode="login" aria-label="返回上一页">${this.icon('arrow-left')}</button><span class="utility-header-title">${TITLES[type]}</span>`}${type==='companion' ? `<button class="header-profile" data-action="profile" aria-label="个人中心">${this.avatar()}</button>` : '<span class="header-end" aria-hidden="true"></span>'}</header>`;
    }
    field(name,label,value='',opts={}) {
      const error=this.error?.field===name;
      const type=opts.type || 'text', password=type==='password';
      return `<div class="account-field"><label for="field-${name}">${label}${opts.optional ? '<small>选填</small>' : ''}</label><div class="field-input${opts.glass ? ' glass' : ''}"><input id="field-${name}" name="${name}" type="${type}" value="${this.esc(value)}" ${opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : ''} ${opts.maxlength ? `maxlength="${opts.maxlength}"` : ''} ${opts.placeholder ? `placeholder="${this.esc(opts.placeholder)}"` : ''} ${error ? 'aria-invalid="true" aria-describedby="form-error"' : ''}>${password ? `<button type="button" class="password-eye" data-action="password-visibility" data-field="${name}" aria-label="显示${label}" aria-pressed="false">${this.icon('eye')}</button>` : ''}</div></div>`;
    }
    errorMarkup() { return `<p id="form-error" class="form-error" role="alert" ${this.error ? '' : 'hidden'}>${this.esc(this.error?.message || '')}</p>`; }
    submitButton(label) { return `<button type="submit" class="primary" ${this.busy ? 'disabled' : ''}>${this.busy ? '正在处理…' : label}</button>`; }
    authBody() {
      const register=this.app.ui.view.type==='register', f=this.forms;
      if(!register)return `<div class="auth-page login-page"><div class="login-scene">${this.portrait}</div><div class="login-heading"><h1>回到你的书房</h1><p>同一位伴星，接着上次的交流。</p></div><form class="account-form login-card glass" data-center-form="auth" novalidate><div class="login-fields">${this.field('email','邮箱',f.email,{type:'email',autocomplete:'username',maxlength:320,placeholder:'name@example.com'})}${this.field('password','密码',f.password,{type:'password',autocomplete:'current-password',maxlength:200,placeholder:'输入你的密码'})}</div><label class="account-check"><input type="checkbox" name="remember" ${f.remember!==false?'checked':''}>保持登录</label>${this.errorMarkup()}${this.submitButton('登录')}<p class="auth-switch">第一次见面？<button type="button" data-action="auth-mode" data-mode="register">创建账号 ${this.icon('chevron-right')}</button></p></form><button class="login-demo" data-action="demo-signin">先逛逛示例书房 ${this.icon('arrow-right')}</button><p class="auth-demo-note">本机演示 · 请勿使用真实密码</p></div>`;
      const authField=(name,label,value,options={})=>this.field(name,label,value,{...options,glass:true});
      return `<div class="auth-page registration-page"><div class="auth-welcome"><div class="auth-introduction"><h1>从今天，<br>一起学。</h1></div>${this.portrait}</div><p class="auth-description">一个账号，同一位伴星。</p><form class="account-form" data-center-form="auth" novalidate>${authField('displayName','怎么称呼你',f.displayName,{autocomplete:'nickname',maxlength:32,placeholder:'留一个喜欢的称呼'})}${authField('email','邮箱',f.email,{type:'email',autocomplete:'username',maxlength:320,placeholder:'name@example.com'})}${authField('password','密码',f.password,{type:'password',autocomplete:'new-password',maxlength:200,placeholder:'至少 8 位'})}${authField('confirmPassword','确认密码',f.confirmPassword,{type:'password',autocomplete:'new-password',maxlength:200,placeholder:'再输入一次密码'})}<details class="auth-invite" ${f.inviteToken||this.error?.field==='inviteToken'?'open':''}><summary>我有邀请码 ${this.icon('chevron-down')}</summary>${authField('inviteToken','邀请码',f.inviteToken,{optional:true,placeholder:'输入邀请码，加入共读书房',maxlength:100})}</details><label class="account-check"><input type="checkbox" name="remember" ${f.remember!==false?'checked':''}>保持登录</label>${this.errorMarkup()}${this.submitButton('创建账号，进入书房')}<p class="auth-switch">已经有账号？<button type="button" data-action="auth-mode" data-mode="login">去登录</button></p></form><p class="auth-demo-note">本机注册体验 · 请使用演示数据<br>邀请码示例 ASTELLA</p></div>`;
    }
    body() {
      const app=this.app, type=app.ui.view.type, {esc,icon,row}=this;
      if(this.auth)return this.authBody();
      if(!this.user)return '';
      const user=this.user, buddy=this.buddy;
      if(type==='profile')return `<div class="utility-page profile-page"><div class="profile-card glass"><div class="profile-card-top"><span class="utility-eyebrow">我的随身书房</span><button class="edit-profile-link" data-action="profile-edit" aria-label="编辑个人资料">${icon('pencil')}编辑</button></div><div class="profile-heading">${this.avatar()}<div><h1>${esc(user.displayName)}</h1><p>${esc(user.email)}</p><span class="account-device">${icon('monitor')}手机与桌面 · 同一账号</span></div></div></div><button class="account-link glass" data-action="companion" aria-label="进入伴星中心">${this.portrait}<span><small>你的学习搭档</small><strong>${esc(buddy.name)}</strong><em>认识她，也让她更懂你。</em></span><i class="card-arrow">${icon('arrow-right')}</i></button><p class="group-label">账号与日常使用</p><div class="utility-group account-options glass">${row('spaces','folder','学习空间',(user.sample || user.sharedAccess) ? '我的书房与共读书房' : '我的书房')}${row('settings','settings-2','使用设置','阅读、声音与数据授权')}</div><p class="group-label">你自己的数据</p><button class="export-line" data-action="export-space">${icon('download')}<span><strong>导出这个书房的笔记</strong><small>Markdown 整包：正文、来源、每篇的版本记录</small></span>${icon('chevron-right')}</button><button class="logout-link" data-action="logout-prompt">${icon('log-out')}退出登录</button></div>`;
      if(type==='profile-edit'){
        const f=this.forms; f.displayName ??=user.displayName; if(f.avatar===undefined)f.avatar=user.avatar;
        return `<div class="utility-page"><h1>让她认得你的称呼</h1><p class="utility-description">头像和称呼用于这个账号的在场身份。</p><form class="account-form" data-center-form="profile" novalidate><div class="avatar-editor">${this.avatar({displayName:f.displayName,avatar:f.avatar})}<div><button type="button" class="text-action" data-action="pick-avatar">更换头像</button>${f.avatar ? '<button type="button" class="text-action muted" data-action="clear-avatar">移除头像</button>' : ''}<small>图片最大 10 MB</small></div></div>${this.field('displayName','称呼',f.displayName,{maxlength:32,autocomplete:'nickname'})}<div class="readonly-field"><span>邮箱</span><strong>${esc(user.email)}</strong></div>${this.errorMarkup()}${this.submitButton('保存资料')}</form></div>`;
      }
      if(type==='settings')return `<div class="utility-page settings-page"><div class="utility-title"><p class="utility-eyebrow">让学习合你的习惯</p><h1>按你的节奏</h1></div><p class="group-label">阅读与声音</p><div class="utility-group glass settings-group"><label class="setting-field"><i class="setting-icon type-icon">Aa</i><span><strong>阅读字号</strong><small>对话与笔记正文</small></span><select name="textScale" aria-label="阅读字号"><option value="1" ${user.preferences.textScale===1?'selected':''}>标准</option><option value="1.25" ${user.preferences.textScale===1.25?'selected':''}>较大</option><option value="1.5" ${user.preferences.textScale===1.5?'selected':''}>大字</option></select></label><label class="setting-field"><i class="setting-icon">${icon('headphone')}</i><span><strong>朗读速度</strong><small>下次朗读时生效</small></span><select name="speechRate" aria-label="朗读速度">${[[.8,'慢一点'],[1,'正常'],[1.2,'快一点']].map(([n,l])=>`<option value="${n}" ${user.preferences.speechRate===n?'selected':''}>${l}</option>`).join('')}</select></label></div><div class="reading-sample settings-sample"><span class="paper-corner" aria-hidden="true"></span><small>试读一小段</small><p style="font-size:calc(15px * var(--text-scale))">先看一个例子，<br>再用自己的话解释。</p><span class="sample-rule" aria-hidden="true"></span></div><p class="group-label">对话显示</p><div class="utility-group glass"><label class="setting-field"><i class="setting-icon">${icon('message-square-text')}</i><span><strong>打开时的样子</strong><small>两种视图共用同一段交流</small></span><select name="chatLayout" aria-label="对话显示方式"><option value="scene" ${user.preferences.chatLayout!=='history'?'selected':''}>伴星场景</option><option value="history" ${user.preferences.chatLayout==='history'?'selected':''}>聊天记录</option></select></label></div><p class="group-label">由你决定</p><div class="utility-group glass account-options">${row('consent-info','shield','AI 使用与数据',this.store.data.consent?'已允许 · 随时可以撤回':'尚未允许 · 仍可阅读')}${row('memories','sparkles','伴星记忆',buddy.remember?'使用你确认的学习偏好':'已暂停使用记忆')}</div><p class="utility-footnote">换一个书房，依然照你的习惯。</p></div>`;
      if(type==='companion'){
        const current=app.conversation, context=this.store.note(app.ui.lastNoteId), latestDiary=buddy.diary.find(d=>d.space===app.ui.space);
        return `<div class="utility-page companion-page"><div class="companion-hero"><div class="buddy-introduction"><p class="utility-eyebrow">同一颗星 · 一直在你身边</p><h1><strong class="buddy-name">${esc(buddy.name)}</strong><span>在你身边</span></h1><p>读你递来的材料，<br>把知识讲清楚，把想法留下。</p><span class="buddy-status glass"><i></i>${app.activeTask?'正在帮你处理':'我在，接着刚才'}</span></div><div class="buddy-halo" aria-hidden="true"></div>${this.portrait}</div><button class="companion-resume glass" data-action="resume-companion"><span class="resume-icon">${icon('message-square-text')}</span><span><small>接着这次交流</small><strong>${esc(current?.title || '从一个问题开始')}</strong>${context?.space===app.ui.space ? `<em>最近读到《${esc(context.title)}》</em>` : '<em>说一句问题，或递来一页材料</em>'}</span><i class="card-arrow">${icon('arrow-right')}</i></button><div class="agent-actions"><button data-action="companion-idea"><i>${icon('mic')}</i><span>和她聊聊</span></button><button data-action="companion-material"><i>${icon('image')}</i><span>读一张图</span></button><button data-action="companion-note"><i>${icon('book-open')}</i><span>找笔记聊</span></button></div><div class="buddy-details"><button class="buddy-detail glass" data-action="personality"><i>${icon('sparkles')}</i><strong>她的表达</strong><small>${buddy.style==='warm'?'温暖耐心':'直接清楚'} · ${this.detailLabel(buddy.detail)}</small>${icon('chevron-right')}</button><button class="buddy-detail glass" data-action="memories"><i>${icon('history')}</i><strong>她记得的事</strong><small>${this.accounts.memories(app.ui.space).filter(m=>m.enabled).length} 条已确认${buddy.remember?'':' · 已暂停'}</small>${icon('chevron-right')}</button></div><button class="buddy-diary" data-action="diary"><span class="diary-spine" aria-hidden="true"></span><span><small>我们的日记${latestDiary ? ` · ${latestDiary.date.slice(5).replace('-',' / ')}` : ''}</small><strong>${esc(latestDiary?.title || '下一段学习，一起留下')}</strong><p>${esc(latestDiary ? latestDiary.text.split('。')[0]+'。' : '经历会留在它发生的书房。')}</p></span>${icon('chevron-right')}</button></div>`;
      }
      if(type==='personality'){
        const f=this.forms; f.name??=buddy.name; f.style??=buddy.style; f.detail??=buddy.detail;
        return `<div class="utility-page"><div class="personality-intro">${this.portrait}<div><h1>让她用熟悉的方式说</h1><p class="utility-description">名字和表达方式跟随账号。</p></div></div><form class="account-form" data-center-form="personality" novalidate>${this.field('name','她的名字',f.name,{maxlength:16})}<fieldset class="choice-group"><legend>说话风格</legend>${[['warm','温暖耐心','一步一步，留些思考空间'],['direct','直接清楚','先说重点，再给理由']].map(([v,l,d])=>`<label><input type="radio" name="style" value="${v}" ${f.style===v?'checked':''}><span><strong>${l}</strong><small>${d}</small></span></label>`).join('')}</fieldset><div class="account-field"><label for="field-detail">讲解分量</label><select id="field-detail" name="detail">${['brief','balanced','detailed'].map(v=>`<option value="${v}" ${f.detail===v?'selected':''}>${this.detailLabel(v)}</option>`).join('')}</select></div><div class="reading-sample"><small>表达预览</small><p>${esc(this.preview(f.style,f.detail))}</p></div>${this.errorMarkup()}${this.submitButton('保存她的设定')}</form></div>`;
      }
      if(type==='memories')return `<div class="utility-page"><h1>记住的，也能改</h1><p class="utility-description">由你决定哪些理解继续被使用。</p><label class="remember-setting glass"><span><strong>使用已确认的记忆</strong><small>关闭后保留记录，暂停在讲解中使用。</small></span><input type="checkbox" role="switch" name="rememberCompanion" aria-label="使用已确认的记忆" ${buddy.remember?'checked':''}></label><div class="memory-list">${this.accounts.memories(app.ui.space).map(m=>`<article class="memory-item ${m.enabled?'':'memory-paused'}" data-memory-id="${esc(m.id)}"><div class="memory-meta"><span>${m.space?'仅当前书房':'跟随账号的学习偏好'}</span><span>${m.enabled?'正在使用':'已停用'}</span></div><p>${esc(m.text)}</p><small>来自：${esc(m.source)}</small><div class="memory-actions"><button data-action="memory-edit" data-id="${m.id}">修正</button><button data-action="memory-toggle" data-id="${m.id}">${m.enabled?'停用这条':'重新使用'}</button>${m.conversationId ? `<button data-action="memory-source" data-id="${m.id}">看原交流</button>` : ''}</div></article>`).join('') || '<div class="utility-empty">还没有确认的记忆。<p>先一起学习，想让她长期记住时再确认。</p></div>'}</div></div>`;
      if(type==='memory-edit'){
        const memory=this.accounts.memories(app.ui.space).find(m=>m.id===app.ui.view.id); if(!memory)return '<div class="utility-empty">这条记忆在当前书房不可读。</div>';
        this.forms.text??=memory.text;
        return `<div class="utility-page"><h1>按你的意思改</h1><p class="utility-description">${memory.space?'仅用于当前书房。':'一般学习偏好跟随账号。'}不改变原交流。</p><form class="account-form" data-center-form="memory" novalidate><label class="account-field" for="field-text">这条记忆<textarea id="field-text" name="text" maxlength="300" rows="5">${esc(this.forms.text)}</textarea></label><p class="utility-description">来自：${esc(memory.source)}</p>${this.errorMarkup()}${this.submitButton('保存修正')}</form></div>`;
      }
      if(type==='diary')return `<div class="utility-page"><h1>我们学过的日子</h1><p class="utility-description">${esc(this.spaceName(app.ui.space))} · 保留当时的经历</p><div class="diary-list">${buddy.diary.filter(d=>d.space===app.ui.space).map(d=>`<button class="diary-entry" data-action="diary-entry" data-id="${esc(d.id)}"><span class="diary-date">${d.date.slice(5).replace('-',' / ')}<small>${d.date.slice(0,4)}</small></span><span><strong>${esc(d.title)}</strong><p>${esc(d.text.split('\n')[0])}</p></span>${icon('chevron-right')}</button>`).join('') || '<div class="utility-empty">这里还没有日记。<p>学习经历会留在它发生的书房里。</p></div>'}</div><p class="utility-footnote">日记只在它发生的那天留下，这里读已有的。</p></div>`;
      if(type==='diary-entry'){
        const diary=buddy.diary.find(d=>d.id===app.ui.view.id && d.space===app.ui.space);if(!diary)return '<div class="utility-empty">这篇日记不属于当前书房。</div>';
        return `<article class="paper diary-paper"><p class="paper-meta">${esc(diary.date)} · ${esc(this.spaceName(app.ui.space))}</p><h1>${esc(diary.title)}</h1><p class="diary-text">${esc(diary.text)}</p><div class="diary-signature">${esc(buddy.name)} · 学习日记</div>${this.store.note(diary.noteId)?.space===app.ui.space ? row('open-note','book-open','回到那篇笔记',this.store.note(diary.noteId).title,`data-id="${esc(diary.noteId)}"`) : ''}${row('diary-source','message-square-text','看看当时的交流','接续同一份聊天',`data-id="${esc(diary.conversationId)}"`)}</article>`;
      }
      return '';
    }
    detailLabel(v) { return ({brief:'简短要点',balanced:'适中讲解',detailed:'展开讲解'})[v]; }
    preview(style,detail) { return `${style==='direct'?'先说重点：':'我们先抓住一个小问题：'}职位由谁决定？${detail==='brief'?'从这个问题读起。':detail==='detailed'?'如果地方官员由中央任免，中央就能通过任命、考核和撤换管理地方。再对照责任关系，用自己的话解释一次。':'先看人员从哪里来，再看他向谁负责。'}`; }
    input(target) {
      const form=target.closest('[data-center-form]'); if(!form || !target.name)return false;
      if(target.type==='radio' && !target.checked)return true;
      this.forms[target.name]=target.type==='checkbox'?target.checked:target.value;
      if(this.error){this.error=null; const err=this.app.root.querySelector('#form-error');if(err)err.hidden=true;this.app.root.querySelectorAll('[aria-invalid]').forEach(el=>el.removeAttribute('aria-invalid'));}
      if(form.dataset.centerForm==='personality' && ['style','detail'].includes(target.name)) this.app.render();
      return true;
    }
    change(target) {
      if(target.id==='avatar-file'){this.attachAvatar(target.files?.[0]);target.value='';return true;}
      if(target.name==='chatLayout'){if(!['scene','history'].includes(target.value))return true;try{this.accounts.update(u=>{u.preferences.chatLayout=target.value;});this.app.render();}catch(error){this.app.toast(error.message);}return true;}
      if(target.name==='textScale' || target.name==='speechRate'){
        try { const n=Number(target.value), choices=target.name==='textScale'?[1,1.25,1.5]:[.8,1,1.2];if(!choices.includes(n))return true; this.accounts.update(user=>{user.preferences[target.name]=n;});this.app.applyAccountPreferences();this.app.render(); }
        catch(error){this.app.toast(error.message);this.app.render();} return true;
      }
      if(target.name==='rememberCompanion') { try{this.accounts.update(u=>{u.companion.remember=target.checked;});this.app.render();}catch(error){this.app.toast(error.message);this.app.render();} return true; }
      return this.input(target);
    }
    async attachAvatar(file) {
      if(!file)return;
      const owner=this.user?.id;
      try {
        if(file.size>10*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。');
        const url=URL.createObjectURL(file), image=new Image();
        try { image.src=url;await image.decode(); const canvas=document.createElement('canvas');const ratio=Math.min(1,256/Math.max(image.width,image.height));canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);if(this.user?.id===owner && this.app.ui.view.type==='profile-edit'){this.forms.avatar=canvas.toDataURL('image/png');this.app.render();} } finally{URL.revokeObjectURL(url);}
      }catch(error){this.app.toast(error.message || '这张图片无法读取，原头像保留。');}
    }
    async submit(form) {
      if(!form.dataset.centerForm)return false;
      if(this.busy)return true;
      const kind=form.dataset.centerForm, values={...this.forms};this.error=null;this.busy=true;this.app.render();
      try {
        if(kind==='auth'){
          if(this.app.offline)throw new Error('暂时离线，请联网后再试；输入内容还在。');
          if(this.app.ui.view.type==='register')await this.accounts.register(values);else await this.accounts.login(values);
          this.clear();this.app.activateAccount();
        }else{
          if(kind==='profile')this.accounts.updateProfile(values);
          if(kind==='personality')this.accounts.updateCompanion(values);
          if(kind==='memory')this.accounts.updateMemory(this.app.ui.view.id,{text:values.text},this.app.ui.space);
          this.clear();this.app.back();this.app.toast(kind==='profile'?'资料已保存':kind==='memory'?'记忆已修正':'她的设定已保存，下一次讲解开始使用');
        }
      }catch(error){this.busy=false;this.error=error;this.app.render();const input=this.app.root.querySelector(`#field-${error.field}`);input?.focus({preventScroll:false});}
      return true;
    }
    action(action,button) {
      const app=this.app,data=button.dataset;
      if(this.busy && ['auth-mode','back','demo-signin'].includes(action))return true;
      if(!this.user && !['auth-mode','password-visibility','demo-signin'].includes(action))return false;
      if(['profile','profile-edit','settings','companion','personality','memories','diary'].includes(action)){this.open(action);return true;}
      if(['memory-edit','diary-entry'].includes(action)){this.open(action,{id:data.id});return true;}
      if(action==='auth-mode'){this.clear();app.ui.view={type:data.mode};app.ui.stack=[];app.ui.positions[app.key]=0;app.render();return true;}
      if(action==='password-visibility'){const input=app.root.querySelector(`#field-${data.field}`);if(input){const show=input.type==='password';input.type=show?'text':'password';button.innerHTML=this.icon(show?'eye-off':'eye');button.setAttribute('aria-pressed',String(show));button.setAttribute('aria-label',`${show?'隐藏':'显示'}${data.field==='confirmPassword'?'确认密码':'密码'}`);}return true;}
      if(action==='demo-signin'){if(this.busy)return true;this.accounts.useDemo();this.clear();app.activateAccount();return true;}
      if(action==='logout-prompt'){app.openSheet('logout');return true;}
      if(action==='confirm-logout'){app.leaveAccount();this.accounts.logout();this.clear();app.activateAccount();return true;}
      if(action==='pick-avatar'){app.root.querySelector('#avatar-file').click();return true;}
      if(action==='clear-avatar'){this.forms.avatar=null;app.render();return true;}
      if(action==='resume-companion'){app.resumeFromCenter();return true;}
      if(action==='companion-idea'){app.resumeFromCenter();app.action('voice',button);return true;}
      if(action==='companion-prompt'){app.resumeFromCenter();app.ui.drafts[app.draftKey]=data.text;app.render();app.root.querySelector('#chat-input')?.focus();return true;}
      if(action==='companion-material'){app.resumeFromCenter();app.openSheet('attach');return true;}
      if(action==='companion-note'){app.ui.filter='notes';app.tab('notes');return true;}
      if(action==='memory-toggle'){try{const m=this.accounts.memories(app.ui.space).find(m=>m.id===data.id);this.accounts.updateMemory(data.id,{enabled:!m.enabled},app.ui.space);app.render();}catch(error){app.toast(error.message);}return true;}
      if(action==='memory-source' || action==='diary-source'){const id=action==='memory-source'?this.accounts.memories(app.ui.space).find(m=>m.id===data.id)?.conversationId:data.id;const conversation=this.store.conversation(id);if(!conversation || conversation.space!==app.ui.space){app.toast('原交流当前不可读。');return true;}if(conversation.status==='active'){app.ui.context=null;app.ui.attachment=null;app.tab('chat');}else app.navigate({type:'archive',id});app.renderMirror();return true;}
      return false;
    }
  }
  window.MOBILE_DEMO_CENTERS = { Centers,TYPES,TITLES };
})();
