import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchClock } from '../source/timeline.js';

function advance(clock, start, count) {
  let result;
  for (let i=0; i<count; i++) result=clock.tick(start+i*1000/60);
  return result;
}

test('a slow real load never auto-completes at the old showcase deadline',()=>{
  const clock=new LaunchClock();
  const state=advance(clock,0,900);
  assert.ok(state.time>14);
  assert.equal(state.progress,0);
  assert.equal(clock.exitAt,null);
});

test('first lighting starts at the native presentation time and later updates cannot rewind it',()=>{
  const clock=new LaunchClock();
  clock.configure({elapsed:1.6,ready:true});
  const first=clock.tick(0,false);
  assert.equal(first.time,1.6);
  assert.equal(first.progress,0);
  clock.configure({elapsed:0});
  assert.equal(clock.tick(10,false).time,1.61);
});

test('native ready waits for a painted scene and duplicate signals preserve the departure',()=>{
  const clock=new LaunchClock();
  clock.configure({ready:true});
  clock.tick(0,false); clock.tick(20,false);
  assert.equal(clock.exitAt,null);
  clock.tick(40,true);
  const departure=clock.exitAt;
  clock.configure({ready:true});
  const middle=advance(clock,60,15);
  assert.equal(clock.exitAt,departure);
  assert.ok(middle.progress>0 && middle.progress<1);
  assert.equal(advance(clock,400,45).progress,1);
});

test('backgrounding freezes both material time and the in-flight handoff',()=>{
  const clock=new LaunchClock();
  clock.configure({ready:true}); advance(clock,0,10);
  const before=clock.tick(170);
  clock.configure({active:false});
  assert.deepEqual(clock.tick(20_000),before);
  clock.configure({active:true});
  assert.deepEqual(clock.tick(40_000),before);
  assert.ok(clock.tick(40_016).progress>before.progress);
});

test('reduced motion shortens the handoff and turning it off cannot rewind it',()=>{
  const clock=new LaunchClock();
  clock.configure({ready:true,reduced:true});
  advance(clock,0,5);
  const progress=clock.tick(85).progress;
  clock.configure({reduced:false});
  assert.ok(clock.tick(95).progress>=progress);
  assert.equal(clock.exitDuration,.18);
  assert.equal(advance(clock,110,10).progress,1);
});
