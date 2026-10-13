const test=require('node:test');
const assert=require('node:assert/strict');
const {VoiceSession,SAMPLE}=require('../mobile-companion-scene.js');
const {Accounts}=require('../mobile-companion-account.js');
const {environment}=require('./mobile-companion-test-env.cjs');
test('voice cancellation rejects late responses, preserves unfinished text and never resumes a cancelled request',()=>{
  const voice=new VoiceSession();voice.start();voice.text('没说完');voice.pause();assert.equal(voice.transcript,'没说完');voice.resume();assert.equal(voice.wait('first'),true);assert.equal(voice.transcript,'');
  voice.pause();assert.equal(voice.accept('first'),false);voice.resume();voice.text('新的问题');voice.wait('second');assert.equal(voice.accept('first'),false);assert.equal(voice.accept('second'),true);voice.interrupt();assert.equal(voice.phase,'listening');voice.close();assert.equal(voice.accept('second'),false);
});
test('ambient entry plays once; recording, pause and motion off follow the existing voice lifecycle',()=>{
  const env=environment({history:false});try{
    const {app}=env.w.mobileDemo,layer=env.root.querySelector('.companion-flow');
    assert.equal(env.root.dataset.flow,'entry');app.render();assert.equal(env.root.querySelector('.companion-flow'),layer);
    app.scene.flow.finishEntry();assert.equal(env.root.dataset.flow,'idle');app.render();assert.equal(env.root.dataset.flow,'idle');
    app.scene.voice.start();assert.equal(env.root.dataset.flow,'listening');app.scene.voice.pause();assert.equal(env.root.dataset.flow,'idle');
    app.scene.voice.resume();assert.equal(env.root.dataset.flow,'listening');env.root.classList.add('motion-off');app.scene.sync();assert.equal(env.root.dataset.flow,'idle');
    env.root.classList.remove('motion-off');app.scene.sync();assert.equal(env.root.dataset.flow,'listening');app.scene.stop();assert.equal(env.root.dataset.flow,'idle');
    assert.equal(env.root.querySelector('.companion-flow'),layer);
  }finally{env.close();}
});
test('bottom flow follows the same sound envelope as the wave and cancels its frame loop on stop',()=>{
  const env=environment({history:false});try{
    const {app}=env.w.mobileDemo,flow=app.scene.flow,frames=new Map();let serial=0;
    flow.finishEntry();env.w.requestAnimationFrame=fn=>{frames.set(++serial,fn);return serial;};env.w.cancelAnimationFrame=id=>frames.delete(id);
    const sample=t=>{const [id,fn]=frames.entries().next().value;frames.delete(id);fn(t);assert.equal(Number(flow.layer.dataset.amplitude),Number(app.scene.envelope(t).amp.toFixed(3)));return Number(flow.layer.style.getPropertyValue('--flow-level'));};
    app.scene.voice.start();app.scene.example();let strong,quiet;
    for(const t of [230,246,262,278])strong=sample(t);
    for(const t of [730,746,762,778])quiet=sample(t);
    assert.ok(strong>quiet,'a quieter wave reduces the light strength');
    app.scene.speaking=true;app.scene.paint();assert.equal(env.root.dataset.flow,'speaking');sample(1000);
    env.root.classList.add('motion-off');app.scene.sync();assert.equal(frames.size,0);assert.equal(flow.frame,0);
    env.root.classList.remove('motion-off');app.scene.sync();assert.equal(frames.size,1);
    app.scene.stop();assert.equal(frames.size,0);assert.equal(env.root.dataset.flow,'idle');
  }finally{env.close();}
});
test('fresh accounts default to scene; switching and restoring preference keeps the same chat and draft',()=>{
  const env=environment({history:false});try{
    const {app,accounts,store}=env.w.mobileDemo,id=app.conversation.id,model=app.scene.model.canvas;
    assert.ok(env.root.querySelector('.live2d-seat'));assert.equal(env.root.querySelector('[data-message-id]'),null);
    app.ui.drafts[app.draftKey]='尚未发送';app.render();env.click('[data-mode="history"]');assert.ok(env.root.querySelector('[data-message-id]'));assert.equal(app.conversation.id,id);assert.equal(env.root.querySelector('#chat-input').value,'尚未发送');
    assert.equal(new Accounts(env.w.localStorage,env.w.sessionStorage).user.preferences.chatLayout,'history');
    env.click('[data-mode="scene"]');env.click('[data-tab="notes"]');env.click('[data-tab="chat"]');assert.equal(app.conversation.id,id);assert.equal(app.scene.model.canvas,model);assert.equal(app.ui.drafts[app.draftKey],'尚未发送');assert.equal(store.data.tasks.length,0);
    app.scene.voice.start();app.scene.voice.text('还没说完');env.click('[data-mode="history"]');env.click('.thread-quick [data-action="prompt"]');assert.equal(app.scene.voice.phase,'idle');assert.ok(env.root.querySelector('#chat-input').value.includes('还没说完'));assert.ok(env.root.querySelector('#chat-input').value.includes('整理成一篇笔记'));assert.equal(app.conversation.id,id);
  }finally{env.close();}
});
test('voice explanations create one shared chat request, not a note; cancelled playback cannot restart from old callbacks',()=>{
  const env=environment({history:false});try{
    const {app,store}=env.w.mobileDemo,spoken=[];env.w.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};env.w.speechSynthesis={getVoices:()=>[{lang:'zh-CN',localService:true}],speak:u=>spoken.push(u),cancel(){}};
    app.runTask=()=>{};const notes=store.data.notes.length,messages=app.conversation.messages.length;
    app.scene.voice.start();app.scene.voice.text(SAMPLE);app.scene.submit();const task=app.activeTask;assert.equal(task.kind,'explain');assert.equal(app.scene.voice.phase,'thinking');assert.equal(app.conversation.messages.length,messages+1);app.execute(task);
    assert.equal(store.data.notes.length,notes);assert.equal(app.conversation.messages.length,messages+2);assert.equal(app.conversation.messages.at(-1).taskId,task.id);assert.equal(app.scene.voice.phase,'speaking');assert.ok(spoken[0].text.includes('两个问题'));
    app.scene.flow.finishEntry();spoken[0].onstart();assert.ok(app.scene.envelope(100).mouth>0);assert.equal(env.root.dataset.flow,'speaking');app.scene.action('voice-primary');assert.equal(app.scene.voice.phase,'listening');assert.equal(env.root.dataset.flow,'listening');assert.equal(app.scene.envelope(110).mouth,0);const count=spoken.length;spoken[0].onend();assert.equal(spoken.length,count);assert.equal(env.root.dataset.flow,'listening');
    app.scene.action('voice-end');assert.equal(app.ui.drafts[app.draftKey]||'','');
    app.scene.voice.start();app.scene.voice.text('整理成一篇笔记');app.scene.submit();const created=app.activeTask;app.execute(created);assert.equal(store.data.notes.length,notes+1);const link=env.root.querySelector('.scene-speech [data-action="open-note"]');assert.ok(link);env.click('.scene-speech [data-action="open-note"]');assert.equal(app.ui.view.type,'reader');assert.equal(app.ui.view.id,created.receipt.noteId);assert.equal(app.scene.voice.phase,'idle');
  }finally{env.close();}
});
test('leaving or closing voice saves partial text and a late answer stays in history without autoplay',()=>{
  const env=environment({history:false});try{
    const {app,store}=env.w.mobileDemo;app.ui.drafts['chat:home']='文字草稿';app.scene.voice.start();app.scene.voice.text('未说完的想法');app.tab('notes');assert.equal(app.ui.drafts['chat:home'],'文字草稿\n未说完的想法');assert.equal(app.scene.voice.phase,'idle');assert.equal(app.scene.model.host.hidden,true);
    app.tab('chat');app.runTask=()=>{};app.scene.voice.start();app.scene.voice.text(SAMPLE);app.scene.submit();const task=app.activeTask;app.scene.action('voice-end');app.execute(task);assert.equal(task.status,'succeeded');assert.equal(app.scene.voice.phase,'idle');assert.equal(app.scene.speaking,false);assert.ok(app.conversation.messages.at(-1).text.includes('两个问题'));
  }finally{env.close();}
});
test('voice requests obey offline, consent and read-only write checks while explanations remain available',()=>{
  const env=environment({history:false});try{
    const {app,store}=env.w.mobileDemo;app.runTask=()=>{};app.ui.attachment={name:'待发图片'};app.scene.start();assert.equal(app.scene.voice.phase,'idle');assert.equal(store.data.tasks.length,0);app.ui.attachment=null;app.scene.voice.start();app.scene.voice.text(SAMPLE);app.offline=true;app.scene.submit();assert.equal(store.data.tasks.length,0);assert.equal(app.scene.voice.transcript,SAMPLE);
    app.offline=false;store.data.consent=false;app.scene.submit();assert.equal(app.sheet.type,'consent');assert.equal(store.data.tasks.length,0);app.closeSheet(false);store.data.consent=true;
    app.switchSpace('shared');app.scene.voice.start();app.scene.voice.text('新增一篇笔记');app.scene.submit();assert.equal(store.data.tasks.length,0);app.scene.voice.text(SAMPLE);app.scene.submit();assert.equal(app.activeTask.kind,'explain');assert.equal(app.activeTask.space,'shared');assert.equal(app.scene.voice.phase,'thinking');
  }finally{env.close();}
});
test('particles have bounded work, off draws a stationary frame and clears mouth feedback; model uses layout offsets',()=>{
  const env=environment({history:false});try{
    const {app}=env.w.mobileDemo;let arcs=0,frames=0;env.w.CanvasRenderingContext2D=function(){};env.w.requestAnimationFrame=()=>{frames++;return 9;};env.w.cancelAnimationFrame=()=>{};
    const canvas=env.w.document.createElement('canvas');Object.defineProperties(canvas,{clientWidth:{value:300},clientHeight:{value:60}});canvas.getContext=()=>({setTransform(){},clearRect(){},beginPath(){},arc(){arcs++;},fill(){}});env.root.append(canvas);
    app.scene.particles.sync(canvas,false);assert.equal(arcs,900);assert.equal(frames,1);app.scene.particles.sync(canvas,true);assert.equal(arcs,1800);assert.equal(frames,1);assert.equal(app.scene.model.level,0);
    const parent={offsetLeft:7,offsetTop:20,offsetParent:env.root},seat={isConnected:true,offsetLeft:12,offsetTop:42,offsetParent:parent,clientWidth:300,clientHeight:400};app.scene.model.seat=seat;app.scene.model.position();assert.equal(app.scene.model.host.style.left,'19px');assert.equal(app.scene.model.host.style.top,'62px');
  }finally{env.close();}
});
test('history playback follows the model after switching views, and pause/stop clear speaking cues',()=>{
  const env=environment({history:false});try{
    const {app}=env.w.mobileDemo,spoken=[];env.w.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};env.w.speechSynthesis={getVoices:()=>[{lang:'zh-CN',localService:true}],speak:u=>spoken.push(u),cancel(){},pause(){},resume(){}};
    app.scene.flow.finishEntry();app.scene.setMode('history');app.playParts([{text:'同一份回复，切换时继续读。'}],'这一段');spoken[0].onstart();app.scene.setMode('scene');assert.equal(app.scene.label(),'正在说');assert.ok(app.scene.model.levelSource()>0);assert.equal(env.root.dataset.flow,'speaking');
    app.action('pause-audio',{dataset:{}});assert.equal(app.scene.label(),'已暂停');assert.equal(app.scene.model.levelSource(),0);assert.equal(env.root.dataset.flow,'idle');app.action('pause-audio',{dataset:{}});assert.ok(app.scene.model.levelSource()>0);assert.equal(env.root.dataset.flow,'speaking');
    app.stopAudio(false);assert.equal(env.root.dataset.flow,'idle');assert.equal(app.scene.model.levelSource(),0);spoken[0].onend();assert.equal(app.player,null);assert.equal(app.scene.speaking,false);
  }finally{env.close();}
});
test('note reading and note playback stay quiet while chat playback retains its flow',()=>{
  const env=environment({history:false});try{
    const {app}=env.w.mobileDemo,spoken=[];
    env.w.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
    env.w.speechSynthesis={getVoices:()=>[{lang:'zh-CN',localService:true}],speak:u=>spoken.push(u),cancel(){},pause(){},resume(){}};
    app.openNote('note-history');assert.equal(app.ui.view.type,'reader');assert.equal(env.root.dataset.flow,'idle');
    app.playParts([{text:'读笔记时仍可以听声音。'}],'读笔记');spoken[0].onstart();
    assert.equal(app.scene.speaking,true);assert.ok(app.player);assert.equal(env.root.dataset.flow,'idle');assert.equal(app.scene.flow.frame,0);
    app.action('pause-audio',{dataset:{}});app.action('pause-audio',{dataset:{}});assert.equal(env.root.dataset.flow,'idle');
    app.stopAudio();app.tab('chat');app.playParts([{text:'回到交流后，流光跟着说话。'}],'交流');spoken[1].onstart();
    assert.equal(env.root.dataset.flow,'speaking');
  }finally{env.close();}
});
