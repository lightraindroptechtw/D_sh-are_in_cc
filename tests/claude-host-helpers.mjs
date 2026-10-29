/** Test helpers: a synthetic DSH plugin directory and a tiny stand-in for the Claude Code mod. */
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import {rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildClaudeHost} from '../lib/claude-host/build.mjs';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const toolHeader=`import{defineTool}from'@deepseek-ai/dsh-tools';const tool=(name,execute,extra={})=>defineTool({name,description:'synthetic '+name,parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:typeof v==='string'?v:JSON.stringify(v)}]},execute,...extra});`;

const created=[];
process.on('exit',()=>{for(const dir of created)try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}});
let bundleDir;
/** One shared bundle of the child host for all subprocess tests. */
export async function sharedBundle(){
  if(!bundleDir){
    bundleDir=await fs.mkdtemp(path.join(os.tmpdir(),'claude-host-bundle-'));
    await buildClaudeHost({outputDir:bundleDir});
    created.push(bundleDir);
  }
  return path.join(bundleDir,'runtime','claude-host.mjs');
}

/** Create <root>/source/index.mjs and <root>/runtime/settings.json for a synthetic plugin.
 * The official runtime and worker are taken from this repository, not copied. */
export async function makePlugin(t,source,settings={},{files={}}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claude-host-plugin-'));
  created.push(root); // removed on exit: the child host may still hold files when t.after hooks run
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{}));
  await fs.mkdir(path.join(root,'source'),{recursive:true});await fs.mkdir(path.join(root,'runtime'),{recursive:true});
  await fs.writeFile(path.join(root,'source','index.mjs'),source);
  for(const [name,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,'source',name)),{recursive:true});await fs.writeFile(path.join(root,'source',name),text);}
  const merged={name:'synthetic',entry:'index.mjs',services:['timer','fs','settings','webServer','commands','skills'],initializeTimeoutMs:20000,callTimeoutMs:5000,cancelGraceMs:200,stateMode:'package',
    ...settings,claudeHost:{runtimeRoot:projectRoot,workerPath:path.join(projectRoot,'lib','dsh-host-worker.mjs'),...(settings.claudeHost??{})}};
  await fs.writeFile(path.join(root,'runtime','settings.json'),JSON.stringify(merged,null,2));
  return root;
}

/** Spawn the child host like the mod does and speak the protocol. `answer(method, params)` plays the mod. */
export async function spawnHost(t,root,{answer,env={},bundle=true,bundleFile,rootArg=true}={}){
  const entry=bundleFile??(bundle?await sharedBundle():path.join(projectRoot,'lib','claude-host','main.mjs'));
  const args=rootArg?[entry,'--root',root]:[entry];
  const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const lines=[],stderr=[],waiters=[];
  let port,token;
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const push=line=>{lines.push(line);for(const waiter of [...waiters])if(waiter.test(line)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(line);}};
  createInterface({input:child.stdout}).on('line',text=>{
    let line;try{line=JSON.parse(text);}catch{push({type:'garbage',text});return;}
    if(line.type==='ready'){port=line.port;token=line.token;}
    push(line);
    if(line.type==='request'&&answer)void respond(line);
  });
  child.stderr.on('data',chunk=>stderr.push(chunk.toString('utf8')));
  async function respond(request){
    let outcome;
    try{outcome={id:request.id,result:await answer(request.method,request.params,request)};}
    catch(error){outcome={id:request.id,error:{code:error.code??'ERROR',message:error.message}};}
    if(outcome.result===undefined&&!outcome.error)return; // the test chose not to answer
    await rpc('reply',outcome).catch(()=>{});
  }
  const next=(test,timeoutMs=30000)=>{
    const found=lines.find(test);if(found)return Promise.resolve(found);
    return new Promise((resolve,reject)=>{
      const waiter={test,resolve};waiters.push(waiter);
      const timer=setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(new Error('timed out waiting for a protocol line; seen: '+lines.map(l=>l.type).join(',')+' stderr: '+stderr.join('').slice(-400)));},timeoutMs);
      timer.unref();waiter.resolve=value=>{clearTimeout(timer);resolve(value);};
    });
  };
  async function rpc(method,params={},{tokenOverride,raw=false}={}){
    const response=await fetch(`http://127.0.0.1:${port}/rpc`,{method:'POST',headers:{authorization:`Bearer ${tokenOverride??token}`,'content-type':'application/json'},body:JSON.stringify({method,params})});
    if(raw)return response;
    const body=await response.json();
    if(body.error)throw Object.assign(new Error(body.error.message),{code:body.error.code});
    return body.result;
  }
  const host={child,lines,stderr,exited,next,rpc,get port(){return port;},get token(){return token;},
    ready:()=>next(l=>l.type==='ready'||l.type==='fatal').then(line=>{if(line.type==='fatal')throw Object.assign(new Error(line.message),{fatal:line});return line;}),
    fatal:()=>next(l=>l.type==='fatal'),
    async stop(){if(child.exitCode===null&&!child.killed){try{await rpc('dispose');}catch{}await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill();}}};
  t.after(()=>host.stop());
  return host;
}
