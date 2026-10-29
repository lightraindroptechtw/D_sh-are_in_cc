import {installOfficial} from './common.mjs';
export const descriptor={id:'webServer',displayName:'本機網頁路由模組',services:['webServer'],officialPackage:'@deepseek-ai/dsh-host-webserver',requires:{capabilities:[]},methods:{register:{support:'full',reason:'原路由限定在本機回送位址'},registerUpgrade:{support:'partial',reason:'保留原服務但 MCP 控制工具不轉送 WebSocket 連線'},nativePanel:{support:'unsupported',reason:'不嵌入 DSH 聊天介面'}},requirements:['外部操作仍需使用者授權']};
export const install=environment=>installOfficial(descriptor,environment);
