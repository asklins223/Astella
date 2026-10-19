import * as T from 'three';
import { paths } from './artwork.js';
import registration from './actor-registration.json';
import blinkRegistration from './blink-registration.json';
import { vertex, fragment } from './water-shaders.js';
import { LaunchClock, clamp, fade } from './timeline.js';
import { presentCompanion, validTarget } from './landing.js';

const clock = new LaunchClock();
const actor = document.querySelector('#companion');
const imageData = new Map();
function assetData(name) {
  if (!imageData.has(name)) imageData.set(name, new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='artwork/'+name+'.js';
    script.onload=()=>{
      const value=window.AstellaArtwork?.[name];
      if (value) resolve(value); else reject(new Error('Missing artwork'));
      script.remove();
    };
    script.onerror=reject;
    document.head.append(script);
  }));
  return imageData.get(name);
}
const loader = new T.TextureLoader();
const camera = new T.OrthographicCamera(-426,426,923,-923,.1,5000);
camera.position.z = 2000;
const scene = new T.Scene();
let renderer, model, frameId = null, destroyed = false, painted = false;
let native = { dark: false, active: true, reduced: false, ready: false, target: null };
let key = null, generation = 0, finished = false, pokeAt = null;

function notify(type) {
  const message = { type };
  window.webkit?.messageHandlers?.astellaMotion?.postMessage(message);
  window.AstellaMotionBridge?.postMessage(JSON.stringify(message));
}

function mask(config, path, blur) {
  const canvas = document.createElement('canvas');
  canvas.width = config.w; canvas.height = config.h;
  const context = canvas.getContext('2d');
  if (blur) context.filter = `blur(${blur}px)`;
  context.fillStyle = 'white'; context.fill(new Path2D(path));
  const texture = new T.CanvasTexture(canvas); texture.minFilter = T.LinearFilter;
  return texture;
}

function affine(matrix) { return new T.Matrix3().set(...matrix[0], ...matrix[1], 0,0,1); }
function disposeModel(current) {
  if (!current) return;
  scene.remove(current.mesh);
  current.mesh.geometry.dispose(); current.mesh.material.dispose();
  for (const texture of current.textures) texture.dispose();
}

async function loadScene(next) {
  key = next;
  const revision = ++generation, config = paths[next];
  const prefix = next === 'room' ? 'night-room' : 'soft-star';
  const textures = await Promise.all([prefix+'-approved.png', prefix+'-empty.png',
    'companion-stage.png', 'companion-blink.png'].map(async name => loader.loadAsync(await assetData(name))));
  if (destroyed || revision !== generation) { textures.forEach(texture=>texture.dispose()); return; }
  const [art, clean, alpha, blink] = textures;
  actor.src=await assetData('companion-stage.png');
  for (const texture of [art, clean, blink]) texture.colorSpace = T.SRGBColorSpace;
  textures.forEach(texture=>texture.minFilter=T.LinearFilter);
  const actorToScene = affine(registration[prefix].matrix);
  const sceneToActor = actorToScene.clone().invert();
  const outer = mask(config, config.outer, 2), interior = mask(config, config.interior, 14);
  const uniforms = {
    uArt:{value:art}, uClean:{value:clean}, uActorMask:{value:alpha}, uBlink:{value:blink},
    uOuter:{value:outer}, uInterior:{value:interior}, uSize:{value:new T.Vector2(config.w,config.h)},
    uActorMap:{value:sceneToActor}, uActorToScene:{value:actorToScene},
    uBlinkMap:{value:affine(blinkRegistration.matrix).invert().multiply(sceneToActor)},
    uBlinkSize:{value:new T.Vector2(blinkRegistration.width,blinkRegistration.height)},
    uRemoveActor:{value:0}, uActor:{value:1}, uTime:{value:0}, uLamp:{value:0}, uFlow:{value:0},
    uCompare:{value:0}, uScene:{value:next==='room'?0:1}, uExit:{value:0}, uJelly:{value:1},
    uLoading:{value:1}, uKick:{value:-100},
  };
  const mesh = new T.Mesh(new T.PlaneGeometry(config.w,config.h,84,168), new T.ShaderMaterial({
    uniforms, vertexShader:vertex, fragmentShader:fragment, transparent:true, depthWrite:false, toneMapped:false,
  }));
  disposeModel(model);
  model = { mesh, uniforms, config, registration:registration[prefix].matrix, textures:[...textures,outer,interior] };
  notify('assetsReady');
  scene.add(mesh); resize(); schedule();
}

