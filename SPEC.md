# D_sh-are_in_cc 規格（子代理共用）

目標：把 DSH（DeepSeek Harness）插件轉成 **Claude Code mod**（Claude Code 的 JavaScript 擴充模組，見 `docs/claude-mod-api/`）。做法是兩個程式合作：

- **mod**：跑在 Claude Code 裡，沒有 Node.js、沒有 DOM，只能用引擎給的 `$` 介面。負責把 DSH 插件的能力接到 Claude Code（註冊工具、加系統提示、攔截工具呼叫、斜線指令、呼叫模型、子代理、介面）。
- **子程序宿主**：由 mod 在對話開始時用 `$.process.spawn` 啟動的 Node 程式。裡面跑「官方 DSH 宿主」（沿用 `lib/dsh-host.mjs`、`lib/dsh-host-worker.mjs` 和 `lib/modules/`），真正執行 DSH 插件的程式碼。

本資料夾是 `<Codex 工作區>/outputs/dsh-to-codex`（GPT 的工作區）0.4.0 的複製品（快照時間見 `docs/snapshot-date.txt`）。**不要修改 `outputs/dsh-to-codex`**，那邊由 GPT 負責。

## 必讀

- `docs/claude-mod-api/reference.md`：mod 的完整說明。
- `docs/claude-mod-api/types/claude-code.d.ts`：這個版本（2.1.308）的 API 型別，約 22,000 行，用搜尋找需要的段落，例如 `'tool.call'`、`register: (tool: ToolSpec)`、`process: {`、`http: {`、`prompt.compose`、`model: {`、`agent: {`、`$.plugin.root`。
- `docs/claude-mod-api/examples/`：可以直接載入的 mod 範例。
- `docs/codex-0.4.0-review.md`：0.4.0 在 100 個來源上的失敗原因，其中四個轉換器錯誤要在這裡修。
- Claude Code 命令列：`<Claude Code 執行檔>`（不在 PATH 上）。只准用 `plugin validate`、`plugin test`、`--version`、`--help`。

## 生成的 Claude 插件長這樣

```
<輸出資料夾>/
  .claude-plugin/plugin.json      { "name", "version", "description" }，name 只用小寫英文、數字、連字號，最多 64 字
  hooks/hooks.json                { "modules": ["./register.ts"] }
  hooks/register.ts               由 templates/claude-mod/register.ts 產生，設定以 JSON 字面值嵌入（取代佔位字串 "__DSH_BRIDGE_CONFIG__"）
  skills/                         DSH 插件原本的技能，原樣複製
  runtime/claude-host.mjs         子程序宿主入口（esbuild 打包成單檔）
  runtime/dsh-host-worker.mjs     官方宿主工作程序（沿用）
  runtime/host-env/               內附官方 DSH 套件（沿用 host-build）
  runtime/source-deps/            來源的正式依賴（沿用 source-deps）
  runtime/settings.json           子程序宿主的設定
  source/                         DSH 插件原始碼（不修改）
  conversion-report.json
```

不要產生 `bin/` 資料夾（儲存到 claude.ai 的插件會被拒絕）。

## 嵌入 register.ts 的設定（`__DSH_BRIDGE_CONFIG__`）

```json
{
  "schemaVersion": 1,
  "pluginName": "<plugin.json 的 name>",
  "displayName": "<DSH 插件名稱>",
  "hostEntry": "runtime/claude-host.mjs",
  "node": "node",
  "startupTimeoutMs": 120000,
  "callTimeoutMs": 60000,
  "features": { "tools": true, "commands": true, "systemPrompt": true, "interception": false },
  "staticTools": [ { "dshName": "...", "name": "...", "description": "...", "inputSchema": {} } ]
}
```

`staticTools` 是靜態分析時已知的工具，可以是空陣列；工具清單以子程序回報的為準。

## 子程序宿主的通訊協定

**啟動**：mod 執行 `$.process.spawn({ argv: [config.node, `${$.plugin.root}/${config.hostEntry}`], cwd: $.plugin.root, env })`。

