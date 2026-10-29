import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import Web from '@deepseek-ai/dsh-web';
import Tools from '@deepseek-ai/dsh-tools';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import * as webTools from '@deepseek-ai/dsh-tool-web';
import {descriptor,install,webConfiguration} from '../lib/modules/web.mjs';

async function fixture(t,config={}){
  const root=new Context();t.after(()=>root.fiber.dispose());
  for(const [plugin,value]of [[Prompt,{includeHarnessIdentity:false,includeRuntimeContext:false}],[Tools,{mode:'native'}],[Web,config],[webTools,{}]])await root.plugin(plugin,value).await();
  return root;
}
const execute=(root,name,args)=>root.tools.execute({callId:Math.random().toString(),name,arguments:args,signal:new AbortController().signal});

test('web reuses official provider service and official search/fetch tools without network',async t=>{
  const root=await fixture(t);const module=await install({root,capabilities:{mcp:true}});assert.equal(typeof module.services.web.search,'function');assert.equal(descriptor.officialPackage,'@deepseek-ai/dsh-web');assert.deepEqual(root.tools.schemas().map(x=>x.name).sort(),['web_fetch','web_search']);
  let searched=0,fetched=0;
  root.web.registerSearchProvider({id:'synthetic',available:()=>true,search:async(request,signal)=>{searched++;assert.equal(request.query,'synthetic query');assert.ok(signal);return {sources:[{url:'https://example.invalid/probe',title:'Synthetic'}],truncated:false};}});
  root.web.registerFetchProvider({id:'synthetic',available:()=>true,fetch:async(request,signal)=>{fetched++;assert.ok(signal);return {url:request.url,statusCode:200,body:{kind:'text',content:'synthetic fetch body'},truncated:false};}});
  const search=await execute(root,'web_search',{queries:['synthetic query']});assert.equal(search.isError,false);assert.match(search.content[0].text,/Synthetic/);
  const fetch=await execute(root,'web_fetch',{url:'https://example.invalid/probe'});assert.equal(fetch.isError,false);assert.match(fetch.content[0].text,/synthetic fetch body/);assert.equal(searched,1);assert.equal(fetched,1);
  const invalid=await execute(root,'web_search',{queries:[]});assert.equal(invalid.isError,true);assert.equal(searched,1,'official validation must reject before provider runs');
});

test('web preserves official missing/ambiguous provider errors and explicit profile selection',async t=>{
  const selected=webConfiguration({defaultConfig:{web:{searchProvider:'second',fetchProvider:'fetcher',unrelated:'ignored'}}});assert.deepEqual(selected,{searchProvider:'second',fetchProvider:'fetcher'});
  const root=await fixture(t,{searchProvider:'second'});let called=[];
  for(const id of ['first','second'])root.web.registerSearchProvider({id,available:()=>true,search:async()=>{called.push(id);return {sources:[],truncated:false};}});
  const result=await execute(root,'web_search',{queries:['test']});assert.equal(result.isError,false);assert.deepEqual(called,['second']);
  await assert.rejects(root.web.fetch({url:'https://example.invalid'}),error=>error.code==='WEB_PROVIDER_UNAVAILABLE');
  assert.throws(()=>root.web.registerSearchProvider({id:'second',available:()=>true,search(){}}),error=>error.code==='WEB_DUPLICATE_PROVIDER');
});

test('web disables cleanly when Codex MCP is unavailable or official service is unmounted',async()=>{
  assert.deepEqual((await install({capabilities:{mcp:false}})).services,{});assert.equal((await install({capabilities:{mcp:false}})).diagnostics[0].code,'MODULE_CAPABILITY_UNAVAILABLE');
  assert.equal((await install({root:{get:()=>undefined},capabilities:{mcp:true}})).diagnostics[0].code,'MODULE_SERVICE_UNAVAILABLE');
});
