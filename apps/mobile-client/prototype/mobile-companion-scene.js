/* Scene and history share the existing conversation/store. No microphone data is collected. */
(function(root,factory){const api=factory();if(typeof module==='object' && module.exports)module.exports=api;else root.MOBILE_DEMO_SCENE=api;})(typeof window==='object'?window:globalThis,()=>{
  const SAMPLE='讲讲分封制和郡县制，官员的责任有什么不同？';
  class AmbientFlow {
    constructor(root,levelSource){
      this.root=root;this.levelSource=levelSource;this.phase='idle';this.entering=true;this.off=false;
      this.frame=0;this.level=0;this.lastFrame=0;
      this.layer=document.createElement('div');this.layer.className='companion-flow';this.layer.setAttribute('aria-hidden','true');
      this.layer.innerHTML='<div class="flow-breath"><i class="flow-light"></i><i class="flow-light flow-light-secondary"></i></div>';
      root.append(this.layer);this.replayEntry();
    }
    replayEntry(){clearTimeout(this.timer);if(this.off)return;this.entering=true;this.apply();this.timer=setTimeout(()=>this.finishEntry(),4200);}
    finishEntry(){clearTimeout(this.timer);this.entering=false;this.apply();}
    sync(phase,off){this.phase=phase;this.off=off;if(off && this.entering)this.finishEntry();else this.apply();}
    apply(){
      if(this.disposed)return;
      this.root.dataset.flow=this.off?'idle':this.phase!=='idle'?this.phase:this.entering?'entry':'idle';
      if(this.root.dataset.flow==='idle'){
        cancelAnimationFrame(this.frame);this.frame=0;this.lastFrame=0;this.level=0;
        this.layer.style.setProperty('--flow-level','0');
      }else if(!this.frame){this.frame=requestAnimationFrame(t=>this.tick(t));}
    }
    tick(t){
      this.frame=0;
      if(this.disposed || this.off || this.root.dataset.flow==='idle')return;
      const raw=this.root.dataset.flow==='entry'?.55:this.levelSource(t);
      const target=Math.max(0,Math.min(1,raw));
      const elapsed=this.lastFrame?Math.min(64,Math.max(1,t-this.lastFrame)):16;
      // A short attack catches speech peaks; a softer release lets the light settle.
      this.level+=(target-this.level)*(1-Math.exp(-elapsed/(target>this.level?55:150)));
      this.lastFrame=t;this.layer.dataset.amplitude=target.toFixed(3);
      this.layer.style.setProperty('--flow-level',this.level.toFixed(3));
      this.frame=requestAnimationFrame(n=>this.tick(n));
    }
    dispose(){this.disposed=true;clearTimeout(this.timer);cancelAnimationFrame(this.frame);this.frame=0;this.layer.remove();delete this.root.dataset.flow;}
  }
  class VoiceSession {
    constructor(change=()=>{}){this.change=change;this.phase='idle';this.transcript='';this.taskId=null;this.token=0;}
    set(phase){this.phase=phase;this.change(this);}
    start(){this.token++;this.taskId=null;this.transcript='';this.set('listening');}
    text(value){if(this.phase==='listening'){this.transcript=value;this.change(this);}}
    wait(taskId){if(this.phase!=='listening' || !taskId)return false;this.taskId=taskId;this.transcript='';this.set('thinking');return true;}
    accept(taskId){if(this.phase!=='thinking' || taskId!==this.taskId)return false;this.taskId=null;this.set('speaking');return true;}
    interrupt(){this.token++;this.taskId=null;this.set('listening');}
    pause(){if(this.phase==='idle')return;this.token++;this.taskId=null;this.set('paused');}
    resume(){if(this.phase!=='paused')return;this.token++;this.set('listening');}
    close(){this.token++;this.taskId=null;this.set('idle');}
  }
  class Particles {
    constructor(level,mouth){this.level=level;this.mouth=mouth;this.frame=0;this.dots=Array.from({length:900},(_,i)=>({x:(i%180)/179,l:Math.floor(i/180),r:.62+(i%7)*.1,drift:Math.sin(i*17.13)*7}));}
    sync(canvas,off){if(this.canvas!==canvas){this.canvas=canvas;this.context=typeof window.CanvasRenderingContext2D==='function' && canvas?.getContext('2d');}this.off=off;cancelAnimationFrame(this.frame);this.frame=0;if(this.context){this.draw(performance.now());if(!off && !document.hidden)this.frame=requestAnimationFrame(t=>this.tick(t));}else this.mouth(0);}
    tick(t){this.draw(t);if(this.context && this.canvas?.isConnected && !this.off && !document.hidden)this.frame=requestAnimationFrame(n=>this.tick(n));else{this.frame=0;this.mouth(0);}}
    draw(t){
      const canvas=this.canvas,c=this.context;if(!canvas || !c)return;
      const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight),d=Math.min(devicePixelRatio||1,2);if(canvas.width!==w*d || canvas.height!==h*d){canvas.width=w*d;canvas.height=h*d;}
      c.setTransform(d,0,0,d,0,0);c.clearRect(0,0,w,h);const value=this.off?{amp:.12,mouth:0}:this.level(t);this.mouth(value.mouth);canvas.dataset.amplitude=value.amp.toFixed(2);canvas.dataset.frame=String((Number(canvas.dataset.frame)||0)+1);
      for(const dot of this.dots){const x=dot.x,edge=Math.pow(Math.sin(x*Math.PI),.75),time=this.off?0:t/1000;
        const wave=Math.sin(x*19-time*3.3+dot.l*.52)*.58+Math.sin(x*31+time*2.2+dot.l)*.28;
        const y=h/2+wave*edge*(8+value.amp*h*.45)+(dot.l-2)*3*edge+dot.drift*edge*(.35+value.amp);
        c.fillStyle=`rgba(74,115,172,${.12+edge*.49})`;c.beginPath();c.arc(12+x*(w-24),y,dot.r,0,Math.PI*2);c.fill();
      }
    }
    dispose(){cancelAnimationFrame(this.frame);this.frame=0;this.mouth(0);}
  }
  class Scene {
    constructor(app,accounts,store,helpers){
      Object.assign(this,{app,accounts,store,...helpers});this.textOpen=null;this.reply='';this.caption='';this.speaking=false;this.timers=[];this.speechToken=0;this.lastMessage=app.conversation.messages.at(-1)?.id;if('speechSynthesis' in window)window.speechSynthesis.getVoices();
      this.flow=new AmbientFlow(app.root,t=>this.envelope(t).amp);this.voice=new VoiceSession(()=>this.update());this.model=new window.MOBILE_DEMO_LIVE2D.Live2D(app.root);this.model.levelSource=()=>this.envelope(performance.now()).mouth;this.particles=new Particles(t=>this.envelope(t),level=>this.model.setLevel(level));
      this.media=window.matchMedia('(prefers-reduced-motion: reduce)');this.media.addEventListener('change',()=>this.sync());
    }
    get mode(){return this.accounts.user?.preferences.chatLayout==='history'?'history':'scene';}
    get visible(){return this.app.ui.view.type==='chat' && !this.app.centers.active;}
    get active(){return this.voice.phase!=='idle';}
    get textVisible(){return this.app.keyboard || this.textOpen!==false && (this.textOpen || this.app.ui.attachment || !!this.app.ui.drafts[`chat:${this.app.ui.space}`]);}
    modeMarkup(){return `<div class="dialogue-modes glass" role="group" aria-label="对话显示方式"><button data-action="dialogue-mode" data-mode="scene" aria-pressed="${this.mode==='scene'}">伴星</button><button data-action="dialogue-mode" data-mode="history" aria-pressed="${this.mode==='history'}">记录</button></div>`;}
    body(){
      const {esc,icon}=this,name=this.accounts.user?.companion.name||'伴星';
      return `<div class="companion-scene" data-node-key="companion-scene"><div class="scene-title"><button data-action="companion"><strong>${esc(name)}</strong>${icon('chevron-right')}</button><span>${this.app.ui.space==='shared'?'共读书房 · 只读':'和你在同一个书房'}</span></div><div class="live2d-seat" data-node-key="model-seat"><p class="model-status" role="status" ${this.model.state==='ready'?'hidden':''}>${esc(this.model.error||'伴星正在过来…')}</p></div><div class="scene-speech glass" data-node-key="speech-bubble"><span class="bubble-speaker">${esc(name)}<i></i><span data-voice-label>${this.label()}</span></span><p data-scene-caption aria-live="polite">${esc(this.bubbleText())}</p>${this.reply?`<div class="bubble-links">${this.result?`<button class="bubble-more" data-action="${this.result.type==='note'?'open-note':'open-image'}" data-id="${esc(this.result.id)}">${this.result.type==='note'?'打开笔记':'看原图'}</button>`:''}<button class="bubble-more" data-action="dialogue-mode" data-mode="history">看完整对话</button></div>`:''}</div></div>`;
    }
    bubbleText(){const task=this.app.activeTask;return this.caption || (this.voice.phase==='thinking' ? '这句我听到了，我来理一理。' : task ? task.stage : this.short(this.reply)) || '我在。想聊什么，直接告诉我。';}
    short(text){const flat=text.replace(/\s+/g,' ');return flat.length>56?flat.slice(0,54)+'…':flat;}
    label(){return ({idle:this.app.player?(this.app.player.paused?'已暂停':this.speaking?'正在说':'准备声音'):this.app.activeTask?'正在处理':'陪着你',listening:this.voice.transcript?'你在说':'等你开口',thinking:'在想这件事',speaking:this.speaking?'正在说':'准备声音',paused:'已暂停'})[this.voice.phase] || '改用文字也可以';}
    dock(){
      const {icon,esc}=this,p=this.voice.phase,pending=!!this.voice.transcript.trim();
      return `<div class="voice-dock ${this.active?'voice-active':''}" data-node-key="voice-dock"><div class="voice-wave" ${this.active?'':'hidden'}><canvas class="particle-wave" aria-hidden="true"></canvas><span data-voice-label role="status">${this.label()}</span></div>${this.active?`<p class="voice-transcript" data-voice-transcript>${esc(this.transcriptText())}</p>`:''}<div class="voice-controls"><button class="voice-side glass" data-action="scene-text" aria-label="改用文字">${icon('pencil')}</button><button class="voice-main glass" data-action="voice-primary" aria-label="${!this.active?'开始语音演示':p==='speaking'?'打断伴星，继续说':p==='thinking'?'暂停语音':p==='paused'?'继续语音':pending?'发送当前话语':'体验下一轮语音'}">${icon(p==='speaking'?'message-square-text':p==='thinking'?'pause':p==='paused'?'play':'mic')}<span>${!this.active?'和我聊聊':p==='speaking'?'我想说':p==='thinking'?'暂停一下':p==='paused'?'继续聊':pending?'说好了':'再聊一句'}</span></button><button class="voice-side glass" data-action="${this.active?'voice-end':'attach'}" aria-label="${this.active?'结束语音':'递材料'}">${icon(this.active?'x':'plus')}</button></div><div class="voice-aux">${this.active && p==='listening'?'<button data-action="voice-example">体验一段话</button><button data-action="voice-pause">暂停</button>':''}<small>语音演示 · 未启用麦克风</small></div></div>`;
    }
    transcriptText(){return this.voice.transcript || (this.lastUtterance?'刚才 · '+this.lastUtterance:'体验样例，或改用文字说出你的问题。');}
    setMode(mode){if(!['scene','history'].includes(mode))return;this.app.captureScroll();if(this.accounts.user){try{this.accounts.update(user=>{user.preferences.chatLayout=mode;});}catch(error){return this.app.toast(error.message);}}this.app.routeTransition={kind:'tab',direction:mode==='history'?1:-1};this.app.render();this.app.root.querySelector(`[data-mode="${mode}"]`)?.focus({preventScroll:true});}
    update(){if(this.app.surface)this.app.render();}
    sync(){
      const root=this.app.root,visible=this.visible;root.dataset.dialogue=this.mode;root.dataset.voice=this.voice.phase;
      this.model.sync(visible && this.mode==='scene'?root.querySelector('.live2d-seat'):null,this.app.motion.off);this.model.report();
      this.particles.sync(visible?root.querySelector('.particle-wave'):null,this.app.motion.off || !this.active || this.voice.phase==='paused' || !!this.app.sheet);this.paint();
    }
    get readingNote(){return ['reader','compare','review','history'].includes(this.app.ui.view.type);}
    syncFlow(){this.flow.sync(this.speaking && !this.app.player?.paused?'speaking':this.visible && this.voice.phase==='listening'?'listening':'idle',this.app.motion.off || document.hidden || this.readingNote);}
    paint(){this.syncFlow();const root=this.app.root;root.querySelectorAll('[data-voice-label]').forEach(el=>el.textContent=this.label());const bubble=root.querySelector('[data-scene-caption]');if(bubble)bubble.textContent=this.bubbleText();const transcript=root.querySelector('[data-voice-transcript]');if(transcript)transcript.textContent=this.transcriptText();const primary=root.querySelector('[data-action="voice-primary"]');if(primary && this.voice.phase==='listening'){const pending=!!this.voice.transcript.trim();primary.setAttribute('aria-label',pending?'发送当前话语':'体验下一轮语音');primary.querySelector('span').textContent=pending?'说好了':'再聊一句';}}
    envelope(t){
      const phase=this.voice.phase,amp=this.speaking ? .5+.28*Math.sin(t/113) : phase==='listening' && this.timers.length ? .46+.24*Math.sin(t/160) : phase==='thinking' ? .16 : .06;
      // Browser TTS exposes word boundaries, not PCM. This bounded envelope is an
      // estimated mouth cue only while a real utterance is playing.
      const mouth=this.speaking?Math.max(.04,(.46+.3*Math.sin(t/74))*(1-Math.min(.4,(t-(this.boundaryAt||t))/2000))):0;
      return {amp:Math.max(.04,amp),mouth};
    }
    clearTimers(){this.timers.forEach(clearTimeout);this.timers=[];}
    cancelSpeech(){this.speechToken++;clearTimeout(this.startTimeout);this.speaking=false;this.model.setLevel(0);if('speechSynthesis' in window)window.speechSynthesis.cancel();this.syncFlow();}
    start(){if(this.app.ui.attachment)return this.app.toast('这轮已经带图，先用文字问；语音可以单独发。');this.app.stopAudio(false);this.app.closeSheet(false);this.clearTimers();this.cancelSpeech();this.textOpen=false;this.app.keyboard=false;this.caption='';this.lastUtterance='';this.voice.start();this.example();}
    example(){if(this.voice.phase!=='listening')return;this.clearTimers();const token=this.voice.token;this.voice.transcript='';this.paint();for(let n=3;n<SAMPLE.length+3;n+=3){this.timers.push(setTimeout(()=>{if(this.voice.token!==token || this.voice.phase!=='listening')return;this.voice.transcript=SAMPLE.slice(0,n);this.paint();},n*65));}this.timers.push(setTimeout(()=>{if(this.voice.token===token && this.voice.phase==='listening'){this.clearTimers();this.submit();}},SAMPLE.length*65+650));}
    submit(){this.clearTimers();const text=this.voice.transcript.trim();if(!text)return this.app.toast('还没有一句话。可以体验样例，或改用文字。');this.lastUtterance=text;const task=this.app.send(text,{key:`chat:${this.app.ui.space}`,voiceText:text});if(task)this.voice.wait(task.id);}
    observe(){
      const message=this.app.conversation.messages.at(-1);if(message && message.id!==this.lastMessage){this.lastMessage=message.id;if(message.role==='assistant'){this.reply=message.text;this.result=message.noteId?{type:'note',id:message.noteId}:message.assetId?{type:'image',id:message.assetId}:null;}}
      if(this.voice.phase!=='thinking')return;const task=this.store.data.tasks.find(t=>t.id===this.voice.taskId);if(!task)return;
      if(['failed','paused','unknown','stopped'].includes(task.status)){this.voice.pause();this.app.toast(task.error||'这次先停下，记录里可以查看结果。');return;}
      const answer=this.app.conversation.messages.find(m=>m.role==='assistant' && m.taskId===task.id);if(answer && this.voice.accept(task.id))this.speak(answer.text);
    }
    speak(text){
      if(!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)){this.caption=this.short(text);this.voice.pause();return this.app.toast('浏览器没有朗读声音，回复已保留在记录里。');}
      this.cancelSpeech();const token=this.speechToken;const chunks=(text.match(/[^。！？\n]+[。！？]?/g)||[text]).flatMap(line=>line.match(/.{1,46}/g)||[]);let index=0;
      const next=()=>{if(token!==this.speechToken || this.voice.phase!=='speaking')return;const line=chunks[index],utterance=new window.SpeechSynthesisUtterance(line);utterance.lang='zh-CN';utterance.rate=this.accounts.user?.preferences.speechRate||1;const voices=window.speechSynthesis.getVoices();const local=voices.find(v=>v.lang.startsWith('zh') && v.localService);if(!local){this.caption=this.short(text);this.voice.pause();return this.app.toast('浏览器没有本机中文朗读声音，完整回复可以在记录里读。');}utterance.voice=local;
        this.caption=line;this.paint();this.startTimeout=setTimeout(()=>{if(token===this.speechToken && !this.speaking){this.cancelSpeech();this.voice.pause();this.app.toast('声音未启动，完整回复可以在记录里读。');}},5000);
        utterance.onstart=()=>{if(token!==this.speechToken)return;clearTimeout(this.startTimeout);this.speaking=true;this.boundaryAt=performance.now();this.paint();};
        utterance.onboundary=()=>{if(token===this.speechToken)this.boundaryAt=performance.now();};
        utterance.onend=()=>{if(token!==this.speechToken)return;this.speaking=false;this.model.setLevel(0);if(++index<chunks.length)next();else{this.caption=this.short(text);this.voice.interrupt();}};
        utterance.onerror=()=>{if(token===this.speechToken){this.cancelSpeech();this.voice.pause();this.app.toast('声音被中断，可以继续读文字。');}};
        window.speechSynthesis.speak(utterance);
      };next();
    }
    stop(render=false){if(['listening','paused'].includes(this.voice.phase) && this.voice.transcript){const key=`chat:${this.app.ui.space}`,draft=this.app.ui.drafts[key]||'';if(!draft.includes(this.voice.transcript))this.app.ui.drafts[key]=draft?draft+'\n'+this.voice.transcript:this.voice.transcript;}this.clearTimers();this.cancelSpeech();this.voice.token++;this.voice.taskId=null;this.voice.phase='idle';this.caption='';this.particles.dispose();this.syncFlow();if(render)this.update();}
    suspend(){if(!this.active)return;this.clearTimers();this.cancelSpeech();this.voice.pause();}
    action(action){
      switch(action){
        case 'voice':if(this.app.ui.attachment){this.app.toast('这轮已经带图，先用文字问；语音可以单独发。');return true;}if(this.app.ui.view.type!=='chat')this.app.tab('chat');this.start();return true;
        case 'voice-primary':if(!this.active)this.start();else if(this.voice.phase==='speaking'){this.cancelSpeech();this.caption='';this.voice.interrupt();}else if(this.voice.phase==='thinking')this.suspend();else if(this.voice.phase==='paused')this.voice.resume();else if(this.voice.transcript.trim())this.submit();else this.example();return true;
        case 'voice-example':this.example();return true;
        case 'voice-pause':this.suspend();return true;
        case 'voice-end':this.stop(true);return true;
        case 'scene-text':this.stop();this.textOpen=true;this.update();this.app.root.querySelector('#chat-input')?.focus({preventScroll:true});return true;
        default:return false;
      }
    }
    dispose(){this.stop();this.flow.dispose();this.model.dispose();}
  }
  return {VoiceSession,Particles,AmbientFlow,Scene,SAMPLE};
});
