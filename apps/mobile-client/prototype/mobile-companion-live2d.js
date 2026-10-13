/* The same approved local runtime/model as companion-interaction-live2d.js.
   Canvas lifetime is independent of DOM reconciliation and route snapshots. */
(() => {
  // The standalone review server starts at the repository root; the React app's
  // Vite server starts at apps/mobile-client and already mirrors approved assets
  // into its public directory. Resolve each host explicitly.
  const assets = location.pathname.startsWith('/apps/mobile-client/prototype/')
    ? new URL('../../desktop-client/src/renderer/public/assets/companion/', location.href)
    : new URL('/assets/companion/', location.origin);
  let runtime;
  const loadScript = path => new Promise((resolve,reject) => { const node=document.createElement('script');node.src=new URL(path,assets).href;node.onload=resolve;node.onerror=()=>reject(new Error('本机 Live2D 运行资源无法读取'));document.head.append(node); });
  class Live2D {
    constructor(root) {
      this.root=root;this.host=document.createElement('div');this.host.className='scene-model-layer';this.host.hidden=true;this.host.setAttribute('aria-hidden','true');
      this.canvas=document.createElement('canvas');this.host.append(this.canvas);root.append(this.host);this.level=0;this.state='idle';this.disposed=false;
      this.onFrame=()=>{if(this.levelSource)this.setLevel(this.levelSource());this.model?.internalModel.coreModel.setParameterValueById('ParamMouthOpenY',this.level);};
      this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.fail('图形资源中断，请刷新重试');});
      this.observer=new ResizeObserver(()=>this.position());this.observer.observe(root);
    }
    sync(seat,off) { this.seat=seat;this.off=off;this.host.hidden=!seat || document.hidden || this.state==='unavailable';this.position();if(seat && !this.started && typeof fetch==='function'){this.started=true;void this.init();}this.run(); }
    position() {
      if(!this.seat || !this.seat.isConnected)return;
      // Offset geometry excludes the route transition transform. The persistent
      // canvas must not inherit a transient translated snapshot position.
      let left=0,top=0;for(let node=this.seat;node && node!==this.root;node=node.offsetParent){left+=node.offsetLeft;top+=node.offsetTop;}
      Object.assign(this.host.style,{left:`${left}px`,top:`${top}px`,width:`${this.seat.clientWidth}px`,height:`${this.seat.clientHeight}px`});
      if(this.state==='ready')this.fit();
    }
    measure() {
      const i=this.model.internalModel,out={x:0,y:0,width:0,height:0};let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
      for(let n=0;n<i.coreModel.getDrawableCount();n++){const b=i.getDrawableBounds(n,out);if(b.width<=0 || b.height<=0)continue;left=Math.min(left,b.x);right=Math.max(right,b.x+b.width);top=Math.min(top,b.y);bottom=Math.max(bottom,b.y+b.height);}
      this.box=Number.isFinite(left)?{left:left/i.originalWidth,right:right/i.originalWidth,top:1-bottom/i.originalHeight,bottom:1-top/i.originalHeight}:{left:0,right:1,top:0,bottom:1};
    }
    fit() {
      if(!this.app || !this.model || !this.seat || this.disposed)return;
      const w=Math.max(1,this.seat.clientWidth),h=Math.max(1,this.seat.clientHeight),i=this.model.internalModel,b=this.box;
      this.app.renderer.resize(w,h);const scale=Math.min(w/(Math.max(.05,b.right-b.left)*i.originalWidth),h/(Math.max(.05,b.bottom-b.top)*i.originalHeight))*.88;
      this.model.scale.set(scale);this.model.position.set(w/2+i.originalWidth*scale/2-(b.left+b.right)*i.originalWidth*scale/2,h*.98-b.bottom*i.originalHeight*scale+i.originalHeight*scale/2);this.app.renderer.render(this.app.stage);
    }
    cropVisibleInk() {
      const gl=this.app.renderer.gl,w=this.canvas.width,h=this.canvas.height,p=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
      let x1=w,x2=0,y1=h,y2=0;for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){if(p[(y*w+x)*4+3]<40)continue;x1=Math.min(x1,x);x2=Math.max(x2,x);y1=Math.min(y1,y);y2=Math.max(y2,y);}
      if(x2<=x1 || y2<=y1)return;
      const r=this.app.renderer.resolution,i=this.model.internalModel,s=this.model.scale.x,m=this.model.position;
      this.box={left:((x1/r-m.x)/s+i.originalWidth/2)/i.originalWidth,right:((x2/r-m.x)/s+i.originalWidth/2)/i.originalWidth,top:(((h-y2)/r-m.y)/s+i.originalHeight/2)/i.originalHeight,bottom:(((h-y1)/r-m.y)/s+i.originalHeight/2)/i.originalHeight};
    }
    setLevel(value){this.level=this.off?0:Math.max(0,Math.min(1,value));this.host.dataset.mouthLevel=this.level.toFixed(2);}
    run(){if(!this.model || this.disposed)return;const active=!this.host.hidden && !this.off;this.model.autoUpdate=active;if(active)this.app.start();else{this.app.stop();this.level=0;this.onFrame();this.app.renderer.render(this.app.stage);}}
    async init(){
      this.state='loading';this.report();
      try{
        const response=await fetch(new URL('live2d-v3/whale/manifest.json',assets));if(!response.ok)throw new Error('模型清单无法读取');const manifest=await response.json();
        if(manifest.modelId!=='companion-live2d-whale-v3' || manifest.status!=='production' || manifest.ownerApproved?.by!=='Owner' || !manifest.modelLicense?.commercialReleaseAllowed)throw new Error('本机模型许可登记未通过');
        runtime ||= (async()=>{for(const path of ['vendor/pixi.min.js','vendor/live2dcubismcore.min.js','vendor/cubism4.min.js'])await loadScript(path);})();await runtime;if(this.disposed)return;
        this.app=new window.PIXI.Application({view:this.canvas,width:320,height:400,antialias:true,backgroundAlpha:0,resolution:Math.min(devicePixelRatio||1,2),autoDensity:true});
        const model=await window.PIXI.live2d.Live2DModel.from(new URL('live2d-v3/whale/c_0120.model3.json',assets).href,{autoInteract:false});if(this.disposed){model.destroy();return;}
        this.model=model;model.anchor.set(.5,.5);this.app.stage.addChild(model);model.internalModel.on('beforeModelUpdate',this.onFrame);
        this.measure();this.fit();this.cropVisibleInk();this.fit();this.state='ready';this.report();this.run();
      }catch(error){if(!this.disposed)this.fail(error.message || 'Live2D 无法加载');}
    }
    report(){this.root.dataset.live2d=this.state;const status=this.root.querySelector('.model-status');if(status){status.hidden=this.state==='ready';status.textContent=this.error || '伴星正在过来…';}}
    fail(reason){this.state='unavailable';this.error=reason;this.host.hidden=true;this.app?.stop();this.report();}
    dispose(){this.disposed=true;this.observer.disconnect();this.model?.internalModel.off('beforeModelUpdate',this.onFrame);this.model?.destroy();this.app?.destroy(false);this.host.remove();}
  }
  window.MOBILE_DEMO_LIVE2D={Live2D};
})();
