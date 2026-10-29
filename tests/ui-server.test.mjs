import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {startPluginUi} from '../lib/ui-server.mjs';

const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port));});
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
async function fixture(t,{registry}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-server-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const uiRoot=path.join(root,'runtime/ui');await fs.mkdir(path.join(uiRoot,'source/lib/nested'),{recursive:true});
  const asset=Buffer.from([0,255,10,128]),source='lib/nested/original.png';
  const manifest={format:1,name:'real-ui',version:'2',clients:[{id:'client',source,url:'/__dsh_ui/source/'+source}],assets:[{source,sha256:createHash('sha256').update(asset).digest('hex')}]};
  for(const [name,bytes]of [['manifest.json',JSON.stringify(manifest)],['index.html','<div id="app"></div>'],['browser.js','window.loaded=true'],['host.css','body{}'],['source/'+source,asset]])await fs.writeFile(path.join(uiRoot,name),bytes);
  await fs.writeFile(path.join(root,'private.json'),'PRIVATE');
  const calls=[];
  const rpc=async(method,args)=>{calls.push({method,args});if(method==='routes')return typeof registry==='function'?registry():registry??null;if(method==='describe')return {name:'real-ui'};if(method==='settings.describe')return [{ns:'plugin',value:{flag:false},revision:1}];if(method==='settings.update')return {applied:true,args};throw Object.assign(new Error('Real source error'),{code:'ORIGINAL_ERROR'});};
  const ui=await startPluginUi({root,rpc});t.after(()=>ui.close());
  return {root,uiRoot,asset,ui,calls,manifest};
}
const rawGet=(url,requestPath,headers={})=>new Promise((resolve,reject)=>{const target=new URL(url);const req=http.get({hostname:target.hostname,port:target.port,path:requestPath,headers},res=>{const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts)}));});req.on('error',reject);});

test('real HTTP serves relocatable UI metadata, original nested assets and host RPC envelopes',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.ui.url)).status,200);
  assert.equal((await(await fetch(f.ui.url+'__dsh_ui/manifest')).json()).name,'real-ui');
  const context=await(await fetch(f.ui.url+'__dsh_ui/context')).json();assert.equal(context.host.name,'real-ui');assert.equal(context.settings[0].revision,1);
  for(const relative of ['__dsh_ui/source/lib/nested/original.png','lib/nested/original.png'])assert.deepEqual(Buffer.from(await(await fetch(f.ui.url+relative)).arrayBuffer()),f.asset);
  const invoke=async(method,params)=>await(await fetch(f.ui.url+'__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})})).json();
  assert.deepEqual(await invoke('settings.update',{ns:'plugin',patch:{flag:true},revision:1}),{ok:true,result:{applied:true,args:{ns:'plugin',patch:{flag:true},revision:1}}});
  assert.equal((await invoke('commands.run',{})).error.code,'ORIGINAL_ERROR');
  assert.equal((await invoke('dispose',{})).error.code,'UI_RPC_UNAVAILABLE');
  assert.equal(f.calls.some(call=>call.method==='dispose'),false);
});

test('only registered backend routes forward original status, binary, cookies, form and multipart bodies',async t=>{
  const requests=[];
  const backend=http.createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);requests.push({url:req.url,headers:req.headers,body});res.writeHead(207,{'content-type':'application/octet-stream','x-original':'yes','set-cookie':['a=1; Path=/; HttpOnly','b=2; Path=/']});res.end(body.length?body:Buffer.from([0,255,128,1]));});
  const backendOrigin=await listen(backend);t.after(()=>close(backend));
  const f=await fixture(t,{registry:{origin:backendOrigin,routes:[{kind:'prefix',path:'/api/original'},{kind:'exact',path:'/image.bin'}]}});
  const original=await fetch(f.ui.url+'api/original/nested?x=1');assert.equal(original.status,207);assert.equal(original.headers.get('x-original'),'yes');assert.equal(original.headers.getSetCookie().length,2);assert.deepEqual(Buffer.from(await original.arrayBuffer()),Buffer.from([0,255,128,1]));
  const body=Buffer.from('name=%E4%B8%AD&flag=true');const form=await fetch(f.ui.url+'api/original/save',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:'a=1',origin:new URL(f.ui.url).origin},body});assert.deepEqual(Buffer.from(await form.arrayBuffer()),body);assert.equal(requests.at(-1).headers.cookie,'a=1');assert.equal(requests.at(-1).headers.origin,backendOrigin);
  const multipart=new FormData();multipart.append('file',new Blob([Buffer.from([255,0,128])]),'original.bin');const upload=await fetch(f.ui.url+'api/original/upload',{method:'POST',body:multipart});await upload.arrayBuffer();assert.match(requests.at(-1).headers['content-type'],/^multipart\/form-data; boundary=/);assert.ok(requests.at(-1).body.includes(Buffer.from([255,0,128])));
  const before=requests.length;assert.equal((await fetch(f.ui.url+'api/unregistered')).status,404);assert.equal(requests.length,before);assert.equal((await fetch(f.ui.url+'api/original-escape')).status,404);
  assert.equal((await fetch(f.ui.url+'image.bin')).status,207);
});

