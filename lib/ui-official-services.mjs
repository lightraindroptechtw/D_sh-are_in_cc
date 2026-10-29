import {randomUUID} from 'node:crypto';
import {runCommand} from './modules/claude/commands.mjs';

const methods={settings:{describe:[],update:['ns','patch','expectedRevision'],replace:['ns','section','expectedRevision'],mutate:['ns','ops','expectedRevision'],openSettingsDocument:[]},credentials:{describe:['refs'],set:['ref','value'],unset:['ref']},commands:{list:['agentId'],execute:['agentId','line','submittedAttachments']}};
const fail=(code,message)=>Object.assign(new Error(message),{code});
const view=row=>Object.fromEntries(['ns','autoGenerate','schema','value','base','user','applies','revision'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]).concat([['secrets',(row.secrets??[]).map(({path,set})=>({path:[...path],set}))]]));
/** Explicit DSH public UI signatures; no generic access to ctx or secret reads. */
export async function dispatchOfficialUiCall({ctx,namespace,method,args={},signal}){
  const names=Object.hasOwn(methods,namespace)&&Object.hasOwn(methods[namespace],method)?methods[namespace][method]:null;
  if(!names)return undefined;
  const input=Array.isArray(args)?Object.fromEntries(names.map((name,index)=>[name,args[index]])):args;
  try{
    signal?.throwIfAborted();
    const service=ctx.get(namespace);
    if(!service)throw fail('gateway/unavailable',`插件尚未啟用「${namespace}」服務，這項操作無法執行。`);
    let value;
    if(namespace==='settings'){
      if(method==='describe')value={writable:service.writable===true,hasDocument:typeof service.prepareDocument==='function',namespaces:service.describe({redactSecrets:true}).map(view)};
      else if(method==='openSettingsDocument'){
        // Claude Code gives the worker no channel to open a program on the user's desktop, so say so instead of pretending.
        throw fail('gateway/unsupported','Claude Code 宿主尚未提供開啟設定文件的功能；請直接用編輯器開啟設定檔。');
      }else{
        if(typeof input.ns!=='string'||!input.ns)throw fail('gateway/bad-request','請指定要修改的設定名稱。');
        await service[method](input.ns,input[method==='update'?'patch':method==='replace'?'section':'ops'],input.expectedRevision);
        const row=service.describe({redactSecrets:true}).find(row=>row.ns===input.ns);
        if(!row)throw fail('settings/rejected','設定已卸載，請重新開啟插件頁面。');
        value=view(row);
      }
    }else if(namespace==='credentials'){
      if(method==='describe'){
        if(!Array.isArray(input.refs))throw fail('gateway/bad-request','請提供要查詢的金鑰欄位清單。');
        value=Object.fromEntries(await Promise.all(input.refs.map(async ref=>{const info=await service.describe(ref);return [ref,{configured:info.configured,writable:info.writable,...(info.source?{source:info.source}:{})}];})));
      }else if(method==='set')await service.set(input.ref,input.value);
      else await service.unset(input.ref);
    }else if(method==='list')value=await service.list(undefined);
    else{
      if(input.submittedAttachments?.length)throw fail('gateway/unsupported','這個指令帶有 DSH 附件收據，目前尚未接上；文字指令仍可使用。');
      const match=typeof input.line==='string'&&input.line.match(/^\s*\/?([a-z][a-z0-9_-]*)([\s\S]*)$/);
      if(!match)throw fail('gateway/bad-request','請提供完整的插件指令。');
      const commandId='claude-ui-'+randomUUID();
      const result=await runCommand(ctx,{name:match[1],args:match[2],signal});
      value={commandId,result:{kind:'success',text:result.text}};
    }
    signal?.throwIfAborted();return {ok:true,value};
  }catch(error){return {ok:false,error:{code:signal?.aborted?'gateway/cancelled':error.code==='SETTINGS_CONFLICT'?'settings/conflict':error.code??'gateway/internal',message:error.message??String(error),details:{}}};}
}
