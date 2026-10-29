import { expect, test } from 'claude-code/testing'
import { START, slash, stage, tn, resultText } from './sim'

test('the UI command calls the built-in browser with the child origin and starts no model',async($,on)=>{
 const shown:unknown[]=[]
 on('mcp.call',(_,e)=>{shown.push({server:e.server,tool:e.tool,args:e.args});return {value:{content:[],isError:false}}})
 const world=stage(on,{}, {rewrite:(method,_params,result)=>method==='ui.open'?{url:'http://127.0.0.1:45678/'}:result})
 await $.session.start(START)
 expect(world.commands.some(c=>c.name==='dsh-fixture-ui')).toBe(true)
 const result=await $.command.run(slash('dsh-fixture-ui'))
 expect(result.text).toContain('已開啟')
 expect(shown).toEqual([{server:'Claude_Browser',tool:'preview_start',args:{url:'http://127.0.0.1:45678/'}}])
 expect(world.modelCalls.length).toBe(0)
 expect(world.agentCalls.length).toBe(0)
})

test('a browser-origin tool call still observes the plugin posting ban', {options:{outboundMode:'deny'}},async($,on)=>{
 const world=stage(on,{tools:[{dshName:'ask'},{dshName:'post_comment'}],reverse:'ui'})
 await $.session.start(START)
 const result=JSON.parse(resultText(await $.tool.call({tool:tn('ask')})))
 expect(result.method).toBe('ui.execute')
 expect(result.reply.result.isError).toBe(true)
 expect(JSON.stringify(result.reply)).toContain('OUTBOUND_DENIED')
 expect(world.cores[0]?.calls.filter(c=>c.method==='tools.call'&&c.params.name==='post_comment').length).toBe(0)
})

test('closing the UI prevents a late confirmation from sending anything',async($,on)=>{
 let release:()=>void=()=>{}
 const lateAnswer=new Promise<void>(resolve=>{release=resolve})
 const world=stage(on,{tools:[{dshName:'ask'},{dshName:'post_comment'}],reverse:'ui',cancelUiRequest:true},{answers:['這次送出'],beforeAnswer:()=>lateAnswer})
 await $.session.start(START)
 const result=JSON.parse(resultText(await $.tool.call({tool:tn('ask')})))
 expect(result.reply.result.isError).toBe(true)
 expect(JSON.stringify(result.reply)).toContain('取消')
 release()
 await world.clock.settle()
 expect(world.cores[0]?.calls.filter(c=>c.method==='tools.call'&&c.params.name==='post_comment').length).toBe(0)
})
