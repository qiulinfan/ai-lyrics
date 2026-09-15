import test from 'node:test';
import assert from 'node:assert/strict';
import {IdleModel} from './idle-model.mjs';
import {Broker} from './hy-bridge-core.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){
  let time=1000,model=null,loads=0,unloads=0;
  const ops={inspect:async()=>model,load:async()=>{loads++;model={status:'idle',queued:0};},unload:async()=>{unloads++;model=null;}};
  const life=new IdleModel(ops,{now:()=>time});
  return {life,ops,advance:ms=>time+=ms,get counts(){return {loads,unloads};},get model(){return model;}};
}
test('exact ten-minute idle boundary, reload after eviction',async()=>{
  const f=fixture();await f.life.reconcile();assert.equal(f.life.stats().phase,'unloaded');assert.equal(f.counts.loads,0);
  await f.life.use(async()=>42);f.advance(599999);assert.equal(await f.life.checkIdle(),false);
  f.advance(1);assert.equal(await f.life.checkIdle(),true);assert.deepEqual(f.counts,{loads:1,unloads:1});
  await f.life.use(async()=>43);assert.deepEqual(f.counts,{loads:2,unloads:1});f.life.stop();
});
test('concurrent misses share one load and active work cannot be evicted',async()=>{
  const f=fixture();let release;const gate=new Promise(r=>release=r);
  const jobs=[f.life.use(()=>gate),f.life.use(()=>gate)];await tick();assert.equal(f.counts.loads,1);
  f.advance(600001);assert.equal(await f.life.checkIdle(),false);assert.equal(f.counts.unloads,0);
  release();await Promise.all(jobs);f.advance(600000);await f.life.checkIdle();assert.equal(f.counts.unloads,1);f.life.stop();
});
test('cached response after eviction does not load the model',async()=>{
  const f=fixture();const broker=new Broker((task,signal)=>f.life.use(async()=>task,signal),{ttlMs:3600000});
  await broker.submit({text:'same'});f.advance(600000);await f.life.checkIdle();
  f.life.touch();await broker.submit({text:'same'});assert.deepEqual(f.counts,{loads:1,unloads:1});f.life.stop();
});
test('new request during unload waits, then reloads; no overlap',async()=>{
  const f=fixture();await f.life.use(async()=>{});f.advance(600000);
  const original=f.ops.unload;let release;
  f.ops.unload=async()=>{await new Promise(r=>release=r);await original();};
  const eviction=f.life.checkIdle();await tick();let ran=false;
  const use=f.life.use(async()=>{ran=true;});await tick();assert.equal(ran,false);
  release();await eviction;await use;assert.equal(ran,true);assert.deepEqual(f.counts,{loads:2,unloads:1});f.life.stop();
});
test('request arrival during idle inspection prevents eviction',async()=>{
  const f=fixture();await f.life.use(async()=>{});f.advance(600000);
  const original=f.ops.inspect;let release;
  f.ops.inspect=async()=>{await new Promise(r=>release=r);return original();};
  const eviction=f.life.checkIdle();await tick();f.life.touch();release();
  assert.equal(await eviction,false);assert.equal(f.counts.unloads,0);f.life.stop();
});
test('load failure is recoverable on the next request',async()=>{
  const f=fixture();const original=f.ops.load;f.ops.load=async()=>{throw new Error('temporary');};
  await assert.rejects(f.life.use(async()=>{}),/temporary/);assert.equal(f.life.stats().activeUsers,0);
  f.ops.load=original;await f.life.use(async()=>{});assert.equal(f.counts.loads,1);f.life.stop();
});