test('origin, Host, traversal and source tamper checks block only invalid access',async t=>{
  const f=await fixture(t);const origin=new URL(f.ui.url).origin;
  assert.equal((await fetch(f.ui.url+'__dsh_ui/manifest',{headers:{origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(f.ui.url+'__dsh_ui/manifest',{headers:{origin}})).status,200);
  assert.equal((await rawGet(origin,'/__dsh_ui/manifest',{host:'other.example'})).status,403);
  for(const relative of ['/../private.json','/__dsh_ui/source/%2e%2e/%2e%2e/private.json','/__dsh_ui/source/lib/%252e%252e/private.json','/__dsh_ui/source/lib%5c..%5cprivate.json'])assert.equal((await rawGet(origin,relative)).status,400,relative);
  assert.equal((await fetch(f.ui.url+'private.json')).status,404);
  await fs.writeFile(path.join(f.uiRoot,'source/lib/nested/original.png'),'changed');
  assert.equal((await fetch(f.ui.url+'__dsh_ui/source/lib/nested/original.png')).status,409);
});

test('registered route cannot turn into a remote arbitrary URL proxy',async t=>{
  const f=await fixture(t,{registry:{origin:'https://example.com',routes:[{kind:'prefix',path:'/api'}]}});
  const response=await fetch(f.ui.url+'api/test');assert.equal(response.status,502);assert.match((await response.json()).error.message,/loopback/);
});

test('live source responses stream immediately and UI close cancels all sockets/resources',async t=>{
  let disconnected;const ended=new Promise(resolve=>{disconnected=resolve;});
  const backend=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: original\n\n');req.on('close',disconnected);});
  const backendOrigin=await listen(backend);t.after(()=>close(backend));
  const f=await fixture(t,{registry:{origin:backendOrigin,routes:[{kind:'exact',path:'/events'}]}});
  const response=await fetch(f.ui.url+'events'),reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/original/);
  await f.ui.close();await f.ui.close();assert.equal(f.ui.describe().available,false);
  await Promise.race([ended,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Source stream remained open')),2000);timer.unref();})]);
  await assert.rejects(fetch(f.ui.url));await reader.cancel().catch(()=>{});
});

test('compressed original responses remain readable after the Node proxy decompresses them',async t=>{
  const backend=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});res.end(gzipSync(JSON.stringify({original:'壓縮回應'})));});
  const backendOrigin=await listen(backend);t.after(()=>close(backend));
  const f=await fixture(t,{registry:{origin:backendOrigin,routes:[{kind:'exact',path:'/compressed'}]}});
  const response=await fetch(f.ui.url+'compressed');assert.equal(response.headers.get('content-encoding'),null);assert.deepEqual(await response.json(),{original:'壓縮回應'});
});

test('disconnecting a browser RPC cancels the host operation',async t=>{
 const f=await fixture(t);await f.ui.close();let started,canceled;
 const began=new Promise(resolve=>{started=resolve}),ended=new Promise(resolve=>{canceled=resolve});
 const ui=await startPluginUi({root:f.root,rpc:async(method,_params,{signal}={})=>{
   assert.equal(method,'execute');started();return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{canceled();reject(new Error('canceled'));},{once:true});});
 }});t.after(()=>ui.close());
 const controller=new AbortController();const request=fetch(ui.url+'__dsh_ui/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'execute',params:{name:'test'}}),signal:controller.signal});
 await began;controller.abort();await assert.rejects(request);
 await Promise.race([ended,new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('browser cancel did not reach host')),1500);timer.unref?.();})]);
});
