# 子程序宿主（Claude Code mod 啟動的 Node 程式）

這個資料夾是 `SPEC.md` 裡「子程序宿主」的實作。mod 用 `$.process.spawn` 啟動它，它在裡面用官方 DSH 宿主（`lib/dsh-host.mjs`、`lib/dsh-host-worker.mjs`、`lib/modules/`）執行 DSH 插件，再把工具、指令、提示詞段落、攔截規則用 `SPEC.md` 規定的協定交給 mod。

## 檔案

| 檔案 | 作用 |
|---|---|
| `main.mjs` | 入口。讀 `runtime/settings.json`，啟動宿主，把協定物件逐行寫到標準輸出 |
| `host.mjs` | 核心：載入官方宿主、迴圈位址上的 JSON-RPC 伺服器、工具與指令呼叫、`status`、關閉流程 |
| `reverse.mjs` | 反向請求通道（子程序請 mod 代辦；`request` 行與 `reply`） |
| `cause.mjs` | 啟動失敗時找出「第一行真正的原因」，包含 Cordis 的 `pending (waiting for service: x)` |
| `tools.mjs` | Claude Code 工具名稱（只含英數字、`_`、`-`，最長 64）與結果內容 |
| `build.mjs` | `buildClaudeHost({ outputDir })`：用 esbuild 打成 `<outputDir>/runtime/claude-host.mjs` |
| `../modules/claude/` | 給 Claude Code 用的 DSH 服務模組：`approval`、`llm`、`agents`、`subagents`、`userQuestions`、`shell`、`subprocess`、`credentials`、`storageDomain`、`jobs`、`connection`、`commands`、`systemPrompt`、攔截 |

`build.mjs` 只寫 `runtime/claude-host.mjs`。`runtime/dsh-host-worker.mjs`、`runtime/host-env/`、`runtime/source-deps/`、`runtime/settings.json` 由現有的官方宿主建置（`lib/host-build.mjs` 的 `buildOfficialHost`）產生，這裡沿用。

執行時 `claude-host.mjs` 以自己所在位置的上一層當外掛根目錄（`<root>/runtime/claude-host.mjs`）。除錯時可加 `--root <資料夾>`。

## runtime/settings.json

由 `lib/host-build.mjs` 產生。子程序宿主使用的欄位：

`entry`（相對於 `source/`，必填）、`packageDir`、`name`、`config`、`services`（預設 `timer、fs、settings、webServer、commands、skills`）、`serviceConfig`、`plan`、`moduleOptions`、`sourceNodePaths`、`workspace`、`passEnv`、`homeMode`、`initializeTimeoutMs`、`callTimeoutMs`、`cancelGraceMs`、`lenientOutput`、`allowTools`、`interception`、`stateId`、`stateMode`。


### 新增欄位 `claudeHost`（全部選填）

| 欄位 | 預設 | 說明 |
|---|---|---|
| `pluginName` | 環境變數 `DSH_CLAUDE_PLUGIN_NAME` | Claude Code 看到的插件名稱。有設定時，`interception.pre/post` 對 `mcp__<pluginName>__*` 這類自己的工具一律放行，避免政策跑兩次 |
| `reverseTimeoutMs` | `{ "exec.check": 600000, "approval.request": 600000, "model.complete": 300000, "agent.spawn": 600000, "ui.notify": 10000, "ui.ask": 600000, "prompt.submit": 30000 }` | 每種反向請求等 mod 回覆的上限（毫秒）；逾時視為錯誤 `REVERSE_REQUEST_TIMEOUT`。可只填要改的方法 |
| `interception` | 自動偵測 | `true` 強制回報 `interception: true`。自動偵測看插件有沒有 `tools/pre-execute`、`tools/post-execute` 的監聽器，或 `settings.interception === true` |
| `idleExitMs` | 不啟用 | 多久沒有任何 RPC 就自行關閉；每個 RPC 重設計時 |
| `stateDir` | 見下 | 絕對路徑，直接指定狀態資料夾 |
| `stateRoot` | 見下 | 絕對路徑，狀態根目錄 |
| `runtimeRoot` | `<root>/runtime/host-env` | 官方套件所在位置（測試與開發用，例如指向轉換器專案根目錄） |
| `workerPath` | `<root>/runtime/dsh-host-worker.mjs` | 官方宿主工作程序（測試與開發用） |

狀態資料夾：`claudeHost.stateDir` → 否則 `stateMode: "package"` 或沒有 `stateId` 時用 `<root>/.state` → 否則 `<DSH_CLAUDE_STATE_ROOT 或 claudeHost.stateRoot 或 ~/.dsh-to-claude/state>/<stateId>`。不會寫到 `~/.claude`，也不會寫到外掛快取之外的 Claude Code 目錄。

### 環境變數（由 mod 在 `spawn` 的 `env` 設定，皆選填）

