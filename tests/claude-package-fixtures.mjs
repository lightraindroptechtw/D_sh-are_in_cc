// 測試共用：合成 DSH 來源、替身範本、替身子程序宿主。不使用任何第三方 DSH 插件。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tempRoot(t,label='dsh to claude '){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),label));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}

/** 與 B 的範本相同的佔位字串；內容只求形狀正確。 */
export async function writeStubTemplates(dir){
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'plugin.json'),JSON.stringify({name:'__DSH_PLUGIN_NAME__',version:'__DSH_PLUGIN_VERSION__',description:'__DSH_PLUGIN_DESCRIPTION__',userConfig:{allowModelCalls:{type:'boolean',title:'Allow model calls',description:'Let the DSH plugin ask the model.',default:false},allowAgents:{type:'boolean',title:'Allow agents',description:'Let the DSH plugin start subagents.',default:false}}},null,2));
  await fs.writeFile(path.join(dir,'hooks.json'),JSON.stringify({modules:['./register.ts']},null,2));
  await fs.writeFile(path.join(dir,'register.ts'),'import type { Register } from "claude-code";\nconst config = "__DSH_BRIDGE_CONFIG__";\nexport const register: Register = (on, options) => {\n  void config; void options;\n};\n');
  return dir;
}

/** 替身：只寫出入口檔，不打包。 */
export const stubBuildHost=async({outputDir})=>{
  await fs.mkdir(path.join(outputDir,'runtime'),{recursive:true});
  await fs.writeFile(path.join(outputDir,'runtime','claude-host.mjs'),'// stub claude host\n');
};

const toolSource=`import{defineTool}from'@deepseek-ai/dsh-tools';
export const name='synthetic-tools';
export const inject=['tools','systemPrompt','llm','agents','sessionController'];
export function apply(ctx){
  ctx.tools.register(defineTool({name:'echo_probe',description:'Echo the input',parameters:{},output:{schema:{type:'json'},render:(_,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async()=>({ok:true})}));
  ctx.systemPrompt.section({name:'probe-guide',order:5,text:'Use echo_probe.'});
}
`;

/** 有工具、提示、llm、agents，另有一個 Claude 沒有對應的服務 sessionController 與一個技能。 */
export async function writeToolSource(root,{name='@acme/Synthetic Tools',withSkill=true}={}){
  const dir=path.join(root,'source-tools');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name,version:'1.2.3',description:'Synthetic "quoted" plugin with $& dollars',type:'module',main:'index.ts'}));
  await fs.writeFile(path.join(dir,'index.ts'),toolSource);
  if(withSkill){
    await fs.mkdir(path.join(dir,'skills','Probe Skill'),{recursive:true});
    await fs.writeFile(path.join(dir,'skills','Probe Skill','SKILL.md'),'---\nname: probe-skill\ndescription: A synthetic skill\n---\n\nBody.\n');
    await fs.writeFile(path.join(dir,'skills','Probe Skill','notes.txt'),'resource\n');
  }
  return dir;
}

/** 只有技能，沒有程式入口。 */
export async function writeSkillOnlySource(root){
  const dir=path.join(root,'source-skills');
  await fs.mkdir(path.join(dir,'skills','only'),{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'skill-only-pack',version:'0.0.1',description:'skills'}));
  await fs.writeFile(path.join(dir,'skills','only','SKILL.md'),'---\nname: only-skill\ndescription: Only skill\n---\n\nHello.\n');
  return dir;
}

/** 純 DSH 介面：package.json 宣告 dsh.client，沒有工具、技能。 */
export async function writeUiOnlySource(root){
  const dir=path.join(root,'source-ui');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'ui-only-panel',version:'0.1.0',type:'module',main:'index.js',dsh:{client:'./client.js'}}));
  await fs.writeFile(path.join(dir,'index.js'),'export const name="ui-only-panel";export function apply(){}\n');
  await fs.writeFile(path.join(dir,'client.js'),'export default {};\n');
  return dir;
}
