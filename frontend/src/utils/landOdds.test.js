import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOdds } from './landOdds.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
const choose=(n,k)=>{ if(k<0 || k>n)return 0;let x=1;for(let i=1;i<=k;i++)x=x*(n-i+1)/i;return x; };
test('play skips first draw; draw includes it; turn capped at deck size',()=>{
 assert.equal(sourceOdds({sources:9,turn:1}).seen,7);
 assert.equal(sourceOdds({sources:9,turn:1,onDraw:true}).seen,8);
 assert.equal(sourceOdds({sources:9,turn:3}).seen,9);
 assert.equal(sourceOdds({sources:9,turn:3,onDraw:true}).seen,10);
 assert.equal(sourceOdds({deck:7,sources:1,turn:20}).seen,7);
});
test('zero, all, impossible demand and full-deck boundaries',()=>{
 near(sourceOdds({sources:0}).probability,0);
 near(sourceOdds({sources:40,needed:2}).probability,1);
 near(sourceOdds({sources:1,needed:2}).probability,0);
 near(sourceOdds({deck:7,sources:2,needed:2}).probability,1);
});
test('independent combination formula across source, demand and turn ranges',()=>{
 for(let sources=0;sources<=40;sources++)for(let needed=1;needed<=4;needed++)for(let turn=1;turn<=8;turn++)for(const onDraw of [false,true]){
  const r=sourceOdds({sources,needed,turn,onDraw});
  let expected=0;for(let k=needed;k<=Math.min(sources,r.seen);k++)expected+=choose(sources,k)*choose(40-sources,r.seen-k)/choose(40,r.seen);
  near(r.probability,expected);
 }
});
test('more sources, later draws, drawing first improve access; more pips reduce it',()=>{
 for(let sources=0;sources<40;sources++){
  const p=sourceOdds({sources}).probability;
  assert.ok(sourceOdds({sources:sources+1}).probability+1e-12>=p);
  assert.ok(sourceOdds({sources,onDraw:true}).probability+1e-12>=p);
  assert.ok(sourceOdds({sources,turn:4}).probability+1e-12>=p);
  assert.ok(sourceOdds({sources,needed:2}).probability<=p+1e-12);
 }
});
test('rejects malformed inputs instead of fabricating percentages',()=>{
 for(const args of [{sources:-1},{sources:41},{sources:'9'},{sources:1.2},{sources:9,deck:6},{sources:9,deck:101},{sources:9,needed:0},{sources:9,turn:0},{sources:9,turn:NaN},{sources:9,onDraw:1}])assert.throws(()=>sourceOdds(args));
});
