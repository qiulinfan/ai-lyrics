import test from 'node:test';
import assert from 'node:assert/strict';
import {Broker,parseTask,parseTranslation,partialTranslation,makePrompt,songTask} from './hy-bridge-core.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('one active, two queued; excess requests fail fast',async()=>{
  let active=0,peak=0;const releases=[];
  const broker=new Broker(async task=>{active++;peak=Math.max(peak,active);await new Promise(r=>releases.push(r));active--;return task;});
  const promises=Array.from({length:10},(_,i)=>broker.submit({i}).then(v=>({v}),e=>({status:e.status})));
  assert.equal(broker.stats().active,1);assert.equal(broker.stats().queued,2);
  for(let i=0;i<3;i++){releases.shift()();await tick();}
  const result=await Promise.all(promises);
  assert.equal(result.filter(x=>x.status===429).length,7);assert.equal(peak,1);
  assert.equal(broker.stats().waiters,0);assert.equal(broker.jobs.size,0);
});
test('identical callers share one inference; cancelling one preserves others',async()=>{
  let release;const broker=new Broker(async()=>{await new Promise(r=>release=r);return {ok:true};});
  const ac=new AbortController();const first=broker.submit({x:1},ac.signal).catch(e=>e.status);
  const rest=Array.from({length:7},()=>broker.submit({x:1}));
  const excess=await broker.submit({x:1}).catch(e=>e.status);assert.equal(excess,429);
  ac.abort();assert.equal(await first,499);release();await Promise.all(rest);
  assert.equal(broker.stats().executions,1);await broker.submit({x:1});assert.equal(broker.stats().cacheHits,1);
});
test('last caller cancellation aborts execution and removes queued work',async()=>{
  let aborted=false;
  const broker=new Broker(async(_,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true})));
  const a=new AbortController(),b=new AbortController();
  const p=broker.submit({x:1},a.signal).catch(e=>e.status),q=broker.submit({x:2},b.signal).catch(e=>e.status);
  b.abort();assert.equal(broker.stats().queued,0);a.abort();await Promise.all([p,q]);await tick();
  assert.ok(aborted);assert.equal(broker.stats().active,0);assert.equal(broker.jobs.size,0);assert.equal(broker.stats().waiters,0);
});
test('cache has an explicit entry bound',async()=>{
  const broker=new Broker(async x=>x,{maxCache:2});
  for(let i=0;i<5;i++)await broker.submit({i});
  assert.equal(broker.stats().cacheEntries,2);
});
test('numbered lyric inputs and outputs stay aligned',()=>{
  const body={model:'lyrics-hy18b',messages:[{role:'system',content:'翻译成中文。'},{role:'user',content:'【整首歌词，仅供理解】：\n今日は晴れです。\n\n【请逐行翻译下列指定行，按编号输出】（共 2 行）：\n1. 今日は晴れです。\n2. 明日も晴れです。'}]};
  const task=parseTask(body);assert.equal(task.lines.length,2);assert.ok(makePrompt(task).startsWith('<｜hy_begin'));
  assert.equal(parseTranslation('[01] 今天晴天\n[02] 明天也是晴天',2).length,2);
  assert.throws(()=>parseTranslation('[01] 今天晴天',2));
  assert.throws(()=>parseTranslation('[02] 今天晴天\n[01] 明天晴天',2));
  assert.throws(()=>parseTask({...body,model:'lyrics-qwen9b'}));
});
test('different batches of the same song use one canonical whole-song task',()=>{
  const a=songTask({context:'甲\n乙\n甲\n♪',lines:['甲'],target:'简体中文'});
  const b=songTask({context:'甲\n乙\n甲\n♪',lines:['乙'],target:'简体中文'});
  assert.deepEqual(a.full,b.full);assert.deepEqual(a.indices,[0]);assert.deepEqual(b.indices,[1]);
});
test('missing IDs are detected without shifting following lines',()=>{
  const p=partialTranslation('[01] 甲\n[03] 丙',3);
  assert.deepEqual(p.missing,[1]);assert.equal(p.lines[2].translation,'丙');
  assert.throws(()=>partialTranslation('[01] 甲\n[01] 乙',2));
});
