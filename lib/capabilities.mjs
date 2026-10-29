// Claude Code 外掛能用的功能摘要：給審查子代理判斷「裝不進來的部分 Claude Code 做不做得到」。
// 來源是 Claude Code 自己寫出的型別檔 claude-code.d.ts（兩萬多行，大半是寫程式用的細節），
// 這裡只抽出每個功能、事件、畫面位置的名稱和第一句說明、各種畫面能用的元件，以及內建工具的名稱，約兩百行。
// 使用者環境才有的東西（連上的 MCP 伺服器，例如桌面版的內建瀏覽器）型別檔沒有，由安裝技能在審查時另外列給子代理。
// 型別檔跟著 Claude Code 版本更新，摘要也就跟著更新，不必手寫清單。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {dshHome} from './npm-source.mjs';

const versionOf=text=>/^\/\/ Written by Claude Code (\d+(?:\.\d+)*)/.exec(text)?.[1]??null;
const compareVersions=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<Math.max(x.length,y.length);i++){const d=(x[i]??0)-(y[i]??0);if(d)return d;}return 0;};
const subdirs=async dir=>(await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])).filter(d=>d.isDirectory()).map(d=>path.join(dir,d.name));

/**
 * 找型別檔：載入 plugin-authoring 技能時寫在暫存資料夾的（<暫存>/claude/bundled-skills/<版本>/<亂碼>/plugin-authoring/types/），
 * 以及 Claude Code 載入開發中 mod 時寫在 mod 旁邊的（~/.claude/dev-mods/<…>/<mod>/.claude-plugin/types/claude-code/）。
 * 有好幾份時用版本最新的。找不到回傳 null。
 */
export async function findTypesFile({tmp=os.tmpdir(),userHome=os.homedir()}={}){
  const candidates=[];
  for(const version of await subdirs(path.join(tmp,'claude','bundled-skills')))
    for(const hash of await subdirs(version))candidates.push(path.join(hash,'plugin-authoring','types','claude-code.d.ts'));
  for(const session of await subdirs(path.join(userHome,'.claude','dev-mods')))
    for(const mod of await subdirs(session))candidates.push(path.join(mod,'.claude-plugin','types','claude-code','index.d.ts'));
  let best=null;
  for(const file of candidates){
    const head=await fs.readFile(file,'utf8').then(text=>text.slice(0,200)).catch(()=>null);
    const version=head&&versionOf(head);
    if(version&&(!best||compareVersions(version,best.version)>0))best={file,version};
  }
  return best;
}

/** 說明的前 count 句：JSDoc 去掉星號，到第一個空行或 @標記為止；太長的截到 260 字。 */
function firstSentence(doc,count=1){
  const text=[];
  for(const line of doc){
    const body=line.replace(/^\s*\/?\*+\/?\s?/,'').replace(/\*\/\s*$/,'').trim();
    if(!body){if(text.length)break;continue;}
    if(body.startsWith('@'))break;
    text.push(body);
  }
  let sentence=text.join(' ');
  const ends=[...sentence.matchAll(/\.(\s|$)/g)];
  if(ends.length>=count)sentence=sentence.slice(0,ends[count-1].index+1);
  return sentence.length>260?`${sentence.slice(0,259)}…`:sentence;
}

/** 緊接在第 i 行前面的 JSDoc 那幾行。 */
function docBefore(lines,i){
  let end=i-1;while(end>=0&&!lines[end].trim())end--;
  if(end<0||!lines[end].trim().endsWith('*/'))return [];
  let start=end;while(start>0&&!lines[start].trim().startsWith('/**'))start--;
  return lines.slice(start,end+1);
}

/** 從 start 那一行起、縮排 indent 格的成員：[{ name, doc }]，doc 是緊接在前面的 JSDoc。到縮排更少的 } 為止。 */
function members(lines,start,indent){
  const found=[];const pad=' '.repeat(indent);
  const name=new RegExp(`^${pad}'?([A-Za-z][\\w.]*)'?\\??: `);
  let doc=[];
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i];
    if(/^\s*}/.test(line)&&line.search(/\S/)<indent)break;
    if(line.startsWith(`${pad}/**`)){doc=[];for(;i<lines.length;i++){doc.push(lines[i]);if(lines[i].includes('*/'))break;}continue;}
    const match=name.exec(line);
    if(match){found.push({name:match[1],doc:firstSentence(doc),line:i});doc=[];}
    else if(line.trim()&&!line.startsWith(pad+' '))doc=[];
  }
  return found;
}

const findLine=(lines,regex,from=0)=>{for(let i=from;i<lines.length;i++)if(regex.test(lines[i]))return i;return -1;};

