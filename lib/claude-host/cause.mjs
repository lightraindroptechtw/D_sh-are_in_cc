import {diagnoseStartup} from '../startup-diagnostics.mjs';
import {expressionEnvNames} from '../compat/dsh-expression.mjs';
import {blockedText} from '../modules/claude/blocked.mjs';

const SECRET_PATTERNS=[[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,'Bearer [redacted]'],[/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g,'[redacted-key]'],[/((?:token|password|passwd|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,'$1[redacted]']];
/** Remove obvious credentials from one diagnostic line. The line is bounded and never the raw log. */
export function sanitizeLine(text,limit=500){
  let out=String(text??'').replace(/\u001b\[[0-9;]*m/g,'').replace(/\s+/g,' ').trim();
  for(const [pattern,replacement]of SECRET_PATTERNS)out=out.replace(pattern,replacement);
  return out.length>limit?out.slice(0,limit-1)+'…':out;
}

const linesOf=text=>String(text??'').split(/\r?\n/).map(line=>line.trimEnd()).filter(Boolean);

/** Names from Cordis lines such as `x (cordis:target): pending (waiting for service: shell)`. */
export function waitingServices(logs){
  const names=new Set();
  for(const match of String(logs??'').matchAll(/waiting for service:?\s*([A-Za-z0-9_$,\s-]+?)\)/g))for(const name of match[1].split(/[\s,]+/))if(name)names.add(name);
  return [...names];
}

/** First line of a Cordis activation failure: `target-plugin (cordis:target): Error: message`. */
function cordisFailure(logs){
  for(const line of linesOf(logs)){
    const match=line.match(/\(cordis:[A-Za-z0-9_-]+\):\s*((?:[A-Za-z]*Error|Error)\b.*)$/);
    if(match)return match[1];
  }
  return null;
}
function reservedMember(text){return String(text).match(/property ["'][A-Za-z0-9_$-]+["'] is already declared[^\n]*/)?.[0]??null;}
function esbuildError(text){
  const match=String(text).match(/^(.*?):(\d+):(\d+):\s*ERROR:\s*(.+)$/m);
  if(!match)return String(text).match(/ERROR:\s*(.+)$/m)?.[1]??null;
  const file=match[1].split(/[\\/]/).pop();
  return `${match[4].replace(/^\[plugin:[^\]]+\]\s*/,'')} (${file}:${match[2]}:${match[3]})`;
}

/** `- <message> (at <path>)` lines that follow Cordis' `ValidationError: invalid config:` in the error text or the worker log. */
export function configIssues(...texts){
  for(const text of texts){
    const lines=String(text??'').split(/\r?\n/);
    const start=lines.findIndex(line=>/invalid config:/.test(line));
    if(start<0)continue;
    const issues=[];
    for(const line of lines.slice(start+1)){
      const match=line.match(/^\s*-\s+(.*?)(?:\s+\(at ([^)]+)\))?\s*$/);
      if(!match)break;
      issues.push({message:match[1].slice(0,200),path:match[2]??null});
      if(issues.length>=8)break;
    }
    return issues;
  }
  return null;
}
const valueAt=(object,dotted)=>String(dotted??'').split('.').filter(Boolean).reduce((value,key)=>value&&typeof value==='object'?value[key]:undefined,object);
/** Environment variables a config value reads (`{ $dshExpression: "process.env.X ..." }`), by issue path; every settings.config / settings.entries[].config is tried. */
function envForPath(settings,dotted){
  const configs=[settings?.config,...(Array.isArray(settings?.entries)?settings.entries.map(row=>row?.config):[]),...Object.values(settings?.config&&typeof settings.config==='object'?settings.config:{})];
  const names=new Set();
  for(const config of configs){
    const value=dotted?valueAt(config,dotted):undefined;
    if(value&&typeof value==='object'&&typeof value.$dshExpression==='string')for(const name of expressionEnvNames(value.$dshExpression))names.add(name);
  }
  return [...names];
}
const oneLine=text=>String(text??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join(' ');

/** A plugin whose configuration did not validate: name the setting and, when it comes from an environment variable, the plugin option. */
export function describeConfigFailure(error,logs,{settings,env=process.env}={}){
  const issues=configIssues(error?.message,logs);
  if(!issues)return null;
  const compatMissing=(error?.details?.compat??[]).filter(row=>row?.id==='config-env-missing').flatMap(row=>Array.isArray(row.names)?row.names:[]);
  const rows=[],named=new Set();
  for(const issue of issues){
    const envs=envForPath(settings,issue.path).filter(name=>!(typeof env[name]==='string'&&env[name]));
    for(const name of envs)named.add(name);
    rows.push({path:issue.path,message:issue.message,env:envs});
  }
  for(const name of compatMissing)if(!named.has(name)){named.add(name);rows.push({path:null,message:'environment variable is not set',env:[name]});}
  const parts=rows.map(row=>{
    const where=row.path?`設定欄位 ${row.path}`:'設定';
    if(row.env.length)return `${where} 讀取的環境變數 ${row.env.join('、')} 沒有設定（請在插件選項填入 ${row.env.map(name=>`secret_${name}`).join('、')}）`;
    return `${where}：${row.message}`;
  });
  const first=issues[0];
  const original=`ValidationError: invalid config: ${first.message}${first.path?` (at ${first.path})`:''}`;
  const missing=rows.flatMap(row=>row.env.map(name=>({path:row.path,env:name,option:`secret_${name}`})));
  const message=`插件設定驗證失敗，插件沒有啟動。${parts.join('；')}。（原始錯誤：${original}）`;
  return {code:'PLUGIN_CONFIG_INVALID',message,missing,issues};
}

/** A start-up failure that is a known block (permission model, missing secret): the four-part notice on one line. */
export function describeBlockedFailure(error){
  const blocked=Array.isArray(error?.details?.blocked)?error.details.blocked.find(row=>row&&typeof row.what==='string'):null;
  if(!blocked)return null;
  return {code:String(blocked.code??error.code??'ERR_ACCESS_DENIED'),message:oneLine(blockedText(blocked)),blocked};
}

/** Turn a startup failure into the first real cause. Unknown logs are never copied wholesale. */
export function describeStartupFailure(error,logs='',context={}){
  const text=String(error?.message??error??''),all=String(logs??'');
  const waiting=waitingServices(all);
  const fromUnsupported=(error?.unsupported??[]).map(item=>String(item?.feature??'')).filter(feature=>feature.startsWith('service:')).map(feature=>feature.slice(8));
  const services=[...new Set([...waiting,...fromUnsupported])];
  const blocked=describeBlockedFailure(error);
  if(blocked)return {code:blocked.code,message:sanitizeLine(blocked.message,1200),services,classification:'blocked',blocked:blocked.blocked};
  const config=describeConfigFailure(error,all,context);
  if(config)return {code:config.code,message:sanitizeLine(config.message,1200),services,classification:'config',missing:config.missing};
  const diagnosis=diagnoseStartup(error,all);
  let cause=reservedMember(all)??reservedMember(text);
  if(!cause)cause=cordisFailure(all);
  if(!cause&&services.length)cause=`Plugin did not activate: waiting for service: ${services.join(', ')} (not provided by the Claude Code host)`;
  if(!cause)cause=esbuildError(text);
  if(!cause){
    const first=linesOf(text)[0];
    cause=first??linesOf(all).find(line=>/error|warning|did not activate/i.test(line))??'The DSH host failed to start (no cause reported)';
  }
  return {code:error?.code&&error.code!=='DSH_HOST_ERROR'?String(error.code):diagnosis.code,message:sanitizeLine(cause),services,classification:diagnosis.classification};
}
