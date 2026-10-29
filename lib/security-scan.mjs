// 安全掃描：固定規則，不呼叫模型、不執行來源。掃插件原始碼（不含 node_modules），每項附檔案與行號。
// 結果是「地圖」，標出值得人（或審查的子代理）去讀的位置；它不證明插件安全，也不證明插件惡意。
// 只記名稱與位置，不記金鑰的值：程式片段會先把像金鑰的字串換成 [已遮蔽]。
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import {expressionEnvNames} from './compat/dsh-expression.mjs';

export const SECURITY_SCAN_SCHEMA_VERSION=1;
const JS_FILE=/\.(?:[cm]?jsx?|[cm]?tsx?)$/i;
const TYPES_FILE=/\.d\.[cm]?ts$/i;
const MAX_FILES=20000,MAX_AST_BYTES=6*1024*1024,MAX_TEXT_BYTES=24*1024*1024,MAX_ROWS=3000;
const SKIP_DIRS=new Set(['.git','.hg','.svn','__pycache__','.venv','venv','.pytest_cache','.cache','.npm']);
const OTHER_LANGUAGES={'.py':'Python','.pyw':'Python','.sh':'Shell','.bash':'Shell','.zsh':'Shell','.fish':'Shell','.ps1':'PowerShell','.psm1':'PowerShell','.bat':'Windows 批次檔','.cmd':'Windows 批次檔','.vbs':'VBScript','.rb':'Ruby','.go':'Go','.rs':'Rust','.java':'Java','.kt':'Kotlin','.php':'PHP','.pl':'Perl','.lua':'Lua','.r':'R','.swift':'Swift','.c':'C','.cc':'C++','.cpp':'C++','.cs':'C#','.applescript':'AppleScript'};
const BINARY_EXT=new Set(['.exe','.dll','.so','.dylib','.node','.wasm','.jar','.msi','.bin','.pyd','.com','.scr','.apk','.dmg','.pkg','.deb','.rpm']);