| 變數 | 說明 |
|---|---|
| `DSH_CLAUDE_STATE_ROOT` | 狀態根目錄（絕對路徑）。mod 不設定；用轉換器的 `--state-root`（寫進 `claudeHost.stateRoot`）或測試時由環境提供 |
| `DSH_CLAUDE_WORKSPACE` | 檔案服務（`fs`）的工作目錄，絕對路徑；`settings.workspace` 優先。**mod 在 `session.start` 以工作階段的 `cwd` 設定** |
| `DSH_CLAUDE_PLUGIN_NAME` | 同 `claudeHost.pluginName`。**mod 以 `plugin.json` 的 name 設定** |
| `DSH_CLAUDE_PARENT_PID` | mod 所在行程編號；該行程消失後子程序自己結束（每 5 秒檢查）。**mod 目前不設定**：Claude Code 的 `$` 介面沒有提供行程編號。子程序靠引擎在模組卸載或 `stream.return()` 時終止它，工作程序在連線中斷時自己結束；Claude Code 被強制終止時子程序可能殘留（假說，未實測） |

要傳給插件的環境變數（API 金鑰等）仍然要列在 `passEnv`；官方宿主不會繼承其他變數。例外：`DSH_CLAUDE_SECRET_NAMES` 列出的名稱會自動加進白名單（見下）。

### 安全限制（SECURITY-PLAN.md 約定 3～6）

| 變數 | 說明 |
|---|---|
| `DSH_CLAUDE_SECRET_NAMES` | mod 從插件選項 `secret_<名稱>` 傳入的金鑰變數名稱，`,` 分隔。加進工作程序的環境變數白名單；值不寫日誌。`credentials` 缺金鑰時點名 `secret_<名稱>` |
| `DSH_CLAUDE_ALLOW_DIRECT_EXEC` | `1`：工作程序多給 `--allow-child-process`、`--allow-worker`、`--allow-addons`、`--allow-wasi`（原生模組、WASI、背景執行緒都能繞過限制，所以跟著同一個開關） |
| `DSH_CLAUDE_EXTRA_FOLDERS` | `;` 分隔的絕對路徑，加進可讀寫資料夾；相對路徑忽略並寫一行日誌 |
| `DSH_CLAUDE_ALLOW_INTERCEPTION` | 不是 `1` 時 `ready.interception` 一律 `false`；插件有攔截監聽器時 `metadata.interceptionState.note` 與 `status.restricted` 註明「插件有攔截監聽器但使用者沒有開啟」。`interception.pre` 只回 `allow`／`deny`（不回改寫的 `input`） |

**Node 權限模式**：工作程序以 `--permission`（Node 22.13／23.5 以前是 `--experimental-permission`）啟動。可讀：插件資料夾、狀態資料夾、工作資料夾、`runtimeRoot`、工作程序所在資料夾、`sourceNodePaths`、額外資料夾（同時加入實際路徑）；可寫：狀態資料夾（含暫存 `tmp/`）、工作資料夾、額外資料夾。Node 24 沒有網路相關旗標，網路不受限。`claudeHost.sandbox: false` 關閉；Node 不支援時照常啟動，`ready.metadata.sandbox.reason` 與 `status.restricted` 寫「此電腦的 Node 版本不支援權限限制」。

權限模式下工作程序做不到、改由宿主程序做的事：建立 SDK 範圍連結（`fs.symlink` 需要完整權限）、版本別名外殼、執行時編譯插件入口（esbuild 要開程式；反向請求 `host.compileEntry` 在宿主內處理，不送 mod）、`subprocess.resolveExecutable` 的 PATH 搜尋。官方檔案服務（`dsh-fs-local`）的寫入：Node 權限模式一律停用以檔案代號改權限（`FileHandle.chmod`／`fchmod`，錯誤沒有路徑），工作程序記住每個代號開啟時的路徑，改成以路徑 `chmod`（照常檢查權限）；Windows 覆寫既有檔案時要用原生模組 koffi 複製 DACL、呼叫 `ReplaceFileW`，這兩步經內部請求 `fs.win32` 在宿主做（`win32-fs.mjs`，兩個路徑都必須在可寫資料夾內）。JavaScript 版 `fs.realpath(Sync)` 會從磁碟根目錄逐段檢查，被擋時改用 `.native` 版。工作程序內 `fs.existsSync` 對不准讀的路徑回 `false`（Node 原本會丟 `ERR_ACCESS_DENIED`，官方設定檔載入器往上層找 `node_modules` 時因此失敗）。插件的 Node 子程序（開啟直接執行程式時）會繼承同樣的限制（Node 的行為）。

**執行指令**：`shell`、`subprocess` 的實際 `child_process` 呼叫在宿主程序（`exec-support.mjs` 的 `createExecRunner`），工作程序經 IPC（`{event:'exec', op:start|write|end|kill}`，回 `execEvent`）請宿主執行，串流輸出、終止、逾時照舊。宿主自己再檢查一次工作目錄並送 `exec.check`（`{ tool:"Bash", command, cwd, why }`，逾時 600 秒）；mod 回 `UNKNOWN_METHOD`（或舊 mod 的 `UNSUPPORTED`）時退回 `approval.request`。所以插件直接對 IPC 送訊息也跳不過檢查。

