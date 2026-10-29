import {installOfficial} from './common.mjs';
export const descriptor={id:'settings',displayName:'設定模組',services:['settings'],officialPackage:'@deepseek-ai/dsh-settings',companionBefore:['@deepseek-ai/dsh-config-editor'],requires:{capabilities:[]},methods:{describe:{support:'full',reason:'官方秘密遮蔽與欄位規格'},update:{support:'full',reason:'官方驗證、版本衝突及固定資料目錄'},nativeSettingsPage:{support:'unsupported',reason:'Claude Code 沒有 DSH 設定頁；使用插件選項或原插件畫面'}},requirements:[]};
export const install=environment=>installOfficial(descriptor,environment);