**子程序 → mod**：標準輸出，每行一個 JSON 物件。標準錯誤只放日誌。

| `type` | 內容 |
|---|---|
| `ready` | `{ port, token, tools, commands, promptSections, interception, metadata }`。`tools` 是 `{ dshName, name, description, inputSchema }` 陣列；`commands` 是 `{ name, description }` 陣列；`promptSections` 是 `{ id, text }` 陣列 |
| `fatal` | `{ code, message }`，啟動失敗，之後程序結束。`message` 必須是第一行真正的錯誤原因，例如 Cordis 的 `property "inject" is already declared as accessor` 或 esbuild 的 `Could not resolve "x"`，不要只寫「插件沒有啟動」 |
| `toolsChanged` | `{ tools }` |
| `promptChanged` | `{ promptSections }` |
| `request` | `{ id, method, params }`：子程序要 mod 代辦的事（見下面「反向請求」） |
| `log` | `{ level, text }` |

**mod → 子程序**：`$.http.fetch("http://127.0.0.1:<port>/rpc", { method: "POST", headers: { authorization: "Bearer <token>", "content-type": "application/json" }, body })`，`body` 是 `{ method, params }`，回應是 `{ result }` 或 `{ error: { code, message } }`。子程序只綁 127.0.0.1、隨機埠、隨機 32 位元組權杖，沒有權杖的請求一律拒絕。

| `method` | `params` → `result` |
|---|---|
| `tools.call` | `{ name, args, callId }` → `{ content: [{ type: "text", text }], isError }` |
| `tools.cancel` | `{ callId }` → `{}` |
| `commands.run` | `{ name, args }` → `{ text }` |
| `interception.pre` | `{ tool, input }` → `{ decision: "allow" \| "deny", reason?, input? }` |
| `interception.post` | `{ tool, input, result }` → `{ result? }` |
| `reply` | `{ id, result }` 或 `{ id, error }`：回覆子程序的反向請求 |
| `status` | `{}` → `{ state, plugin, tools, services, unsupported }` |
| `dispose` | `{}` → `{}`，之後子程序結束 |

## 反向請求（子程序請 mod 代辦）

子程序裡的 DSH 服務模組，遇到只有 Claude Code 才做得到的事，就送 `request`，等 mod 用 `reply` 回覆：

| `method` | mod 怎麼做 | 預設 |
|---|---|---|
| `approval.request` | 問使用者，例如用 `$.ui` 的對話框（查型別找可用的方法）；只有使用者明確同意才回 `{ approved: true }` | 開啟 |
| `model.complete` | `$.model.complete({ prompt, system })` | **關閉**，要使用者在 `userConfig` 開啟 `allowModelCalls` |
| `agent.spawn` | `$.agent.spawn({ prompt, subagentType? })` | **關閉**，同上 |
| `ui.notify` | `$.ui.toast` 或 `$.ui.status` | 開啟 |

關閉時回 `{ error: { code: "DISABLED", message } }`，子程序把它變成 DSH 的明確錯誤，不能假裝成功。

## 分工與檔案歸屬（三個子代理同時做，不要改別人的檔案）

| 負責 | 檔案 |
|---|---|
| 子程序宿主（A） | `lib/claude-host/**`、四個錯誤修正會碰到的 `lib/inspect.mjs`、`lib/modules/**`、`lib/dsh-host.mjs`、`lib/dsh-host-worker.mjs`、`lib/host-build.mjs`、`lib/source-deps.mjs`、`package.json`、`package-lock.json`、`node_modules/`、`tests/claude-host-*.test.mjs`、`tests/fix-*.test.mjs` |
| mod 範本（B） | `templates/claude-mod/**`、`tests/claude-mod/**` |
| 轉換器（C） | `lib/claude-package.mjs`、`lib/converter-claude.mjs`、`bin/d-sh-are-in-cc.mjs`、`tests/claude-package-*.test.mjs`、`README.md` |

**介面約定：**