**阻礙通知**：權限錯誤（`ERR_ACCESS_DENIED`、`ERR_DLOPEN_DISABLED`）、缺金鑰、`DSH_MODULE_UNSUPPORTED`、執行指令被拒，都變成四段式訊息（`lib/modules/claude/blocked.mjs`）：寫進工具結果，並送 `ui.notify`（`warning`）。同一種阻礙（同程式／同資料夾／同金鑰）一次工作階段只通知一次，總共最多 12 則。插件自己 `try/catch` 吞掉的 `child_process`／`fs` 權限錯誤也會通知（工作程序包住這些函式）。啟動時被擋：`fatal.code` 是 `ERR_ACCESS_DENIED`，`message` 是壓成一行的四段式訊息。插件設定驗證失敗（Cordis `ValidationError: invalid config:`）：`fatal.code` 為 `PLUGIN_CONFIG_INVALID`，訊息點名欄位與它讀的環境變數、`secret_<名稱>`，另附 `fatal.missing: [{ path, env, option }]`。`status` 多 `sandbox` 與 `restricted`（目前受限的功能：`kind、what、why、how、impact、code、count`）。

## 預先編譯的插件入口（`runtime/plugin.mjs`）

插件放在很深的路徑時（Windows 上 `esbuild.exe` 的完整路徑超過約 260 字元），工作程序啟動時才呼叫 esbuild 會出現 `spawn ...esbuild.exe ENOENT`。所以轉換器（`lib/converter-claude.mjs`）在轉換時就把插件入口編譯好：

- `runtime/plugin.mjs`：編譯結果。設定與執行時編譯相同（共用 `lib/precompile-entry.mjs`），只有寫死路徑的地方不同：`@deepseek-ai/*` 保持裸套件名稱並設為外部（執行時靠 `<stateDir>/compiled/node_modules/@deepseek-ai` 解析）；`import.meta.url`、`createRequire` 的入口 URL、`__dirname`／`__filename` 都用佔位字串 `__DSH_SOURCE_ROOT_URL__/<相對於 source/ 的路徑>`。整個外掛資料夾搬家後仍正確。
- `runtime/plugin.meta.json`：`{ schemaVersion, entry, lazyDependencies }`。`entry` 要和 `settings.entry` 一致，否則視為過期，不使用。
- 執行時：`host.mjs` 把 `runtime/plugin.mjs`（或 `claudeHost.precompiledEntry`）當 `precompiledEntry` 傳給工作程序；檔案存在且 meta 相符時，工作程序把佔位字串換成 `source/` 的真實 file URL，寫到 `<stateDir>/compiled/plugin.mjs`，不啟動 esbuild。檔案不在、meta 不符就退回原本的執行時編譯。
- 轉換時編譯失敗不會讓轉換失敗：報告 `notes` 多一筆 `PRECOMPILE_SKIPPED`，執行時再編譯一次（原因通常會重現）。`convertToClaude` 的 `precompileEntry: false` 可關閉。
- `__dirname`／`__filename`：CommonJS 風格的來源檔被打成 ES 模組後沒有這兩個變數，所以每個用到（且自己沒有宣告）的檔案開頭補上由該檔案 URL 算出的定義；預先編譯和執行時編譯兩條路相同。

## 版本相容（`lib/compat/`）

宿主內附的官方套件是 0.2.1-rc.2；為舊版或特定版本寫的插件靠以下五種相容處理啟動。每一種實際用到時，`ready.metadata.compat` 多一列（只記名稱，不記任何值）。

- **一個 patch 掛多列插件**（`cordis.patch.yml` 的 `insert` 有多列 `<套件名>/<子路徑>`，子路徑是 package.json 的 `exports`；例：dsh-agentmail）：`lib/inspect.mjs` 產生 `plan.entries`，轉換器寫進 `settings.entries: [{ id, name, entry, config }]`，預先編譯成 `runtime/plugins/<id>.mjs`（`plugin.meta.json` 的 `entries`）。工作程序把每列各自載入成獨立 Cordis 插件；任何一列沒啟動，整個宿主就算啟動失敗。`settings.config[<列 id>]` 覆蓋該列設定的最上層鍵。
- **`!!js` 設定值**：只接受 `process.env.X`、字面值、`! && || ?? == != === !== ?:` 與 `Number/String/Boolean(...)`，不用 eval（`lib/compat/dsh-expression.mjs`）。值在啟動時從工作程序的環境（只含 `passEnv` 傳入的變數）取得，沒有就是 undefined（該鍵移除，`compat` 列 `config-env-missing` 記變數名稱）；超出語法的式子不執行，變成 undefined 並記 `config-expression-unsupported`。轉換器把式子讀到的變數名稱加進 `passEnv`，不把值寫進任何檔案。
- **`@deepseek-ai/dsh-llm` 0.1 的舊匯出**（`lib/compat/index.mjs`）：編譯插件入口時，`@deepseek-ai/dsh-llm` 換成「真實 0.2 套件逐一重新匯出 + `CallId`（= 0.2 的 `ToolCallId`，都是原樣傳回字串）、`assertNever`、`deepFreeze`（0.2 移到 `@deepseek-ai/dsh-util-values`，程式碼相同）」。兩版都沒有的名稱仍是編譯錯誤；行為不等價的舊名稱會列在 `unavailable`，被使用時才丟明確錯誤（目前沒有）。
- **精確版本檢查**（`lib/compat/version-alias.mjs`）：來源的 peerDependency 要求剛好某版本、且該版本列在 `VERSION_ALIASES`（目前只有 `@deepseek-ai/dsh-tools` 0.2.1-alpha.2 對內附 0.2.1-rc.2：`defineTool`、`ToolArgsError`、`validateArgs` 程式碼相同，差異只在 PTC（程式化工具呼叫）內部）時，轉換器寫 `settings.versionAliases`。工作程序把 `<stateDir>/compiled/node_modules/@deepseek-ai` 改成真實資料夾：其他套件是連結，被別名的套件是外殼套件——package.json 回報要求的版本，檔案 `export *` 重新匯出內附的真實套件。所以插件拿到的是同一份模組（同一個工具登記表類別），不是第二份。
- **`apply()` 的傳回值**（`lib/compat/apply-result.mjs`）：Cordis 只接受 undefined、dispose 函式、promise 或 generator 作為 `apply()` 的傳回值，其他值丟 `TypeError: Invalid effect`（4.0.1 與 4.0.5 相同，不是版本差異）。例：dsh-ark9canvas 傳回 `{ api, getConfig, dispose(){} }`。物件有 `dispose` 函式時改成以該函式當清理函式，其他物件／原始值忽略（`compat` 列 `apply-return-value` 記鍵名）。

