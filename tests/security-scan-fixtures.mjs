// 安全掃描測試用的合成 DSH 插件。不使用任何第三方插件；寫死的「金鑰」都是假的測試字串。
import fs from 'node:fs/promises';
import path from 'node:path';

export const FAKE_SECRET='zq9X7w2LmN4pR8sT1vB6yC3dF5gH0jKa';

const write=async(root,rel,text)=>{const file=path.join(root,rel);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};

/** 每一類規則都有正例的插件。 */
export async function writeRiskySource(root){
  const dir=path.join(root,'risky');
  await write(dir,'package.json',JSON.stringify({name:'risky-plugin',version:'1.0.0',type:'module',main:'index.js',scripts:{postinstall:'node setup.js'},dsh:{bundle:{patch:'./cordis.patch.yml'},client:'./client.js'}}));
  await write(dir,'cordis.patch.yml',[
    '- insert:',
    '    - id: risky',
    '      name: risky-plugin',
    '      config:',
    '        apiKey: !!js process.env.AGENTMAIL_API_KEY',
    '        inbox: !!js process.env.AGENTMAIL_INBOX_ID',
    '    - id: mcp',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        transport: stdio',
    '        command: uvx',
    '        args: [some-mcp-server]',
    ''].join('\n'));
  await write(dir,'index.js',`import {spawn,execSync} from 'node:child_process';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import axios from 'axios';
import {defineTool} from '@deepseek-ai/dsh-tools';
const PY='python';
const API_KEY='${FAKE_SECRET}';
export const name='risky-plugin';
export function apply(ctx){
  spawn(PY,['mcp_server.py']);
  execSync('cloudflared tunnel run');
  require('child_process').execFile('uv',['sync']);
  const anything=pick();
  spawn(anything);
  Bun.spawn(['git','status']);
  new Deno.Command('ffmpeg',{args:[]});
  fs.writeFileSync(path.join(os.homedir(),'.risky','state.json'),'{}');
  fs.readFileSync('/etc/hosts','utf8');
  fsp.rm('../outside',{recursive:true});
  fs.readFileSync('local.txt','utf8');
  fetch('https://api.example-search.com/v1/search?q=1');
  https.request('https://hooks.slack.com/services/x');
  new WebSocket('wss://stream.example.io/feed');
  axios.post('https://api.example-bar.com/items',{});
  const key=process.env.TAVILY_API_KEY;
  const p=process.env.PATH;
  const {GITHUB_TOKEN}=process.env;
  const max=process.env.MAX_TOKENS;
  spawn('node',['x.js'],{env:{...process.env}});
  ctx.credentials.resolve('my-service-ref');
  ctx.tools.register(defineTool({name:'post_comment',description:'Post a comment under a video',parameters:{bvid:{type:'string'},text:{type:'string'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'search_comments',description:'Search comments',parameters:{q:{type:'string'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'create_draft',description:'Create an email draft',parameters:{to:{type:'string'},body:{type:'string'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'send_draft',description:'Send a previously created draft.',parameters:{draftId:{type:'string'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'video_feedback',description:'发表评论到视频下面，然后返回结果',parameters:{bvid:{type:'string'},content:{type:'string'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'nas_reboot',description:'Reboot the NAS (POST /system/reboot). Takes minutes.',parameters:{confirm:{type:'boolean'}},execute:async()=>({})}));
  ctx.tools.register(defineTool({name:'wecom_notify_group',description:'Notify the team',parameters:{text:{type:'string'}},execute:async()=>({})}));
  ctx.commands.register({name:'send-report',description:'Send the report',execute:async()=>'ok'});
  void key;void p;void GITHUB_TOKEN;void max;void API_KEY;
}
function pick(){return 'x';}
`);
  // 包裝函式註冊（B 站插件的寫法）
  await write(dir,'lib/wrapped.js',`export function install(ctx){
  const tool=(spec)=>ctx.tools.register({...spec});
  tool({
    name:'send_email',
    description:'寄信給指定的人。'+'\\n第二行',
    parameters:{to:{type:'string'},subject:{type:'string'},body:{type:'string'}},
    async execute(args){return args;},
  });
  tool({name:'get_messages',description:'取得私信列表',parameters:{},async execute(){return [];}});
}
`);
  await write(dir,'mcp_server.py',`import os, subprocess, requests
from mcp.server.fastmcp import FastMCP
mcp = FastMCP("x")
TOKEN = os.environ.get("BILI_SESSDATA")

@mcp.tool()
async def send_message(receiver_uid: int, text: str) -> str:
    """Send a private message to a user."""
    return "ok"

@mcp.tool()
async def search_videos(keyword: str) -> str:
    """Search videos."""
    subprocess.run(["ffmpeg", "-i", "a"])
    requests.get("https://api.example-video.com/search")
    return ""
`);
  await write(dir,'scripts/unused.sh','echo hi\n');
  await write(dir,'client.js',`fetch('https://cdn.example-client.com/x.js');\n`);
  await write(dir,'tests/fixture.test.js',`import {spawn} from 'node:child_process';spawn('rm');\n`);
  await write(dir,'node_modules/dep/index.js',`require('child_process').spawn('evil');\n`);
  await write(dir,'node_modules/dep/package.json','{"name":"dep"}');
  return dir;
}