// ---------- 小工具 ----------
const posix=p=>p.split(path.sep).join('/');
const clip=(text,max=160)=>{const value=String(text).replace(/\s+/g,' ').trim();return value.length>max?value.slice(0,max-1)+'…':value;};
const KNOWN_TOKEN=/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;
/** 把程式片段中像金鑰的字串換成 [已遮蔽]：已知格式，以及 24 字以上、同時有字母和數字、沒有空白的字串字面值。 */
export function redactSnippet(text){
  return String(text).replace(KNOWN_TOKEN,'[已遮蔽]').replace(/(["'`])([A-Za-z0-9+/_.=-]{24,})\1/g,(all,q,body)=>/[A-Za-z]/.test(body)&&/\d/.test(body)&&!/^(?:https?|wss?):|\//.test(body)&&!/^[A-Z][A-Z0-9_]+$/.test(body)?q+'[已遮蔽]'+q:all);
}
/** 看起來像金鑰的值（用在 --config 的檢查與寫死的字串）。不回傳值本身。 */
export function looksLikeSecretValue(value){
  if(typeof value!=='string')return false;
  const text=value.trim();
  if(text.length<12||/\s/.test(text))return false;
  KNOWN_TOKEN.lastIndex=0;if(KNOWN_TOKEN.test(text)){KNOWN_TOKEN.lastIndex=0;return true;}
  KNOWN_TOKEN.lastIndex=0;
  if(/^(?:https?|wss?|file):/i.test(text)||/^[A-Z][A-Z0-9_]*$/.test(text)||/[\\/]/.test(text)&&!/^[A-Za-z0-9+/=]+$/.test(text))return false;
  if(/^[a-z0-9]+(?:[.:_\/-][a-z0-9]+)+$/.test(text)&&!/\d{6,}|[a-z0-9]{20,}/.test(text))return false; // dsh-auto-memory.presentation.v1 之類的命名
  return text.length>=24&&/[A-Za-z]/.test(text)&&/\d/.test(text)&&/^[A-Za-z0-9+/_.=:-]+$/.test(text);
}

// 名稱切成小寫詞：TAVILY_API_KEY → tavily api key；sendMessage → send message。
export function nameTokens(name){
  return String(name??'').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const SECRET_TOKENS=new Set(['key','apikey','token','secret','password','passwd','pwd','credential','credentials','cookie','cookies','sessdata','bearer','privatekey','accesskey','secretkey','passphrase','jwt']);
const NOT_SECRET_SUFFIX=new Set(['url','uri','endpoint','host','port','model','timeout','dir','path','file','name','env','var','ref','field','header','label','hint','placeholder','title','description','prompt','id','type','limit','count','prefix','mode','enabled','base','version','region','secure','debug','stream','proxy','ttl','days','flag','style','storage','cache','length','size','format','algorithm','alg']);
/** 名稱看起來是金鑰（環境變數名稱或設定欄位名稱）。PWD／OLDPWD、MAX_TOKENS、KEYWORDS、*_URL 之類不算。 */
export function isSecretName(name){
  const tokens=nameTokens(name);
  if(!tokens.length)return false;
  if(['PWD','OLDPWD'].includes(String(name)))return false;
  if(NOT_SECRET_SUFFIX.has(tokens.at(-1)))return false;
  return tokens.some(token=>SECRET_TOKENS.has(token));
}

const unwrap=node=>{while(node&&(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node)||ts.isTypeAssertionExpression(node)||ts.isAwaitExpression(node)||(ts.isSatisfiesExpression?.(node))))node=node.expression;return node;};
const moduleName=spec=>String(spec).replace(/^node:/,'');

// ---------- 規則表 ----------
const PROCESS_MEMBERS=new Set(['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']);
const SHELL_STRING_MEMBERS=new Set(['exec','execSync']);
const PROCESS_PACKAGES=new Set(['execa','cross-spawn','node-pty','shelljs','zx','tinyexec','nano-spawn','@expo/spawn-async']);
const FS_MODULES=new Set(['fs','fs/promises','fs-extra','graceful-fs','original-fs','fs-extra/esm']);
const FS_READ=new Set(['readFile','readFileSync','createReadStream','readdir','readdirSync','opendir','opendirSync','readJson','readJsonSync','readJSON','readlink','readlinkSync','open','openSync','watch','watchFile']);
const FS_WRITE=new Set(['writeFile','writeFileSync','appendFile','appendFileSync','createWriteStream','mkdir','mkdirSync','mkdtemp','mkdtempSync','rename','renameSync','copyFile','copyFileSync','cp','cpSync','symlink','symlinkSync','link','linkSync','chmod','chmodSync','chown','chownSync','truncate','truncateSync','utimes','utimesSync','outputFile','outputFileSync','outputJson','outputJsonSync','writeJson','writeJsonSync','writeJSON','ensureDir','ensureDirSync','ensureFile','mkdirs','mkdirp','copy','copySync','move','moveSync']);
const FS_DELETE=new Set(['rm','rmSync','rmdir','rmdirSync','unlink','unlinkSync','remove','removeSync','emptyDir','emptyDirSync']);
const NET_MODULE_MEMBERS={http:['request','get','createServer'],https:['request','get','createServer'],http2:['connect','createServer','createSecureServer'],net:['connect','createConnection','createServer','Socket'],tls:['connect','createServer'],dgram:['createSocket'],undici:['request','fetch','stream','connect','Agent','Client','Pool','WebSocket'],dns:['lookup','resolve']};
const NET_PACKAGES=new Set(['axios','got','node-fetch','ky','superagent','cross-fetch','isomorphic-fetch','ws','socket.io-client','request','needle','phin','make-fetch-happen','eventsource','undici','@slack/web-api','nodemailer','telegraf','node-telegram-bot-api','discord.js','openai','@anthropic-ai/sdk','agentmail','resend','twilio','@sendgrid/mail','googleapis','@octokit/rest','octokit','@octokit/core','grammy','wechaty','@larksuiteoapi/node-sdk','tencentcloud-sdk-nodejs','cos-nodejs-sdk-v5','ali-oss','@aws-sdk/client-s3','aws-sdk','mysql2','pg','mongodb','redis','ioredis','imapflow','smtp-server','puppeteer','puppeteer-core','playwright','playwright-core']);
const NET_GLOBAL_CALLS=new Set(['fetch']);
const NET_GLOBAL_NEW=new Set(['WebSocket','EventSource','XMLHttpRequest']);
const HOME_ENV=/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|XDG_[A-Z_]+)$/;

// ---------- 對外發文判斷 ----------
const READ_TOKENS=new Set(['draft','drafts','search','list','get','read','fetch','query','check','status','find','view','show','count','preview','lookup','load','info','history','whoami','login','logout','poll','config','configure','setup','settings','inbox','unread','received','stats','describe','download','parse','summarize','summary','analyze','translate','validate','verify','debug','health','schema','browse','scan','export','inspect','retrieve','watch','monitor','detail','details','meta','metadata','subtitle','subtitles','transcript','search','recent','latest','top','trending','rank','hot','feed','profile','help','guide','doc','docs','template','templates','format','render','preview','estimate','calc','calculate']);
const NOT_OUTBOUND_TOKENS=new Set(['ack','acknowledge','mark','archive','delete','remove','cancel','unschedule','clear','mute','unsubscribe','block','annotate']);
const OUTBOUND_TOKENS=new Set(['reply','comment','send','post','publish','tweet','retweet','repost','message','email','mail','dm','sms','forward','broadcast','announce','toot','mention']);
const CREATE_TOKENS=new Set(['create','open','new','submit','add']);
const PUBLIC_OBJECT_TOKENS=new Set(['issue','pr','pull','discussion','thread','status','note','story','article','review','tweet','post','comment','reply']);
const OUT_DESC=/(?:发|發)(?:表|送|布|佈|帖|评论|評論|私信|消息|訊息|邮件|郵件|弹幕|彈幕|动态|動態|微博|推文|帖子|文章|出)|寄(?:信|出|送|邮件|郵件)|留言|(?:回复|回覆)(?:评论|評論|消息|訊息|私信|邮件|郵件|他|她|对方|對方|某条|某條)|私信(?:给|給)|推送(?:到|给|給)|\b(?:send|sends|sending|post|posts|publish|publishes|tweet|tweets|reply to|replies to|comment on|comments on|email|emails|e-mail)\b/i;
const NOT_OUT_DESC=/\bsend(?:s|ing)?\s+in\b|\bsend(?:s|ing)?\s+(?:a\s+|an\s+|the\s+)?(?:http|https|api|request|query|prompt|command|keys?|keystrokes?|signal|input|ping|heartbeat|text to the model)\b|\bpost(?:s)?\s+(?:a\s+|an\s+|the\s+)?(?:request|query|json|data to (?:the )?(?:api|server|endpoint))|\bpost-?process|\bpostgres/i;
const READ_DESC_START=/^\s*(?:[`*_#>\s]*)(?:get|gets|list|lists|search|searches|read|reads|fetch|fetches|query|queries|look up|looks up|retrieve|retrieves|show|shows|view|views|check|checks|return|returns|取|获取|獲取|查|搜|读|讀|看|列|拉取|检索|檢索|抓取|下载|下載)/i;
const TARGET_FIELD=/^(?:to|cc|bcc|recipient|recipients|receiver|receivers|receiver_?uid|receiver_?id|uid|mid|user|user_?id|username|chat|chat_?id|channel|channel_?id|room|room_?id|group|group_?id|thread|thread_?id|conversation|conversation_?id|bvid|aid|oid|avid|rpid|root|parent|parent_?id|post_?id|tweet_?id|status_?id|reply_?to|in_?reply_?to|target|address|email|phone|webhook|webhook_?url|repo|repository|owner|issue|issue_?number|pr|pull_?number|inbox|inbox_?id|message_?id|dynamic_?id|video|video_?id|guild|guild_?id)$/i;
const TEXT_FIELD=/^(?:text|content|body|message|msg|comment|reply|subject|title|html|markdown|md|caption|status|note|description|summary)$/i;

/** 判斷一個工具是否「用使用者的名義把內容送給別人或公開出去」。純函式，依名稱、描述、參數名稱。 */
export function classifyOutbound({name,description='',parameters=[]}){
  const tokens=nameTokens(name);
  const text=String(description??'');
  // 只看描述的第一個子句：發送動詞在後面的子句（例如「使用者可以在那裡回覆」）不算。
  const firstSentence=(text.split(/[\n。！!？?]|\.\s/)[0]??'').split(/[，,：:（(;；]|\s[—-]\s/)[0]??'';
  const fields=pickFields(parameters);
  const verdict=(outbound,reason,confidence)=>({outbound,reason,confidence,kind:outbound?outboundKind(name,text):null,...(outbound?fields:{targetFields:[],textFields:[]})});
  const readToken=tokens.find(token=>READ_TOKENS.has(token)||NOT_OUTBOUND_TOKENS.has(token));
  // send_draft／publish_draft：寄出草稿本身就是發送，不因為有 draft 而排除。
  const sendVerb=tokens.find(token=>['send','publish','post','tweet'].includes(token));
  if(sendVerb&&['draft','drafts'].includes(readToken)&&tokens.every(token=>token===readToken||!READ_TOKENS.has(token)&&!NOT_OUTBOUND_TOKENS.has(token)))return verdict(true,`名稱含發送類字詞「${sendVerb}」（寄出草稿）`,'name');
  if(readToken)return verdict(false,`名稱含讀取類字詞「${readToken}」`,'name');
  const outToken=tokens.find(token=>OUTBOUND_TOKENS.has(token));
  if(outToken)return verdict(true,`名稱含發送類字詞「${outToken}」`,'name');
  const create=tokens.find(token=>CREATE_TOKENS.has(token)),object=tokens.find(token=>PUBLIC_OBJECT_TOKENS.has(token));
  if(create&&object)return verdict(true,`名稱是「${create} ${object}」（建立公開內容）`,'name');
  const descMatch=firstSentence.match(OUT_DESC);
  if(descMatch&&descMatch[0]!=='POST'&&!READ_DESC_START.test(firstSentence)&&!NOT_OUT_DESC.test(firstSentence))return verdict(true,`描述第一句含發送類字詞「${clip(firstSentence.match(OUT_DESC)[0],20)}」`,'description');
  return verdict(false,'名稱與描述沒有發送類字詞','none');
}
function outboundKind(name,description){
  return kindOf(nameTokens(name).join(' '),true)??kindOf(String(description).slice(0,300))??'other';
}
function kindOf(text,isName=false){
  if(isName&&/mail/.test(text))return 'email';
  if(isName&&/\b(?:message|messages|dm|sms|chat)\b/.test(text))return 'message';
  if(/\b(?:e-?mail|mail|smtp|inbox)\b|邮件|郵件|寄信/i.test(text))return 'email';
  if(/\b(?:comment|comments|reply|replies|danmaku)\b|评论|評論|留言|回复|回覆|弹幕|彈幕/i.test(text))return 'comment';
  if(/\b(?:message|messages|dm|sms|chat|im|wecom|wechat|telegram|slack|discord|feishu|lark|dingtalk|whatsapp|signal)\b|私信|消息|訊息|企业微信|企業微信|飞书|飛書|钉钉|釘釘/i.test(text))return 'message';
  if(/\b(?:post|posts|publish|tweet|toot|status|issue|pr|article|story)\b|发布|發布|动态|動態|微博|推文|帖子/i.test(text))return 'post';
  return null;
}
function pickFields(parameters){
  const names=(parameters??[]).filter(item=>typeof item==='string');
  const textFields=names.filter(item=>TEXT_FIELD.test(item));
  const targetFields=names.filter(item=>!textFields.includes(item)&&TARGET_FIELD.test(item));
  return {targetFields,textFields};
}

// ---------- 混淆判斷 ----------
/** 純統計：_0x 識別字比例、十六進位跳脫字元密度、常見混淆器的固定寫法；只有「很長的行」算壓縮（minified），不算混淆。 */
export function obfuscationMetrics(text){
  const lines=text.split(/\r?\n/);
  let maxLine=0;for(const line of lines)if(line.length>maxLine)maxLine=line.length;
  const identifiers=text.match(/\b[A-Za-z_$][\w$]*\b/g)??[];
  const hexIdentifiers=identifiers.filter(item=>/^_0x[0-9a-f]{3,}$/i.test(item));
  const hexEscapes=(text.match(/\\x[0-9a-fA-F]{2}/g)??[]).length;
  const hexStringArrays=(text.match(/\[\s*(?:(['"])(?:\\x[0-9a-fA-F]{2}){2,}\1\s*,\s*){8,}/g)??[]).length;
  const markers=[];
  if(/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)/.test(text))markers.push('packer（eval(function(p,a,c,k,e,d)）');
  if(/while\s*\(\s*!!\s*\[\s*\]\s*\)/.test(text)&&hexIdentifiers.length>=5)markers.push('javascript-obfuscator 的 while(!![]) 迴圈');
  if(/\[\s*\]\s*\[\s*\(\s*!\s*\[\s*\]\s*\+\s*\[\s*\]\s*\)/.test(text))markers.push('JSFuck 寫法');
  if(/\beval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/.test(text))markers.push('eval(解碼後的字串)');
  if(/\b(?:new\s+)?Function\s*\(\s*(?:atob|Buffer\.from|unescape)\s*\(/.test(text))markers.push('Function(解碼後的字串)');
  const longBase64=(text.match(/(['"`])[A-Za-z0-9+/]{2000,}={0,2}\1/g)??[]).length;
  return {bytes:text.length,lines:lines.length,maxLineLength:maxLine,averageLineLength:Math.round(text.length/Math.max(1,lines.length)),identifiers:identifiers.length,hexIdentifiers:hexIdentifiers.length,hexIdentifierRatio:identifiers.length?Number((hexIdentifiers.length/identifiers.length).toFixed(3)):0,hexEscapes,hexEscapeDensity:Number((hexEscapes*4/Math.max(1,text.length)).toFixed(3)),hexStringArrays,longBase64Strings:longBase64,markers};
}
export function judgeObfuscation(metrics){
  const reasons=[];
  if(metrics.hexIdentifiers>=20&&metrics.hexIdentifierRatio>=0.15)reasons.push(`識別字有 ${metrics.hexIdentifiers} 個是 _0x 形式（占 ${(metrics.hexIdentifierRatio*100).toFixed(0)}%）`);
  if(metrics.hexEscapes>=300&&metrics.hexEscapeDensity>=0.15)reasons.push(`十六進位跳脫字元（\\x..）有 ${metrics.hexEscapes} 個，占檔案 ${(metrics.hexEscapeDensity*100).toFixed(0)}%`);
  if(metrics.hexStringArrays>=1&&metrics.hexIdentifiers>=5)reasons.push('有整串十六進位編碼的字串陣列');
  reasons.push(...metrics.markers.map(item=>'常見混淆寫法：'+item));
  const minified=metrics.maxLineLength>=5000||metrics.averageLineLength>=400&&metrics.bytes>=20000;
  return {obfuscated:reasons.length>0,minified,reasons};
}