## 協定細節（對 `SPEC.md` 的補充與偏離）

**沒有偏離**，以下是 SPEC 沒有寫死的部分，mod 實作時請依此：

- `ready` 行的 `metadata` 內容：`host`、`versions`、`services`、`unsupported`（尚未對應的功能清單）、`modules`（每個服務模組的狀態）、`moduleDiagnostics`、`lazyDependencies`（打包時改成延後載入的選用依賴）、`listeners`（`tools/pre-execute`／`post-execute` 監聽器數量）、`pluginName`。**列在 `tools` 裡不代表功能可用**，請看 `unsupported` 和 `moduleDiagnostics`。
- `fatal` 的 `message` 是第一行真正的原因（Cordis 錯誤、esbuild 的 `Could not resolve "x" (檔案:行:欄)`、缺少的官方匯出、缺少的服務名稱），已去除顏色碼、壓成一行、遮蔽疑似金鑰。額外欄位 `services`：等不到的服務名稱陣列（沒有時省略）。`code` 例如 `HOST_PLUGIN_INACTIVE`、`SOURCE_DEPENDENCY_MISSING`、`HOST_DEPENDENCY_MISSING`、`DSH_API_EXPORT_MISSING`、`UNSUPPORTED_ENTRY`、`SETTINGS_UNREADABLE`、`SETTINGS_INVALID`。`fatal` 之後程序以代碼 1 結束。
- `tools.call` 的 `name` 可以是 Claude 名稱或 `dshName`。工具本身失敗（拋例外、逾時、被政策拒絕）一律回 `{ content: [{ type: "text", text: "<代碼>: <訊息>" }], isError: true }`，逾時與重啟還會多一個 `code` 欄位（`HOST_TIMEOUT`、`HOST_RESTARTED`、`HOST_EXITED`）；沒有這個工具才回 RPC 錯誤 `TOOL_NOT_FOUND`。只回傳文字區塊，圖片等其他區塊會換成一行說明，不會默默丟掉。
- 工具逾時（`callTimeoutMs`，或工具自己宣告的 `timeoutMs`）後，官方宿主會重啟工作程序並重新初始化，之後的呼叫照常；重啟當下其他進行中的呼叫得到 `HOST_RESTARTED`，不會自動重試。
- `tools.cancel`：中止對應的呼叫（插件透過官方 `exec.signal` 收到）。callId 不存在也回 `{}`。mod 端的 `$.http.fetch` 被中止（連線中斷）也會取消正在跑的工具。
- `commands.run`：`args` 是字串（陣列會用空白接起來）。處理函式在沒有 DSH Agent 的情況下被直接呼叫（官方 `commands.execute` 需要 Agent 與對話紀錄，所以無法使用，也不寫入 DSH 對話紀錄）。處理函式如果用到 `agent.session`、`agent.send` 等會得到明確錯誤。處理函式回報 `kind: "error"` 時回 RPC 錯誤 `COMMAND_FAILED`；找不到回 `COMMAND_NOT_FOUND`。只能執行全域登記的命令。
- `interception.pre`：跑官方 `tools/pre-execute` 瀑布。`deny` 回 `{ decision: "deny", reason }`；`ask` 會送 `approval.request` 給 mod，使用者同意才放行；宿主本身出錯時一律拒絕（fail closed）。`interception.post`：跑 `tools/post-execute` 與 `tools/result`。`block` 把結果換成 `{ content: [回饋文字], isError: true }`；`accept` 帶新內容時替換結果；沒有變更回 `{}`。DSH 規則是用 DSH 的工具名稱寫的，Claude Code 內建工具（`Bash`、`Read`…）名稱不同時規則可能不會命中（假說，尚未逐個插件對照）。`interception` 為 `false` 時這兩個方法直接放行，不進工作程序。
- `status` 另有 `activeCalls`、`pendingReverseRequests`。
- `reply` 對不明或已逾時的 `id` 回 `{}`（忽略），不當成錯誤。
- HTTP：只接受 `POST /rpc`。沒有或錯誤的權杖一律 401（權杖用固定時間比對）、錯誤路徑 404、錯誤方法 405、JSON 無法解析 400、本文超過 8 MiB 413。權杖只出現在 `ready` 那一行，不寫進任何日誌或 `fatal`。
- `dispose` 先回 `{}`，再關閉工作程序與伺服器，程序以代碼 0 結束。收到 `SIGTERM`／`SIGINT` 也一樣。標準輸出寫入失敗（mod 已經不在）時也會結束。

