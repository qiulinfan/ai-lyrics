import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
const exec=promisify(execFile);
const lms=homedir()+'/.lmstudio/bin/lms';
export const MODEL='lyrics-hy18b';
async function cli(args){return (await exec(lms,args,{timeout:60000,maxBuffer:2*1024*1024})).stdout;}
export const modelOps={
  async inspect(){
    const all=JSON.parse(await cli(['ps','--json']));
    const model=all.find(m=>m.identifier===MODEL);
    if(!model)return null;
    if(model.modelKey!=='hy-mt2-1.8b'||model.contextLength!==8192||model.parallel!==1)
      throw new Error('lyrics-hy18b exists with unexpected configuration; refusing to alter it');
    return model;
  },
  async load(){
    await cli(['server','start','--bind','127.0.0.1','--port','1234']);
    if(!await this.inspect())await cli(['load','hy-mt2-1.8b','--identifier',MODEL,'--context-length','8192','--parallel','1','--gpu','max','-y']);
    if(!await this.inspect())throw new Error('Hy-MT2 load did not produce the expected instance');
  },
  async unload(){if(await this.inspect())await cli(['unload',MODEL]);}
};
