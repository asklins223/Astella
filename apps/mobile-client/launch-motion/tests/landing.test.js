import test from 'node:test';
import assert from 'node:assert/strict';
import { companionMatrix, validTarget } from '../source/landing.js';

const options={width:440,height:956,artwork:{w:852,h:1846},
  registration:[[.97,-.02,261],[.02,.97,608]],target:{x:40,y:260,width:330,height:300},progress:1,reduced:false};

test('the endpoint fits the actual native image bounds without a final position jump',()=>{
  const matrix=companionMatrix(options), scale=300/534;
  assert.deepEqual(matrix,[scale,0,0,scale,205-440*scale/2,260]);
});

test('the iOS fallback width correction keeps the same image center',()=>{
  const matrix=companionMatrix({...options,target:{...options.target,scaleX:1.08}});
  const center=matrix[4]+220*matrix[0];
  assert.ok(Math.abs(center-205)<1e-8);
  assert.ok(Math.abs(matrix[0]/matrix[3]-1.08)<1e-8);
});

test('reduced motion skips travel and preserves the same endpoint',()=>{
  assert.deepEqual(companionMatrix({...options,progress:.01,reduced:true}),companionMatrix(options));
});

test('records or another native page uses a fade instead of an invented companion location',()=>{
  assert.equal(companionMatrix({...options,target:null}),null);
  assert.equal(validTarget({x:NaN,y:0,width:440,height:534}),false);
  assert.equal(validTarget({x:0,y:0,width:0,height:534}),false);
});
