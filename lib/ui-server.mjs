import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const contained=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host','content-length']);
const mime={'.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.ogg':'audio/ogg','.txt':'text/plain; charset=utf-8'};
const publicRpc=new Set(['describe','context','routes','settings.describe','settings.update','commands.list','commands.run','skills.list','skills.get','getTools','execute','ui.connection.call','ui.typert.call','ui.events.poll','ui.resources.file','ui.stream.open','ui.stream.read','ui.stream.send','ui.stream.end','ui.stream.cancel']);
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
function pathname(raw){
  if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//')||/[\\\0]/.test(raw))throw Object.assign(new Error('插件畫面的路徑格式不正確'),{status:400});
  let decoded;try{decoded=decodeURIComponent(raw.split('?')[0]);}catch{throw Object.assign(new Error('插件畫面的路徑編碼不正確'),{status:400});}
  if(/[\\\0]/.test(decoded)||decoded.split('/').some(part=>part==='..'||part==='.')||/%(?:2e|2f|5c|00)/i.test(decoded))throw Object.assign(new Error('這個路徑超出了插件公開的畫面資料夾'),{status:400});
  return decoded;
}
function registeredRoute(registry,url){
  return registry.routes.some(row=>typeof row.path==='string'&&(row.kind==='exact'?url.pathname===row.path:row.kind==='prefix'&&(url.pathname===row.path||url.pathname.startsWith(row.path.replace(/\/$/,'')+'/'))));
}
async function readJson(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw Object.assign(new Error('這次畫面控制請求超過 8 MB，請縮小內容後重試'),{status:413});chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('畫面傳來的資料格式不正確'),{status:400});}
}