// ---------- JavaScript／TypeScript ----------
function scanJs(text,rel){
  const kind=/\.tsx?$|\.[cm]ts$/i.test(rel)?(/x$/i.test(rel)?ts.ScriptKind.TSX:ts.ScriptKind.TS):/x$/i.test(rel)?ts.ScriptKind.JSX:ts.ScriptKind.JS;
  const tree=ts.createSourceFile(rel,text,ts.ScriptTarget.Latest,true,kind);
  const out={processes:[],files:[],network:[],environment:[],wholeEnvironment:[],credentialRefs:[],hardcodedSecrets:[],tools:[],urls:[],homeReferences:[],imports:[]};
  const line=node=>tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1;
  const code=node=>redactSnippet(clip(node.getText(tree)));
  const bindings=new Map(); // 本機名稱 → {module, member}
  const consts=new Map();
  const nodes=[];const walk=node=>{nodes.push(node);ts.forEachChild(node,walk);};walk(tree);
  const requireOf=node=>{node=unwrap(node);if(node&&ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')&&node.arguments[0]&&ts.isStringLiteralLike(node.arguments[0]))return moduleName(node.arguments[0].text);return null;};
  for(const node of nodes){
    if(ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)){
      const mod=moduleName(node.moduleSpecifier.text),clause=node.importClause;out.imports.push(mod);
      if(clause?.isTypeOnly)continue;
      if(clause?.name)bindings.set(clause.name.text,{module:mod,member:'default'});
      if(clause?.namedBindings){if(ts.isNamespaceImport(clause.namedBindings))bindings.set(clause.namedBindings.name.text,{module:mod,member:null});else for(const item of clause.namedBindings.elements)bindings.set(item.name.text,{module:mod,member:(item.propertyName??item.name).text});}
    }
    if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&ts.isStringLiteral(node.moduleReference.expression))bindings.set(node.name.text,{module:moduleName(node.moduleReference.expression.text),member:null});
    if(ts.isVariableDeclaration(node)&&node.initializer){
      const mod=requireOf(node.initializer);
      if(mod){out.imports.push(mod);if(ts.isIdentifier(node.name))bindings.set(node.name.text,{module:mod,member:null});else if(ts.isObjectBindingPattern(node.name))for(const item of node.name.elements)if(ts.isIdentifier(item.name))bindings.set(item.name.text,{module:mod,member:item.propertyName&&!ts.isComputedPropertyName(item.propertyName)?item.propertyName.text:item.name.text});}
      else{
        const init=unwrap(node.initializer);
        // const cp = require('child_process').spawn / const {promises: fsp} = fs
        if(ts.isIdentifier(node.name)&&init&&ts.isPropertyAccessExpression(init)){const base=resolveObject(init.expression);if(base)bindings.set(node.name.text,{module:base.module,member:base.member&&base.member!=='default'?base.member+'.'+init.name.text:init.name.text});}
        if(ts.isObjectBindingPattern(node.name)&&init&&ts.isIdentifier(init)&&bindings.has(init.text)){const base=bindings.get(init.text);for(const item of node.name.elements)if(ts.isIdentifier(item.name))bindings.set(item.name.text,{module:base.module,member:item.propertyName&&!ts.isComputedPropertyName(item.propertyName)?item.propertyName.text:item.name.text});}
        if(ts.isIdentifier(node.name)&&!consts.has(node.name.text)&&(node.parent.flags&ts.NodeFlags.Const))consts.set(node.name.text,node.initializer);
      }
    }
  }
  // 同一個名稱在檔案裡宣告超過一次（參數、迴圈變數、不同函式裡的同名常數）就不展開，避免拿錯值。
  const declared=new Map();
  const declare=name=>{if(name&&ts.isIdentifier(name))declared.set(name.text,(declared.get(name.text)??0)+1);else if(name&&(ts.isObjectBindingPattern(name)||ts.isArrayBindingPattern(name)))for(const item of name.elements)if(!ts.isOmittedExpression(item))declare(item.name);};
  for(const node of nodes)if(ts.isVariableDeclaration(node)||ts.isParameter(node)||ts.isBindingElement(node)&&false||ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))declare(node.name);
  for(const [name]of consts)if((declared.get(name)??0)!==1)consts.delete(name);
  function resolveObject(expr){
    expr=unwrap(expr);
    if(!expr)return null;
    const mod=requireOf(expr);if(mod)return {module:mod,member:null};
    if(ts.isIdentifier(expr))return bindings.get(expr.text)??null;
    if(ts.isPropertyAccessExpression(expr)){const base=resolveObject(expr.expression);if(base&&(base.member===null||base.member==='default'))return {module:base.module,member:expr.name.text};}
    return null;
  }
  const staticString=(node,depth=0)=>{
    node=unwrap(node);
    if(!node||depth>4)return null;
    if(ts.isStringLiteralLike(node))return node.text;
    if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(span=>'${…}'+span.literal.text).join('');
    if(ts.isBinaryExpression(node)){
      const op=node.operatorToken.kind;
      if(op===ts.SyntaxKind.PlusToken){const left=staticString(node.left,depth+1),right=staticString(node.right,depth+1);if(left===null&&right===null)return null;return (left??'${…}')+(right??'${…}');}
      if(op===ts.SyntaxKind.BarBarToken||op===ts.SyntaxKind.QuestionQuestionToken)return staticString(node.left,depth+1)??staticString(node.right,depth+1);
    }
    if(ts.isConditionalExpression(node)){const a=staticString(node.whenTrue,depth+1),b=staticString(node.whenFalse,depth+1);return a&&b&&a!==b?a+'|'+b:a??b;}
    if(ts.isIdentifier(node)&&consts.has(node.text))return staticString(consts.get(node.text),depth+1);
    if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='String'&&node.arguments[0])return staticString(node.arguments[0],depth+1);
    if(ts.isPropertyAccessExpression(node)&&node.getText(tree)==='process.execPath')return 'node';
    return null;
  };
  // 檔案路徑的證據：把參數的文字連同一層常數展開，給旗標判斷用。
  const evidenceText=(node,depth=0)=>{
    node=unwrap(node);if(!node)return '';
    let text=node.getText(tree);
    if(depth<3)for(const id of collectIdentifiers(node))if(consts.has(id))text+=' '+evidenceText(consts.get(id),depth+1);
    return text;
  };
  const collectIdentifiers=node=>{const names=new Set();const visit=n=>{if(ts.isIdentifier(n))names.add(n.text);ts.forEachChild(n,visit);};visit(node);return names;};
  const pathFlags=(node,access)=>{
    const text=evidenceText(node),flags=[];
    if(/(['"`])(?:[A-Za-z]:[\\/]|\\\\\\\\|\/(?!\/)[A-Za-z._~-])/.test(text))flags.push('absolute');
    if(/homedir\s*\(|process\.env\.(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)|env\[\s*['"](?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA)['"]\s*\]|(['"`])~[\\/]/.test(text))flags.push('home');
    if(/(['"`])\.\.(?:[\\/]|\1)|[\\/]\.\.(?:[\\/]|['"`])/.test(text))flags.push('parent');
    if(access==='write'||access==='delete')flags.push(access);
    return flags;
  };
  const programName=raw=>{
    if(raw===null||raw===undefined)return null;
    let token=String(raw).trim();
    if(token.includes('|')&&!/\s/.test(token))return token.split('|').map(item=>programName(item)).filter(Boolean).join('|')||null;
    token=token.replace(/^["']/,'').split(/\s+/)[0].replace(/["']$/,'');
    token=token.split('${…}')[0];
    const base=token.split(/[\\/]/).pop()??'';
    const name=base.replace(/\.(?:exe|cmd|bat|com)$/i,'');
    return name||null;
  };
  const urlDomain=raw=>{if(typeof raw!=='string')return null;const match=raw.match(/^\s*(?:https?|wss?):\/\/([^/?#'"`\s$]+)/i);return match?match[1].toLowerCase().replace(/^[^@]*@/,'').replace(/:\d+$/,''):null;};
  const addProcess=(node,api,args,{shellString=false}={})=>{
    const first=args?.[0];
    const raw=first?staticString(first):null;
    let program=programName(raw);
    if(api.endsWith('fork'))program='node';
    out.processes.push({line:line(node),api,program,...(program?{}:{expression:first?clip(first.getText(tree),80):null}),...(shellString?{shell:true}:{}),...(raw&&shellString?{command:redactSnippet(clip(raw,120))}:{}),code:code(node)});
  };
  const addNetwork=(node,api,args)=>{
    const raw=args?.[0]?staticString(args[0]):null;
    const domain=urlDomain(raw);
    out.network.push({line:line(node),api,domain,...(raw&&domain?{url:redactSnippet(clip(raw.replace(/\?.*$/,'?…'),120))}:{}),code:code(node)});
  };
  const fsAccess=member=>FS_WRITE.has(member)?'write':FS_DELETE.has(member)?'delete':FS_READ.has(member)?'read':null;
  const addFile=(node,api,member,args)=>{
    const access=fsAccess(member);if(!access)return;
    const target=args?.[0];
    out.files.push({line:line(node),api,access,flags:target?pathFlags(target,access):[access].filter(x=>x!=='read'),target:target?redactSnippet(clip(target.getText(tree),100)):null,code:code(node)});
  };
  const enclosingToolCall=node=>{for(let p=node.parent,depth=0;p&&depth<6;p=p.parent,depth++)if(ts.isCallExpression(p)){const callee=p.expression.getText(tree);if(/(?:^|\.)(?:commands?)\.(?:register|add)$|registerCommand$|(?:^|\.)command$/.test(callee))return 'command';return 'call';}return null;};
  const propOf=(obj,name)=>obj.properties.find(p=>(ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p)||ts.isMethodDeclaration(p))&&p.name&&!ts.isComputedPropertyName(p.name)&&p.name.text===name);
  const propValue=p=>p?ts.isPropertyAssignment(p)?p.initializer:ts.isShorthandPropertyAssignment(p)?p.name:p:null;
  const objectKeys=(node,depth=0)=>{
    node=unwrap(node);if(!node||depth>3)return [];
    if(ts.isIdentifier(node)&&consts.has(node.text))return objectKeys(consts.get(node.text),depth+1);
    if(ts.isCallExpression(node)){
      // Schema.object({...}) / z.object({...}) / Type.Object({...})
      const callee=node.expression.getText(tree);
      if(/(?:^|\.)(?:object|Object|strictObject|looseObject)$/.test(callee)&&node.arguments[0])return objectKeys(node.arguments[0],depth+1);
      if(ts.isPropertyAccessExpression(node.expression))return objectKeys(node.expression.expression,depth+1); // z.object({...}).strict()
      return [];
    }
    if(ts.isObjectLiteralExpression(node)){
      const props=propOf(node,'properties');
      if(props&&ts.isObjectLiteralExpression(unwrap(propValue(props))??node))return objectKeys(propValue(props),depth+1);
      return node.properties.filter(p=>p.name&&!ts.isComputedPropertyName(p.name)&&(ts.isPropertyAssignment(p)||ts.isShorthandPropertyAssignment(p)||ts.isMethodDeclaration(p))).map(p=>p.name.text);
    }
    return [];
  };
  const isFunctionNode=n=>{n=unwrap(n);return Boolean(n&&(ts.isFunctionExpression(n)||ts.isArrowFunction(n)||ts.isMethodDeclaration(n)||ts.isIdentifier(n)));};
  for(const node of nodes){
    // ---- 環境變數 ----
    if((ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node))){
      const objText=node.expression.getText(tree);
      if(['process.env','Bun.env','import.meta.env','globalThis.process.env'].includes(objText)){
        const name=ts.isPropertyAccessExpression(node)?node.name.text:ts.isStringLiteralLike(node.argumentExpression)?node.argumentExpression.text:null;
        if(name)out.environment.push({line:line(node),name,api:objText});
        else out.environment.push({line:line(node),name:null,api:objText,expression:clip(node.argumentExpression.getText(tree),60)});
        if(name&&HOME_ENV.test(name))out.homeReferences.push({line:line(node),kind:'home-environment',name});
      }
    }
    if(ts.isVariableDeclaration(node)&&node.initializer&&ts.isObjectBindingPattern(node.name)&&['process.env','Bun.env'].includes(unwrap(node.initializer).getText(tree)))
      for(const item of node.name.elements){const name=(item.propertyName&&!ts.isComputedPropertyName(item.propertyName)?item.propertyName:item.name);if(ts.isIdentifier(name)||ts.isStringLiteral(name))out.environment.push({line:line(item),name:name.text,api:'process.env（解構）'});}
    if((ts.isSpreadAssignment(node)||ts.isSpreadElement(node))&&['process.env','Bun.env'].includes(unwrap(node.expression).getText(tree)))out.wholeEnvironment.push({line:line(node),code:code(node.parent??node)});
    if(ts.isPropertyAssignment(node)&&node.name&&!ts.isComputedPropertyName(node.name)&&node.name.text==='env'&&['process.env'].includes(unwrap(node.initializer).getText(tree)))out.wholeEnvironment.push({line:line(node),code:code(node)});
    // ---- 寫死的金鑰（只記名稱與位置） ----
    if((ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)||ts.isPropertyAssignment(node)&&node.name&&!ts.isComputedPropertyName(node.name))&&node.initializer&&ts.isStringLiteralLike(unwrap(node.initializer))){
      const name=node.name.text,value=unwrap(node.initializer).text;
      if(isSecretName(name)&&looksLikeSecretValue(value)&&!/^(?:your|xxx|<|\$\{|placeholder|example|changeme|test)/i.test(value))out.hardcodedSecrets.push({line:line(node),name,length:value.length});
    }
    // ---- 網址字面值（只取網域） ----
    if(ts.isStringLiteralLike(node)||ts.isTemplateHead?.(node)){const domain=urlDomain(node.text);if(domain&&!/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|example\.(?:com|org)|www\.w3\.org|json-schema\.org)$/.test(domain))out.urls.push({line:line(node),domain});}
    // ---- 家目錄 ----
    if(ts.isCallExpression(node)){const callee=node.expression;const resolved=ts.isIdentifier(callee)?bindings.get(callee.text):ts.isPropertyAccessExpression(callee)?(()=>{const base=resolveObject(callee.expression);return base?{module:base.module,member:callee.name.text}:null;})():null;if(resolved?.module==='os'&&resolved.member==='homedir')out.homeReferences.push({line:line(node),kind:'os.homedir'});}
    // ---- 呼叫：開程式、讀寫檔案、連網路、憑證 ----
    if(ts.isCallExpression(node)||ts.isNewExpression(node)){
      const callee=unwrap(node.expression),args=node.arguments??[];
      const isNew=ts.isNewExpression(node);
      let target=null;
      if(ts.isIdentifier(callee))target=bindings.get(callee.text)??{module:null,member:callee.text,global:true};
      else if(ts.isPropertyAccessExpression(callee)){const base=resolveObject(callee.expression);if(base)target={module:base.module,member:base.member&&base.member!=='default'?base.member+'.'+callee.name.text:callee.name.text};else target={module:null,member:callee.name.text,object:callee.expression.getText(tree)};}
      if(target){
        const member=String(target.member??'');
        const last=member.split('.').pop();
        const mod=target.module;
        if(mod==='child_process'&&PROCESS_MEMBERS.has(last))addProcess(node,'child_process.'+last,args,{shellString:SHELL_STRING_MEMBERS.has(last)});
        else if(mod&&PROCESS_PACKAGES.has(mod)&&(['default','execa','execaNode','execaSync','execaCommand','spawn','exec','command','x','$'].includes(last)||target.member===null))addProcess(node,mod+(last&&last!=='default'?'.'+last:''),args,{shellString:/command|exec$/.test(last)&&mod!=='execa'});
        else if(target.object==='Bun'&&['spawn','spawnSync'].includes(last))addProcess(node,'Bun.'+last,ts.isArrayLiteralExpression(unwrap(args[0])??{})?unwrap(args[0]).elements:args.length&&ts.isObjectLiteralExpression(unwrap(args[0]))?[propValue(propOf(unwrap(args[0]),'cmd'))].filter(Boolean).flatMap(x=>ts.isArrayLiteralExpression(unwrap(x))?unwrap(x).elements:[x]):args);
        else if(target.object==='Deno'&&(isNew&&last==='Command'||['run'].includes(last)))addProcess(node,'Deno.'+last,args);
        else if(target.object==='process'&&['dlopen','binding'].includes(last))out.processes.push({line:line(node),api:'process.'+last,program:null,expression:clip(args[0]?.getText(tree)??'',80),code:code(node)});
        else if(mod&&FS_MODULES.has(mod))addFile(node,mod+'.'+member,last,args);
        else if(target.object==='Bun'&&['write','file'].includes(last))addFile(node,'Bun.'+last,last==='write'?'writeFile':'readFile',args);
        else if(target.object==='Deno'&&/^(?:read|write|remove|mkdir|rename|copyFile)/.test(last))addFile(node,'Deno.'+last,/^read/.test(last)?'readFile':/^remove/.test(last)?'rm':'writeFile',args);
        else if(mod&&NET_MODULE_MEMBERS[mod]?.includes(last))addNetwork(node,mod+'.'+last,args);
        else if(mod&&NET_PACKAGES.has(mod)&&mod!=='undici')addNetwork(node,mod+(target.member&&target.member!=='default'?'.'+target.member:''),args);
        else if(!mod&&target.global&&NET_GLOBAL_CALLS.has(member)&&!isNew)addNetwork(node,'fetch',args);
        else if(!mod&&target.global&&isNew&&NET_GLOBAL_NEW.has(member))addNetwork(node,'new '+member,args);
        else if(!mod&&['globalThis','window','self','global'].includes(target.object)&&last==='fetch')addNetwork(node,'fetch',args);
        else if(!mod&&/(?:^|\.)credentials$/.test(target.object??'')&&['resolve','describe'].includes(last)){
          const raw=args[0]?staticString(args[0]):null;
          out.credentialRefs.push({line:line(node),api:'credentials.'+last,name:raw&&/^[A-Za-z0-9_.:/-]+$/.test(raw)?raw:null,...(raw?{}:{expression:clip(args[0]?.getText(tree)??'',80)}),code:code(node)});
        }
        else if(/fetch|request|^(?:get|post|put|patch|del|delete|head|call|send|connect|download|upload)$/i.test(last)&&args[0]&&/^\s*(?:https?|wss?):\/\//i.test(staticString(args[0])??''))addNetwork(node,`${clip(callee.getText(tree),40)}（網址參數）`,args); // 注入的 fetch（this.fetchImpl('https://…')）、自己包的 request
      }
    }
    // Bun.$`cmd` / zx $`cmd`
    if(ts.isTaggedTemplateExpression(node)){
      const tag=node.tag.getText(tree),bound=ts.isIdentifier(node.tag)?bindings.get(node.tag.text):null;
      if(tag==='Bun.$'||bound&&['zx','bun','execa'].includes(bound.module)){const raw=ts.isNoSubstitutionTemplateLiteral(node.template)?node.template.text:node.template.head.text;out.processes.push({line:line(node),api:tag==='Bun.$'?'Bun.$':bound.module+'.$',program:programName(raw),shell:true,code:code(node)});}
    }
    // ---- 工具定義：有 name 且有 execute/handler，或有 description 加 parameters/inputSchema 的物件字面值 ----
    if(ts.isObjectLiteralExpression(node)){
      const nameProp=propOf(node,'name');
      if(nameProp){
        const runner=['execute','handler','run','callback','invoke'].map(key=>propOf(node,key)).find(Boolean);
        const params=['parameters','inputSchema','input_schema','schema','args','argsSchema','input'].map(key=>propOf(node,key)).find(Boolean);
        const descProp=propOf(node,'description');
        if(runner&&isFunctionNode(propValue(runner))&&(params||descProp)||descProp&&params&&!runner&&/(?:^|\.)(?:register|registerTool|defineTool|tool|addTool|createTool)$/.test(node.parent&&ts.isCallExpression(node.parent)?node.parent.expression.getText(tree):'')){
          const toolName=staticString(propValue(nameProp));
          const context=enclosingToolCall(node);
          if(toolName&&context!=='command'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(toolName)){
            const description=descProp?staticString(propValue(descProp))??'':'';
            out.tools.push({line:line(node),name:toolName,description:description.replace(/\$\{…\}/g,'…'),parameters:params?objectKeys(propValue(params)):[],source:'object-spec'});
          }
        }
      }
    }
    // server.tool('name','desc',schema,handler) / server.registerTool('name',{description,inputSchema},handler)
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['tool','registerTool'].includes(node.expression.name.text)&&node.arguments.length>=2&&ts.isStringLiteralLike(node.arguments[0])&&node.arguments.some(arg=>{arg=unwrap(arg);return arg&&(ts.isArrowFunction(arg)||ts.isFunctionExpression(arg));})){
      let description='',parameters=[];
      for(const arg of node.arguments.slice(1)){const value=unwrap(arg);if(!value)continue;if(ts.isStringLiteralLike(value)&&!description)description=value.text;else if(ts.isObjectLiteralExpression(value)){const d=propOf(value,'description');if(d&&!description)description=staticString(propValue(d))??'';const s=propOf(value,'inputSchema')??propOf(value,'parameters');parameters=s?objectKeys(propValue(s)):objectKeys(value);}}
      out.tools.push({line:line(node),name:node.arguments[0].text,description,parameters,source:'mcp-server-call'});
    }
  }
  out.imports=[...new Set(out.imports)];
  return out;
}

// 太大或解析失敗的檔案：只用文字規則抓最明顯的幾項。
function scanJsByText(text){
  const out={processes:[],files:[],network:[],environment:[],wholeEnvironment:[],credentialRefs:[],hardcodedSecrets:[],tools:[],urls:[],homeReferences:[],imports:[],textOnly:true};
  const lineAt=index=>text.slice(0,index).split('\n').length;
  for(const m of text.matchAll(/(?:require\(|from\s*|import\()\s*['"](?:node:)?child_process['"]/g))out.processes.push({line:lineAt(m.index),api:'child_process（文字比對）',program:null,code:'child_process'});
  for(const m of text.matchAll(/\bfetch\s*\(\s*(['"`])((?:https?|wss?):\/\/[^'"`\s/]+)/g))out.network.push({line:lineAt(m.index),api:'fetch（文字比對）',domain:m[2].replace(/^\w+:\/\//,'').toLowerCase(),code:'fetch'});
  for(const m of text.matchAll(/\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)|\bprocess\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g))out.environment.push({line:lineAt(m.index),name:m[1]??m[2],api:'process.env（文字比對）'});
  return out;
}

// ---------- Python ----------
function scanPython(text){
  const out={processes:[],network:[],environment:[],tools:[],files:[]};
  const lines=text.split(/\r?\n/);
  const literalDomain=s=>{const m=s.match(/['"](?:https?|wss?):\/\/([^/'"\s:]+)/i);return m?m[1].toLowerCase():null;};
  for(let i=0;i<lines.length;i++){
    const raw=lines[i],stripped=raw.replace(/#.*$/,''),n=i+1;
    let m;
    if((m=stripped.match(/\b(subprocess\.(?:run|Popen|call|check_output|check_call|getoutput|getstatusoutput)|os\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?)|asyncio\.create_subprocess_(?:exec|shell)|pty\.spawn)\s*\(\s*(?:\[\s*)?(?:f?['"]([^'"]+)['"])?/)))
      out.processes.push({line:n,api:m[1],program:m[2]?m[2].trim().split(/\s+/)[0].split(/[\\/]/).pop().replace(/\.exe$/i,''):null,code:redactSnippet(clip(raw))});
    if((m=stripped.match(/\b(requests\.(?:get|post|put|delete|patch|head|request|Session)|httpx\.(?:get|post|put|delete|patch|request|Client|AsyncClient)|aiohttp\.ClientSession|urllib\.request\.(?:urlopen|Request)|urlopen|socket\.(?:socket|create_connection)|websockets?\.connect|smtplib\.SMTP(?:_SSL)?)\s*\(/)))
      out.network.push({line:n,api:m[1],domain:literalDomain(stripped),code:redactSnippet(clip(raw))});
    for(const e of stripped.matchAll(/\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g))out.environment.push({line:n,name:e[1]??e[2],api:'os.environ'});
    if((m=stripped.match(/\bopen\s*\([^)]*,\s*['"]([wax][b+t]*)['"]/)))out.files.push({line:n,api:'open',access:'write',flags:['write'],code:redactSnippet(clip(raw))});
    // @mcp.tool() / @tool() / @server.tool 之後的 def
    if(/^\s*@(?:[\w.]+\.)?tool\b(?:\s*\(|\s*$)/.test(stripped)){
      for(let j=i+1;j<Math.min(lines.length,i+8);j++){
        const def=lines[j].match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)?/);
        if(!def){if(/^\s*@/.test(lines[j])||!lines[j].trim())continue;break;}
        let doc='';
        for(let k=j+1;k<Math.min(lines.length,j+6);k++){const d=lines[k].trim().replace(/^[rubf]*("""|''')/i,'');if(lines[k].trim().match(/^[rubf]*("""|''')/i)){if(d.replace(/("""|''')\s*$/,'').trim()){doc=d.replace(/("""|''')\s*$/,'').trim();break;}for(let q=k+1;q<Math.min(lines.length,k+6);q++)if(lines[q].trim()){doc=lines[q].trim().replace(/("""|''')\s*$/,'');break;}break;}if(lines[k].trim())break;}
        const params=(def[2]??'').split(',').map(item=>item.trim().split(/[:=\s]/)[0]).filter(item=>item&&!['self','ctx','context','*','**kwargs','*args'].includes(item));
        out.tools.push({line:j+1,name:def[1],description:doc,parameters:params,source:'python-tool-decorator'});
        break;
      }
    }
  }
  return out;
}

// ---------- 走訪檔案 ----------
async function walkPackage(root){
  const files=[],skipped=[],bundled={directories:[],packages:new Set(),files:0,truncated:false};
  const countNodeModules=async dir=>{
    const stack=[dir];
    while(stack.length){
      const current=stack.pop();
      let entries;try{entries=await fs.readdir(current,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        const full=path.join(current,entry.name);
        if(entry.isSymbolicLink())continue;
        if(entry.isDirectory()){if(path.basename(current)==='node_modules'){if(entry.name.startsWith('@')){for(const inner of await fs.readdir(full).catch(()=>[]))bundled.packages.add(entry.name+'/'+inner);}else if(!entry.name.startsWith('.'))bundled.packages.add(entry.name);}stack.push(full);}
        else if(entry.isFile()){bundled.files++;if(bundled.files>=200000){bundled.truncated=true;return;}}
      }
    }
  };
  const walk=async dir=>{
    let entries;try{entries=(await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));}catch(error){skipped.push({path:posix(path.relative(root,dir))||'.',reason:'無法讀取資料夾：'+error.code});return;}
    for(const entry of entries){
      const full=path.join(dir,entry.name),rel=posix(path.relative(root,full));
      if(entry.isSymbolicLink()){skipped.push({path:rel,reason:'符號連結，未跟隨'});continue;}
      if(entry.isDirectory()){
        if(entry.name==='node_modules'){bundled.directories.push(rel);await countNodeModules(full);continue;}
        if(SKIP_DIRS.has(entry.name)){skipped.push({path:rel,reason:'略過的資料夾（版本控制或 Python 快取／虛擬環境）'});continue;}
        await walk(full);
      }else if(entry.isFile()){
        if(files.length>=MAX_FILES){skipped.push({path:rel,reason:`超過 ${MAX_FILES} 個檔案，未掃描`});continue;}
        files.push(full);
      }
    }
  };
  await walk(root);
  return {files,skipped,bundled:{directories:bundled.directories,packages:[...bundled.packages].sort(),files:bundled.files,truncated:bundled.truncated}};
}

const isTestPath=rel=>/(?:^|\/)(?:tests?|__tests__|spec|specs|examples?|fixtures?|__mocks__|e2e)\//i.test(rel)||/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(rel)||/(?:^|[\/._-])self-?test[\w.-]*\.[cm]?[jt]sx?$/i.test(rel);

function clientPaths(pkg){
  const set=new Set();
  const add=value=>{if(typeof value==='string')set.add(posix(path.normalize(value)).replace(/^\.\//,''));else if(value&&typeof value==='object')for(const item of Object.values(value))add(item);};
  if(typeof pkg?.dsh?.client==='string')add(pkg.dsh.client);
  if(pkg?.dsh?.client&&typeof pkg.dsh.client==='object'&&typeof pkg.dsh.client.entry==='string')add(pkg.dsh.client.entry);
  if(pkg?.exports&&typeof pkg.exports==='object')for(const [key,value]of Object.entries(pkg.exports))if(/client|web|ui|browser/i.test(key))add(value);
  return set;
}
// DSH 前端畫面程式：package.json 指名的檔案；或插件宣告了 dsh.client 時，檔名就叫 client.* 的檔案；或匯入 DSH 前端套件（@deepseek-ai/dsh-client*）的檔案。React 不算：有插件的執行期程式也匯入 React。
// 只因為放在 client/ 資料夾不算（例如 lib/client/webdav.js 是連 NAS 的程式，不是畫面）。
const CLIENT_IMPORT=/(?:from\s*|import\s*\(\s*|require\(\s*)['"]@deepseek-ai\/dsh-client[\w/-]*['"]/; // React 不算：有插件的執行期程式（dsh-eteams）也匯入 React
const looksLikeClient=(rel,clients,pkg,text)=>clients.has(rel)||Boolean(pkg?.dsh?.client)&&/(?:^|\/)client\.[cm]?[jt]sx?$/i.test(rel)||typeof text==='string'&&CLIENT_IMPORT.test(text.slice(0,200000));

// ---------- 主函式 ----------
/**
 * 掃描一個 DSH 插件資料夾。`root` 是來源根目錄，`packageDir` 是 DSH 套件所在子目錄。
 * `outboundTool` / `notOutboundTool` 讓使用者手動修正對外發文判斷（工具名稱）。
 * 不執行任何來源、不連網路、不呼叫模型。
 */
export async function scanSecurity(root,{packageDir='.',outboundTool=[],notOutboundTool=[]}={}){
  root=path.resolve(root);
  const packageRoot=path.resolve(root,packageDir);
  const back=path.relative(root,packageRoot);
  if(typeof packageDir!=='string'||back.startsWith('..')||path.isAbsolute(back))throw new Error('套件子目錄必須位於來源資料夾內');
  const rel=file=>posix(path.relative(packageRoot,file));
  let pkg={};try{pkg=JSON.parse(await fs.readFile(path.join(packageRoot,'package.json'),'utf8'));}catch{/* 沒有 package.json 也掃 */}
  const {files,skipped,bundled}=await walkPackage(packageRoot);
  const clients=clientPaths(pkg);
  const rows={processes:[],files:[],network:[],environment:[],wholeEnvironment:[],credentialRefs:[],hardcodedSecrets:[],homeReferences:[],urls:[]};
  const tools=[],obfuscation=[],minified=[],otherLanguages=[],binaries=[],parseErrors=[],patchSecrets=[],installScripts=[];
  const textByRel=new Map(); // 給「其他語言檔案是否被執行」的參照比對
  const pythonTools=[];
  let jsFiles=0;
  const push=(list,item)=>{if(list.length<MAX_ROWS)list.push(item);else list.truncated=true;};
  for(const file of files){
    const r=rel(file),ext=path.extname(file).toLowerCase(),base=path.basename(file).toLowerCase();
    let context=isTestPath(r)?'test':looksLikeClient(r,clients,pkg)?'client':'runtime';
    let size;try{size=(await fs.stat(file)).size;}catch{continue;}
    if(BINARY_EXT.has(ext)){binaries.push({path:r,bytes:size,kind:ext.slice(1)});continue;}
    if(JS_FILE.test(file)&&!TYPES_FILE.test(file)){
      jsFiles++;
      if(size>MAX_TEXT_BYTES){skipped.push({path:r,reason:`檔案 ${size} 位元組，超過掃描上限，未掃描`});continue;}
      const text=await fs.readFile(file,'utf8');
      if(context==='runtime'&&looksLikeClient(r,clients,pkg,text))context='client';
      if(context!=='test')textByRel.set(r,text);
      const metrics=obfuscationMetrics(text),judged=judgeObfuscation(metrics);
      if(judged.obfuscated)obfuscation.push({path:r,context,reasons:judged.reasons,metrics});
      else if(judged.minified)minified.push({path:r,context,maxLineLength:metrics.maxLineLength,bytes:metrics.bytes});
      let result;
      if(size>MAX_AST_BYTES)result=scanJsByText(text);
      else try{result=scanJs(text,r);}catch(error){parseErrors.push({path:r,message:clip(error.message,200)});result=scanJsByText(text);}
      for(const key of Object.keys(rows))for(const item of result[key]??[])push(rows[key],{path:r,context,...item});
      if(context==='runtime')for(const tool of result.tools)tools.push({path:r,...tool});
      continue;
    }
    if(OTHER_LANGUAGES[ext]||/^(?:dockerfile|makefile)$/i.test(base)){
      const item={path:r,language:OTHER_LANGUAGES[ext]??base,bytes:size};
      otherLanguages.push(item);
      if(['.py','.pyw'].includes(ext)&&size<4*1024*1024){
        const text=await fs.readFile(file,'utf8');
        const result=scanPython(text);
        for(const key of ['processes','network','environment','files'])for(const row of result[key])push(rows[key],{path:r,context:context==='test'?'test':'python',language:'python',...row});
        for(const tool of result.tools)pythonTools.push({path:r,...tool});
        item.imports=[...text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map(m=>(m[1]??m[2]).split('.')[0]);
      }
      continue;
    }
    if(/\.ya?ml$/i.test(base)&&size<1024*1024){
      const text=await fs.readFile(file,'utf8');
      textByRel.set(r,text);
      if(/!!js/.test(text))text.split(/\r?\n/).forEach((lineText,index)=>{if(/!!js/.test(lineText))for(const name of expressionEnvNames(lineText))patchSecrets.push({path:r,line:index+1,name,via:'!!js process.env'});});
      // MCP 子程序設定（@deepseek-ai/dsh-mcp-client 的 command）
      try{const doc=YAML.parse(text,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:s=>({$dshExpression:s})}],maxAliasCount:50});const visit=(value,depth=0)=>{if(depth>40||!value||typeof value!=='object')return;if(typeof value.command==='string'&&(value.transport==='stdio'||Array.isArray(value.args))){const index=text.indexOf(value.command);push(rows.processes,{path:r,context:'runtime',line:index>=0?text.slice(0,index).split('\n').length:null,api:'MCP 子程序設定（command）',program:path.basename(value.command).replace(/\.(?:exe|cmd|bat)$/i,''),code:redactSnippet(clip(value.command+' '+(value.args??[]).join(' ')))});}for(const child of Object.values(value))visit(child,depth+1);};visit(doc);}catch{/* 解析錯誤留給 inspect 報 */}
      continue;
    }
    if(['.mcp.json','mcp.json'].includes(base)&&size<1024*1024){
      try{const data=JSON.parse(await fs.readFile(file,'utf8'));for(const [key,server]of Object.entries(data?.mcpServers??{}))if(typeof server?.command==='string')push(rows.processes,{path:r,context:'runtime',line:null,api:`MCP 子程序設定（${key}）`,program:path.basename(server.command).replace(/\.(?:exe|cmd|bat)$/i,''),code:redactSnippet(clip(server.command+' '+(server.args??[]).join(' ')))});}catch{/* 無法解析就略過 */}
    }
    if(/\.(?:json|md|txt|toml|ini|cfg)$/i.test(base)&&size<512*1024)textByRel.set(r,await fs.readFile(file,'utf8'));
  }
  for(const [name,script]of Object.entries(pkg.scripts??{}))if(/^(?:pre|post)?install$|^prepare$|^prepublish$/.test(name))installScripts.push({name,command:redactSnippet(clip(script,200)),note:'轉換器安裝依賴時一律加 --ignore-scripts，這段不會在轉換時執行'});

  // 其他語言的檔案是否會被執行：檔名出現在執行期程式或設定裡就算「有被引用」。
  const runtimeTexts=[...textByRel.entries()].filter(([r])=>!isTestPath(r));
  for(const item of otherLanguages){
    const name=path.basename(item.path),stem=name.replace(/\.[^.]+$/,'');
    const refs=runtimeTexts.filter(([r,text])=>r!==item.path&&text.includes(name)).map(([r])=>r);
    item.referencedBy=refs.slice(0,10);
    item.executed=refs.length?'可能（檔名出現在插件程式或設定中）':'沒找到引用（假說：不會被執行）';
    item.executedLikely=refs.length>0;
    void stem;
  }
  // Python 檔被其他會執行的 Python 檔 import，也算可能執行。
  const pyLikely=new Set(otherLanguages.filter(item=>item.executedLikely&&item.imports).flatMap(item=>item.imports));
  for(const item of otherLanguages)if(!item.executedLikely&&/\.pyw?$/.test(item.path)&&pyLikely.has(path.basename(item.path).replace(/\.pyw?$/,''))){item.executedLikely=true;item.executed='可能（被會執行的 Python 檔匯入）';}
  for(const item of otherLanguages)delete item.imports;

  // ---- 工具與對外發文 ----
  const overridesOn=new Set(outboundTool),overridesOff=new Set(notOutboundTool);
  const seen=new Map();
  for(const tool of tools){if(!seen.has(tool.name))seen.set(tool.name,tool);}
  const classified=[...seen.values()].map(tool=>{
    const auto=classifyOutbound(tool);
    let outbound=auto.outbound,reason=auto.reason,decidedBy='rules';
    if(overridesOn.has(tool.name)){outbound=true;decidedBy='user';reason='使用者以 --outbound-tool 標記';}
    if(overridesOff.has(tool.name)){outbound=false;decidedBy='user';reason='使用者以 --not-outbound-tool 標記';}
    const fields=outbound&&!auto.outbound?{...pickFields(tool.parameters),kind:outboundKind(tool.name,tool.description)}:{targetFields:auto.targetFields,textFields:auto.textFields,kind:auto.kind};
    return {name:tool.name,path:tool.path,line:tool.line,source:tool.source,description:clip(redactSnippet(tool.description??''),300),parameters:tool.parameters,outbound,decidedBy,reason,confidence:decidedBy==='user'?'user':auto.confidence,...(outbound?fields:{})};
  });
  for(const name of overridesOn)if(!seen.has(name))classified.push({name,path:null,line:null,source:'user',description:'',parameters:[],outbound:true,decidedBy:'user',reason:'使用者以 --outbound-tool 標記（掃描沒找到這個工具的定義）',confidence:'user',kind:'other',targetFields:[],textFields:[]});
  const internalTools=[];const seenPy=new Set();
  for(const tool of pythonTools){if(seenPy.has(tool.name))continue;seenPy.add(tool.name);const auto=classifyOutbound(tool);internalTools.push({name:tool.name,path:tool.path,line:tool.line,source:tool.source,description:clip(redactSnippet(tool.description??''),200),parameters:tool.parameters,outbound:auto.outbound,reason:auto.reason,confidence:auto.confidence,...(auto.outbound?{kind:auto.kind,targetFields:auto.targetFields,textFields:auto.textFields}:{})});}

  // ---- 金鑰 ----
  const secretMap=new Map();
  const addSecret=(name,where)=>{if(!secretMap.has(name))secretMap.set(name,{name,locations:[]});const row=secretMap.get(name);if(row.locations.length<10)row.locations.push(where);};
  for(const item of rows.environment)if(item.name&&isSecretName(item.name)&&item.context!=='test')addSecret(item.name,{path:item.path,line:item.line,via:item.language==='python'?'Python os.environ':'process.env',context:item.context});
  for(const item of patchSecrets)if(isSecretName(item.name))addSecret(item.name,{path:item.path,line:item.line,via:item.via,context:'runtime'});
  const envNames=[...new Set([...rows.environment.filter(item=>item.name&&item.context!=='test').map(item=>item.name),...patchSecrets.map(item=>item.name)])].sort();

  // ---- 摘要 ----
  const live=list=>list.filter(item=>item.context!=='test');
  const runtimeOnly=list=>list.filter(item=>item.context==='runtime'||item.context==='python');
  const uniq=list=>[...new Set(list.filter(Boolean))].sort();
  const reviewBlocking=obfuscation.filter(item=>item.context!=='test');
  const summary={
    spawnsProcesses:runtimeOnly(rows.processes).length>0,
    programs:uniq(runtimeOnly(rows.processes).flatMap(item=>String(item.program??'').split('|'))),
    unknownPrograms:runtimeOnly(rows.processes).filter(item=>!item.program).length,
    usesNetwork:runtimeOnly(rows.network).length>0,
    domains:uniq(runtimeOnly(rows.network).map(item=>item.domain)),
    mentionedDomains:uniq(live(rows.urls).map(item=>item.domain)).slice(0,200),
    writesFiles:runtimeOnly(rows.files).some(item=>['write','delete'].includes(item.access)),
    fileFlags:{absolute:runtimeOnly(rows.files).filter(item=>item.flags?.includes('absolute')).length,home:runtimeOnly(rows.files).filter(item=>item.flags?.includes('home')).length+runtimeOnly(rows.homeReferences).length,parent:runtimeOnly(rows.files).filter(item=>item.flags?.includes('parent')).length,write:runtimeOnly(rows.files).filter(item=>['write','delete'].includes(item.access)).length},
    environmentNames:envNames,
    secretNames:[...secretMap.keys()].sort(),
    usesCredentialService:live(rows.credentialRefs).length>0,
    credentialRefs:uniq(live(rows.credentialRefs).map(item=>item.name)),
    hardcodedSecrets:live(rows.hardcodedSecrets).length,
    passesWholeEnvironment:runtimeOnly(rows.wholeEnvironment).length>0,
    tools:classified.filter(item=>item.source!=='user').length,
    outboundToolNames:classified.filter(item=>item.outbound).map(item=>item.name),
    internalOutboundToolNames:internalTools.filter(item=>item.outbound).map(item=>item.name),
    obfuscated:reviewBlocking.length>0,
    obfuscatedFiles:reviewBlocking.map(item=>item.path),
    minifiedFiles:minified.map(item=>item.path),
    otherLanguageFiles:otherLanguages.length,
    otherLanguagesExecuted:otherLanguages.filter(item=>item.executedLikely).map(item=>item.path),
    binaries:binaries.map(item=>item.path),
    installScripts:installScripts.map(item=>item.name)
  };
  summary.reviewable=!summary.obfuscated;
  summary.verdict=summary.obfuscated?'unreviewable':'reviewable';
  return {
    schemaVersion:SECURITY_SCAN_SCHEMA_VERSION,engine:'fixed-rules',modelCalls:0,sourceExecuted:false,
    note:'固定規則的靜態掃描：只標出位置，不證明安全也不證明惡意。透過變數或動態組出的程式名稱、網址、路徑可能抓不到；node_modules 只統計不掃描。',
    package:{name:pkg.name??path.basename(packageRoot),version:pkg.version??null,packageDir:posix(path.relative(root,packageRoot))||'.'},
    files:{scanned:files.length,javascript:jsFiles,skipped,parseErrors,bundledDependencies:bundled,contexts:{runtime:'插件執行期程式',client:'DSH 前端畫面程式（依檔名或 package.json 判斷；轉成 Claude 插件後不執行，假說）',test:'測試或範例（不算進摘要）',python:'Python 檔'}},
    summary,
    processes:rows.processes,network:rows.network,fileAccess:rows.files,homeReferences:rows.homeReferences,
    environment:rows.environment,wholeEnvironment:rows.wholeEnvironment,
    secrets:{names:[...secretMap.values()],credentialRefs:rows.credentialRefs,hardcoded:rows.hardcodedSecrets,patchExpressions:patchSecrets},
    tools:classified,internalTools,
    obfuscation:{files:obfuscation,minified},
    otherLanguages,binaries,installScripts,
    urls:summarizeUrls(rows.urls)
  };
}
function summarizeUrls(urls){
  const byDomain=new Map();
  for(const item of urls){if(!byDomain.has(item.domain))byDomain.set(item.domain,{domain:item.domain,count:0,first:{path:item.path,line:item.line},contexts:new Set()});const row=byDomain.get(item.domain);row.count++;row.contexts.add(item.context);}
  return [...byDomain.values()].map(row=>({...row,contexts:[...row.contexts]})).sort((a,b)=>b.count-a.count).slice(0,300);
}

// ---------- 給轉換器用 ----------
const titleCase=word=>word.charAt(0).toUpperCase()+word.slice(1).toLowerCase();
/** 由環境變數名稱猜服務名稱：TAVILY_API_KEY → Tavily。猜不到回傳 null。 */
export function serviceFromEnvName(name){
  const parts=String(name).split(/_+/).filter(Boolean);
  const index=parts.findIndex(part=>SECRET_TOKENS.has(part.toLowerCase())||['API','ACCESS','PRIVATE','CLIENT','APP','BOT','AUTH'].includes(part.toUpperCase()));
  const prefix=(index<0?[]:parts.slice(0,index)).filter(part=>!['DSH','PLUGIN'].includes(part.toUpperCase()));
  return prefix.length?prefix.map(titleCase).join(' '):null;
}
/** 掃描結果 → 約定 2 的 secretOptions（只收環境變數名稱合法的金鑰）。 */
export function secretOptionsFromScan(scan,{displayName}={}){
  const toolsByFile=new Map();
  for(const tool of scan.tools??[])if(tool.path){if(!toolsByFile.has(tool.path))toolsByFile.set(tool.path,[]);toolsByFile.get(tool.path).push(tool.name);}
  return (scan.secrets?.names??[]).filter(item=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.name)).map(item=>{
    const service=serviceFromEnvName(item.name)??displayName??'插件';
    const files=[...new Set(item.locations.map(loc=>loc.path))];
    const tools=[...new Set(files.flatMap(file=>toolsByFile.get(file)??[]))];
    const features=tools.length?`工具 ${tools.slice(0,8).join('、')}${tools.length>8?' 等':''}（依讀取金鑰的檔案推測）`:'插件本身（無法從程式位置判斷是哪個功能）';
    const where=item.locations.slice(0,3).map(loc=>`${loc.path}${loc.line?':'+loc.line:''}`).join('、');
    const pythonOnly=item.locations.every(loc=>loc.via==='Python os.environ');
    return {option:'secret_'+item.name,env:item.name,title:`${service} 金鑰（${item.name}）`,features,required:false,
      description:`DSH 插件「${displayName??'插件'}」從環境變數 ${item.name} 讀取的金鑰（或權杖、密碼）。用到它的功能：${features}。填在這裡會存進系統的安全儲存區，不會寫進插件資料夾；不需要這些功能可以留空。程式位置：${where}${pythonOnly?'（由插件內附的 Python 程式讀取）':''}。`,
      locations:item.locations};
  });
}
/** --config 裡看起來是金鑰的欄位：回傳欄位路徑，不回傳值。 */
export function configSecretPaths(config){
  const found=[];
  const walk=(value,trail)=>{
    if(Array.isArray(value)){value.forEach((item,index)=>walk(item,[...trail,String(index)]));return;}
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)){
      const next=[...trail,key];
      if(typeof item==='string'&&item.trim()&&(isSecretName(key)&&!/^\$\{|^process\.env/.test(item)||looksLikeSecretValue(item)))found.push({path:next.join('.'),reason:isSecretName(key)?'欄位名稱像金鑰':'值的格式像金鑰'});
      else walk(item,next);
    }
  };
  walk(config,[]);
  return found;
}

// ---------- 白話摘要（SECURITY.md） ----------
const loc=item=>item.path?`\`${item.path}${item.line?':'+item.line:''}\``:'（無位置）';
const CONTEXT_NOTE={client:'（DSH 前端畫面程式）',test:'（測試／範例）',python:'（Python）',runtime:''};
const FLAG_TEXT={absolute:'絕對路徑',home:'使用者家目錄',parent:'用 .. 往外',write:'寫入',delete:'刪除'};
const KIND_TEXT={comment:'留言／回覆',message:'私訊／訊息',email:'寄信',post:'公開發文',other:'對外送出內容'};
export function renderSecurityMarkdown(scan,{displayName,pluginName,outboundTools=[],secretOptions=[],allowUnreviewable=false,configSecrets=[]}={}){
  const s=scan.summary,lines=[];
  const list=(rows,format,limit=25)=>{for(const row of rows.slice(0,limit))lines.push('- '+format(row));if(rows.length>limit)lines.push(`- ……還有 ${rows.length-limit} 處，見 \`security-report.json\``);};
  lines.push(`# 安全摘要：${displayName??scan.package.name}`,'');
  lines.push('這份摘要由轉換器用**固定規則**掃描插件原始碼產生（沒有呼叫 AI，也沒有執行插件）。它只標出「值得去看的位置」，**不代表插件安全，也不代表插件惡意**。透過變數組出來的程式名稱、網址和路徑可能抓不到。完整結果在 `security-report.json`。','');
  lines.push('**先知道的事**：這個插件執行的是第三方寫的程式碼，權限和你的使用者帳號一樣（可以讀寫你能讀寫的檔案、連網路）。轉換後的保護（每次確認發文、限制直接開程式、限制讀寫的資料夾）只能降低風險，不能消除風險。','');
  lines.push('## 一眼看懂','');
  const yes=(flag,text,detail='')=>lines.push(`- ${flag?'**會**':'沒看到'}${text}${flag&&detail?'：'+detail:''}`);
  yes(s.spawnsProcesses,'自己開程式',(s.programs.length?s.programs.map(p=>'`'+p+'`').join('、'):'')+(s.unknownPrograms?`${s.programs.length?'，另有 ':''}${s.unknownPrograms} 處看不出程式名稱`:''));
  yes(s.usesNetwork,'連網路',s.domains.length?s.domains.slice(0,15).map(d=>'`'+d+'`').join('、')+(s.domains.length>15?' 等':''):'網域看不出來（網址是變數組出來的）');
  yes(s.writesFiles,'寫入或刪除檔案',[s.fileFlags.home?`${s.fileFlags.home} 處和家目錄有關`:'',s.fileFlags.absolute?`${s.fileFlags.absolute} 處用絕對路徑`:'',s.fileFlags.parent?`${s.fileFlags.parent} 處用 .. 往外`:''].filter(Boolean).join('，'));
  yes(s.secretNames.length>0,'需要金鑰',s.secretNames.map(n=>'`'+n+'`').join('、'));
  yes(s.outboundToolNames.length>0,'用你的帳號對外發文','工具 '+s.outboundToolNames.map(n=>'`'+n+'`').join('、'));
  if(s.internalOutboundToolNames.length)lines.push(`- 插件內附的 Python 工具裡也有會對外發文的：${s.internalOutboundToolNames.map(n=>'`'+n+'`').join('、')}（不是 Claude 直接看得到的工具，插件自己或它開的子代理可能會用）`);
  if(s.obfuscated)lines.push(`- **有混淆過的程式碼，無法審查**：${s.obfuscatedFiles.map(f=>'`'+f+'`').join('、')}。${allowUnreviewable?'使用者以 `--allow-unreviewable` 堅持轉換。':'轉換器預設拒絕轉換。'}`);
  else lines.push('- 沒看到混淆過的程式碼');
  if(s.minifiedFiles.length)lines.push(`- 有壓縮過（整個檔案擠在很長的幾行）的程式：${s.minifiedFiles.length} 個檔案，人工閱讀困難，但不算混淆`);
  if(s.otherLanguageFiles)lines.push(`- 有 ${s.otherLanguageFiles} 個其他語言的檔案，其中 ${s.otherLanguagesExecuted.length} 個可能會被執行`);
  if(s.binaries.length)lines.push(`- 有 ${s.binaries.length} 個執行檔或二進位檔（無法閱讀內容）：${s.binaries.slice(0,10).map(f=>'`'+f+'`').join('、')}`);
  if(s.passesWholeEnvironment)lines.push('- 有把**整份環境變數**交給子程式或其他地方的寫法（環境變數裡可能有你的其他金鑰）');
  if(s.hardcodedSecrets)lines.push(`- 程式裡有 ${s.hardcodedSecrets} 處寫死、看起來像金鑰的字串（值沒有記錄）`);
  lines.push('');
  const proc=scan.processes.filter(item=>item.context!=='test');
  if(proc.length){lines.push('## 自己開程式','','插件不經過 Claude Code 的權限確認，直接執行其他程式。轉換後預設會被擋下，被擋下時會問你要不要完全信任這個插件（完全信任後它可以開任何程式、讀寫任何檔案，不再問；插件選項 `allowDirectExec` 效果相同）。','');list(proc,item=>`${loc(item)}${CONTEXT_NOTE[item.context]??''}：${item.api}，程式 ${item.program?'`'+item.program+'`':'看不出來'+(item.expression?`（\`${item.expression}\`）`:'')}`);lines.push('');}
  const net=scan.network.filter(item=>item.context!=='test');
  if(net.length){lines.push('## 連網路','','網路連線目前無法由轉換後的保護限制（假說），只能靠審查。','');list(net,item=>`${loc(item)}${CONTEXT_NOTE[item.context]??''}：${item.api}${item.domain?'，網域 `'+item.domain+'`':''}`);lines.push('');}
  const fileRows=scan.fileAccess.filter(item=>item.context!=='test'&&(item.flags?.length));
  if(fileRows.length){lines.push('## 讀寫檔案（只列有寫入、刪除、絕對路徑、家目錄或 .. 往外的）','');list(fileRows,item=>`${loc(item)}${CONTEXT_NOTE[item.context]??''}：${item.api}（${(item.flags??[]).map(f=>FLAG_TEXT[f]??f).join('、')}）${item.target?'，路徑 `'+item.target+'`':''}`);lines.push('');}
  const home=scan.homeReferences.filter(item=>item.context!=='test');
  if(home.length){lines.push('## 用到使用者家目錄','');list(home,item=>`${loc(item)}${CONTEXT_NOTE[item.context]??''}：${item.kind==='os.homedir'?'os.homedir()':'環境變數 '+item.name}`,15);lines.push('');}
  if(s.secretNames.length||scan.secrets.credentialRefs.length||scan.secrets.hardcoded.length){
    lines.push('## 金鑰','');
    for(const item of scan.secrets.names)lines.push(`- \`${item.name}\`：${item.locations.map(l=>loc(l)+(l.via?'（'+l.via+'）':'')).join('、')}`);
    for(const item of scan.secrets.credentialRefs.filter(r=>r.context!=='test').slice(0,15))lines.push(`- DSH 憑證服務 ${item.api}：${item.name?'`'+item.name+'`':'名稱是動態的'}，${loc(item)}`);
    for(const item of scan.secrets.hardcoded.filter(r=>r.context!=='test').slice(0,15))lines.push(`- 寫死的字串 \`${item.name}\`（${item.length} 字，值未記錄）：${loc(item)}`);
    if(secretOptions.length)lines.push('',`轉換後，這些金鑰請填在插件選項的敏感欄位（存在系統安全儲存區）：${secretOptions.map(o=>'`'+o.option+'`').join('、')}。不要用 \`--config\` 把金鑰寫進 \`runtime/settings.json\`。`);
    lines.push('');
  }
  if(configSecrets.length){lines.push('## 轉換時 `--config` 裡像金鑰的欄位','','這些值會以純文字存在插件資料夾的 `runtime/settings.json`，分享插件資料夾就會跟著出去。建議改用插件選項的金鑰欄位。值沒有記錄在這裡。','');for(const item of configSecrets)lines.push(`- \`${item.path}\`（${item.reason}）`);lines.push('');}
  const toolRows=scan.tools.filter(item=>item.outbound);
  if(toolRows.length||scan.tools.length){
    lines.push('## 對外發文','','「對外發文」指插件用你的名義把內容送給別人或公開出去（留言、私訊、寄信、發文）。讀取、搜尋、建立草稿不算。轉換後這些工具預設**每次都會問你**（插件選項 `outboundMode`）。判斷依工具名稱與描述，可能誤判：轉換時可用 `--outbound-tool <名稱>`、`--not-outbound-tool <名稱>` 修正。','');
    if(toolRows.length)for(const item of toolRows)lines.push(`- \`${item.name}\`（${KIND_TEXT[item.kind]??item.kind}）：${item.description?clip(item.description,80):'沒有描述'}。${loc(item)}；判斷依據：${item.reason}${item.targetFields?.length?`；目的地欄位 ${item.targetFields.join('、')}`:''}${item.textFields?.length?`；內容欄位 ${item.textFields.join('、')}`:''}`);
    else lines.push('- 沒有判定為對外發文的工具');
    const other=scan.tools.filter(item=>!item.outbound);
    if(other.length)lines.push('',`其他工具（判定不是對外發文）：${other.map(item=>'`'+item.name+'`').join('、')}`);
    const internal=scan.internalTools.filter(item=>item.outbound);
    if(internal.length){lines.push('','插件內附的 Python 工具中，判定會對外發文的：');for(const item of internal)lines.push(`- \`${item.name}\`（${KIND_TEXT[item.kind]??item.kind}）：${loc(item)}`);}
    lines.push('');
  }
  if(scan.obfuscation.files.length||scan.obfuscation.minified.length){
    lines.push('## 混淆與壓縮','');
    for(const item of scan.obfuscation.files)lines.push(`- **混淆**：${loc(item)}${CONTEXT_NOTE[item.context]??''}：${item.reasons.join('；')}`);
    list(scan.obfuscation.minified,item=>`壓縮（不算混淆）：${loc(item)}${CONTEXT_NOTE[item.context]??''}，最長一行 ${item.maxLineLength} 字`,15);
    lines.push('');
  }
  if(scan.otherLanguages.length){lines.push('## 其他語言的檔案','');list(scan.otherLanguages,item=>`${loc(item)}（${item.language}）：${item.executed}${item.referencedBy?.length?'，出現在 '+item.referencedBy.slice(0,3).map(r=>'`'+r+'`').join('、'):''}`,30);lines.push('');}
  if(scan.installScripts.length){lines.push('## 安裝腳本','');for(const item of scan.installScripts)lines.push(`- \`${item.name}\`：\`${item.command}\`（${item.note}）`);lines.push('');}
  if(scan.files.bundledDependencies.files)lines.push('## 打包的依賴','',`\`node_modules\` 裡有 ${scan.files.bundledDependencies.files} 個檔案（${scan.files.bundledDependencies.packages.length} 個套件），只統計、沒有掃描。`,'');
  if(outboundTools.length||pluginName)lines.push('---','',`插件名稱：\`${pluginName??''}\`。被擋下時去哪裡放行，見同資料夾的 \`README.md\`。`,'');
  return lines.join('\n');
}
