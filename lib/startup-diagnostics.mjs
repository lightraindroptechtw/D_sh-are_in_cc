import {createHash} from 'node:crypto';

/** Turn transient, potentially sensitive worker logs into bounded known causes.
 * Unknown text is fingerprinted, never copied into a report or stderr. */
export function diagnoseStartup(error,logs=''){
  const text=String(error?.message??'')+'\n'+String(logs),fingerprint=createHash('sha256').update(text).digest('hex');
  const row=(code,classification,summary,details={})=>({code,classification,summary,...details,fingerprint,rawLogRetained:false});
  let match;
  if((match=text.match(/(?:Official runtime dependency is unavailable:|Cannot load pinned official runtime package:)\s*(@deepseek-ai\/[a-z0-9._-]+)/i)))return row('HOST_DEPENDENCY_MISSING','missing-dependency','缺少內附官方套件：'+match[1],{package:match[1]});
  if((match=text.match(/(?:Could not resolve|Cannot find (?:package|module))\s*["']([@a-z0-9_./-]+)["']/i)))return row('SOURCE_DEPENDENCY_MISSING','missing-dependency','無法解析來源套件：'+match[1],{package:match[1]});
  if((match=text.match(/property ["']([A-Za-z0-9_$-]+)["'] is already declared/)))return row('CORDIS_NAME_CONFLICT','other','Cordis 內建名稱衝突：'+match[1],{member:match[1]});
  if((match=text.match(/No matching export[^\n]*?for import ["']([A-Za-z0-9_$-]+)["']/)))return row('DSH_API_EXPORT_MISSING','upstream-error','來源需要的官方匯出不存在：'+match[1],{member:match[1]});
  if((match=text.match(/does not provide an export named ["']([A-Za-z0-9_$-]+)["']/)))return row('DSH_API_EXPORT_MISSING','upstream-error','來源需要的官方匯出不存在：'+match[1],{member:match[1]});
  if((match=text.match(/(?:No generic module maps this DSH service|No service adapter|HOST_SERVICE_UNSUPPORTED|DSH_MODULE_UNSUPPORTED|DSH_MODULE_METHOD_UNSUPPORTED|MODULE_CAPABILITY_UNAVAILABLE)/)))return row('HOST_MODULE_UNAVAILABLE','missing-module','來源呼叫未對應或停用的宿主服務');
  const missing=(error?.unsupported??[]).filter(item=>/^service:[A-Za-z][A-Za-z0-9_-]*$/.test(item.feature??'')).map(item=>item.feature.slice(8));
  if(missing.length)return row('HOST_REQUIRED_SERVICE_UNAVAILABLE','missing-module','來源缺少必要服務：'+missing.join(', '),{services:missing});
  if(error?.code==='HOST_TIMEOUT'||/timed out|超時/.test(text))return row('HOST_TIMEOUT','timeout','來源初始化超過設定期限');
  if(/Plugin entry id is invalid/.test(text))return row('HOST_ENTRY_ID_INVALID','other','來源內部識別碼不合法');
  if(/Invalid effect/.test(text))return row('CORDIS_INVALID_EFFECT','upstream-error','Cordis 拒絕來源提供的資源清理形式；需對照來源支援版本');
  if(/SDK_INCOMPATIBLE/.test(text))return row('SDK_VERSION_MISMATCH','upstream-error','來源的 SDK 版本或介面檢查未通過；沒有替換來源要求');
  if(/(?:api[_ -]?key|credential|token).{0,40}(?:missing|not configured|required)|(?:missing|required).{0,40}(?:api[_ -]?key|token)/i.test(text))return row('CREDENTIAL_REQUIRED','missing-credential','來源需要尚未提供的憑證');
  return row(error?.code==='HOST_PLUGIN_INACTIVE'?'HOST_PLUGIN_INACTIVE':'HOST_INITIALIZATION_FAILED','other','來源未能啟動；原因尚未確認，只保留指紋，未保存原始日誌');
}
