/** The official provider seam and official model-facing tools are mounted as
 * independent loader rows. No replacement schema or permissive validator exists.
 */
export const descriptor={
  id:'web',displayName:'內建網頁工具模組',services:['web'],
  officialPackage:'@deepseek-ai/dsh-web',companionPackages:['@deepseek-ai/dsh-tool-web'],configKey:'web',
  requires:{capabilities:['mcp']},
  methods:{
    registerSearchProvider:{support:'full',reason:'沿用官方搜尋來源登記、重複識別碼檢查與清除機制'},
    registerFetchProvider:{support:'full',reason:'沿用官方抓取來源登記、重複識別碼檢查與清除機制'},
    search:{support:'full',reason:'沿用官方來源選擇、取消訊號與結果數限制；來源可能需要使用者金鑰'},
    fetch:{support:'full',reason:'沿用官方來源選擇與取消訊號；來源本身的限制仍然適用'},
    web_search:{support:'full',reason:'由官方 dsh-tool-web 掛載原工具結構與驗證'},
    web_fetch:{support:'full',reason:'由官方 dsh-tool-web 掛載原工具結構與驗證'},
  },
  requirements:['實際搜尋或抓取需要至少一個可用來源；未設定來源時工具仍列出並回傳官方錯誤','需要金鑰的來源僅使用轉送的環境變數或來源設定','插件自己登記同名工具（web_search、web_fetch）時，官方預先掛載的版本讓位，插件的版本優先'],
};

/** 官方 dsh-tool-web 預先掛載的工具名稱。 */
export const OFFICIAL_WEB_TOOL_NAMES=Object.freeze(['web_search','web_fetch']);

/**
 * 插件自己登記和官方網頁工具同名的工具時，官方版本讓位（先移除官方那一筆，再登記插件的），不讓啟動失敗。
 * 做法：包住工具登記表的 register。只處理「全域登記表裡目前那一筆不是經由本包裝登記的、名稱屬於官方網頁工具」的情況；
 * 插件之間彼此同名仍然維持官方的重複錯誤。插件登記失敗時把官方那一筆放回去。
 * 讓位發生時寫一行到 stderr（只含工具名稱）。回傳還原函式；登記表結構和預期不同時回傳 null。
 * 限制：官方那一筆的撤銷函式仍屬官方外掛，行程結束時它會依名稱刪除登記表項目（此時插件的版本一併消失，無影響）。
 */
export function yieldOfficialWebTools(tools,{names=OFFICIAL_WEB_TOOL_NAMES,log=message=>process.stderr.write(`${message}\n`)}={}){
  const table=tools?.layers?.global?.tools;
  if(!tools||typeof tools.register!=='function'||!table||typeof table.get!=='function'||!(table.data instanceof Map))return null;
  const original=tools.register;
  const own=Object.hasOwn(tools,'register');
  const owned=new Set();
  const official=new Set(names);
  const wrapped=function register(definition){
    const name=definition?.name;
    const existing=typeof name==='string'&&official.has(name)&&!owned.has(name)?table.get(name):undefined;
    if(existing!==undefined&&existing!==definition)table.data.delete(name);
    try{
      const dispose=Reflect.apply(original,this,[definition]);
      if(typeof name==='string')owned.add(name);
      if(existing!==undefined&&existing!==definition)log('[web] 插件登記了同名工具 '+name+'，官方網頁工具讓位');
      return dispose;
    }catch(error){
      if(existing!==undefined&&!table.data.has(name))table.data.set(name,existing);
      throw error;
    }
  };
  Object.defineProperty(tools,'register',{value:wrapped,configurable:true,writable:true});
  return ()=>{if(tools.register===wrapped){if(own)tools.register=original;else delete tools.register;}};
}

/** Reuse the already-mounted official service. The worker owns loader lifetime.
 * A missing capability or omitted official loader row disables this module.
 */
export async function install({root,capabilities={}}={}){
  const diagnostics=[];
  if(capabilities.mcp===false)return {services:{},diagnostics:[{module:'web',code:'MODULE_CAPABILITY_UNAVAILABLE',reason:'宿主未提供 MCP 工具介面'}]};
  const service=root?.get?.('web');
  if(!service)return {services:{},diagnostics:[{module:'web',code:'MODULE_SERVICE_UNAVAILABLE',reason:'官方網頁服務尚未掛載；必須先載入 descriptor.officialPackage 與 companionPackages'}]};
  const restore=yieldOfficialWebTools(root.get?.('tools'));
  if(!restore)diagnostics.push({module:'web',code:'WEB_TOOL_YIELD_UNAVAILABLE',reason:'工具登記表的結構和預期不同，插件登記 web_search／web_fetch 同名工具時可能因重複而失敗'});
  return {services:{web:service},diagnostics,dispose:async()=>{restore?.();}};
}

/** Profile defaults are read from the analysis result, never a hardcoded plugin
 * identity. The caller passes this to the official WebRuntime Config parser.
 */
export function webConfiguration(plan={}){
  const input=plan.serviceConfig?.web??plan.defaultConfig?.web;
  if(!input||typeof input!=='object'||Array.isArray(input))return {};
  const output={};
  for(const key of ['searchProvider','fetchProvider'])if(typeof input[key]==='string')output[key]=input[key];
  return output;
}