/** Serve a generated package's UI; original backend routes are never fabricated. */
export async function startPluginUi({root,rpc,onNotice}){
  if(typeof rpc!=='function')throw new Error('插件畫面尚未連接真實後端');
  const uiRoot=await fs.realpath(path.join(root,'runtime/ui'));
  const manifest=JSON.parse(await fs.readFile(path.join(uiRoot,'manifest.json'),'utf8'));
  if(!Array.isArray(manifest.clients)||!Array.isArray(manifest.assets))throw new Error('插件畫面清單格式不正確，請重新轉換');
  const staticFiles=new Map([['/','index.html'],['/__dsh_ui/','index.html'],['/__dsh_ui/index.html','index.html'],['/__dsh_ui/browser.js','browser.js'],['/__dsh_ui/host.css','host.css'],['/__dsh_ui/browser.css','browser.css'],['/__dsh_ui/browser.js.LEGAL.txt','browser.js.LEGAL.txt']].map(([url,file])=>[url,{file}]));
  const rootAssets=new Map();
  for(const asset of manifest.assets){
    if(typeof asset.source!=='string'||typeof asset.sha256!=='string')throw new Error('插件畫面的資源紀錄不正確，請重新轉換');
    const relative=asset.source.split('/').join(path.sep),file=path.resolve(uiRoot,'source',relative);
    if(!contained(path.join(uiRoot,'source'),file))throw new Error('這項畫面資源超出了插件公開資料夾');
    const row={file:path.relative(uiRoot,file),sha256:asset.sha256};
    staticFiles.set('/__dsh_ui/source/'+asset.source,row);
    rootAssets.set('/'+asset.source,row);
    for(const prefix of ['public/','static/'])if(asset.source.startsWith(prefix))rootAssets.set('/'+asset.source.slice(prefix.length),row);
  }
  let origin,closed=false,closePromise;
  const controllers=new Set(),sockets=new Set();
  const serveFile=async(req,res,row)=>{
    const file=path.resolve(uiRoot,row.file),real=await fs.realpath(file);if(!contained(uiRoot,file)||!contained(uiRoot,real))throw Object.assign(new Error('這項畫面資源超出了插件公開資料夾'),{status:403});
    const bytes=await fs.readFile(real);
    if(row.sha256&&createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Object.assign(new Error('原畫面資源在轉換後被修改，請重新檢查並轉換'),{status:409,code:'UI_ASSET_TAMPERED'});
    res.writeHead(200,{'content-type':mime[path.extname(file).toLowerCase()]??'application/octet-stream','content-length':bytes.length,'cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
  };
  const forward=async(req,res,registry)=>{
    const backend=new URL(registry.origin);
    if(backend.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(backend.hostname)||backend.username||backend.password||backend.search||backend.hash||backend.pathname!=='/')throw Object.assign(new Error('原插件後端應使用本機回送位址（loopback），目前設定不符'),{status:502});
    const target=new URL(req.url,backend);if(target.origin!==backend.origin||!registeredRoute(registry,target))return false;
    const headers=new Headers(),extraHop=new Set(String(req.headers.connection??'').toLowerCase().split(',').map(value=>value.trim()));
    for(const [name,value]of Object.entries(req.headers))if(value!==undefined&&!hopHeaders.has(name)&&!extraHop.has(name))headers.set(name,Array.isArray(value)?value.join(', '):value);
    if(headers.has('origin'))headers.set('origin',backend.origin);
    if(headers.has('referer'))headers.set('referer',backend.origin+'/');
    const controller=new AbortController();controllers.add(controller);
    const abort=()=>{if(!res.writableEnded)controller.abort();};res.on('close',abort);
    try{
      const response=await fetch(target,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Readable.toWeb(req),...(!['GET','HEAD'].includes(req.method)?{duplex:'half'}:{}),redirect:'manual',signal:controller.signal});
      const responseHeaders={};
      // Node fetch decompresses the response stream but retains encoding headers.
      for(const [name,value]of response.headers)if(!hopHeaders.has(name)&&!['set-cookie','content-encoding'].includes(name))responseHeaders[name]=value;
      const cookies=response.headers.getSetCookie();if(cookies.length)responseHeaders['set-cookie']=cookies;
      if(responseHeaders.location){try{const redirected=new URL(responseHeaders.location,backend);if(redirected.origin===backend.origin)responseHeaders.location=origin+redirected.pathname+redirected.search+redirected.hash;}catch{}}
      res.writeHead(response.status,response.statusText,responseHeaders);
      if(req.method==='HEAD'||!response.body){await response.body?.cancel();res.end();}else await pipeline(Readable.fromWeb(response.body),res);
      return true;
    }finally{controllers.delete(controller);res.off('close',abort);}
  };
  const server=http.createServer(async(req,res)=>{
    try{
      if(closed)return json(res,503,{ok:false,error:{message:'插件畫面正在關閉'}});
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{ok:false,error:{message:'這次請求來自其他網頁，請從本插件畫面重新操作'}});
      const route=pathname(req.url);
      if(route==='/__dsh_ui/manifest'&&req.method==='GET')return json(res,200,manifest);
      if(route==='/__dsh_ui/context'&&req.method==='GET'){
        const [host,settings]=await Promise.all([rpc('describe',{}),rpc('settings.describe',{}).catch(error=>({available:false,error:{message:error.message,code:error.code}}))]);
        return json(res,200,{manifest,host,settings});
      }
      if(route==='/__dsh_ui/rpc'){
        if(req.method!=='POST')return json(res,405,{ok:false,error:{message:'畫面操作必須使用 POST 請求'}});
        if(!(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))return json(res,415,{ok:false,error:{message:'畫面操作必須傳送 JSON 資料'}});
        const request=await readJson(req);
        if(!publicRpc.has(request?.method))return json(res,400,{ok:false,error:{code:'UI_RPC_UNAVAILABLE',message:'這項後端操作尚未提供給插件畫面；其他功能仍可使用'}});
        const controller=new AbortController();controllers.add(controller);
        const cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
        try{return json(res,200,{ok:true,result:await rpc(request.method,request.params??{},{signal:controller.signal})});}catch(error){if(!controller.signal.aborted)return json(res,200,{ok:false,error:{message:error.message,code:error.code}});}
        finally{res.off('close',cancel);controllers.delete(controller);}
      }
      if(route.startsWith('/__dsh_ui/')){
        const row=staticFiles.get(route);if(!row)return json(res,404,{ok:false,error:{message:'找不到這項插件畫面資源'}});
        if(!['GET','HEAD'].includes(req.method))return json(res,405,{ok:false,error:{message:'讀取畫面資源必須使用 GET 或 HEAD 請求'}});
        return await serveFile(req,res,row);
      }
      if(route==='/')return await serveFile(req,res,staticFiles.get('/'));
      const registry=await rpc('routes',{});
      if(registry?.origin&&Array.isArray(registry.routes)&&await forward(req,res,registry))return;
      const asset=rootAssets.get(route);if(asset&&['GET','HEAD'].includes(req.method))return await serveFile(req,res,asset);
      return json(res,404,{ok:false,error:{code:'SOURCE_ROUTE_UNAVAILABLE',message:'原插件沒有提供這個功能路徑或公開資源，這次操作未完成'}});
    }catch(error){
      if(res.headersSent){res.destroy(error);return;}
      if(error.code==='ENOENT')return json(res,404,{ok:false,error:{message:'找不到插件畫面檔案，請重新轉換'}});
      try{await onNotice?.({code:error.code??'UI_REQUEST_FAILED',message:error.message});}catch{}
      json(res,error.status??502,{ok:false,error:{message:error.message,code:error.code}});
    }
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  origin='http://127.0.0.1:'+server.address().port;
  const describe=()=>({available:!closed,url:origin+'/',name:manifest.name,version:manifest.version,clients:manifest.clients,origin,placement:'standalone-browser',originalFrontend:true});
  const close=()=>closePromise??=(async()=>{closed=true;for(const controller of controllers)controller.abort();const pending=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));for(const socket of sockets)socket.destroy();await pending;})();
  return {url:origin+'/',describe,close};
}
