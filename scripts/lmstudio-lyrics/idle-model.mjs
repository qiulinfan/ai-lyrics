// Serializes model load/unload transitions. Translation scheduling stays in Broker.
export class IdleModel {
  constructor(ops, {idleMs=600000, now=Date.now, onEvent=()=>{}}={}) {
    Object.assign(this,{ops,idleMs,now,onEvent});
    this.lastActivity=now();this.leases=0;this.phase='unknown';this.timer=null;
    this.transition=Promise.resolve();this.loads=0;this.unloads=0;
    this.arm();
  }
  serial(fn){
    const result=this.transition.then(fn,fn);
    this.transition=result.catch(()=>{});
    return result;
  }
  stats(){return {idleTimeoutMs:this.idleMs,phase:this.phase,activeUsers:this.leases,lastActivityAt:this.lastActivity,idleDeadlineAt:this.phase==='unloaded'?null:this.lastActivity+this.idleMs,loads:this.loads,unloads:this.unloads};}
  stop(){clearTimeout(this.timer);this.timer=null;}
  arm(delay=Math.max(1,this.lastActivity+this.idleMs-this.now())){
    this.stop();
    if(this.leases||this.phase==='unloaded')return;
    this.timer=setTimeout(()=>this.checkIdle().catch(error=>{
      this.onEvent({event:'idle_unload_error',error:String(error.message)});this.arm(30000);
    }),delay);
    this.timer.unref?.();
  }
  touch(){this.lastActivity=this.now();this.arm();}
  async reconcile(){
    return this.serial(async()=>{
      const current=await this.ops.inspect();this.phase=current?'ready':'unloaded';this.arm();
    });
  }
  async use(work,signal){
    if(signal?.aborted)throw signal.reason;
    this.leases++;this.touch();
    try{
      await this.serial(async()=>{
        if(signal?.aborted)throw signal.reason;
        const current=await this.ops.inspect();
        if(!current){
          this.phase='loading';
          try{await this.ops.load();this.loads++;this.onEvent({event:'model_loaded'});}
          catch(error){this.phase='unknown';throw error;}
        }
        this.phase='ready';
      });
      if(signal?.aborted)throw signal.reason;
      return await work();
    }finally{
      this.leases--;this.lastActivity=this.now();this.arm();
    }
  }
  async checkIdle(){
    return this.serial(async()=>{
      if(this.leases||this.now()-this.lastActivity<this.idleMs){this.arm();return false;}
      const current=await this.ops.inspect();
      // A request may have arrived while inspect() was awaiting its result.
      if(this.leases||this.now()-this.lastActivity<this.idleMs){this.arm();return false;}
      if(!current){this.phase='unloaded';this.stop();return false;}
      if(Number.isFinite(current.lastUsedTime))this.lastActivity=Math.max(this.lastActivity,current.lastUsedTime);
      if(this.now()-this.lastActivity<this.idleMs){this.arm();return false;}
      // Do not interrupt another local caller using this exact model instance.
      if(current.status!=='idle'||current.queued>0){this.arm(30000);return false;}
      this.phase='unloading';
      try{await this.ops.unload();this.unloads++;this.phase='unloaded';this.onEvent({event:'model_unloaded_idle'});}
      catch(error){this.phase='unknown';throw error;}
      this.stop();return true;
    });
  }
}
