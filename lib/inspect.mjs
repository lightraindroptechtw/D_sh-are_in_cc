import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import {filesIn,inside} from './source.mjs';
import {checkRuntimeVersions} from './runtime-versions.mjs';
import {isCordisContextName,CORDIS_TIMER_ACCESSORS} from './cordis-context.mjs';
import {DSH_SERVICES} from './dsh-services.mjs';
import {expressionEnvNames} from './compat/dsh-expression.mjs';
import {entryIdFor} from './entry-id.mjs';
import {discoverPluginUi} from './ui-assets.mjs';

const exists=async p=>{try{await fs.access(p);return true;}catch{return false;}};
export function literal(node) {
  if(!node)return undefined;
  if(ts.isStringLiteralLike(node)||ts.isNumericLiteral(node))return ts.isNumericLiteral(node)?Number(node.text):node.text;
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(node.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isArrayLiteralExpression(node))return node.elements.map(literal);
  if(ts.isObjectLiteralExpression(node)) {
    const result=Object.create(null);
    for(const p of node.properties)if(ts.isPropertyAssignment(p))result[p.name.text??p.name.getText()]=literal(p.initializer);
    return result;
  }
  return undefined;
}
// Service names are an explicit DSH/Cordis vocabulary. Unknown context members
// remain evidence, never runtime requirements inferred from a variable's spelling.
const dshServices=DSH_SERVICES;
function inspectBindings(tree) {
  // A local checker gives lexical symbol identity even without resolving imports.
  // It distinguishes a nested canvas/zod parameter from the plugin context.
  const host={getSourceFile:n=>n===tree.fileName?tree:undefined,getDefaultLibFileName:()=>'',writeFile(){},getCurrentDirectory:()=>'',getDirectories:()=>[],fileExists:n=>n===tree.fileName,readFile:()=>undefined,getCanonicalFileName:n=>n,useCaseSensitiveFileNames:()=>true,getNewLine:()=> '\n'};
  const checker=ts.createProgram([tree.fileName],{noLib:true,noResolve:true,allowJs:true},host).getTypeChecker();
  const symbol=n=>n&&ts.isIdentifier(n)?checker.getSymbolAtLocation(n):undefined;
  const contexts=new Set(), serviceAliases=new Map(),services=new Set(),contextApi=[],uncertain=[],environment=new Set(),home=[],commands=[],dynamicCommands=[];
  const nodes=[];const walk=n=>{nodes.push(n);ts.forEachChild(n,walk);};walk(tree);
  const pos=n=>tree.getLineAndCharacterOfPosition(n.getStart()).line+1;
  const unwrap=n=>{while(n&&(ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isNonNullExpression(n)||ts.isTypeAssertionExpression(n)))n=n.expression;return n;};
  const member=n=>{n=unwrap(n);return ts.isPropertyAccessExpression(n)?{object:unwrap(n.expression),name:n.name.text}:ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteralLike(n.argumentExpression)?{object:unwrap(n.expression),name:n.argumentExpression.text}:null;};
  const isContext=n=>{n=unwrap(n);if(contexts.has(symbol(n)))return true;const m=member(n);if(m?.name==='root'&&isContext(m.object))return true;if(n&&ts.isCallExpression(n)){const call=member(n.expression);if(call&&['extend','isolate','intercept'].includes(call.name)&&isContext(call.object))return true;if(['extend','isolate','intercept'].includes(serviceAliases.get(symbol(n.expression))))return true;}return false;};
  const known=name=>dshServices.has(name)||isCordisContextName(name);
  const record=(name,n,kind='context-member')=>{if(isCordisContextName(name)){contextApi.push({name,line:pos(n),kind});if(CORDIS_TIMER_ACCESSORS.includes(name))services.add('timer');}else if(dshServices.has(name))services.add(name);else uncertain.push({name,line:pos(n),kind});};
  const findValue=(n,seen=new Set())=>{n=unwrap(n);if(n&&ts.isIdentifier(n)){let key=symbol(n);if(n.parent&&ts.isShorthandPropertyAssignment(n.parent))key=checker.getShorthandAssignmentValueSymbol(n.parent)??key;if(n.parent&&ts.isExportSpecifier(n.parent))key=checker.getExportSpecifierLocalTargetSymbol(n.parent)??key;if(seen.has(key))return n;seen.add(key);const declaration=key?.valueDeclaration;if(declaration&&ts.isVariableDeclaration(declaration))return findValue(declaration.initializer,seen);if(declaration&&ts.isFunctionDeclaration(declaration))return declaration;}return n;};
  const injectNames=n=>{n=findValue(n);if(!n)return [];if(ts.isArrayLiteralExpression(n))return n.elements.flatMap(x=>ts.isStringLiteralLike(x)?[x.text]:[]);if(ts.isObjectLiteralExpression(n))return n.properties.flatMap(p=>ts.isPropertyAssignment(p)?['required','optional'].includes(p.name.text)?injectNames(p.initializer):[p.name.text].filter(Boolean):[]);return [];};
  const bind=(name,kind)=>{if(ts.isIdentifier(name)){const key=symbol(name);if(key){if(kind==='context')contexts.add(key);else serviceAliases.set(key,kind);}return;}if(kind==='context'&&ts.isObjectBindingPattern(name))for(const e of name.elements){if(e.dotDotDotToken)continue;const key=e.propertyName?.text??(ts.isIdentifier(e.name)?e.name.text:null);if(key){record(key,e,'context-destructure');bind(e.name,key==='root'?'context':key);}}};
  const functionLike=n=>n&&(ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n));
  const applyFunction=n=>{n=findValue(n);if(functionLike(n)&&n.parameters[0])bind(n.parameters[0].name,'context');};
  const exported=n=>Boolean(n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword));
  for(const n of nodes){
    if(ts.isFunctionDeclaration(n)&&exported(n)&&(n.name?.text==='apply'||n.modifiers.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword)))applyFunction(n);
    if(ts.isVariableStatement(n)&&exported(n))for(const d of n.declarationList.declarations){if(d.name.getText(tree)==='apply')applyFunction(d.initializer);if(d.name.getText(tree)==='inject')for(const name of injectNames(d.initializer))record(name,d,'inject-declaration');}
    if(ts.isExportSpecifier(n)){const name=n.name.text;if(name==='apply')applyFunction(n.propertyName??n.name);if(name==='inject')for(const value of injectNames(n.propertyName??n.name))record(value,n,'inject-declaration');}
    if(ts.isExportAssignment(n)){const obj=findValue(n.expression);if(functionLike(obj))applyFunction(obj);if(obj&&ts.isObjectLiteralExpression(obj))for(const p of obj.properties){const name=p.name?.text;if(name==='apply')applyFunction(ts.isPropertyAssignment(p)?p.initializer:ts.isShorthandPropertyAssignment(p)?p.name:p);if(name==='inject')for(const value of injectNames(p.initializer))record(value,p,'inject-declaration');}}
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken){const m=member(n.left);if(m&&['exports','module.exports'].includes(m.object.getText(tree))){if(m.name==='apply')applyFunction(n.right);if(m.name==='inject')for(const name of injectNames(n.right))record(name,n,'inject-declaration');}}
  }
  // Context aliases and inject callbacks can nest, so resolve to a fixed point.
  for(let round=0;round<nodes.length;round++){
    const size=contexts.size+serviceAliases.size;
    for(const n of nodes){
      if(ts.isVariableDeclaration(n)&&n.initializer){const init=unwrap(n.initializer),m=member(init);if(isContext(init))bind(n.name,'context');else if(m&&isContext(m.object)&&known(m.name))bind(n.name,m.name);else if(serviceAliases.has(symbol(init)))bind(n.name,serviceAliases.get(symbol(init)));}
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isIdentifier(n.left)){if(isContext(n.right))bind(n.left,'context');else if(serviceAliases.has(symbol(unwrap(n.right))))bind(n.left,serviceAliases.get(symbol(unwrap(n.right))));}
      if(ts.isCallExpression(n)){const m=member(n.expression);if(m?.name==='inject'&&isContext(m.object)||serviceAliases.get(symbol(n.expression))==='inject'){for(const name of injectNames(n.arguments[0]))record(name,n,'inject-call');const cb=findValue(n.arguments[1]);if(functionLike(cb)&&cb.parameters[0])bind(cb.parameters[0].name,'context');}}
    }
    if(size===contexts.size+serviceAliases.size)break;
  }
  const serviceOf=n=>{const m=member(n);return m&&isContext(m.object)?m.name:serviceAliases.get(symbol(unwrap(n)));};
  for(const n of nodes)if(ts.isCallExpression(n)){const m=member(n.expression);if(m?.name==='register'&&serviceOf(m.object)==='commands'){const value=findValue(n.arguments[0]);let name,description='';if(value&&ts.isObjectLiteralExpression(value))for(const p of value.properties)if(ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p)){const key=p.name.text,content=literal(findValue(ts.isPropertyAssignment(p)?p.initializer:p.name));if(key==='name')name=content;if(key==='description'&&typeof content==='string')description=content;}if(typeof name==='string'&&/^[a-z][a-z0-9_-]*$/.test(name))commands.push({name,description,line:pos(n),execution:'unsupported-requires-dsh-agent'});else dynamicCommands.push({line:pos(n),reason:'command-name-not-statically-known'});}}
  const osSymbols=new Set(),homedirSymbols=new Set();
  for(const n of nodes){
    if(ts.isImportDeclaration(n)&&ts.isStringLiteral(n.moduleSpecifier)&&['os','node:os'].includes(n.moduleSpecifier.text)){const c=n.importClause;if(c?.name)osSymbols.add(symbol(c.name));if(c?.namedBindings){if(ts.isNamespaceImport(c.namedBindings))osSymbols.add(symbol(c.namedBindings.name));else for(const e of c.namedBindings.elements)if((e.propertyName??e.name).text==='homedir')homedirSymbols.add(symbol(e.name));}}
    if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(tree)==='require'&&['os','node:os'].includes(literal(n.initializer.arguments[0]))){if(ts.isIdentifier(n.name))osSymbols.add(symbol(n.name));if(ts.isObjectBindingPattern(n.name))for(const e of n.name.elements)if((e.propertyName??e.name).text==='homedir')homedirSymbols.add(symbol(e.name));}
  }
  for(const n of nodes){
    const m=member(n);
    if(m&&isContext(m.object))record(m.name,n);
    // Static process.env references only; values are never read or included.
    const e=envReference(n);if(e&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)){environment.add(e);if(['HOME','USERPROFILE','APPDATA','LOCALAPPDATA'].includes(e)||e.startsWith('XDG_'))home.push({line:pos(n),kind:'home-environment',name:e});}
    if(ts.isCallExpression(n)){const c=member(n.expression);if(homedirSymbols.has(symbol(n.expression))||c?.name==='homedir'&&osSymbols.has(symbol(c.object)))home.push({line:pos(n),kind:'os.homedir'});}
    if(m&&ts.isIdentifier(m.object)&&['ctx','context'].includes(m.object.text)&&!isContext(m.object))uncertain.push({name:m.name,line:pos(n),kind:'unbound-context-name'});
  }
  return {services:[...services],contextApi:[...new Map(contextApi.map(x=>[x.line+':'+x.name+':'+x.kind,x])).values()],uncertainServices:[...new Map(uncertain.map(x=>[x.line+':'+x.name+':'+x.kind,x])).values()],environmentNames:[...environment].sort(),homeAccess:home,commands,dynamicCommands};
}