/** 把型別檔整理成 Markdown 摘要。格式認不得的段落會略過，`missing` 列出略過了哪些。 */
export function summarizeTypes(text){
  const lines=text.split(/\r?\n/);
  const out=[];const missing=[];
  const section=(title,start,build)=>{if(start<0){missing.push(title);return;}const body=build(start);if(!body.length){missing.push(title);return;}out.push('',`## ${title}`,'',...body);};

  section('`$` 底下的功能（在任何事件裡呼叫）',findLine(lines,/^\s*export interface CoreEngineInterface \{/),start=>{
    const body=[];
    for(const noun of members(lines,start,6)){
      const methods=members(lines,noun.line,10);
      if(!methods.length)continue;
      body.push(`- **${noun.name}**：${noun.doc}`);
      for(const m of methods)body.push(`  - \`$.${noun.name}.${m.name}\`：${m.doc}`);
    }
    return body;
  });
  section('事件（`on(\'<事件>\', hook)` 攔截或回應）',findLine(lines,/^\s*export type EngineEventOf = \{/),start=>members(lines,start,6).map(e=>`- \`${e.name}\`：${e.doc}`));
  // 畫面上可以畫的位置（ui.render 的 component）：Pane、AbovePrompt 等，在同一個型別裡。
  const pane=findLine(lines,/^ {6}Pane: \{/);
  let places=-1;for(let i=pane;i>0;i--)if(/^ {2}\S.*[{=]\s*\{?\s*$/.test(lines[i])&&/\{\s*$/.test(lines[i])){places=i;break;}
  section('可以畫東西的位置（`ui.render` 的 component）',pane<0?-1:places,start=>members(lines,start,6).filter(p=>/^[A-Z]/.test(p.name)).map(p=>`- \`${p.name}\`：${p.doc}`));
  const elements=new Set();
  section('各種畫面能用的元件（terminal 是終端機，desktop 是 Claude 桌面版）',findLine(lines,/^ {6}terminal: \{/),start=>{
    const body=[];
    for(let i=start;i<lines.length;i++){
      const surface=/^ {6}(terminal|desktop|vscode|mobile): \{/.exec(lines[i]);
      if(!surface){if(/^ {2}\S/.test(lines[i]))break;continue;}
      const names=[];
      for(i++;i<lines.length&&!/^ {6}\}/.test(lines[i]);i++){const m=/^ {10}(\w+): ElementConstructor/.exec(lines[i]);if(m){names.push(m[1]);elements.add(m[1]);}}
      body.push(`- ${surface[1]}：${names.join('、')}`);
    }
    return body;
  });
  section('元件說明',elements.size?0:-1,()=>[...elements].flatMap(name=>{
    const at=findLine(lines,new RegExp(`^ {2}export (type|interface) ${name}Props\\b`));
    const doc=at<0?'':firstSentence(docBefore(lines,at),2);
    return doc?[`- \`${name}\`：${doc}`]:[];
  }));
  section('自訂畫面區塊（`Client` 的模組）',findLine(lines,/^ {2}export type ClientModule\b/),at=>[`- ${firstSentence(docBefore(lines,at),3)}`]);
  // 內建工具只有名稱：各工具的參數在型別檔的 BuiltinToolInputs，需要時再查。
  section('Claude Code 內建工具（`$.tool.call({ tool: \'<名稱>\', ... })` 呼叫，會經過權限確認；有些只在特定環境出現）',findLine(lines,/^\s*interface BuiltinToolInputs \{/),start=>{
    const names=members(lines,start,4).map(m=>m.name);
    return names.length?[names.join('、')]:[];
  });
  return {markdown:out.join('\n').trim(),missing};
}

/**
 * 找到型別檔、寫出摘要：<home>/capabilities/claude-code-<版本>.md（同一版本已經寫過就直接用）。
 * 回傳 { found, path, version, typesFile, lines, missing }；找不到型別檔時 found 是 false。
 */
export async function writeCapabilities({home=dshHome(),typesFile,tmp,userHome}={}){
  const located=typesFile?{file:typesFile,version:versionOf(await fs.readFile(typesFile,'utf8'))??'unknown'}:await findTypesFile({tmp,userHome});
  if(!located)return {found:false,reason:'找不到 Claude Code 的型別檔（claude-code.d.ts）：這台電腦還沒載入過 plugin-authoring 技能。'};
  const text=await fs.readFile(located.file,'utf8');
  const {markdown,missing}=summarizeTypes(text);
  const file=path.join(home,'capabilities',`claude-code-${located.version}.md`);
  const header=[`# Claude Code ${located.version} 外掛能用的功能`,'',`由型別檔自動摘要（${located.file}），每項只有名稱和第一句說明。這裡沒有的功能，就是 Claude Code 外掛沒有提供；細節要查型別檔。`].join('\n');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,`${header}\n\n${markdown}\n`);
  return {found:true,path:file,version:located.version,typesFile:located.file,lines:markdown.split('\n').length,missing};
}
