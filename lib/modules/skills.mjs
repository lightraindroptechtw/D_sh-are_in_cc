import {installOfficial} from './common.mjs';
export const descriptor={id:'skills',displayName:'技能模組',services:['skills'],officialPackage:'@deepseek-ai/dsh-skill',requires:{capabilities:[]},methods:{register:{support:'full',reason:'保留官方動態技能登記'},list:{support:'full',reason:'只提供允許模型讀取的技能'},get:{support:'full',reason:'保留原內容與相對資源位置'},nativeSlashMenu:{support:'unsupported',reason:'Claude Code 沒有 DSH 原生選單'}},requirements:[]};
export const install=environment=>installOfficial(descriptor,environment);