## 反向請求怎麼回覆

| `method` | 子程序送出的 `params` | mod 的 `reply` |
|---|---|---|
| `approval.request` | `{ toolName, callId?, reason, argumentSummary }`。`argumentSummary` 只有欄位名稱和型別／長度，**不含任何參數值**；敏感欄位名稱顯示 `[redacted]` | `{ result: { approved: true } }` 才放行；其他一律視為拒絕 |
| `model.complete` | `{ prompt, system?, maxTokens?, temperature? }`；多輪訊息會壓成 `[user]\n…\n\n[assistant]\n…` 的單一 `prompt`；不支援工具與圖片 | `{ result: { text } }`（接受 `{ text }`、字串或 `{ content: [{type:"text",text}] }`） |
| `agent.spawn` | `{ prompt, subagentType? }`；`prompt` 內含 `setup` 收集到的靜態提示詞段落與先前往返的文字 | `{ result: { text } }`（也接受字串或 `{ result: "…" }`） |
| `ui.notify` | `{ level: "info"｜"warning"｜"error", text }` | 任何結果，內容不看 |
| `prompt.submit` | `{ text, source? }`：插件的 `agent.followup`（主對話代理，見下方 `conversation`）；`source` 是插件給訊息的 DSH `source` | `{ result: { queued: true } }`；插件選項 `allowFollowups` 關閉（預設）時回 `DISABLED`，畫面只通知一次 |
| `ui.ask` | `{ question, header?, options?(最多 4 個標籤), multiSelect? }`，一次一題 | `{ result: { answer } }`（`$.ui.ask` 回的文字：選項標籤、逗號相接的多選、或「Other」自由輸入）；使用者關閉或非互動模式回 `{ error: { code: "USER_DISMISSED" } }` |

DSH 本身沒有「通知」服務。`ui.notify` 在兩種情況送出：插件自己 `ctx.emit('bridge/notify', { level, text })`；以及工具逾時、工作程序重啟或結束。

回 `{ error: { code: "DISABLED", message } }` 時：

- `model.complete` → DSH 錯誤 `DSH_MODEL_CALLS_DISABLED`，訊息提到 `allowModelCalls`；
- `agent.spawn` → `DSH_AGENTS_DISABLED`，提到 `allowAgents`；
- `approval.request` → `DSH_APPROVAL_DISABLED`。

其他錯誤或逾時：核准視為「未核准」（`unavailable`／`cancelled`），模型與子代理直接把錯誤丟給插件。任何情況都不會假裝成功。