// 「改變模型或工具行為」的靜態證據。只認下列明確寫法；名稱相同但形式不同的呼叫不算。
// web-provider：向 web 服務登記搜尋／抓取後端；llm-provider：登記模型供應商轉接；llm-hook：攔截模型串流或改寫模型能力；
// tool-hook：tools/pre-execute、tools/post-execute、tools/result；agent-hook：agent/pre-step 這類每步攔截；prompt-section：登記系統提示段落。
const LLM_PATCH_MEMBERS=new Set(['resolveModelInfo','streamWithRegistration','adapterStream']);
const TOOL_HOOK_EVENTS=new Set(['tools/pre-execute','tools/post-execute','tools/result']);
const EVENT_METHODS=new Set(['on','once','serial','parallel','bail','waterfall']);
// 跟著對話的寫法：聽對話事件、聽代理出現，或叫代理接著說（followup）。只記證據，不影響「純介面」判斷。
const CHAT_EVENTS=new Set(['session/event','agent/created','agent/disposed','agent/status']);
function chatEvent(node){
  const expr=node.expression;
  if(!ts.isPropertyAccessExpression(expr))return null;
  const method=expr.name.text;
  if(EVENT_METHODS.has(method)&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])&&CHAT_EVENTS.has(node.arguments[0].text))return node.arguments[0].text;
  if(method==='followup')return 'agent.followup';
  return null;
}
function modelBehavior(node,tree){
  const expr=node.expression;
  if(!ts.isPropertyAccessExpression(expr))return null;
  const method=expr.name.text;
  if(method==='registerSearchProvider'||method==='registerFetchProvider')return {kind:'web-provider',name:method};
  if(method==='registerAdapter'||method==='registerProvider')return {kind:'llm-provider',name:method};
  if(method==='section'&&/system-?prompt|\bprompt\b/i.test(expr.expression.getText(tree)))return {kind:'prompt-section',name:'systemPrompt.section'};
  if(EVENT_METHODS.has(method)&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0])){
    const event=node.arguments[0].text;
    if(TOOL_HOOK_EVENTS.has(event))return {kind:'tool-hook',name:event};
    if(event.startsWith('llm/'))return {kind:'llm-hook',name:event};
    if(event.startsWith('agent/pre-')||event.startsWith('prompt/'))return {kind:'agent-hook',name:event};
  }
  return null;
}
export function inspectJs(text,filename='source.ts') {
  const tree=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,filename.endsWith('.js')?ts.ScriptKind.JS:ts.ScriptKind.TS);
  const tools=[], imports=new Set(), calls=[], dynamicImports=[],toolTimeouts=[],behaviors=[],chatEvents=[]; let registrations=0;
  const bindings=inspectBindings(tree);
  const runtimeBinding=clause=>!clause?.isTypeOnly&&(!clause?.namedBindings||!ts.isNamedImports(clause.namedBindings)||Boolean(clause.name)||clause.namedBindings.elements.some(item=>!item.isTypeOnly));
  const visit=node=>{
    if(ts.isObjectLiteralExpression(node)&&node.properties.some(prop=>prop.name?.text==='execute')){const timeout=node.properties.find(prop=>prop.name?.text==='timeoutMs');if(timeout){const value=ts.isPropertyAssignment(timeout)?literal(timeout.initializer):undefined;toolTimeouts.push({line:tree.getLineAndCharacterOfPosition(timeout.getStart()).line+1,timeoutMs:typeof value==='number'&&Number.isFinite(value)&&value>0?value:null,static:typeof value==='number'&&Number.isFinite(value)&&value>0});}}
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&runtimeBinding(node.importClause))imports.add(node.moduleSpecifier.text);
    if(ts.isExportDeclaration(node)&&!node.isTypeOnly&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&(!node.exportClause||!ts.isNamedExports(node.exportClause)||node.exportClause.elements.some(item=>!item.isTypeOnly)))imports.add(node.moduleSpecifier.text);
    if(ts.isCallExpression(node)) {
      const callee=node.expression.getText(tree);
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||callee==='require'){
        if(node.arguments.length&&ts.isStringLiteralLike(node.arguments[0]))imports.add(node.arguments[0].text);
        else dynamicImports.push({line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1,expression:node.getText(tree).slice(0,160)});
      }
      if(/(?:^|\.)tools\.register$/.test(callee)||callee==='defineTool') {
        if(callee.endsWith('tools.register')) registrations++;
        let arg=node.arguments[0];
        if(arg&&ts.isCallExpression(arg)&&arg.expression.getText(tree)==='defineTool')arg=arg.arguments[0];
        const spec=arg&&literal(arg);
        if(spec?.name && typeof spec.name==='string')tools.push({name:spec.name,description:spec.description||'',line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
      }
      const behavior=modelBehavior(node,tree);if(behavior)behaviors.push({...behavior,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
      const chat=chatEvent(node);if(chat)chatEvents.push({name:chat,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
      if(callee==='setInterval'||callee==='setTimeout')calls.push({feature:callee,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
    }
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&LLM_PATCH_MEMBERS.has(node.left.name.text))behaviors.push({kind:'llm-hook',name:node.left.name.text,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
    if(ts.isStringLiteralLike(node)&&LLM_PATCH_MEMBERS.has(node.text)&&node.parent&&ts.isCallExpression(node.parent)&&node.parent.arguments.includes(node))behaviors.push({kind:'llm-hook',name:node.text,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1});
    ts.forEachChild(node,visit);
  };visit(tree);
  return {tools:[...new Map(tools.map(t=>[t.name,t])).values()],imports:[...imports],...bindings,registrations,calls,dynamicImports,toolTimeouts,behaviors,chatEvents};
}

export function parsePatch(text) {
  const doc=YAML.parseDocument(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:s=>({$dshExpression:s})}],maxAliasCount:50});
  if(doc.errors.length)throw new Error(doc.errors.map(e=>e.message).join('; '));
  if(doc.warnings.some(w=>w.code==='TAG_RESOLVE_FAILED'))throw new Error('掛載設定包含無法辨識的 YAML 標籤');
  const value=doc.toJS({maxAliasCount:50});
  const ancestors=new Set();
  const check=(item,depth=0)=>{if(!item||typeof item!=='object')return;if(depth>100||ancestors.has(item))throw new Error('掛載設定包含循環參照或巢狀過深');ancestors.add(item);for(const child of Object.values(item))check(child,depth+1);ancestors.delete(item);};
  check(value);return value;
}
function envReference(node) {
  if(ts.isPropertyAccessExpression(node)&&node.expression.getText()==='process.env')return node.name.text;
  if(ts.isElementAccessExpression(node)&&node.expression.getText()==='process.env'&&ts.isStringLiteral(node.argumentExpression))return node.argumentExpression.text;
}
export function headerExpression(text) {
  const file=ts.createSourceFile('expression.ts',`const value=(${text});`,ts.ScriptTarget.Latest,true);
  let node=file.statements[0]?.declarationList?.declarations[0]?.initializer;
  if(node&&ts.isParenthesizedExpression(node))node=node.expression;
  if(file.parseDiagnostics.length||file.statements.length!==1||!node||!ts.isConditionalExpression(node))return null;
  const key=envReference(node.condition), yes=node.whenTrue, no=node.whenFalse;
  if(!key||!ts.isObjectLiteralExpression(yes)||!ts.isObjectLiteralExpression(no)||no.properties.length)return null;
  const result={};
  for(const prop of yes.properties) {
    if(!ts.isPropertyAssignment(prop)||ts.isComputedPropertyName(prop.name)||envReference(prop.initializer)!==key)return null;
    result[prop.name.text??prop.name.getText()]=key;
  }
  return Object.keys(result).length?result:null;
}
function resolveExport(value) {
  if(typeof value==='string')return value;
  if(Array.isArray(value))for(const item of value){const r=resolveExport(item);if(r!==undefined)return r;}
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value))if(['import','node','default'].includes(key)){const r=resolveExport(item);if(r!==undefined)return r;}
  if(value===null)return null;
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const dynamic=value=>object(value)&&Object.hasOwn(value,'$dshExpression')||value&&typeof value==='object'&&Object.values(value).some(dynamic);
const group=row=>(row.group===true||row.name==='cordis:group')&&Array.isArray(row.config);
function composePatches(layers,issues) {
  const roots=[];
  const flatten=rows=>rows.flatMap(row=>[row,...(group(row)?flatten(row.config):[])]);
  const issue=(code,message)=>issues.push({code,message});
  const normalizeRows=(rows,file,reserved=new Set(flatten(roots).map(row=>row.id).filter(Boolean)))=>{
    if(!Array.isArray(rows)){issue('PATCH_INSERT',`${file}: insert 必須是條目陣列`);return [];}
    const result=[];
    for(const raw of rows){
      if(!object(raw)||typeof raw.name!=='string'){issue('PATCH_ROW',`${file}: 無法辨識插入條目`);continue;}
      if(raw.id!==undefined&&(typeof raw.id!=='string'||!raw.id)){issue('PATCH_ROW',`${file}: 條目 id 必須是非空字串`);continue;}
      if(raw.id&&reserved.has(raw.id)){issue('PATCH_DUPLICATE_ID',`${file}: 重複的條目 id ${raw.id}`);continue;}
      if(raw.id)reserved.add(raw.id);
      const row={...raw,_patchPath:file};
      if(group(row))row.config=normalizeRows(row.config,file,reserved);
      result.push(row);
    }
    return result;
  };
  for(const {file,patches}of layers){
    if(!Array.isArray(patches)){issue('PATCH_SHAPE',`${file}: 掛載設定必須是操作陣列`);continue;}
    for(const patch of patches){
      if(!object(patch)){issue('PATCH_SHAPE',`${file}: 掛載操作必須是物件`);continue;}
      const target=typeof patch.id==='string'&&patch.id?flatten(roots).find(row=>row.id===patch.id):null;
      if(patch.id&&!target){issue('PATCH_TARGET',`${file}: 找不到條目 ${patch.id}，未套用操作`);continue;}
      if(patch.name&&target&&patch.name!==target.name){issue('PATCH_NAME_ASSERTION',`${file}: ${patch.id} 的插件名稱不符合斷言`);continue;}
      if(Object.hasOwn(patch,'insert')){
        if(target&&!group(target)){issue('PATCH_GROUP',`${file}: ${patch.id} 不是可插入條目的分組`);continue;}
        (target?target.config:roots).push(...normalizeRows(patch.insert,file));
      }else if(target){
        const oldChildren=new Set(group(target)?flatten(target.config):[]);
        const reserved=new Set(flatten(roots).filter(row=>!oldChildren.has(row)).map(row=>row.id).filter(Boolean));
        for(const [key,value]of Object.entries(patch))if(!['id','name'].includes(key))target[key]=structuredClone(value);
        if(Object.hasOwn(patch,'config')&&group(target))target.config=normalizeRows(target.config,file,reserved);
        target._patchPath=file;
      }else issue('PATCH_TARGET',`${file}: 覆寫操作缺少可辨識的 id`);
    }
  }
  // Only actual group rows contain child rows; arbitrary config is never walked.
  const active=rows=>rows.flatMap(row=>row.disabled===true?[]:dynamic(row.disabled)?(issue('PATCH_DYNAMIC_DISABLED',`${row._patchPath}: ${row.id??row.name} 的啟用條件是動態值，未啟用`),[]):group(row)?active(row.config):[row]);
  return active(roots);
}
function normalizeMcp(c,{name,file,issues,dsh=false}) {
  const warn=(code,message,field)=>issues.push({code,message:`${name}: ${message}`,path:file,...(field?{field}:{})});
  if(!object(c)){warn('MCP_UNSUPPORTED','MCP 設定必須是物件');return null;}
  const transport=dsh?c.transport:c.type??(c.command?'stdio':'streamable-http');
  if(transport==='sse'){warn('SSE_TRANSPORT','SSE 傳輸尚未支援，未產生此連線');return null;}
  if(!['stdio','streamable-http','streamable_http','http'].includes(transport)){warn('MCP_UNSUPPORTED',`不支援傳輸方式 ${String(transport)}`);return null;}
  const allowed=dsh?new Set(['transport','serverName','command','args','env','cwd','url','headers','toolCallTimeoutMs']):new Set(['type','command','args','env','cwd','url','headers','http_headers','env_http_headers','env_vars','bearer_token_env_var','enabled','startup_timeout_sec','tool_timeout_sec','enabled_tools','disabled_tools','oauth','oauth_resource']);
  for(const key of Object.keys(c))if(!allowed.has(key))warn(key==='failOnStartupError'?'MCP_STARTUP_SEMANTICS_OMITTED':'MCP_CONFIG_OMITTED',`未移植設定欄位 ${key}`,key);
  for(const [key,value]of Object.entries(c))if(key!=='headers'&&dynamic(value)){warn('UNSUPPORTED_EXPRESSION',`設定 ${key} 含有未知動態值，未產生此連線`,key);return null;}
  let server;
  if(transport==='stdio'){
    if(typeof c.command!=='string'||!c.command||!Array.isArray(c.args??[])||(c.args??[]).some(x=>typeof x!=='string')||c.env!==undefined&&(!object(c.env)||Object.values(c.env).some(x=>typeof x!=='string'))||c.cwd!==undefined&&typeof c.cwd!=='string'){warn('MCP_UNSUPPORTED','stdio 的 command/args/env/cwd 格式不符，未產生此連線');return null;}
    server={command:c.command,args:c.args??[],...(c.env?{env:c.env}:{}),...(c.cwd!==undefined?{cwd:c.cwd}:{})};
    if(c.headers!==undefined||c.url!==undefined)warn('MCP_CONFIG_OMITTED','stdio 不使用 headers/url');
  }else{
    try{const url=new URL(c.url);if(!['http:','https:'].includes(url.protocol))throw new Error();}catch{warn('MCP_UNSUPPORTED','HTTP 端點必須是完整 HTTP(S) 網址');return null;}
    server={url:c.url};
    const headers=c.headers??c.http_headers;
    if(headers?.$dshExpression){
      const optional=headerExpression(headers.$dshExpression);
      if(!optional){warn('UNSUPPORTED_EXPRESSION','動態標頭不能安全轉換，未產生此連線','headers');return null;}
      server._optionalEnvHeaders=optional;
      warn('OPTIONAL_ENV_HEADER','保留選填環境標頭語意；需要本機 HTTP 代理，不會改成必填環境標頭','headers');
    }else if(headers!==undefined){
      if(!object(headers)||dynamic(headers)||Object.values(headers).some(x=>typeof x!=='string')){warn('MCP_UNSUPPORTED','headers 必須是靜態字串對應表');return null;}
      server.http_headers=headers;
    }
    if(c.command!==undefined||c.args!==undefined||c.env!==undefined||c.cwd!==undefined)warn('MCP_CONFIG_OMITTED','HTTP 不使用 command/args/env/cwd');
  }
  if(dsh&&c.toolCallTimeoutMs!==undefined){if(typeof c.toolCallTimeoutMs!=='number'||!Number.isFinite(c.toolCallTimeoutMs)||c.toolCallTimeoutMs<=0){warn('MCP_UNSUPPORTED','toolCallTimeoutMs 必須是正數');return null;}server.tool_timeout_sec=c.toolCallTimeoutMs/1000;}
  if(!dsh)for(const [key,value]of Object.entries(c))if(allowed.has(key)&&!['type','headers','command','args','env','cwd','url','http_headers'].includes(key))server[key]=value;
  return server;
}
export async function inspectSource(source,{sourceEntry,packageDir='.'}={}) {
  const root=source.root??path.resolve(source);
  if(typeof packageDir!=='string'||!inside(root,path.resolve(root,packageDir)))throw new Error('套件子目錄必須位於來源資料夾內');
  const packageRoot=await fs.realpath(path.resolve(root,packageDir));
  if(!inside(await fs.realpath(root),packageRoot))throw new Error('套件子目錄不可透過連結超出來源資料夾');
  const pkgPath=path.join(packageRoot,'package.json');
  const pkg=await exists(pkgPath)?JSON.parse(await fs.readFile(pkgPath,'utf8')):{};
  const all=await filesIn(root); const relative=f=>path.relative(root,f).split(path.sep).join('/');
  const evidence=[],issues=[],mcpServers={},skilled=[],pythonServers=[],js=[],skippedJs=new Map();
  const hasExports=Object.hasOwn(pkg,'exports');
  const rootExport=object(pkg.exports)&&Object.keys(pkg.exports).some(key=>key.startsWith('.'))?pkg.exports['.']:pkg.exports;
  let entry=hasExports?resolveExport(rootExport):pkg.main;
  if(hasExports&&!entry&&(rootExport!==undefined&&rootExport!==null||pkg.main))issues.push({code:'ENTRY_EXPORT_UNSUPPORTED',message:'套件沒有可用的 Node ESM 根入口；未將 require 或其他子路徑當作根入口'});
  if(entry!==undefined&&entry!==null&&typeof entry!=='string'){issues.push({code:'ENTRY_INVALID',message:'套件入口必須是路徑字串'});entry=null;}
  const fallback=['index.js','index.mjs','lib/index.js','src/index.ts','src/index.js'];
  if(entry && (!inside(root,path.resolve(packageRoot,entry))||!(await exists(path.resolve(packageRoot,entry))))) {
    issues.push({code:'ENTRY_MISSING',message:`宣告的入口不存在：${entry}`});entry=null;
  }
  if(!entry&&!hasExports)for(const item of fallback)if(await exists(path.join(packageRoot,item))){entry=item;break;}
  if(sourceEntry!==undefined){
    if(typeof sourceEntry!=='string'||!inside(root,path.resolve(packageRoot,sourceEntry))||!await exists(path.resolve(packageRoot,sourceEntry)))throw new Error('指定的來源入口必須存在於來源資料夾內');
    entry=sourceEntry;evidence.push({kind:'explicit-source-entry',path:relative(path.resolve(packageRoot,entry))});
  }
  if(entry&&(packageRoot!==path.resolve(root)||sourceEntry!==undefined))entry=relative(path.resolve(packageRoot,entry));
  for(const file of all) {
    const rel=relative(file);
    if(inside(packageRoot,file)&&file.endsWith('SKILL.md')&&!/(?:^|\/)(?:archive|tests?|examples?|\.github)\//.test(rel)) {
      const text=await fs.readFile(file,'utf8');
      const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if(front)try{const meta=YAML.parse(front[1]);if(typeof meta?.name==='string'&&meta.name.trim()&&typeof meta?.description==='string'&&meta.description.trim())skilled.push({path:rel,name:meta.name});else issues.push({code:'INVALID_SKILL',message:`技能缺少名稱或說明：${rel}`});}catch{issues.push({code:'INVALID_SKILL',message:`技能前置資料無法解析：${rel}`});}
      else issues.push({code:'INVALID_SKILL',message:`技能缺少前置資料：${rel}`});
    }
    if(/\.(?:[cm]?jsx?|[cm]?tsx?)$/.test(file)) {
      const bytes=(await fs.stat(file)).size;
      if(bytes>8*1024*1024){skippedJs.set(path.resolve(file),bytes);continue;}
      const item=inspectJs(await fs.readFile(file,'utf8'),rel);js.push({path:rel,...item});
    }
    if(file.endsWith('.py')&&(await fs.stat(file)).size<1024*1024) {
      const text=await fs.readFile(file,'utf8');
      if(/^\s*(?:from mcp\.|import mcp)/m.test(text)&&/\.run\(\s*transport\s*=\s*['"]stdio['"]\s*\)/.test(text)) {
        const req=path.join(path.dirname(file),'requirements.txt');
        pythonServers.push({path:rel,requirements:(await exists(req))?relative(req):null,evidence:'mcp import and explicit stdio run; execution unverified',status:'candidate-not-enabled'});
      }
    }
  }
  const patch=pkg.dsh?.bundle?.patch;
  const layers=[];
  if(patch!==undefined){
    const patches=typeof patch==='string'?[patch]:Array.isArray(patch)&&patch.every(item=>typeof item==='string')?patch:null;
    if(!patches)issues.push({code:'PATCH_DECLARATION',message:'dsh.bundle.patch 必須是路徑字串或有序路徑字串陣列'});
    else for(const file of patches){
      const full=path.resolve(packageRoot,file);
      if(!inside(root,full))issues.push({code:'PATCH_ESCAPE',message:`掛載設定超出插件資料夾：${file}`});
      else try{layers.push({file:relative(full),patches:parsePatch(await fs.readFile(full,'utf8'))});}catch(e){issues.push({code:'PATCH_PARSE',message:`${file}: ${e.message}`});}
    }
  }
  let defaultConfig={};
  const serviceConfig={};
  const rows=composePatches(layers,issues);
  // One bundle, several plugins: patch rows named "<package>/<subpath>" whose subpath is an entry of package.json "exports"
  // (dsh-agentmail mounts tools / identity / approval / inbound this way). Each such row is its own Cordis plugin with its own config.
  // A package whose rows are all named after the package itself (or after other packages) is not affected.
  const patchEntries=[];
  if(sourceEntry===undefined&&object(pkg.exports)&&typeof pkg.name==='string'&&pkg.name){
    const candidates=[];
    for(const row of rows){
      if(typeof row.name!=='string'||row.name===pkg.name||!row.name.startsWith(pkg.name+'/'))continue;
      const subpath='./'+row.name.slice(pkg.name.length+1);
      if(!Object.hasOwn(pkg.exports,subpath)||subpath.includes('*'))continue;
      const target=resolveExport(pkg.exports[subpath]);
      const full=typeof target==='string'?path.resolve(packageRoot,target):null;
      if(!full||!inside(root,full)||!(await exists(full))){issues.push({code:'PATCH_ENTRY_MISSING',message:`${row._patchPath}: ${row.name} 對應的匯出 ${subpath} 找不到檔案，未掛載`});continue;}
      candidates.push({row,subpath,full});
    }
    if(candidates.length){
      const mainRow=rows.find(row=>row.name===pkg.name);
      if(mainRow&&entry)candidates.unshift({row:mainRow,subpath:'.',full:path.resolve(root,entry)});
      const used=new Set();
      for(const {row,subpath,full} of candidates){
        let id=entryIdFor(typeof row.id==='string'&&row.id?row.id:subpath==='.'?'main':subpath.slice(2),'entry');
        while(used.has(id))id+='-'+(used.size+1);
        used.add(id);
        patchEntries.push({id,name:row.name,subpath,entry:relative(full),config:object(row.config)?structuredClone(row.config):{},patchPath:row._patchPath});
      }
      evidence.push({kind:'patch-entries',path:candidates[0].row._patchPath,entries:patchEntries.map(item=>({id:item.id,name:item.name,entry:item.entry}))});
      if(!entry)entry=patchEntries[0].entry;
    }
  }
  for(const row of rows){
    if(row.name==='@deepseek-ai/dsh-web'&&object(row.config)&&!dynamic(row.config))serviceConfig.web=row.config;
    if(row.name===pkg.name&&row.config!==undefined){
      if(!object(row.config)||dynamic(row.config))issues.push({code:'DEFAULT_CONFIG_DYNAMIC',message:`${row._patchPath}: 插件預設設定含有未知動態值或不是物件，未移植`});
      else defaultConfig=row.config;
    }
    if(row.name==='@deepseek-ai/dsh-mcp-client'){
      const name=typeof row.config?.serverName==='string'?row.config.serverName:row.id??'mcp';
      const server=normalizeMcp(row.config,{name,file:row._patchPath,issues,dsh:true});
      if(server){if(Object.hasOwn(mcpServers,name))issues.push({code:'MCP_DUPLICATE_SERVER',message:`重複 MCP 伺服器名稱 ${name}，未覆寫既有連線`});else{mcpServers[name]=server;evidence.push({kind:'declared-mcp',path:row._patchPath,name});}}
    }
  }
  for(const name of ['.mcp.json','mcp.json']) {
    const file=path.join(packageRoot,name);if(!(await exists(file)))continue;
    try{const data=JSON.parse(await fs.readFile(file,'utf8'));if(!object(data.mcpServers))throw new Error('mcpServers 必須是物件');for(const [key,raw]of Object.entries(data.mcpServers)){const config=normalizeMcp(raw,{name:key,file:name,issues});if(config){if(Object.hasOwn(mcpServers,key))issues.push({code:'MCP_DUPLICATE_SERVER',message:`重複 MCP 伺服器名稱 ${key}，未覆寫既有連線`});else{mcpServers[key]=config;evidence.push({kind:'declared-mcp',path:name,name:key});}}}}
    catch(e){issues.push({code:'MCP_JSON',message:e.message});}
  }
  if(packageRoot!==path.resolve(root))for(const server of Object.values(mcpServers))if(server.command&&typeof(server.cwd??'.')==='string'&&!path.isAbsolute(server.cwd??'.')&&!path.win32.isAbsolute(server.cwd??'.')){
    const resolved=path.resolve(packageRoot,server.cwd??'.');
    // Preserve package-relative command paths while retaining siblings in the repository.
    if(inside(root,resolved))server.cwd=relative(resolved)||'.';
    else server.cwd=resolved;
  }
  // Repository files are candidates only. Runtime claims follow the declared
  // entry's local import/re-export graph, excluding TypeScript type-only edges.
  const byFile=new Map(js.map(item=>[path.resolve(root,item.path),item]));
  const reached=new Set(),activeJs=[];
  const resolveImport=async (specifier,from)=>{
    const raw=path.resolve(path.dirname(from),specifier);
    if(!inside(root,raw)){issues.push({code:'LOCAL_IMPORT_ESCAPE',message:`${relative(from)}: 本機匯入超出來源資料夾：${specifier}`});return null;}
    const candidates=[raw];
    if(/\.[cm]?jsx?$/.test(raw)){
      const stem=raw.replace(/\.[^.]+$/,'');
      const replacement=raw.endsWith('.mjs')?['.mts','.ts']:raw.endsWith('.cjs')?['.cts','.ts']:['.ts','.tsx'];
      candidates.push(...replacement.map(ext=>stem+ext));
    }
    if(!path.extname(raw))candidates.push(...['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'].map(ext=>raw+ext));
    candidates.push(...['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'].map(ext=>path.join(raw,'index'+ext)));
    for(const file of candidates)if(byFile.has(file)||skippedJs.has(path.resolve(file)))return file;
    if(!await exists(raw))issues.push({code:'LOCAL_IMPORT_MISSING',message:`${relative(from)}: 找不到本機匯入 ${specifier}`});
    return null;
  };
  const visitFile=async file=>{
    if(reached.has(file))return;reached.add(file);
    const item=byFile.get(file);if(!item){if(skippedJs.has(file))issues.push({code:'JS_ANALYSIS_LIMIT',path:relative(file),bytes:skippedJs.get(file),message:`入口可達的 JavaScript/TypeScript 檔案 ${relative(file)} 超過單檔 8 MiB 分析上限；尚未分析，不能視為沒有工具或宿主功能`});return;}
    activeJs.push(item);
    for(const unknown of item.dynamicImports)issues.push({code:'DYNAMIC_IMPORT',message:`${item.path}:${unknown.line}: 動態匯入路徑不能靜態確認，未當作已載入依賴`,path:item.path,line:unknown.line});
    for(const specifier of item.imports)if(specifier.startsWith('.')||path.isAbsolute(specifier)){const dependency=await resolveImport(specifier,file);if(dependency)await visitFile(dependency);}
  };
  if(entry)await visitFile(path.resolve(root,entry));
  for(const item of patchEntries)await visitFile(path.resolve(root,item.entry));
  const toolTimeouts=activeJs.flatMap(s=>s.toolTimeouts.map(item=>({path:s.path,...item})));
  const services=[...new Set(activeJs.flatMap(s=>s.services))];
  const commands={definitions:activeJs.flatMap(s=>s.commands.map(item=>({path:s.path,...item}))),dynamicRegistrations:activeJs.flatMap(s=>s.dynamicCommands.map(item=>({path:s.path,...item})))};
  for(const item of commands.dynamicRegistrations)issues.push({code:'COMMAND_DYNAMIC_NAME',path:item.path,line:item.line,message:'入口可達程式註冊動態命令名稱；需宿主啟動後列舉，無法靜態產生逐命令技能'});
  // Names read by `!!js process.env.X` config values of the mounted entries are forwarded like names the code reads.
  const patchEnvNames=patchEntries.flatMap(item=>{const names=[];const walk=value=>{if(Array.isArray(value))value.forEach(walk);else if(object(value)){if(typeof value.$dshExpression==='string')names.push(...expressionEnvNames(value.$dshExpression));else Object.values(value).forEach(walk);}};walk(item.config);return names;});
  const environment={requiredNames:[...new Set([...activeJs.flatMap(s=>s.environmentNames),...patchEnvNames])].sort(),sourceExecuted:false};
  const homeEvidence=activeJs.flatMap(s=>s.homeAccess.map(item=>({path:s.path,...item})));
  const homeAccess={detected:homeEvidence.length>0,evidence:homeEvidence,sourceExecuted:false};
  const contextApi=activeJs.flatMap(s=>s.contextApi.map(item=>({path:s.path,...item})));
  const uncertainServices=activeJs.flatMap(s=>s.uncertainServices.map(item=>({path:s.path,...item})));
  const behaviors=activeJs.flatMap(s=>(s.behaviors??[]).map(item=>({path:s.path,...item})));
  const chatEvents=activeJs.flatMap(s=>(s.chatEvents??[]).map(item=>({path:s.path,...item})));
  let frontend=null;
  try{frontend=await discoverPluginUi({sourceRoot:root,packageDir:relative(packageRoot)||'.'});}
  catch(cause){issues.push({code:'UI_DISCOVERY',message:'原畫面檔案無法準備：'+cause.message});}
  const client=Boolean(pkg.dsh?.client)||Boolean(frontend);
  const registrations=activeJs.reduce((n,s)=>n+s.registrations,0);
  if(client)issues.push({code:'NATIVE_UI',message:frontend?'原畫面可在獨立網頁承載；所需服務與實際操作仍須驗證，不修改 Claude Code 聊天外觀。':'來源宣告 DSH 畫面，但找不到可載入的前端檔案；其餘功能照常轉換。'});
  const hostFeatures=services.filter(s=>!['tools','logger','effect'].includes(s));
  if(hostFeatures.length)issues.push({code:'HOST_SERVICES',message:`需要 DSH 宿主服務：${hostFeatures.join(', ')}`});
  if(activeJs.some(s=>s.calls.some(c=>['setInterval','setTimeout'].includes(c.feature))))issues.push({code:'SCHEDULER',message:'入口可達程式含計時器或延遲註冊；檢查與轉換不執行來源。啟動官方宿主引擎時會執行原初始化及計時器，須先審查設定'});
  const manifestFile=path.join(packageRoot,'skills.manifest.json');
  if(await exists(manifestFile))try{const m=JSON.parse(await fs.readFile(manifestFile,'utf8'));if(!Array.isArray(m.default)||!m.default.every(n=>typeof n==='string'))throw new Error('技能清單 default 必須是名稱字串陣列');const enabled=new Set(m.default);for(const name of enabled)if(!skilled.some(skill=>skill.name===name))issues.push({code:'SKILL_MANIFEST_MISSING',message:`技能清單選取不存在的技能：${name}`});for(let i=skilled.length-1;i>=0;i--)if(!enabled.has(skilled[i].name))skilled.splice(i,1);evidence.push({kind:'skill-default-manifest',path:'skills.manifest.json',selected:[...enabled]});}catch(e){issues.push({code:'SKILL_MANIFEST',message:e.message});skilled.splice(0);}
  const hostRuntime=entry&&(registrations||hostFeatures.length||behaviors.length||contextApi.some(item=>['inject','plugin','provide','get','on','once','effect','emit','parallel','serial','bail','waterfall'].includes(item.name)))?{entry,services:hostFeatures,status:'candidate-not-executed'}:null;
  const runtimeCompatibility=await checkRuntimeVersions(pkg);
  const hasRoute=skilled.length||Object.keys(mcpServers).length||pythonServers.length||hostRuntime||frontend;
  return {schemaVersion:1,source:{origin:source.origin??root,commit:source.commit??null},name:pkg.name??path.basename(root),description:pkg.description??'',version:pkg.version??null,license:pkg.license??null,defaultConfig,serviceConfig,runtimeCompatibility,environment,homeAccess,
    root,packageDir:relative(packageRoot)||'.',entry:entry??null,...(patchEntries.length?{entries:patchEntries}:{}),patch:patch??null,capabilities:{skills:skilled,commands,toolTimeouts,mcpServers,pythonServers,hostRuntime,toolRuntime:entry&&registrations?{entry,registrations,tools:[...new Map(activeJs.flatMap(s=>s.tools).map(t=>[t.name,t])).values()]}:null},host:{client,frontend,services,features:hostFeatures,contextApi,uncertainServices,behaviors,chatEvents},evidence,issues,convertible:Boolean(hasRoute),status:hasRoute?(issues.length?'partial':'candidate'):'unsupported'};
}