- A 提供 `lib/claude-host/build.mjs`：`export async function buildClaudeHost({ outputDir })`，把子程序宿主打包成 `<outputDir>/runtime/claude-host.mjs`。子程序執行時讀 `<outputDir>/runtime/settings.json`，格式和現有 `lib/converter.mjs` 為官方宿主引擎產生的 `runtime/settings.json` 相同（現有 `lib/host-server.mjs` 讀的就是這個）；需要新增的欄位寫在 `lib/claude-host/README.md`。
- B 提供 `templates/claude-mod/plugin.json`（佔位字串 `__DSH_PLUGIN_NAME__`、`__DSH_PLUGIN_VERSION__`、`__DSH_PLUGIN_DESCRIPTION__`，並宣告 `userConfig`：`allowModelCalls`、`allowAgents`，布林，預設 false）、`templates/claude-mod/hooks.json`、`templates/claude-mod/register.ts`（含字串字面值 `"__DSH_BRIDGE_CONFIG__"`，連同引號一起換成 JSON）。
- C 產生插件時：`runtime/host-env`、`runtime/dsh-host-worker.mjs`、`runtime/source-deps`、`runtime/settings.json` 用現有 `lib/converter.mjs` 官方宿主那條路徑的同一套函式產生；再呼叫 A 的 `buildClaudeHost`；再用 B 的範本寫 `.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.ts`。A、B 的檔案還沒寫好時，先照介面寫，測試裡可以用替身。

## 要在這裡修的四個轉換器錯誤（見 docs/codex-0.4.0-review.md）

1. 分析器與 `lib/modules/index.mjs` 把 Cordis 的方法名稱（`inject`、`provide`、`emit`、`plugin`、`on`、`get`、`set`、`extend`、`isolate`、`scope` 等）當成服務。改成：只承認已知的 DSH 服務名稱；其他名稱標為「不確定」，不呼叫 `root.provide`；`installModules` 每個服務各自 try/catch，一個失敗不能拖垮全部。
2. 內附官方環境缺官方套件（`@deepseek-ai/dsh-credentials`、`dsh-storage-domain`、`dsh-mcp-client`、`dsh-client-connection`、`dsh-agent`、`dsh-plugin-manager`、`@deepseek-ai/schemastery`）。先查 npm 上 0.2.1-rc.2 有沒有這些套件（`npm view <pkg>@0.2.1-rc.2 version`，只查不裝）；有就加進 `package.json` 和內附清單（安裝要加 `--ignore-scripts`），沒有就在報告列出並給明確錯誤。
3. 選用依賴：esbuild 打包時找不到的套件，改成標記為外部（external），讓它在執行時才失敗，例如寫一個 esbuild 外掛，對無法解析的裸套件名稱回傳 `external: true`。
4. 有範圍前綴的套件名稱（`@scope/name`）不能直接當 `entryId`：轉成 `scope-name` 這類合法字串。

每項都要有單元測試。

## 禁止事項

- 不修改 `<Codex 工作區的上層>/` 底下的任何東西（GPT 的工作區，包括 `outputs/dsh-to-codex` 和 `work/`）、使用者的 `~/.claude` 設定、`~/.claude/dev-mods`，也不安裝插件到使用者的 Claude Code。
- 不執行 `claude -p`、`claude plugin eval` 或任何會跑模型的指令；不呼叫付費 API；不登入任何服務；不發送訊息。
- 執行第三方 DSH 插件只限這四個已經跑過的來源：`dsh-plugin-finance-data`、`dsh-plugin-academic-writing`、`dsh-plugin-education`、`dsh-plugin-translation`（位置在 `<Codex 工作區>/work/dsh-corpus-100/sources/`，只讀不改；裡面的 `candidates.json` 在上一層 `work/dsh-corpus-100/`）。其他測試一律用自己寫的合成 DSH 插件。
- 安裝依賴一律加 `--ignore-scripts`。
- 金鑰、權杖不寫進日誌、報告或測試輸出。
- 不把「列得出工具」說成「功能可用」。沒有根據的推測要標明「假說」。
