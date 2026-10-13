const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {JSDOM}=require('jsdom');
const {webcrypto}=require('node:crypto');
const demoDir=join(__dirname,'..');
function environment({history=true}={}) {
  const dom = new JSDOM(readFileSync(join(demoDir, 'mobile-companion-layout.html'), 'utf8'), { url:'http://localhost/apps/mobile-client/prototype/mobile-companion-layout.html', runScripts:'outside-only', pretendToBeVisual:true });
  const w = dom.window;
  Object.defineProperty(w,'crypto',{value:webcrypto});
  w.ResizeObserver=class {observe(){}disconnect(){}};
  w.matchMedia = () => ({ matches:false, addEventListener(){} });
  w.DOMMatrix = class { constructor(value) { this.a=1;this.d=1;this.e=0;this.f=0; if (value && value.startsWith('matrix(')) [this.a,, ,this.d,this.e,this.f]=value.slice(7,-1).split(',').map(Number); } };
  w.Element.prototype.animate = function(keyframes, options) { return { keyframes, options, cancel(){}, onfinish:null }; };
  const root=w.document.querySelector('#device');
  Object.defineProperties(root,{clientWidth:{get:()=>390},clientHeight:{get:()=>844}});
  root.getBoundingClientRect=()=>({left:0,top:0,width:390,height:844});
  for (const file of ['notebook-icons.js','mobile-companion-data.js','mobile-companion-motion.js','mobile-companion-account.js','mobile-companion-centers.js','mobile-companion-live2d.js','mobile-companion-scene.js','mobile-companion-layout.js']) w.eval(readFileSync(join(demoDir,file),'utf8'));
  if(history){w.mobileDemo.accounts.update(u=>{u.preferences.chatLayout='history';});w.mobileDemo.app.render();}
  const click = selector => { const node=w.document.querySelector(selector);assert.ok(node,selector);node.click();return node; };
  return {w,root,click,close:()=>{w.mobileDemo.app.scene.dispose();w.mobileDemo.app.motion.finish();w.close();}};
}
module.exports={environment};
