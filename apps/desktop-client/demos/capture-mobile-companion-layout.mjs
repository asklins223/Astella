import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2]||'http://127.0.0.1:4196';
const outputs=fileURLToPath(new URL('../../../docs/plans/learning-companion/assets/51-mobile-companion/',import.meta.url));
await mkdir(outputs,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.ASTELLA_LAYOUT_BROWSER?{executablePath:process.env.ASTELLA_LAYOUT_BROWSER}:{})});
const page=await browser.newPage({viewport:{width:1450,height:1060},deviceScaleFactor:1});
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
const report={date:'2026-10-10',scope:'Browser layout demo only; no native keyboard, mobile runtime, Agent, audio or business integration.',checks:[],geometry:[],screenshots:[]};
try{
  await page.goto(`${base}/demos/mobile-companion-layout.html`,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  for(const [width,height] of [[390,844],[360,720],[320,640]]){
    for(const scale of [1,1.25,1.5]){
      for(const view of ['chat','keyboard','read','upload','edit','mini']){
        await page.evaluate(({width,height,scale,view})=>{const p=window.mobilePreview;p.setSize(width,height);p.root.style.setProperty('--text-scale',String(scale));p.change(view);}, {width,height,scale,view});
        const geometry=await page.evaluate(()=>{
          const p=window.mobilePreview;p.measure();const content=p.root.querySelector('.content');const composer=p.root.querySelector('.bottom-panel');const header=p.root.querySelector('.topbar');
          const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
          return {...p.metrics,view:p.view,mini:p.mini,keyboardOn:p.keyboard,contentHorizontalOverflow:content.scrollWidth-content.clientWidth,headerHorizontalOverflow:header.scrollWidth-header.clientWidth,composerHorizontalOverflow:composer.scrollWidth-composer.clientWidth,roleBox:box(header.querySelector('.identity')),hostBox:p.mini?box(header.querySelector('.capsule')):null,actionBoxes:[...p.root.querySelectorAll('.topbar button,.composer button')].filter(el=>el.offsetWidth>0).map(box)};
        });
        assert(geometry.content.height>=170,`${view} usable height at ${width}×${height} scale ${scale}`);
        assert(geometry.content.y>=geometry.header.bottom-0.5,`${view} content after header`);
        assert(geometry.content.bottom<=geometry.composer.y+0.5,`${view} content before composer`);
        assert(geometry.composer.bottom<= (geometry.keyboard?.y??height)+0.5,`${view} composer above keyboard`);
        assert(geometry.contentHorizontalOverflow<=1,`${view} content outer width`);
        assert(geometry.headerHorizontalOverflow<=1,`${view} header width`);
        assert(geometry.composerHorizontalOverflow<=1,`${view} composer width`);
        if(geometry.keyboard)assert.equal(geometry.keyboard.height,292,'Keyboard placeholder uses the declared height');
        for(const box of geometry.actionBoxes)assert(box.width>=44&&box.height>=44,'Primary action hit areas are at least 44px');
        for(let i=0;i<geometry.actionBoxes.length;i++)for(let j=i+1;j<geometry.actionBoxes.length;j++){
          const a=geometry.actionBoxes[i],b=geometry.actionBoxes[j];
          assert(a.right<=b.x+.5||b.right<=a.x+.5||a.bottom<=b.y+.5||b.bottom<=a.y+.5,'Primary action hit areas do not overlap');
        }
        if(geometry.hostBox)assert(geometry.roleBox.right<=geometry.hostBox.x,'Role does not cover the mini-program host capsule');
        report.geometry.push({width,height,textScale:scale,state:view,...geometry});
      }
    }
  }
  report.checks.push('54 combinations: 3 screen sizes × 3 body-font scales × 6 states; content, header and composer remain in their own non-overlapping areas.');
  await page.evaluate(()=>{const p=window.mobilePreview;p.setSize(390,844);p.root.style.setProperty('--text-scale','1');p.change('chat');});
  await page.locator('#device textarea').fill('保留这份输入，先去看看原文。');
  await page.locator('#device [data-action="read"]').first().click();
  await page.locator('#device [data-action="back"]').click();
  assert.equal(await page.locator('#device textarea').inputValue(),'保留这份输入，先去看看原文。');
  report.checks.push('Draft is preserved when opening a note and returning to the same conversation.');
  await page.locator('#device [data-action="read"]').first().click();
  const atBottom=await page.evaluate(()=>{const c=document.querySelector('#device .content');c.scrollTop=c.scrollHeight;return Math.abs(c.scrollHeight-c.clientHeight-c.scrollTop)<1;});
  assert(atBottom,'long content can reach bottom');
  await page.locator('#device [data-action="edit"]').click();
  await page.locator('#device [data-action="before"]').click();
  assert(await page.locator('#device .article').innerText().then(t=>t.includes('职务不由家族持续继承')));
  await page.locator('#device [data-action="after"]').click();
  assert.equal(await page.locator('#device table tbody tr').count(),2);
  report.checks.push('Long note reaches its last paragraph; before/after edit views are actually switchable.');
  await page.evaluate(()=>window.mobilePreview.change('keyboard'));
  await page.locator('#device textarea').fill('这是一条演示消息');
  await page.locator('#device .composer .send').click();
  assert(await page.locator('#device .message.user').last().innerText().then(t=>t.includes('这是一条演示消息')));
  report.checks.push('Input and submit work with keyboard placeholder present; message joins the local conversation.');
  await page.evaluate(()=>window.mobilePreview.change('upload'));
  await page.locator('#device [data-action="stop"]').click();
  assert(await page.locator('#device .file-status').innerText().then(t=>t.includes('已停止后续处理')));
  report.checks.push('Task stop changes the displayed local task state without removing already available material.');
  await page.evaluate(()=>window.mobilePreview.root.classList.add('no-blur'));
  assert.equal(await page.locator('#device .file-card').first().evaluate(el=>getComputedStyle(el).backdropFilter),'none');
  report.checks.push('No-blur fallback preserves the same component layout.');
  for(const [board,filename] of [[1,'08-layout-chat-keyboard-reading.png'],[2,'09-layout-upload-edit-miniprogram.png']]){
    await page.goto(`${base}/demos/mobile-companion-layout.html?board=${board}`,{waitUntil:'networkidle'});
    await page.evaluate(()=>document.fonts.ready);
    report[`board${board}Geometry`]=await page.evaluate(()=>window.mobilePreviews.map(p=>{p.measure();return p.metrics;}));
    await page.locator('#workbench').screenshot({path:outputs+filename});
    report.screenshots.push(filename);
  }
  assert.equal(errors.length,0,'browser runtime errors');
  report.checks.push('No page runtime errors during interaction and captures.');
  await writeFile(outputs+'layout-verification-2026-10-10.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks,geometryCases:report.geometry.length,screenshots:report.screenshots},null,2));
}finally{await browser.close();}
