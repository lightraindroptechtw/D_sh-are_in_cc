import {installOfficial} from './common.mjs';
export const descriptor={id:'timer',displayName:'計時器模組',services:['timer'],officialPackage:'@deepseek-ai/cordis-plugin-timer',requires:{capabilities:[]},methods:{setTimeout:{support:'full',reason:'沿用官方 Cordis 計時器與資源清理'},setInterval:{support:'full',reason:'僅在宿主程序存活時執行'},persistentWakeup:{support:'unsupported',reason:'需另行明確啟動常駐模組'}},requirements:[]};
export const install=environment=>installOfficial(descriptor,environment);
