/** Internal loopback endpoint for the `dsh` stand-in (runtime/dsh-cli/dsh.mjs).
 *
 * The plugin runs `dsh ...` as its own child process. That process cannot reach the Claude Code mod directly, so it
 * POSTs the prompt here; the host forwards it as an `agent.spawn` reverse request and returns the subagent's final text.
 * Bound to 127.0.0.1 only, protected by its own random bearer token (never logged, never written to disk). The token
 * and URL reach the plugin through the environment: DSH_CLAUDE_CLI_ENDPOINT / DSH_CLAUDE_CLI_TOKEN. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {sanitizeLine} from './cause.mjs';

export const CLI_ROUTE='/dsh/run';
const MAX_BODY=2*1024*1024;
const MAX_PROMPT=1024*1024;
const DEFAULT_MAX_CONCURRENT=2;
const failure=(code,message)=>Object.assign(new Error(message),{code});
const replyText=reply=>typeof reply==='string'?reply:typeof reply?.text==='string'?reply.text:typeof reply?.result==='string'?reply.result:null;

/** Directory that holds the stand-in: <root>/runtime/dsh-cli (written by build.mjs). */
export const dshCliDirectory=root=>path.resolve(root,'runtime','dsh-cli');

/**
 * Start the endpoint. Resolves with null when the stand-in is not installed or `claudeHost.dshCli` is false.
 * Otherwise resolves with { port, env, close() } where `env` holds the variables to hand to the official host:
 * PATH with the stand-in directory first, the endpoint URL and token, and the node binary to run it with.
 */
export async function createCliEndpoint({root,reverse,log=()=>{},options={},env=process.env,platform=process.platform}={}){
  const config=options.dshCli;
  if(config===false)return null;
  const directory=dshCliDirectory(root);
  try{await fs.access(path.join(directory,'dsh.mjs'));}catch{return null;}
  const settings=config&&typeof config==='object'?config:{};
  const maxConcurrent=Number.isInteger(settings.maxConcurrent)&&settings.maxConcurrent>0?settings.maxConcurrent:DEFAULT_MAX_CONCURRENT;
  const token=randomBytes(32).toString('hex');
  const expected=Buffer.from(token);
  const active=new Set();
  let closed=false;

  const server=http.createServer((req,res)=>{
    const send=(status,body)=>{const text=JSON.stringify(body);if(!res.headersSent)res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(text)});res.end(text);};
    const provided=Buffer.from(String(req.headers.authorization??'').replace(/^Bearer /,''));
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){send(401,{error:{code:'UNAUTHORIZED',message:'A valid bearer token is required'}});req.resume();return;}
    if(req.url!==CLI_ROUTE){send(404,{error:{code:'NOT_FOUND',message:`Use POST ${CLI_ROUTE}`}});req.resume();return;}
    if(req.method!=='POST'){send(405,{error:{code:'METHOD_NOT_ALLOWED',message:`Use POST ${CLI_ROUTE}`}});req.resume();return;}
    const chunks=[];let size=0,aborted=false;
    req.on('data',chunk=>{
      size+=chunk.length;
      if(size>MAX_BODY&&!aborted){aborted=true;send(413,{error:{code:'PAYLOAD_TOO_LARGE',message:'Request body is too large'}});req.destroy();return;}
      chunks.push(chunk);
    });
    req.on('end',async()=>{
      if(aborted)return;
      let body;
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{send(400,{error:{code:'INVALID_JSON',message:'The body is not valid JSON'}});return;}
      const prompt=body?.prompt;
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>MAX_PROMPT){send(400,{error:{code:'INVALID_PARAMS',message:'prompt must be a non-empty string of at most 1 MiB'}});return;}
      if(closed){send(200,{error:{code:'DISPOSED',message:'The host is shutting down'}});return;}
      if(active.size>=maxConcurrent){send(200,{error:{code:'BUSY',message:`Already running ${active.size} dsh-relayed subagent(s); try again when one has finished`}});return;}
      const controller=new AbortController();active.add(controller);
      // The caller going away (dsh killed, timeout in the plugin) cancels the wait; the subagent itself may still finish.
      res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      const description=typeof body.description==='string'&&body.description.trim()?sanitizeLine(body.description,100):'dsh (relayed)';
      const subagentType=typeof settings.subagentType==='string'&&settings.subagentType?settings.subagentType:undefined;
      log('info',`dsh stand-in: starting a Claude subagent (prompt ${prompt.length} characters)`);
      try{
        const reply=await reverse.request('agent.spawn',{prompt,description,...(subagentType?{subagentType}:{})},{signal:controller.signal});
        const text=replyText(reply);
        if(text===null)throw failure('AGENT_REPLY_INVALID','agent.spawn answered without text');
        log('info',`dsh stand-in: the subagent finished (${text.length} characters)`);
        send(200,{result:{text}});
      }catch(cause){
        const code=typeof cause?.code==='string'?cause.code:'AGENT_FAILED';
        const message=code==='DISABLED'
          ?`Claude 子代理被關閉，所以 dsh 轉接沒有執行。請在插件選項開啟 allowAgents。（${sanitizeLine(cause.message,300)}）`
          :sanitizeLine(cause?.message??cause,1000);
        log('warn',`dsh stand-in: the subagent request failed (${code})`);
        if(!res.writableEnded&&!res.destroyed)send(200,{error:{code,message}});
      }finally{active.delete(controller);}
    });
  });
  server.requestTimeout=0;server.timeout=0;server.headersTimeout=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;

  const previous=env.PATH??env.Path??'';
  const nextPath=previous.split(path.delimiter).includes(directory)?previous:directory+(previous?path.delimiter:'')+previous;
  const childEnv={
    PATH:nextPath,...(platform==='win32'?{Path:nextPath}:{}),
    DSH_CLAUDE_CLI_ENDPOINT:`http://127.0.0.1:${port}${CLI_ROUTE}`,DSH_CLAUDE_CLI_TOKEN:token,DSH_CLAUDE_NODE:process.execPath,
  };
  return {
    port,directory,env:childEnv,
    get pending(){return active.size;},
    async close(){
      closed=true;
      for(const controller of active)controller.abort();
      await new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections?.();});
    },
  };
}
