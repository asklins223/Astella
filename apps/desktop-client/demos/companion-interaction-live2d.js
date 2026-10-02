/* Uses the repository's approved local model and vendor runtime; never substitutes a portrait. */
(() => {
  const seat = document.getElementById("character");
  const status = document.getElementById("model-status");
  const canvas = document.getElementById("live2d");
  const assets = new URL("../src/renderer/public/assets/companion/", document.baseURI);
  let app, model, contentBox, size = 1, expressionTimer = 0;
  let disposed = false;

  function script(path) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script"); el.src = new URL(path, assets).href;
      el.onload = resolve; el.onerror = () => reject(new Error("本机 Live2D 运行资源无法读取"));
      document.head.append(el);
    });
  }
  function measure() {
    const internal = model.internalModel;
    const count = internal.coreModel.getDrawableCount();
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    const out = { x:0,y:0,width:0,height:0 };
    for (let i = 0; i < count; i++) {
      const b = internal.getDrawableBounds(i, out);
      if (!(b.width > 0 && b.height > 0)) continue;
      left = Math.min(left,b.x); right = Math.max(right,b.x+b.width);
      top = Math.min(top,b.y); bottom = Math.max(bottom,b.y+b.height);
    }
    const w = internal.originalWidth, h = internal.originalHeight;
    contentBox = Number.isFinite(left) ? { left:left/w, right:right/w, top:1-bottom/h, bottom:1-top/h } : { left:0,right:1,top:0,bottom:1 };
  }
  function fit() {
    if (!model || disposed) return;
    const w = Math.max(1,seat.clientWidth), h = Math.max(1,seat.clientHeight);
    app.renderer.resize(w,h);
    const mw = model.internalModel.originalWidth, mh = model.internalModel.originalHeight;
    const box = contentBox, bw = Math.max(.05,box.right-box.left)*mw, bh = Math.max(.05,box.bottom-box.top)*mh;
    const scale = Math.min(w/bw,h/bh)*.97*size;
    model.scale.set(scale);
    model.position.set(w/2+mw*scale/2-(box.left+box.right)*mw*scale/2,h*.98-box.bottom*mh*scale+mh*scale/2);
    app.renderer.render(app.stage);
    // Read the fitted frame for Demo verification; the transparent canvas edge
    // does not identify the visible head, particularly after a window resize.
    const ink = readVisibleInk();
    if (ink) {
      seat.dataset.visibleHeadOffset = String((ink.h-ink.y2)/app.renderer.resolution);
      seat.dataset.visibleFootOffset = String((ink.h-ink.y1)/app.renderer.resolution);
    }
    // Bubble count and content never change the character's reserved seat.
  }
  // Dormant prop drawables enlarge the model canvas. Measure the first rendered
  // alpha frame once, so framing follows the character actually on the screen.
  function readVisibleInk() {
    const gl = app.renderer.gl;
    const w = canvas.width, h = canvas.height;
    const pixels = new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let x1 = w, x2 = 0, y1 = h, y2 = 0;
    for (let y=0;y<h;y+=2) for (let x=0;x<w;x+=2) {
      if (pixels[(y*w+x)*4+3]<40) continue;
      x1=Math.min(x1,x); x2=Math.max(x2,x); y1=Math.min(y1,y); y2=Math.max(y2,y);
    }
    return x2>x1 && y2>y1 ? { x1,x2,y1,y2,w,h } : null;
  }
  function measureVisibleInk() {
    const ink = readVisibleInk(); if (!ink) return;
    const { x1,x2,y1,y2,h } = ink;
    const resolution = app.renderer.resolution;
    const mw = model.internalModel.originalWidth, mh = model.internalModel.originalHeight;
    const scale = model.scale.x;
    contentBox = {
      left:((x1/resolution-model.position.x)/scale+mw/2)/mw,
      right:((x2/resolution-model.position.x)/scale+mw/2)/mw,
      top:(((h-y2)/resolution-model.position.y)/scale+mh/2)/mh,
      bottom:(((h-y1)/resolution-model.position.y)/scale+mh/2)/mh,
    };
  }
  function syncMotion() {
    if (!model || disposed) return;
    const run = document.getElementById("demo").dataset.motion === "full" && !document.hidden;
    model.autoUpdate = run;
    if (run) app.start(); else { app.stop(); app.renderer.render(app.stage); }
  }
  async function mood(event) {
    if (!model || disposed || document.getElementById("demo").dataset.motion !== "full") return;
    clearTimeout(expressionTimer);
    try { await model.expression(event.detail); } catch { return; }
    expressionTimer = setTimeout(() => { if (!disposed) model.internalModel.motionManager.expressionManager.resetExpression(); }, 2500);
  }
  function unavailable(reason) {
    seat.dataset.live2d = "unavailable"; canvas.hidden = true;
    document.getElementById("touch").hidden = true;
    status.hidden = false; status.textContent = `${reason}。文字与交互仍可使用。`;
    model && (model.autoUpdate = false); app?.stop();
  }
  async function init() {
    try {
      if (location.protocol === "file:") throw new Error("Live2D 需要通过本机预览地址读取");
      const manifestResponse = await fetch(new URL("live2d-v3/whale/manifest.json", assets));
      if (!manifestResponse.ok) throw new Error("本机 Live2D 模型清单无法读取");
      const manifest = await manifestResponse.json();
      if (manifest.modelId !== "companion-live2d-whale-v3" || manifest.status !== "production" || manifest.ownerApproved?.by !== "Owner" || !manifest.modelLicense?.commercialReleaseAllowed) throw new Error("本机模型许可登记未通过");
      for (const path of ["vendor/pixi.min.js","vendor/live2dcubismcore.min.js","vendor/cubism4.min.js"]) await script(path);
      if (!window.PIXI?.live2d || !window.Live2DCubismCore) throw new Error("Live2D 运行资源不可用");
      app = new window.PIXI.Application({ view:canvas, width:seat.clientWidth, height:seat.clientHeight, antialias:true, backgroundAlpha:0, resolution:Math.min(Math.max(devicePixelRatio,1.5),2), autoDensity:true });
      model = await window.PIXI.live2d.Live2DModel.from(new URL("live2d-v3/whale/c_0120.model3.json", assets).href, { autoInteract:false });
      if (disposed) { model.destroy(); return; }
      model.anchor.set(.5,.5); app.stage.addChild(model); measure(); fit(); measureVisibleInk(); fit();
      status.hidden = true; seat.dataset.live2d = "ready";
      const observer = new ResizeObserver(fit);
      observer.observe(seat); syncMotion();
    } catch (error) { unavailable(error.message || "Live2D 无法加载"); }
  }
  canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); unavailable("Live2D 图形资源已中断"); });
  window.addEventListener("companion-demo-motion", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
  window.addEventListener("companion-demo-mood", (event) => { void mood(event); });
  window.addEventListener("companion-demo-size", (event) => { size = event.detail; fit(); });
  window.addEventListener("pagehide", () => { disposed = true; clearTimeout(expressionTimer); model?.destroy(); app?.destroy(false); }, { once:true });
  void init();
})();
