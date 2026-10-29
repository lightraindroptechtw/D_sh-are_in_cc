import {installOfficial} from './common.mjs';
export const descriptor={id:'fs',displayName:'檔案模組',services:['fs'],officialPackage:'@deepseek-ai/dsh-fs-local',requires:{capabilities:[]},methods:{readFile:{support:'full',reason:'使用官方本機檔案服務及明確工作目錄'},writeFile:{support:'full',reason:'保留官方語義；具有本機使用者權限，並非沙箱'},remoteProviders:{support:'unsupported',reason:'未自動安裝額外檔案後端'}},requirements:['工作目錄與來源可信度由使用者指定']};
export const install=environment=>installOfficial(descriptor,environment);
