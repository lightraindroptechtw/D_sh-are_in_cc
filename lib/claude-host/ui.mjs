import fs from 'node:fs/promises';
import path from 'node:path';
import {startPluginUi} from '../ui-server.mjs';
export async function createClaudeUi({root,rpc,onNotice}){
 let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(root,'runtime/ui/manifest.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 let active,pending,closed=false;
 const describe=()=>({available:true,started:Boolean(active),name:manifest.name,version:manifest.version,placement:'Claude Code 瀏覽器中的獨立網頁；不修改聊天外觀',...(active?{url:active.url}:{})});
 return {describe,async open(){if(closed)throw new Error('插件已結束，請重新載入後再開啟。');pending??=startPluginUi({root,rpc,onNotice}).then(value=>active=value).catch(error=>{pending=undefined;throw error;});await pending;return describe();},async close(){closed=true;try{await pending;}catch{}await active?.close();}};
}
