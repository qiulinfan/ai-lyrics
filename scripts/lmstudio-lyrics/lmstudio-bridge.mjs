// Spotify -> bounded local queue -> one LM Studio Hy-MT2 instance.
import http from 'node:http';
import {appendFileSync,existsSync,statSync,renameSync} from 'node:fs';
import {Broker,parseTask,makePrompt,songTask,fail} from './hy-bridge-core.mjs';
import {IdleModel} from './idle-model.mjs';
import {modelOps} from './lmstudio-model.mjs';
const model='lyrics-hy18b', origin='https://xpui.app.spotify.com';
const log=new URL('./bridge-metrics.jsonl',import.meta.url);
function record(data){
  if(existsSync(log)&&statSync(log).size>1048576)renameSync(log,new URL('./bridge-metrics.previous.jsonl',import.meta.url));
  appendFileSync(log,JSON.stringify({time:new Date().toISOString(),model,...data})+'\n');
}
async function translate(task,signal){
  const start=Date.now();
  const lines=[];
  let firstTokenMs=null,outputChars=0;
  for(let index=0;index<task.lines.length;index++){
    if(signal.aborted)throw fail(499,'Client cancelled');
    const single=await generate({context:'',lines:[task.lines[index]],target:task.target},signal);
    if(firstTokenMs===null)firstTokenMs=single.firstTokenMs;
    const translation=single.output.trim().replace(/^\[0?1\]\s*/, '');
    if(!translation)throw fail(502,'Empty translation');
    const one={translation,grammar:'',keywords:[],examples:[]};
    lines.push({...one,i:index+1});outputChars+=single.output.length;
  }
  record({status:200,elapsedMs:Date.now()-start,firstTokenMs,translatedLines:lines.length,nativeRequests:lines.length,outputChars});
  return {lines};
}

async function generate(task,signal){
  const start=Date.now();
  const upstream=await fetch('http://127.0.0.1:1234/v1/completions',{
    method:'POST',headers:{'Content-Type':'application/json'},signal,
    body:JSON.stringify({model,prompt:makePrompt(task),temperature:0,max_tokens:task.lines.length===1?256:4096,stream:true})
  });
  if(!upstream.ok)throw fail(502,`LM Studio returned ${upstream.status}`);
  const decoder=new TextDecoder();let pending='',output='',firstTokenMs=null,finish=null;
  for await(const chunk of upstream.body){
    pending+=decoder.decode(chunk,{stream:true});if(pending.length>65536)throw fail(502,'Oversized upstream event');
    let end;
    while((end=pending.indexOf('\n'))>=0){
      const line=pending.slice(0,end).trim();pending=pending.slice(end+1);
      if(!line.startsWith('data:'))continue;
      const data=line.slice(5).trim();if(data==='[DONE]')continue;
      const event=JSON.parse(data);if(event.error)throw fail(502,String(event.error.message||event.error));
      if(event.model&&event.model!==model)throw fail(502,'LM Studio returned the wrong model');
      const c=event.choices?.[0];if(!c)continue;
      if(c.text&&firstTokenMs===null)firstTokenMs=Date.now()-start;
      output+=c.text||'';if(output.length>32768)throw fail(502,'Translation exceeds output limit');
      if(c.finish_reason)finish=c.finish_reason;
    }
  }
  if(finish!=='stop')throw fail(502,`Incomplete translation: ${finish}`);
  return {output,firstTokenMs};
}

const lifecycle=new IdleModel(modelOps,{onEvent:record});
lifecycle.reconcile().catch(error=>record({event:'model_inspect_error',error:String(error.message)}));
const broker=new Broker((task,signal)=>lifecycle.use(()=>translate(task,signal),signal),{ttlMs:3600000});
const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
  const ac=new AbortController();res.on('close',()=>{if(!res.writableEnded)ac.abort();});
  try{
    if(!['127.0.0.1:11435','localhost:11435'].includes(req.headers.host)||(req.headers.origin&&req.headers.origin!==origin))throw fail(403,'Forbidden');
    if(req.headers.origin===origin){
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
      res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    }
    if(req.method==='GET'&&req.url==='/health'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,model,revision:'hy18b-v6',limits:{active:1,queued:2,waiters:8,requestBytes:65536,cacheBytes:4194304},...broker.stats(),lifecycle:lifecycle.stats(),rssBytes:process.memoryUsage().rss}));return;
    }
    if(req.url!=='/v1/chat/completions')throw fail(404,'Not found');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST')throw fail(405,'POST required');
    if(Number(req.headers['content-length'])>65536)throw fail(413,'Request too large');
    const chunks=[];let size=0;
    for await(const c of req){size+=c.length;if(size>65536)throw fail(413,'Request too large');chunks.push(c);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'Invalid JSON');}
    const {full,indices}=songTask(parseTask(body));
    lifecycle.touch(); // Valid translation requests reset idle time; health checks do not.
    const whole=await broker.submit(full,ac.signal);if(res.destroyed)return;
    const result={lines:indices.map((index,i)=>({...whole.lines[index],i:i+1}))};
    const content=JSON.stringify(result);
    // Validate each batch before rendering so a missing line cannot shift following translations.
    if(body.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      res.end('data: '+JSON.stringify({object:'chat.completion.chunk',model,choices:[{index:0,delta:{content},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    }else{
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));
    }
  }catch(error){
    if(res.destroyed)return;
    const status=error.status||(error.name==='AbortError'?504:502);if(status===429)res.setHeader('Retry-After','2');
    res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:String(error.message)}));record({status,error:String(error.message)});
  }
});
server.maxConnections=16;server.requestTimeout=20000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
server.listen(11435,'127.0.0.1',()=>console.log('Hy-MT2 lyrics bridge listening on 127.0.0.1:11435'));