模組說明（每個模組的 `descriptor.methods` 逐方法寫明「完整／部分／不支援」；呼叫沒有對應的方法一律丟 `DSH_MODULE_UNSUPPORTED`，不假裝成功）：
- `llm`：`complete()`、`stream()`（把單次結果包成一次性串流，chunk 格式與官方 `BlockAssembler` 相容）、`listProviders()`、`listModels()`。`resolveModelInfo`、`registerAdapter`、`prepareCall` 等其餘方法呼叫就丟 `DSH_MODULE_UNSUPPORTED`。
- `agents`：`create()` 回傳的代理，每次 `send()` 是一個全新的一次性子代理（先前往返文字附在提示詞裡），不是長期對話。沒有排隊與中途插話、`resume`。`send()` 的失敗會在 `whenIdle()` 才丟出。`currentInitiator()` 回 `undefined`、`withInitiator`／`withoutInitiator` 直接執行操作、`requireInitiator()` 明確失敗（沒有 DSH 代理迴圈，所以永遠沒有發起代理）。
- `subagents`：供應商只有 `spawn`（`list()`、`getProvider()`，所有選用能力皆 false，沒有 `prepareContinuable`）。`startActivation()` 經 `agent.spawn` 啟動一次性子代理，回 `{ childId, result, dispose }`，`result` 是 `{ output: [文字區塊], stopReason }`；`agentOptions`（供應商、模型、推理強度）被忽略，`agentPreset`、`outputSchema` 明確失敗。`interrupt`、`waitForChildren`、`listChildren`、`drainDescendants` 只涵蓋本程序啟動的子代理。`startContinuable`、`sendMessage` 等持續對話方法丟 `DSH_MODULE_UNSUPPORTED`（需要 DSH 對話與收件匣）。預設關閉：`result` 以 `DSH_AGENTS_DISABLED` 拒絕。
- `userQuestions`：`ask({ questions })` 每題送一個 `ui.ask`，mod 用 `$.ui.ask` 問使用者並阻塞。超過 4 個選項時把完整清單寫進問題文字改用自由輸入，再以文字比對還原選項。使用者關閉或非互動模式：`DSH_USER_QUESTION_CANCELLED`。`askTimed`、`answer`、`attachWait` 不支援。
- `shell`、`subprocess`：由宿主程序用 Node `child_process` 執行（見上方「執行指令」）；**每次執行前送 `exec.check`**（mod 不認得時退回 `approval.request`，以下描述的是退回時的內容）（`reason` 只寫程式名稱，例如 `Run the local program "node" on this computer`，`argumentSummary` 只有欄位名稱與長度，不含任何值）；使用者不同意、逾時、沒有回覆或被關閉都不執行，丟 `DSH_EXEC_DENIED`／`DSH_EXEC_APPROVAL_UNAVAILABLE`／`DSH_APPROVAL_DISABLED`。工作目錄必須在工作區（`profileContext.cwd`，即 `DSH_CLAUDE_WORKSPACE`）之內，符號連結與 junction 解析後才比對，先檢查目錄、再問核准。環境變數沿用官方做法：名稱含 `KEY`／`PASSWORD`／`SECRET`／`TOKEN` 與 `DSH_*` 不傳給子程序，明確給的才傳。**沒有沙箱**（`sandboxPolicy` 被忽略），指令具有目前使用者的權限。`shell` 在 Windows 用 Windows PowerShell（`-EncodedCommand`，結束代碼等於最後一個原生指令），其他平台用 bash（沒有則 sh）。`subprocess` 沒有 PTY（`spawnTerminal` 不支援）、沒有 spill 檔與 `control` 通道；`spawn()` 同步回傳控制代碼，`done` 在核准通過之前等待。
- `credentials`：憑證參考名稱就是環境變數名稱，每次呼叫即時讀取（要用 `--pass-env` 傳進子程序）。找不到或是空字串丟 `DSH_CREDENTIAL_MISSING`：「缺少金鑰 XXX，請設定環境變數」，不回傳空值。`describe()` 只回是否已設定，`set`／`unset`／記錄類方法不支援。
- `storageDomain`（同時提供 `storage`）：沿用官方 `@deepseek-ai/dsh-storage` 與 `@deepseek-ai/dsh-storage-domain`，後端是本專案的檔案 JSON 後端 `claude-kv`（每個 domain 一個檔案，放在宿主狀態資料夾的 `storage/`，整份原子改寫；宣告 `per-record` 的 domain 也存成單一檔案，資料正確但每次寫入改寫整份，沒有 `backupRecord`）。
- `jobs`：行程內的背景工作登記，沿用 `dsh-jobs` 的介面（`start`、`list`、`get`、`read`、`readAt`、`kill`、`wait`、`remove`、`attachController`、`events.subscribe`）。紀錄不持久，不寫 DSH 對話紀錄，也沒有模型端的工作工具；`start` 不要求 `attachController`。
- `connection`：DSH 前端（瀏覽器）連線在 Claude Code 沒有對象。`rpc.handle`、`rpc.intercept`、`fetch.register`、`register` 登記成功但不會有任何前端呼叫，只記錄頻道名稱；`requestRejection`、`authenticatedUrl` 不存在（插件自行偵測並警告）。模組在安裝結果裡附 `unsupported` 與一筆 `partial` 診斷。只適合「沒有前端時工具仍有意義」的插件，面板與卡片不會出現。（`ready` 的 `metadata.unsupported` 目前由 `lib/dsh-host-worker.mjs` 寫死，尚未收錄模組回報的 `unsupported`。）
- `conversation`（`lib/modules/claude/conversation.mjs`，不是服務）：mod 用 RPC `session.event` 回報對話裡發生的事（`{ sessionId?, kind: user｜tool-call｜tool-result｜turn-end｜model, … }`），這裡照官方格式（`{ seq, time, type, data }`）在插件的 context 上發 `session/event`：`turn/start`、`user/message`、`tool/call`、`tool/result`、`assistant/message`、`turn/end`（`answer`→`completed`、`aborted`、`refusal`→`blocked`、`error`）。mod 只在插件有 `session/event` 監聽器（`ready.metadata.listeners.sessionEvent`）而且插件選項 `shareConversation` 開著時才送；子代理的回合、斜線指令、`isMeta` 的通知不送。整個對話也是一個代理，啟動完成時發 `agent/created`：`status`（回合中是 `running`）、`lastReply`、`whenIdle()`、`followup()`／`send()`（送 `prompt.submit` 反向請求）；`cancel()` 明確失敗。沒有 DSH 的步驟、思考、串流與 `todo/write`。
- `sessionQuery`：由 `conversation` 提供，`listSessions()` 只有目前這個對話，`readSession(id)` 回這個對話轉來的事件（最多 2000 筆，更早的捨棄並寫在 `projection.notes`）；讀別的對話丟 `DSH_SESSION_SCOPE`。
- `agentDefaultModel`（`default-model.mjs`）：`currentSelection()` 回 `{ provider: 'anthropic', model }`，`model` 是 mod 在啟動時用 `session.event`（`kind: model`）回報的工作階段模型，還沒回報時是 `claude`。不能切換模型。
- 入口沒有宣告 `inject` 卻用到服務的插件（例如直接用 `ctx.systemPrompt`）：工作程序把靜態分析找到的服務（`plan.host.services` 中已知的 DSH 服務）當成它的 `inject`，`metadata.compat` 記一筆 `inject-inferred`。
- `sessions` 在 Claude 宿主沒有對應模組：插件若注入它，會得到「No generic module maps this DSH service」的明確錯誤（呼叫時才丟）。讀取目前對話請用 `sessionQuery`。`workspaceRegistry`、`sessionController` 同樣沒有模組。

