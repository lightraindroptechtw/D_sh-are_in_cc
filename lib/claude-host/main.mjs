/** Entry point of the child host. Bundled by build.mjs into <plugin>/runtime/claude-host.mjs.
 * stdout carries protocol lines only; everything else goes to stderr. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startClaudeHost} from './host.mjs';
import {sanitizeLine} from './cause.mjs';

const rootArg=process.argv.indexOf('--root');
const root=path.resolve(rootArg>0&&process.argv[rootArg+1]?process.argv[rootArg+1]:path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));

const stdout=process.stdout;
const realWrite=stdout.write.bind(stdout);
// Keep stray console.log output of the host process itself out of the protocol stream.
console.log=(...args)=>console.error(...args);
const emit=line=>{realWrite(JSON.stringify(line)+'\n');};
let host,exiting=false;
const leave=code=>{if(exiting)return;exiting=true;setTimeout(()=>process.exit(code),50).unref?.();process.exitCode=code;};
const fatal=(code,message,extra={})=>{try{emit({type:'fatal',code,message:sanitizeLine(message,1200),...extra});}catch{}leave(1);};

stdout.on('error',()=>{void host?.shutdown().finally(()=>leave(0));});
process.on('uncaughtException',error=>{if(host)emit({type:'log',level:'error',text:sanitizeLine(`uncaught: ${error?.message}`)});else fatal('HOST_CRASHED',error?.message??'unknown error');});
process.on('unhandledRejection',reason=>{emit({type:'log',level:'error',text:sanitizeLine(`unhandled rejection: ${reason?.message??reason}`)});});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void(host?.shutdown()??Promise.resolve()).finally(()=>leave(0));});

// Optional orphan guard: the mod may pass its own process id so the host does not outlive it.
const parentPid=Number.parseInt(process.env.DSH_CLAUDE_PARENT_PID??'',10);
if(Number.isInteger(parentPid)&&parentPid>1){
  const watch=setInterval(()=>{try{process.kill(parentPid,0);}catch(error){if(error.code==='ESRCH'){clearInterval(watch);void(host?.shutdown()??Promise.resolve()).finally(()=>leave(0));}}},Math.max(100,Number.parseInt(process.env.DSH_CLAUDE_PARENT_POLL_MS??'',10)||5000));
  watch.unref();
}

try{
  let settings;
  try{settings=JSON.parse(await fs.readFile(path.join(root,'runtime','settings.json'),'utf8'));}
  catch(error){throw Object.assign(new Error(`Cannot read runtime/settings.json: ${error.code??error.message}`),{fatal:{code:'SETTINGS_UNREADABLE',message:`Cannot read runtime/settings.json (${error.code??'invalid JSON'})`}});}
  host=await startClaudeHost({root,settings,emit});
  emit(host.ready);
  host.done.then(()=>leave(0));
}catch(error){
  if(error?.fatal)fatal(error.fatal.code,error.fatal.message,{...(error.fatal.services?{services:error.fatal.services}:{}),...(error.fatal.missing?{missing:error.fatal.missing}:{})});
  else fatal(error?.code??'HOST_CRASHED',error?.message??String(error));
}
