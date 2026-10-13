const test=require('node:test');
const assert=require('node:assert/strict');
const {webcrypto}=require('node:crypto');
const {Accounts,validateAuth}=require('../mobile-companion-account.js');
const {Store}=require('../mobile-companion-data.js');
const {environment}=require('./mobile-companion-test-env.cjs');
const memoryStorage=()=>{const map=new Map();return {getItem:key=>map.get(key)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map};};
const credentials={email:'learner@example.test',displayName:'晴天',password:'DemoOnly123',confirmPassword:'DemoOnly123',remember:true};
const fill=(env,name,value)=>{const el=env.root.querySelector(`[name="${name}"]`);assert.ok(el,name);el.value=value;el.dispatchEvent(new env.w.Event('input',{bubbles:true}));return el;};
test('registration validates confirmation, duplicate email and optional invite without exposing plaintext credentials',async()=>{
  const local=memoryStorage(),session=memoryStorage(),accounts=new Accounts(local,session,webcrypto);
  assert.throws(()=>validateAuth({...credentials,confirmPassword:'other'},true),/两次/);
  assert.throws(()=>validateAuth({...credentials,inviteToken:'wrong'},true),/邀请码/);
  const user=await accounts.register({...credentials,inviteToken:'ASTELLA'});
  assert.equal(user.sharedAccess,true);assert.equal(user.companion.diary.length,0);
  assert.ok(!JSON.stringify([...local.map.values()]).includes(credentials.password));
  await assert.rejects(accounts.register({...credentials,email:'LEARNER@example.test'}),/已经注册/);
  accounts.logout();await assert.rejects(accounts.login({...credentials,password:'Wrong123'}),/邮箱或密码/);
  await accounts.login(credentials);assert.equal(accounts.user.id,user.id);
});
test('remembered and session-only identities restore correctly, logout does not auto-login on reload',async()=>{
  const local=memoryStorage(),session=memoryStorage();let accounts=new Accounts(local,session,webcrypto);
  accounts.logout();assert.equal(new Accounts(local,session,webcrypto).user,null);
  await accounts.register({...credentials,remember:false});
  assert.equal(new Accounts(local,session,webcrypto).user.email,credentials.email);
  assert.equal(new Accounts(local,memoryStorage(),webcrypto).user,null);
  await accounts.login(credentials);
  assert.equal(new Accounts(local,memoryStorage(),webcrypto).user.email,credentials.email);
});
test('account switching isolates notes, receipts and chat, then restores the first account objects',async()=>{
  const local=memoryStorage(),session=memoryStorage(),accounts=new Accounts(local,session,webcrypto);
  const store=new Store(local,accounts.businessKey),original=store.note('note-history');store.commit();
  await accounts.register(credentials);store.activate(accounts.businessKey,true);
  assert.equal(store.data.notes.length,0);assert.equal(store.conversation('conversation-current').messages.length,0);assert.equal(store.data.consent,false);
  store.createNote({requestId:'new-user-note',title:'只属于晴天',blocks:[{id:'new-block',type:'paragraph',text:'独立内容'}]});
  accounts.useDemo();store.activate(accounts.businessKey);
  assert.equal(store.note(original.id).title,original.title);assert.ok(!store.data.receipts['new-user-note']);assert.equal(store.data.notes.some(n=>n.title==='只属于晴天'),false);
});
test('space-specific memories cannot be modified from another space, general preferences and pauses persist',()=>{
  const local=memoryStorage(),session=memoryStorage(),accounts=new Accounts(local,session,webcrypto);
  assert.equal(accounts.memories('shared').length,1);
  assert.throws(()=>accounts.updateMemory('memory-history',{text:'越界'},'shared'),/当前书房/);
  accounts.updateMemory('memory-order',{text:'先用自己的话复述。',enabled:false},'home');
  const restored=new Accounts(local,session,webcrypto);assert.equal(restored.memories('shared')[0].text,'先用自己的话复述。');assert.equal(restored.memories('shared')[0].enabled,false);
});
test('profile and companion pages return to their actual source; identity and reading settings apply immediately',async()=>{
  const env=environment();try{
    env.click('[data-tab="notes"]');env.click('[data-action="menu"]');env.click('.sheet [data-action="profile"]');env.click('[data-action="profile-edit"]');
    fill(env,'displayName','阿晴');await env.w.mobileDemo.app.centers.submit(env.root.querySelector('form'));
    assert.equal(env.root.querySelector('h1').textContent,'阿晴');
    env.click('[data-action="settings"]');const select=env.root.querySelector('[name="textScale"]');select.value='1.5';select.dispatchEvent(new env.w.Event('change',{bubbles:true}));
    assert.equal(env.root.style.getPropertyValue('--text-scale'),'1.5');assert.equal(env.w.mobileDemo.accounts.user.preferences.textScale,1.5);
    env.click('[data-action="back"]');env.click('[data-action="companion"]');env.click('[data-action="personality"]');fill(env,'name','小星');
    await env.w.mobileDemo.app.centers.submit(env.root.querySelector('form'));assert.equal(env.root.querySelector('.buddy-name').textContent,'小星');
    env.click('[data-action="back"]');env.click('[data-action="back"]');assert.equal(env.w.mobileDemo.app.ui.view.type,'notes');assert.equal(env.root.querySelector('.identity strong').textContent,'小星');assert.equal(env.root.querySelector('#chat-input'),null);
  }finally{env.close();}
});
test('logout pauses running operations and hides private data; local registration opens a separate empty bookroom',async()=>{
  const env=environment();try{
    const app=env.w.mobileDemo.app,store=env.w.mobileDemo.store;
    app.ui.drafts[app.draftKey]='未发送的私密草稿';store.startTask({kind:'explain',conversationId:app.conversation.id,space:'home',title:'还在处理'});
    env.click('[data-action="menu"]');env.click('.sheet [data-action="profile"]');env.click('[data-action="logout-prompt"]');env.click('[data-action="confirm-logout"]');
    assert.equal(app.ui.view.type,'login');assert.ok(!env.root.textContent.includes('未发送的私密草稿'));assert.ok(!env.w.document.querySelector('#desktop-mirror').textContent.includes('从世袭'));
    env.click('[data-action="auth-mode"]');for(const [key,value]of Object.entries(credentials))if(typeof value==='string')fill(env,key,value);
    await app.centers.submit(env.root.querySelector('form'));assert.equal(app.ui.view.type,'chat');assert.equal(store.data.notes.length,0);assert.equal(app.conversation.messages.length,0);assert.equal(store.data.consent,false);
    env.click('[data-action="menu"]');env.click('.sheet [data-action="profile"]');env.click('[data-action="logout-prompt"]');env.click('[data-action="confirm-logout"]');env.click('[data-action="demo-signin"]');
    assert.equal(env.root.querySelector('#chat-input').value,'未发送的私密草稿');assert.equal(store.data.tasks[0].status,'paused');assert.ok(store.note('note-history'));
  }finally{env.close();}
});
test('memory changes are used only in permitted explanations; source navigation and diary keep the same conversation',async()=>{
  const env=environment();try{
    const {app,store,accounts}=env.w.mobileDemo;
    env.click('[data-action="menu"]');env.click('.sheet [data-action="companion"]');env.click('[data-action="memories"]');env.click('[data-action="memory-edit"][data-id="memory-order"]');fill(env,'text','先复述再核对原文。');await app.centers.submit(env.root.querySelector('form'));
    env.click('[data-action="memory-source"]');assert.equal(app.conversation.id,'conversation-current');assert.equal(app.ui.view.type,'chat');
    const task=store.startTask({kind:'explain',conversationId:'conversation-current',space:'home',payload:{text:'熵是什么？'}});app.finishTask(task);
    assert.ok(app.conversation.messages.at(-1).text.includes('先复述再核对原文。'));
    accounts.update(u=>{u.companion.remember=false;});const next=store.startTask({kind:'explain',conversationId:'conversation-current',space:'home',payload:{text:'熵是什么？'}});app.finishTask(next);assert.ok(!app.conversation.messages.at(-1).text.includes('先复述再核对原文。'));
    env.click('[data-action="menu"]');env.click('.sheet [data-action="companion"]');env.click('[data-action="diary"]');env.click('[data-action="diary-entry"]');assert.ok(env.root.textContent.includes('从两个问题开始'));env.click('[data-action="diary-source"]');assert.equal(app.conversation.id,'conversation-current');
  }finally{env.close();}
});
test('invalid or failed forms stay editable without creating a chat task or consuming a draft',async()=>{
  const env=environment();try{
    const {app,accounts,store}=env.w.mobileDemo;app.leaveAccount();accounts.logout();app.activateAccount();env.click('[data-action="auth-mode"]');
    fill(env,'displayName','晴天');fill(env,'email','learner@example.test');fill(env,'password','DemoOnly123');fill(env,'confirmPassword','Another123');
    await app.centers.submit(env.root.querySelector('form'));assert.equal(app.ui.view.type,'register');assert.equal(env.root.querySelector('#field-confirmPassword').getAttribute('aria-invalid'),'true');assert.equal(store.data.tasks.length,0);assert.equal(env.root.querySelector('#field-email').value,'learner@example.test');
    env.click('[data-action="auth-mode"]');assert.equal(env.root.querySelector('#field-password').value,'');
  }finally{env.close();}
});