## 四個轉換器錯誤（這個專案的修正位置）

| 錯誤 | 修正 | 測試 |
|---|---|---|
| 把 Cordis 方法名稱當成服務 | `lib/cordis-context.mjs`（加入 `scope`）、`lib/dsh-services.mjs`（已知 DSH 服務名單；加入 `shell`、`subagents`、`subprocess`、`workspaceRegistry`、`connection`、`sessionController`、`agentDefaultModel`）、`lib/inspect.mjs`、`lib/modules/index.mjs`（來自分析、又不在名單內的名稱不建立模組列；每個服務各自 try/catch） | `tests/fix-cordis-names.test.mjs` |
| 內附環境缺官方套件 | 七個套件在 npm 的 0.2.1-rc.2（`@deepseek-ai/schemastery` 為 3.18.5）都存在，且已經在 `package.json`、`package-lock.json`、`node_modules` 與內附清單中，不需要再安裝 | `tests/fix-official-packages.test.mjs` |
| 選用依賴打包失敗 | `lib/lazy-dependencies.mjs`：`import()`、`require()`、`require.resolve()` 找不到時保持執行期呼叫；宣告為選用（`optionalDependencies`、選用 peer）的靜態 `import` 變成「用到才丟 not installed」的模組；其他靜態 `import` 找不到仍然是 `Could not resolve` | `tests/fix-optional-imports.test.mjs` |
| 範圍套件名稱當 `entryId` | `lib/entry-id.mjs`：`@scope/name` → `scope-name` | `tests/fix-entry-id.test.mjs` |

## 測試

`tests/claude-host-*.test.mjs`（協定、啟動失敗原因、反向請求、單元、`dsh-plugin-finance-data` 端對端）和 `tests/fix-*.test.mjs`。測試裡的 mod 是 `tests/claude-host-helpers.mjs` 的小型替身，**沒有**在真正的 Claude Code 裡跑過。

## 假的 `dsh` 命令列（`runtime/dsh-cli`）

有些 DSH 插件不是呼叫 DSH 服務，而是自己執行命令列程式 `dsh --profile headless [--patch <overlay>] <提示詞>`，讓它在背景跑一輪無人值守的對話（例如 dsh-bili-scroll 的 `bili_run`）。使用者電腦沒有 DSH 時，這類插件會報「找不到 dsh」。轉換器因此多產生一個假的 `dsh`，把這種呼叫改成 Claude 子代理。

| 檔案 | 作用 |
|---|---|
| `dsh-cli.mjs` | 假 `dsh` 的程式本體（解析參數、讀 overlay、組提示詞、連回宿主）。`build.mjs` 的 `buildDshCli` 把它打成 `runtime/dsh-cli/dsh.mjs`（單檔，無依賴） |
| `cli-endpoint.mjs` | 宿主內的內部端點 `POST /dsh/run`：只綁 127.0.0.1、隨機埠、**獨立的** 32 位元組權杖（與 RPC 權杖不同），權杖只放在環境變數，不寫日誌、不寫檔案、不出現在 `ready` |
| `build.mjs` → `buildDshCli({ outputDir, sourceDir })` | 寫 `runtime/dsh-cli/{dsh.mjs, dsh.cmd, dsh, node_modules/@deepseek-ai/dsh/lib/bin.js}`；若插件原始碼含 `@deepseek-ai/dsh/lib/bin` 字樣（用模組解析找 dsh），再在 `<輸出>/node_modules/@deepseek-ai/dsh/` 放一份同樣的套件，讓 `require.resolve` 找得到 |

**插件怎麼找到它**（宿主在啟動官方宿主時傳 `env`，這個欄位不受 `passEnv` 白名單限制）：

- `PATH`（Windows 同時 `Path`）最前面是 `runtime/dsh-cli`，所以 `dsh`、`dsh.cmd` 命中它；
- `DSH_CLAUDE_CLI_ENDPOINT`、`DSH_CLAUDE_CLI_TOKEN`：內部端點位址與權杖；`DSH_CLAUDE_NODE`：用來跑 `dsh.mjs` 的 node 路徑；
- 官方宿主本來就會把 `PATH` 傳給插件（`OS_ENV`），這裡只是把值換成「stand-in 在最前面」。

**支援**：`--profile <名稱>`、`--patch <檔案>`（可重複）、提示詞（最後一個參數，或不給時從標準輸入）、`--version`、`--help`。**其他一律明確報錯、不假裝成功**：`plugin`、`web` 等子命令、`--dump-config` 等其他參數、多個提示詞參數。

**結束碼**：0 完成（子代理最後文字印在 stdout）；1 失敗（連不到端點、權杖錯誤、`agent.spawn` 失敗或逾時、回覆沒有文字）；2 命令列不支援或 overlay 讀不到／不是 YAML；3 `DISABLED`（使用者沒開 `allowAgents`，stderr 會寫出要開哪個選項）。

