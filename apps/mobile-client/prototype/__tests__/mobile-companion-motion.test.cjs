const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const { panelPlacement, rectTransform, frames } = require('../mobile-companion-motion.js');
const demoDir = join(__dirname, '..');
const {environment}=require('./mobile-companion-test-env.cjs');
test('short panels stay inside small phones and choose the trigger side',()=>{
  for (const size of [{width:320,height:640},{width:390,height:844}]) {
    const top=panelPlacement('menu',{x:15,y:59,width:44,height:44},size,340);
    const bottom=panelPlacement('attach',{x:15,y:size.height-140,width:44,height:44},size,340);
    assert.equal(top.y,112);assert.ok(bottom.y < size.height-140);
    for(const p of [top,bottom,panelPlacement('spaces',{x:250,y:59,width:90,height:44},size,240)]) {
      assert.ok(p.x>=12);assert.ok(p.x+p.width<=size.width-12);assert.ok(p.y>=48);assert.ok(p.y+p.height<=size.height-16);
    }
  }
});
test('a panel opening starts at its actual source rectangle, with a settled final frame',()=>{
  const to={x:12,y:220,width:366,height:500};const from={x:18,y:750,width:44,height:44};
  const start=rectTransform(from,to);
  assert.equal(to.x+start.x,from.x);assert.equal(to.y+start.y,from.y);
  assert.equal(to.width*start.sx,44);assert.equal(to.height*start.sy,44);
  const values=frames(p=>({progress:p}));assert.equal(values[0].progress,0);assert.equal(values.at(-1).progress,1);
  assert.ok(Math.max(...values.map(f=>f.progress))<1.08);
});
test('same-action prompts survive repeated updates and focused input keeps its node and selection',()=>{
  const env=environment();const {w,root}=env;
  try {
    const input=root.querySelector('#chat-input');input.value='还没说完';input.dispatchEvent(new w.Event('input',{bubbles:true}));input.focus();input.setSelectionRange(2,4);
    const message=root.querySelector('[data-message-id]');
    w.mobileDemo.store.desktopEdit('note-history');
    assert.equal(root.querySelector('#chat-input'),input);assert.equal(w.document.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,4);
    assert.equal(root.querySelector('[data-message-id]'),message);
    assert.equal(root.querySelectorAll('.thread-quick button').length,3);
    assert.equal(input.value,'还没说完');
  } finally {env.close();}
});
test('menu > settings page > consent returns to the settings page and then its source',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    click('[data-action="menu"]');click('.sheet [data-action="settings"]');
    assert.equal(w.mobileDemo.app.ui.view.type,'settings');assert.equal(root.querySelector('[role="tablist"]'),null);
    click('.page-scroll [data-action="consent-info"]');assert.equal(root.querySelector('.sheet').dataset.panel,'consent');
    click('[data-action="close-sheet"]');assert.equal(w.mobileDemo.app.ui.view.type,'settings');
    assert.equal(w.document.activeElement.dataset.action,'consent-info');
    click('[data-action="back"]');assert.equal(w.mobileDemo.app.ui.view.type,'chat');
    assert.equal(root.querySelector('.app-surface').inert,false);
    w.mobileDemo.app.motion.finish();assert.equal(root.querySelectorAll('#sheet-title').length,0);
  } finally {env.close();}
});
test('details return to their actual tab and content tabs never retain the chat composer',()=>{
  const env=environment();const {root,click}=env;
  try {
    click('[data-tab="notes"]');assert.equal(root.querySelector('#chat-input'),null);
    click('[data-action="open-note"][data-id="note-history"]');assert.equal(root.querySelector('[role="tablist"]'),null);
    assert.equal(root.querySelectorAll('.page-scroll').length,1);assert.equal(root.querySelector('.route-ghost [data-action]'),null);
    click('[data-action="back"]');assert.equal(root.querySelector('[aria-selected="true"]').dataset.tab,'notes');
    click('[data-tab="stuff"]');assert.equal(root.querySelector('#chat-input'),null);
    click('[data-tab="chat"]');assert.ok(root.querySelector('#chat-input'));
  } finally {env.close();}
});
test('closing can be interrupted by a new panel without an old completion hiding it',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    click('[data-action="menu"]');click('[data-action="close-sheet"]');click('[data-action="spaces"]');
    w.mobileDemo.app.motion.finish();
    assert.equal(root.querySelector('.modal-host').hidden,false);assert.equal(root.querySelector('.sheet').dataset.panel,'spaces');
    assert.equal(root.querySelector('.sheet').inert,false);assert.equal(root.querySelector('.app-surface').inert,true);
  } finally {env.close();}
});
test('turning motion off settles active overlays and subsequent close has no delayed blocker',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    click('[data-action="menu"]');const toggle=w.document.querySelector('#motion-toggle');toggle.checked=true;toggle.dispatchEvent(new w.Event('change',{bubbles:true}));
    assert.equal(w.mobileDemo.app.motion.running.size,0);
    click('[data-action="close-sheet"]');assert.equal(root.querySelector('.modal-host').hidden,true);
    click('[data-tab="notes"]');assert.equal(root.querySelector('.route-ghost'),null);assert.equal(root.querySelector('#chat-input'),null);
  } finally {env.close();}
});
test('a page leaving a tab switch is invisible by half the transition, not a watermark',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    click('[data-tab="stuff"]');
    const ghost=root.querySelector('.route-ghost');
    assert.ok(ghost,'the previous page is handed over as a ghost');
    const entry=[...w.mobileDemo.app.motion.running].find(([node])=>node===ghost);
    const keyframes=entry[1].animation.keyframes;
    assert.equal(keyframes.filter(f=>f.offset<=.5).at(-1).opacity,0);
    assert.equal(keyframes.at(-1).opacity,0);
  } finally{env.close();}
});
test('a render during the return animation keeps the live page instead of its ghost',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    click('[data-tab="notes"]');click('[data-action="open-note"][data-id="note-history"]');click('[data-action="back"]');
    const page=root.querySelector('.page-scroll');
    assert.ok(root.querySelector('.route-ghost'),'the leaving page is still animating');
    w.mobileDemo.app.render();
    assert.equal(root.querySelector('.page-scroll'),page,'the ghost did not replace the live page');
    assert.equal(page.style.position,'');assert.equal(root.querySelectorAll('.viewport > *').length,2);
    w.mobileDemo.app.motion.finish();
    assert.equal(root.querySelectorAll('.viewport > *').length,1);
    assert.equal(root.querySelector('.page-scroll'),page);
  } finally{env.close();}
});
test('a send that is refused still settles the panel it was started from',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    const app=w.mobileDemo.app;
    click('[data-action="attach"]');assert.equal(root.querySelector('.sheet').dataset.panel,'attach');
    app.offline=true;click('.sheet [data-action="sample-image"]');
    app.send();
    assert.equal(app.sheet,null);assert.equal(root.querySelector('.app-surface').inert,false);
    assert.ok(root.querySelector('.toast'));
    app.motion.finish();assert.equal(root.querySelector('.modal-host').hidden,true);
  } finally{env.close();}
});
test('手记 carries no conversation list; an archived thread stays read-only where it opens',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    const app=w.mobileDemo.app, store=w.mobileDemo.store;
    click('[data-tab="notes"]');
    assert.deepEqual([...root.querySelectorAll('[data-action="filter"]')].map(el => el.dataset.filter),['notes','images'],'手记 only filters what was left behind');
    assert.equal(root.querySelector('[data-action="menu-conversations"]'),null);
    assert.equal(root.querySelector('[data-action="open-conversation"]'),null,'history is not a note type');
    click('[data-tab="chat"]');w.mobileDemo.app.scene.setMode('history');
    const earlier=[...root.querySelectorAll('[data-action="open-conversation"]')];
    assert.equal(earlier.length,1,'the older thread sits above the live one in 聊天记录');
    assert.ok(earlier[0].textContent.includes('更早的交流'));
    earlier[0].click();
    assert.equal(app.ui.view.type,'archive');
    assert.ok(root.querySelector('.archive-line.mine'),'both sides stay readable');
    assert.ok(root.querySelector('.detail-dock [data-action="archive-to-thread"]'));
    click('[data-action="quote-archive"]');
    assert.equal(app.ui.view.type,'chat');assert.ok(app.ui.context.quote);
    assert.equal(store.activeConversation('home').id,'conversation-current','reading history did not fork the live thread');
  } finally{env.close();}
});
test('edge drag can cancel and then commit without losing its source page',()=>{
  const env=environment();const {root,click,w}=env;
  try {
    root.setPointerCapture=()=>{};root.hasPointerCapture=()=>false;root.releasePointerCapture=()=>{};
    click('[data-tab="notes"]');click('[data-action="open-note"][data-id="note-history"]');w.mobileDemo.app.motion.finish();
    const fire=(target,type,x)=>{const event=new w.MouseEvent(type,{bubbles:true,clientX:x,clientY:300,button:0});Object.defineProperty(event,'pointerId',{value:1});target.dispatchEvent(event);};
    let paper=root.querySelector('.paper');fire(paper,'pointerdown',5);fire(root,'pointermove',65);
    assert.ok(root.querySelector('.route-ghost'));fire(root,'pointercancel',65);
    assert.equal(root.dataset.screen,'reader');assert.equal(root.querySelector('.page-scroll').style.transform,'');w.mobileDemo.app.motion.finish();
    paper=root.querySelector('.paper');fire(paper,'pointerdown',5);fire(root,'pointermove',180);fire(root,'pointerup',180);
    assert.equal(root.dataset.screen,'notes');assert.equal(root.querySelector('[aria-selected="true"]').dataset.tab,'notes');
  } finally {env.close();}
});