function resize() {
  if (!renderer || !model) return;
  const config = model.config, aspect = innerWidth/innerHeight;
  const height = Math.max(config.h,config.w/aspect), width = height*aspect;
  camera.left=-width/2; camera.right=width/2; camera.top=height/2; camera.bottom=-height/2;
  camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); schedule();
}

function schedule() {
  if (!destroyed && !finished && frameId === null) frameId=requestAnimationFrame(frame);
}

function frame(now) {
  frameId=null;
  if (!model || destroyed) return;
  const snapshot=clock.tick(now,painted), {time,progress,exit}=snapshot, reduced=clock.reduced;
  const hasTarget=validTarget(native.target), u=model.uniforms;
  if (!painted && key==='star' && !reduced && pokeAt===null) pokeAt=time;
  const light=fade(time/(reduced?.18:1.45));
  const flow=reduced?0:1-exit;
  u.uTime.value=time; u.uLamp.value=Math.max(light,exit); u.uFlow.value=flow;
  u.uExit.value=exit; u.uJelly.value=reduced?0:1; u.uActor.value=reduced?0:1;
  u.uKick.value=pokeAt===null?-100:time-pokeAt;
  u.uRemoveActor.value=hasTarget?fade(progress/.12):0;
  u.uActor.value*=1-u.uRemoveActor.value;
  if (clock.exitAt!==null && hasTarget) {
    presentCompanion(actor,{width:innerWidth,height:innerHeight,artwork:model.config,
      registration:model.registration,target:native.target,progress,reduced});
  } else actor.style.display='none';
  if (!painted) notify('paintStarted');
  renderer.render(scene,camera);
  document.querySelector('#backdrop').style.opacity=String(1-exit);
  document.body.dataset.progress=progress.toFixed(3);
  document.body.dataset.scene=key;
  if (!painted) { painted=true; notify('rendered'); }
  if (progress>=1) {
    // Keep the exact endpoint visible until native swaps both layers in one UI update.
    finished=true; notify('landed'); return;
  }
  if (clock.active && !(reduced && light>=.999 && !clock.ready)) schedule();
}

function update(options) {
  if (destroyed || finished) return;
  native={...native,...options};
  document.querySelector('#backdrop').style.background=native.dark?'#101c36':'#f3f6fe';
  clock.configure({active:native.active&&!document.hidden,reduced:native.reduced,ready:native.ready,elapsed:options.elapsed});
  const next=native.dark?'room':'star';
  if (next!==key) loadScene(next).catch(fail);
  schedule();
}

function fail() { if (!destroyed) { finished=true; notify('failed'); } }
function destroy() {
  if (destroyed) return;
  destroyed=true; generation++;
  if (frameId!==null) cancelAnimationFrame(frameId);
  disposeModel(model); model=null; renderer?.dispose(); renderer?.forceContextLoss();
  actor.style.display='none';
}

window.AstellaLaunch={update,destroy};
addEventListener('resize',resize);
document.addEventListener('visibilitychange',()=>update({}));
addEventListener('pagehide',destroy);
addEventListener('error',fail);
addEventListener('unhandledrejection',fail);
notify('bridgeReady');
try {
  renderer=new T.WebGLRenderer({alpha:true,antialias:true,powerPreference:'default'});
  renderer.debug.onShaderError=fail;
  renderer.setClearColor(0,0); renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.outputColorSpace=T.SRGBColorSpace;
  document.querySelector('#world').append(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost',fail);
  renderer.domElement.addEventListener('pointerdown',()=>{ if(key==='star'&&!clock.reduced)pokeAt=clock.time; });
} catch { fail(); }
