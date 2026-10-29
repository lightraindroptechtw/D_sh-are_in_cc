#!/usr/bin/env node
// Converts every corpus source with the Claude converter and starts its child host once (no tool calls).
// Usage: node drivers/survey-100.mjs --run [--ids=a,b] [--concurrency=4] [--tag=name]
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// DSH_SURVEY_CANDIDATES: the corpus candidates.json; DSH_SURVEY_WORK: a short scratch folder (Windows path length).
const candidatesFile=process.env.DSH_SURVEY_CANDIDATES;
const arg=name=>process.argv.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3);
if(!process.argv.includes('--run')){console.error('add --run');process.exit(2);}
if(!candidatesFile||!process.env.DSH_SURVEY_WORK){console.error('set DSH_SURVEY_CANDIDATES and DSH_SURVEY_WORK');process.exit(2);}
const ids=new Set((arg('ids')??'').split(',').filter(Boolean));
const concurrency=Number(arg('concurrency')??4);
const tag=arg('tag')??'base';
const work=process.env.DSH_SURVEY_WORK;
const resultFile=path.join(root,'tmp','survey',`${tag}.json`);

function redact(text){
  return String(text??'').split(/\r?\n/).find(Boolean)?.replace(/\bBearer\s+\S+/gi,'Bearer <redacted>')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi,'$1<redacted>')
    .replace(/[A-Za-z]:[\\/][^\s'"`)]+/g,'<path>').slice(0,300)??'';
}
function run(argv,{cwd,timeoutMs,env}){
  return new Promise(resolve=>{
    const child=spawn(argv[0],argv.slice(1),{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    const timer=setTimeout(()=>{child.kill();resolve({code:'TIMEOUT',out,err});},timeoutMs);
    child.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}
function startHost(out,ws){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(out,'runtime','claude-host.mjs')],{cwd:out,windowsHide:true,
      env:{...process.env,DSH_CLAUDE_BRIDGE:'1',DSH_CLAUDE_PLUGIN_ROOT:out,DSH_CLAUDE_WORKSPACE:ws},stdio:['ignore','pipe','pipe']});
    let buf='',err='',done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve({...value,child,stderr:err});};
    const timer=setTimeout(()=>finish({type:'timeout'}),150000);
    child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
      try{const m=JSON.parse(line);if(m.type==='ready'||m.type==='fatal')finish(m);}catch{}}});
    child.stderr.on('data',d=>{err+=d;if(err.length>20000)err=err.slice(-20000);});
    child.on('close',code=>finish({type:'exit',code}));
  });
}
async function survey(c,index){
  const row={index:index+1,id:c.id,name:c.packageName,version:c.packageVersion};
  const out=path.join(work,tag,String(index+1)),ws=path.join(work,'ws');
  await fs.rm(out,{recursive:true,force:true});await fs.mkdir(ws,{recursive:true});
  const t0=Date.now();
  const conv=await run([process.execPath,path.join(root,'bin','d-sh-are-in-cc.mjs'),'convert',c.localPath,'--out',out,'--package-dir',c.packageSubdir??'.',
    '--lenient-output','--state-root',path.join(work,'state')],{cwd:root,timeoutMs:600000});
  row.convertSeconds=Math.round((Date.now()-t0)/1000);
  let report;try{report=JSON.parse(conv.out);}catch{}
  row.conversion=report?.conversion?.status??report?.status??(conv.code===0?'unknown':'error');
  row.issues=(report?.issues??[]).map(x=>x.code).filter(Boolean);
  if(!report||conv.code==='TIMEOUT'){row.stage='convert';row.error=conv.code==='TIMEOUT'?'CONVERT_TIMEOUT':redact(conv.err||conv.out);return row;}
  try{await fs.access(path.join(out,'runtime','claude-host.mjs'));}catch{row.stage='convert';row.error=row.error??'NO_HOST_ENTRY';return row;}
  const t1=Date.now();
  const m=await startHost(out,ws);
  row.startSeconds=Math.round((Date.now()-t1)/1000);
  if(m.type==='ready'){
    row.stage='ready';row.tools=m.tools?.length??0;row.commands=m.commands?.length??0;row.promptSections=m.promptSections?.length??0;
    row.unsupported=m.metadata?.unsupported??[];
    row.moduleProblems=(m.metadata?.moduleDiagnostics??[]).filter(d=>d.status!=='available').map(d=>`${d.module??d.id}:${d.code??d.status}`);
    row.lazyDependencies=(m.metadata?.lazyDependencies??[]).map(x=>typeof x==='string'?x:x.name??x.specifier).filter(Boolean);
    try{await fetch(`http://127.0.0.1:${m.port}/rpc`,{method:'POST',headers:{authorization:`Bearer ${m.token}`,'content-type':'application/json'},body:JSON.stringify({method:'dispose',params:{}})});}catch{}
  }else if(m.type==='fatal'){row.stage='fatal';row.code=m.code;row.error=redact(m.message);row.waitingServices=m.services;}
  else{row.stage=m.type;row.error=redact(m.stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0]);}
  setTimeout(()=>{try{m.child.kill();}catch{}},3000);
  return row;
}

const all=JSON.parse(await fs.readFile(candidatesFile,'utf8')).candidates;
const list=all.map((c,i)=>[c,i]).filter(([c])=>!ids.size||ids.has(c.id)||ids.has(c.packageName));
let prior=[];try{prior=JSON.parse(await fs.readFile(resultFile,'utf8')).rows;}catch{}
const rows=new Map(prior.map(r=>[r.id,r]));
const save=async()=>{await fs.mkdir(path.dirname(resultFile),{recursive:true});
  await fs.writeFile(resultFile,JSON.stringify({tag,updated:new Date().toISOString(),rows:[...rows.values()].sort((a,b)=>a.index-b.index)},null,2));};
let next=0;
await Promise.all(Array.from({length:concurrency},async()=>{
  while(next<list.length){const [c,i]=list[next++];
    let row;try{row=await survey(c,i);}catch(e){row={index:i+1,id:c.id,stage:'driver',error:redact(e.message)};}
    rows.set(c.id,row);await save();console.log(`${row.index} ${row.id} ${row.stage} ${row.code??''} ${row.error??''}`.slice(0,240));}
}));
const count={};for(const r of rows.values())count[r.stage]=(count[r.stage]??0)+1;
console.log('SUMMARY',JSON.stringify(count));