**提示詞怎麼組**：固定的說明（你是 Claude Code 子代理、沒有人可以回答問題、最後一則訊息就是命令輸出）＋「Relayed settings」＋ `=== Task ===` 後面原樣附上提示詞。overlay 解析後能帶過去的只有文字資訊：overlay 內的系統提示／附加指示（`systemPrompt`、`instructions` 等欄位）、工具允許／禁止名單（DSH 工具名稱，僅供參考）、模型名稱（忽略）。**MCP 伺服器無法掛進 Claude 子代理**：`$.agent.spawn` 只有 `prompt`、`description`、`subagentType`，沒有 MCP 設定欄位；提示詞會明說「這個 MCP 伺服器沒有附上」，stderr 也會印一行提醒。子代理只能用 Claude Code 當時已有的工具。profile 名稱只寫進提示詞，不套用。

**限制與設定**（`runtime/settings.json` 的 `claudeHost.dshCli`，選填）：`false` 完全關閉；物件可設 `maxConcurrent`（預設 2，超過回 `BUSY`）、`subagentType`。呼叫端中斷連線（`dsh` 被殺）會取消宿主這邊的等待，但已啟動的子代理是否停止由 Claude Code 決定。`ready.metadata.dshCli` 表示端點是否啟用。沒有 `runtime/dsh-cli/dsh.mjs`（舊的輸出）時完全不啟用，環境不變。

測試：`tests/claude-host-dsh-cli.test.mjs`。

## 宣告 DSH 前端的插件：哪些轉換、哪些略過

`package.json` 有 `dsh.client` 的插件（原生介面插件）以前一律略過（`not-applicable`）。現在 `isPureNativeUi`（`lib/converter-claude.mjs`）只在「沒有工具、技能、命令、MCP，也沒有下列任一種行為」時才略過。行為由 `lib/inspect.mjs` 靜態找出，記在 `plan.host.behaviors`（`kind`、`name`、`path`、`line`）：

| `kind` | 看哪種寫法 | 算不算 |
|---|---|---|
| `web-provider` | `x.registerSearchProvider(...)`、`x.registerFetchProvider(...)` | 算 |
| `llm-provider` | `x.registerAdapter(...)`、`x.registerProvider(...)`（要是屬性呼叫；單獨的函式 `registerProvider()` 不算） | 算 |
| `llm-hook` | `ctx.on('llm/…')`、指定 `resolveModelInfo`／`streamWithRegistration`／`adapterStream` | 算 |
| `tool-hook` | `ctx.on('tools/pre-execute'｜'tools/post-execute'｜'tools/result')` | 算 |
| `agent-hook` | `ctx.on('agent/pre-…')`、`ctx.on('prompt/…')` | 算 |
| `prompt-section` | `….systemPrompt.section(...)` | 只當證據，不算：實測三個插件都是替 DSH 對話代理或 DSH 網頁入口寫的段落 |

只有計時器或 `webServer` 路由的原生介面插件仍視為純介面（那些路由與計時器是替它自己的前端服務）；沒有宣告前端的插件本來就不走這個判斷。轉換時若同時有前端與行為，`conversion-report.json` 的 `notes` 會寫「前端部分不轉換」。

**列為轉換不等於可用。** 例如 `registerConfigurableProviders`（只是把設定頁掛到 DSH 介面）不算；視覺插件依賴的 `attachments` 服務在 Claude 宿主沒有對應模組，插件能啟動但它的圖片轉寫不會作用。

### 官方網頁工具

插件用到 `web` 服務時，子程序宿主會掛載官方 `@deepseek-ai/dsh-tool-web`，`web_search`、`web_fetch` 出現在 `ready.tools`，搜尋與抓取走插件用 `registerSearchProvider`／`registerFetchProvider` 登記的後端；沒有可用後端或缺金鑰時回官方或插件的明確錯誤（工具仍會列出）。

插件自己登記同名工具（例如 `web_fetch`）時，官方預先掛載的那一個讓位，插件的優先，宿主寫一行 `[web] 插件登記了同名工具 web_fetch，官方網頁工具讓位` 到日誌，不再以 `tool "web_fetch" is already registered` 啟動失敗。插件之間同名仍然是重複錯誤。測試：`tests/fix-native-ui-classification.test.mjs`。


## DSH 原插件的獨立畫面（2026-10-28）

原插件的設定頁、主頁、側欄頁籤與浮窗封裝成獨立網頁，安裝後用 `/<轉換後插件名稱>-ui` 在內建瀏覽器開啟。各環節的檔案、提供與不提供的畫面位置和服務、涵蓋率估計，寫在 [DEVELOPMENT.md 的「原插件畫面」](../../DEVELOPMENT.md#原插件畫面)。

子程序宿主這邊相關的部分：`ui.mjs` 啟動與關閉畫面伺服器；`host.mjs` 依 `runtime/ui/manifest.json` 是否存在決定要不要給工作程序 `uiBackend`，`uiRpc` 轉發時帶上 `execution`，畫面關閉時取消進行中的操作。

這項功能作用於之後重新轉換的插件；既有轉換產物不會自動改寫。轉換器本身的已開市場程序也需重新啟動才能載入新程式。

驗證分開記錄：CC 自帶插件測試環境、真正子程序與本機 HTTP 操作、桌面瀏覽器實際操作，不能互相替代。詳見 [本次驗證](../../docs/original-ui-validation-20261028.md)。