/** 用 javascript-obfuscator 風格產生的混淆檔：大量 _0x 識別字加 while(!![])。 */
export function obfuscatedText(){
  const names=Array.from({length:60},(_,i)=>'_0x'+(0x1a2b+i*7).toString(16));
  const body=names.map((name,i)=>`var ${name}=${names[(i+1)%names.length]}||_0x4f2a('0x${i.toString(16)}');`).join('');
  return `(function(_0x3c1d,_0x5e2f){var _0x1b7a=function(_0x2d4e){while(--_0x2d4e){_0x3c1d['push'](_0x3c1d['shift']());}};while(!![]){try{break;}catch(_0x9f1e){}}}(['\\x68\\x65\\x6c\\x6c\\x6f']));${body}\n`;
}

/** 正常但壓縮過的檔案：很長的一行，識別字是一般名稱。 */
export function minifiedText(){
  return Array.from({length:600},(_,i)=>`function fn${i}(a,b){return a+b+${i}}`).join(';')+'\n';
}

export async function writeObfuscatedSource(root){
  const dir=path.join(root,'obfuscated');
  await write(dir,'package.json',JSON.stringify({name:'obf-plugin',version:'0.1.0',type:'module',main:'index.js'}));
  await write(dir,'index.js',`import './lib/core.js';\nexport const name='obf-plugin';\nexport function apply(ctx){ctx.tools.register({name:'noop',description:'noop',parameters:{},execute:async()=>({})});}\n`);
  await write(dir,'lib/core.js',obfuscatedText());
  return dir;
}

/** 轉換測試用：有一個對外發文工具、一把金鑰。 */
export async function writeOutboundSource(root){
  const dir=path.join(root,'outbound');
  await write(dir,'package.json',JSON.stringify({name:'outbound-plugin',version:'0.2.0',description:'Synthetic outbound plugin',type:'module',main:'index.ts'}));
  await write(dir,'index.ts',`import {defineTool} from '@deepseek-ai/dsh-tools';
export const name='outbound-plugin';
export const inject=['tools'];
export function apply(ctx){
  const key=process.env.TAVILY_API_KEY;
  ctx.tools.register(defineTool({name:'post_reply',description:'在影片底下發留言。',parameters:{bvid:{type:'string'},text:{type:'string'}},output:{schema:{type:'json'},render:(_:unknown,v:unknown)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({ok:Boolean(key)})}));
  ctx.tools.register(defineTool({name:'web_lookup',description:'Search the web',parameters:{q:{type:'string'}},output:{schema:{type:'json'},render:(_:unknown,v:unknown)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({ok:true})}));
}
`);
  return dir;
}
