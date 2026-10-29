# 整合驗證紀錄（不呼叫模型）

驗證者：整合測試子代理（D）。日期：2026-10-23。環境：Windows 11、Node 24.16、Claude Code 2.1.308 命令列。

目標：證明三個部分（子程序宿主 A、mod 範本 B、轉換器 C）接在一起能運作，並找出彼此約定不一致的地方。**全程沒有呼叫模型**，沒有執行 `claude -p`、`plugin eval`，沒有安裝插件，沒有寫入 `~/.claude`，沒有改動 `<Codex 工作區的上層>/` 底下的任何東西（驗證前後來源資料夾沒有任何較新的檔案，且測試比對 `package.json` 內容不變）。

（補充：我沒有任何指令寫入 `~/.claude`。`~/.claude` 裡有今天更新過的檔案，來自本工作階段的宿主與 Codex 插件；我檢查到 `plugins/plugin-directory-cache-v2.json` 的更新時間（15:40）早於我的第一個指令（約 16:20），但沒有逐一排除 `claude plugin test`／`validate` 自己可能寫的快取。）

## 1. 驗證方法與它的限度

- 「替身 `$`」：Claude Code 的 mod 只能在引擎裡跑。`claude plugin test` 的環境沒有行程與網路，所以另寫了一個替身（`tests/e2e-claude-harness.mjs`）：用 esbuild（打包工具）去掉**轉換器實際產生的** `hooks/register.ts` 的型別，原樣載入；替身提供 `$.process.spawn`（真的 `child_process`）、`$.http.fetch`（真的 `fetch`）、`$.clock`、`$.tool.register`、`$.command.register`、`$.ui.*`、`$.model.complete`、`$.agent.spawn`，以及 `on(...)` 的掛鉤串（`next`、`.catch`）。
- 真的部分：產生出的 `register.ts`、產生出的 `runtime/claude-host.mjs`（真的子行程）、標準輸出的 JSON 行、127.0.0.1 上帶權杖的 HTTP、官方 DSH 宿主工作程序（再下一層的子行程）、來源插件程式碼。
- 替身**不是**引擎：`next` 的語意、`$.ui.ask` 的回傳形狀、`stream.return()` 如何終止行程，都是我依型別檔與文件做的近似（假說：足以驗證這些路徑，但不等於引擎的行為）。所以下面的「已驗證」只表示「三個部分彼此對得上」，不表示「在 Claude Code 裡可用」。

## 2. 測試數字

| 項目 | 修正前 | 修正後 |
|---|---|---|
| `node --test tests/*.test.mjs` | 306 個：298 通過、0 失敗、8 略過 | 317 個：309 通過、0 失敗、8 略過（約 98 秒） |
| `node --test tests/claude-mod/*.test.mjs` | 16 個：16 通過 | 16 個：16 通過 |
| `claude plugin test tests/claude-mod/fixture`（引擎自己的測試執行器） | 47 通過、0 失敗（5 個檔案） | 47 通過、0 失敗（5 個檔案） |
| `claude plugin validate tests/claude-mod/fixture` | 通過（有警告） | 通過（有警告） |
| `claude plugin validate tmp/e2e/<四個轉換結果>` | — | 四個都「通過，有警告」 |

- 8 個略過都是 Codex 側的既有測試（需要 Codex 命令列或 Codex 時代的語料），與 Claude 無關。
- 新增 11 個：`tests/e2e-claude.test.mjs` 8 個、`tests/claude-host-units.test.mjs` 1 個、`tests/claude-package-convert.test.mjs` 2 個。
- `claude plugin validate` 的警告：缺 `author`；以及「插件目錄」上架檢查缺 README、LICENSE、圖示。這些只影響上架，不影響用 `--plugin-dir` 載入（假說：該檢查只用於上架）。

## 3. 三方約定的交叉檢查

| 約定 | 結果 |
|---|---|
| `ready` 內容：`port`、`token`、`tools`、`commands`、`promptSections`、`interception`、`metadata` | 一致（B 的 `parseReady` 與 A 的 `ready` 欄位相同；端到端實測） |
| 工具名稱對應 | 一致：A 的 `claudeToolName`、B 的 `cleanName`、C 呼叫 A 的 `claudeToolName` 產生靜態清單，字元規則相同；`mcp__<插件名>__<名稱>` 的插件名與 `plugin.json` 的 name 相同，A 的自家工具放行規則可以對上 |
| `tools.call` / `tools.cancel` / `commands.run` / `status` / `dispose` / `reply` 參數與回傳 | 一致（端到端實測；斜線指令 `hello`/`broken` 也走過） |
| `interception.pre` | 一致（實測 deny、ask 轉成對話框、allow） |
| `interception.post` | **不一致，已修**：mod 送字串結果，A 回 `{ result: { content, isError } }`；B 原本把這個物件整個轉成 JSON 字串當作備註，現在取出文字（register.ts:806） |
| `approval.request` | **不一致，已修**：A 送 `{ toolName, callId, reason, argumentSummary }`；B 只讀 `question/message/description/title` 與 `tool/input`，所以使用者看不到插件給的理由和參數摘要（register.ts:888-893）。B 的替身宿主也改成送 A 真正的形狀（`tests/claude-mod/fake-host-core.mjs`） |
| `model.complete`：A 送 `prompt`、`system`、`maxTokens`、`temperature` | 一致（`temperature` 被 mod 忽略；DSH 的模型代號不轉送，用工作階段的模型） |
| `agent.spawn`：A 送 `prompt`、`subagentType` | 一致（`description` 由 mod 補預設值） |
| `ui.notify`：A 送 `{ level, text }` | 一致 |
| 反向請求 `DISABLED` | 一致：預設兩個開關關閉，子程序把它變成明確的 DSH 錯誤（端到端實測，且沒有任何模型或子代理呼叫發生） |
| mod 設定的環境變數 | **缺口，已補**：A 讀 `DSH_CLAUDE_STATE_ROOT`、`DSH_CLAUDE_WORKSPACE`、`DSH_CLAUDE_PLUGIN_NAME`、`DSH_CLAUDE_PARENT_PID`，B 原本只設 `DSH_CLAUDE_BRIDGE`、`DSH_CLAUDE_PLUGIN_ROOT`（A 根本不讀這兩個）。現在 mod 設 `DSH_CLAUDE_PLUGIN_NAME`（插件名）與 `DSH_CLAUDE_WORKSPACE`（`session.start` 的 `cwd`）。`STATE_ROOT` 由轉換器的 `--state-root` 寫進 `settings.claudeHost.stateRoot`。`PARENT_PID` **沒人設**：Claude Code 的 `$` 沒有提供行程編號（見第 6 節） |
| `runtime/settings.json` 的欄位 | 一致：C 只寫 `claudeHost.stateRoot`，A 讀它；`stateId`、`stateMode`、`interception`、`allowTools` 沿用官方格式 |
| 嵌入 register.ts 的設定 | 一致：B 讀 `features`、`staticTools`、兩個逾時；C 不寫 `env`（選填，不需要）。C 寫的 `staticTools[].inputSchema` 原本是 `{}`，不是合法的物件描述 → **已修**為 `{ type: 'object' }`，B 的 `normalizeTool` 也會補 `type: 'object'`（register.ts:114） |
| 佔位字串替換安全 | 一致：C 用 `split/join`（不會誤解 `$&`），輸出的 JSON 把 U+2028/2029 跳脫；B 的 `build-fixture` 用函式取代。測試涵蓋含引號與 `$&` 的描述。已知小缺口：JSON 物件字面值的 `"__proto__"` 鍵在 TypeScript 裡會改原型而不是當一般欄位（假說：實際工具描述不會出現，沒有處理） |
| 逾時 | **不一致，已修**：mod 與子程序的呼叫逾時都是 `callTimeoutMs`，mod 常在子程序給出精確錯誤前先放棄。現在 mod 多等 5 秒（register.ts:183、750、1096） |

## 4. 修正清單（逐項）

| # | 檔案:行 | 內容 |
|---|---|---|
| 1 | `templates/claude-mod/register.ts:888-893` | 核准對話框讀 A 真正送的 `reason`、`argumentSummary` |
| 2 | `templates/claude-mod/register.ts:806-` | `interception.post` 的替換結果取文字，不再把物件轉成 JSON 字串 |
| 3 | `templates/claude-mod/register.ts:509` 附近、`:1021` | spawn 時設 `DSH_CLAUDE_PLUGIN_NAME` 與 `DSH_CLAUDE_WORKSPACE`；`session.start` 記下 `cwd` |
| 4 | `templates/claude-mod/register.ts:617、639` | **停止子程序的競態**：原本送 `dispose` 後立刻 `stream.return()` 殺行程，子程序來不及自己收尾（實測結束訊號是 `SIGTERM`）。現在等讀取迴圈自己結束再殺；實測正常結束碼 0 |
| 5 | `templates/claude-mod/register.ts:114` | 工具輸入描述缺 `type` 時補 `type: 'object'` |
| 6 | `templates/claude-mod/register.ts:782、799` | 攔截的兩個 RPC 補 `isBusy`：使用者還在回答核准對話框時不計逾時（原本只有工具與命令有） |
| 7 | `templates/claude-mod/register.ts:183、750、1096` | mod 的呼叫逾時 = `callTimeoutMs` + 5 秒 |
| 8 | `lib/modules/claude/interception.mjs:33-34` | **攔截規則要求核准時，等待使用者的時間被 20 秒的政策訊號截斷**（超過 20 秒就當作「已取消」）。核准請求不再帶那個訊號，由反向通道自己的 600 秒上限管 |
| 9 | `lib/converter-claude.mjs:241` | 靜態工具的 `inputSchema` 由 `{}` 改為 `{ type: 'object' }` |
| 10 | `lib/converter-claude.mjs:65-71、167、196-197、240-258` | 狀態邏輯（見第 7 節） |
| 11 | `README.md`、`lib/claude-host/README.md` | 文件對齊上面的修正 |
| 12 | 測試 | `tests/claude-mod/fixture/tests/lifecycle.test.ts`（環境變數、等子程序自己結束）、`prompt-commands.test.ts`（restart 要推進時鐘）、`tools.test.ts`（逾時 8000）、`tests/claude-mod/fake-host-core.mjs`（核准形狀）、`tests/claude-package-convert.test.mjs`（`inputSchema`、狀態規則 2 個新測試）、`tests/claude-host-units.test.mjs`（新增 1 個：核准不帶 20 秒訊號） |
| 13 | 新增 | `tests/e2e-claude-harness.mjs`、`tests/e2e-claude.test.mjs`（8 個測試）；修改後重新產生 `tests/claude-mod/fixture`（`node tests/claude-mod/build-fixture.mjs`） |

## 5. 端到端結果（四個允許的來源 + 合成插件）

轉換指令：`node bin/d-sh-are-in-cc.mjs convert <來源> --out tmp/e2e/<名稱> --no-cli --no-install-deps --state-root <短路徑>`（約 5 秒；輸出約 55 MB，因為內附官方套件）。`tmp/e2e/` 是預設轉換，`tmp/e2e-lenient/` 是加 `--lenient-output` 的轉換。

每個來源都做了：轉換 → 載入產生出的 `register.ts` → `session.start` → 子行程送出 `ready` → 註冊工具 → `prompt.compose` → `/<插件>-status` → 經 mod 的 `tool.call` 路徑真的呼叫工具 → `session.end` → 子行程以結束碼 0 自己離開，下一層的工作程序也消失。

| 來源 | 工具名稱 | 提示詞段落 | 呼叫結果 |
|---|---|---|---|
| dsh-plugin-finance-data | `finance_data` | 進入 `prompt.compose`（874 字元） | `ratio`/`pe`，price 50、eps 5 → `pe = 10.00`；eps 0 → 明確錯誤 |
| dsh-plugin-academic-writing | `academic_writing` | 進入 | `checklist` 有輸出 |
| dsh-plugin-education | `edu_kit` | 進入 | `lesson` 有輸出 |
| dsh-plugin-translation | `translate_kit` | 進入 | `segment` 有輸出；`memo_add` 把檔案寫到**工作階段目錄**的 `.dsh/translation-memo.md`，`memo_get` 讀得回來（證明 `DSH_CLAUDE_WORKSPACE` 接通） |

另外的實測：

- **預設轉換（不加 `--lenient-output`）下，四個插件大部分動作會失敗**：官方輸出驗證（內附 0.2.1-rc.2）拒絕含 `undefined` 欄位的結果，錯誤是 `value is not lossless JSON`。以 finance_data 為例，`format`、`return`、`checklist`、`risk` 失敗，`ratio`、`value` 成功。mod 把這個錯誤原樣當作工具錯誤回報，沒有編造結果（測試涵蓋）。加 `--lenient-output`（只丟掉值為 `undefined` 的欄位）後，同樣動作都成功。原因是否來自版本差異（來源宣告 `^0.1.0-rc.6`）是**假說**：沒有在來源宣告的版本上對照過。這與 Codex 側 0.3.1 的結論相同（見 `docs/codex-0.4.0-review.md`）。
- 引擎殺掉子行程（`stream.return()` 的替身行為）：子行程立即結束，工作程序在連線中斷後自己結束，沒有殘留。
- 子行程環境：沒有權杖進入環境；`/status` 輸出沒有權杖。
- 合成插件，等不到服務（`inject` 含沒人提供的 `mysteryService`）：子行程送 `fatal`，真正原因「Plugin did not activate: waiting for service: mysteryService」原樣出現在狀態列、對話記錄、`/status` 的 `last error`，工具呼叫的拒絕文字也是它；行程以結束碼 1 離開。
- 合成插件，用到已知但 Claude 沒有對應的服務 `shell`：子程序**不會**啟動失敗，而是掛上一個「用到就報錯」的替身服務；呼叫 `ctx.shell.run` 得到明確錯誤（`No generic module maps this DSH service`）。轉換器已把它列為 `SERVICE_UNSUPPORTED`。這與任務裡「等 `shell` 會啟動失敗」的設想不同，是宿主有意的設計（四個轉換器錯誤修正之一）。
- 合成插件，核准與模型：核准對話框的問句帶出插件給的理由、秘密參數值沒有出現、只有選「Approve」才放行（選「Deny」、自由輸入「yes」、對話框被關掉都不放行）；`allowModelCalls`、`allowAgents` 預設關閉時工具得到 `allowModelCalls`／`allowAgents` 的明確錯誤，模型與子代理一次都沒有被呼叫；開啟後 `model.complete` 的 `prompt`、`system` 正確送達，回覆文字回到插件；`agent.spawn` 的回覆經 `turn.complete` 取回。攔截：`Bash` 被規則拒絕、`Write` 的 `ask` 轉成核准對話框、`Read` 的後置封鎖以備註形式送給模型。
- 觀察（環境相關）：工作程序在狀態資料夾下建暫存目錄，狀態路徑很長時 Windows 會 `ENAMETOOLONG`（本專案路徑超過 190 字，用預設的 `~/.dsh-to-claude/state` 不會）。該錯誤是以 `fatal` 的真正原因顯示的。

## 6. 狀態邏輯的判定

C 回報四個轉換都是 `partial`，原因有二：

1. 「需要 DSH 宿主服務：systemPrompt」（`HOST_SERVICES`）：**過時的 Codex 時代規則**。它只是「來源需要哪些服務」的清單，被放進 `omitted`。Claude 版經 `prompt.compose` 提供系統提示（端到端實測提示詞確實進入），真正不支援的服務已由服務對應表的 `SERVICE_UNSUPPORTED` 逐項列入 `omitted`。已修：`HOST_SERVICES` 不再算「沒轉」，只留在 `notes`（`HOST_SERVICES_MAPPED`）。
2. 版本範圍不符（`^0.1.0-rc.6` 對內附 0.2.1-rc.2）：**不是過時規則，但分類錯了**。它不是「沒轉」，卻也不是無害的提醒：實測（第 5 節）預設轉換下大部分動作會失敗。已修：移到新的 `conversion.warnings`，狀態規則改為「`omitted` 與 `warnings` 都空才是 `converted`，否則 `partial`」，並在 `conversion.reason` 寫出原因與 `--lenient-output` 的建議。

結論：四個來源的 `partial` 仍然正確，但理由從兩個變成一個（版本不符）。`tests/claude-package-convert.test.mjs` 新增兩個測試，涵蓋「只有 systemPrompt 需求 → `converted`」「版本不符 → `partial` 且有原因」「不支援的服務 → `partial`」。

## 7. 仍需要真正的 Claude Code 工作階段（含模型）才能確認的事項

以下都**沒有**被驗證，上面的替身是我的近似：

1. 引擎如何把掛鉤回傳的 `{ result: [{ type: 'text', text }] }` 變成模型讀到的 `tool_result`；`{ deny }` 的文字模型怎麼看到、是否標成錯誤。
2. 工具呼叫進行中呼叫 `$.ui.ask`：對話框是否出現、回傳形狀（我假設回傳選項標籤字串）、自由輸入（「Other」）與被關閉時的行為、`-p` 模式沒有人可問時的行為、使用者想很久時引擎有沒有自己的逾時。
3. `stream.return()` 在引擎裡確實終止子行程（Windows 上是否連同子行程的子行程）；`/clear`、`--resume`、模組重新載入、結束 Claude Code 時 `session.end` 是否一定觸發。Claude Code 被強制終止時，子程序可能殘留（`DSH_CLAUDE_PARENT_PID` 沒人設，假說：未實測）。
4. `prompt.compose` 的重新計算時機：`promptChanged` 後 mod 只更新內部文字，下一次引擎組合時才會用到，但引擎是每回合組合還是快取，沒有確認；`scope: 'session'` 與段落順序的實際效果。
5. 在 `session.start` 掛鉤裡 `await $.tool.register`：文件說「下一次提示起生效」，第一個回合模型是否看得到工具；同名再註冊是否「取代」（文件說會，沒實測；這裡靜態工具之後會以真正的輸入描述再註冊一次）。
6. `tool.call` 事件的實際形狀：我假設參數平鋪在事件上，旁邊有 `tool`、`tool_use_id`（`agentId`、`requestMeta` 被排除）。DSH 工具若有叫 `tool` 的參數會被吃掉。完整名稱 `mcp__<插件>__<工具>` 的總長度是否碰到 API 的 64 字上限（假說：外掛名長時可能）。
7. `userConfig`（`allowModelCalls`、`allowAgents`）在 `--plugin-dir` 載入時怎麼設定、`register(on, options)` 是否真的收到值。
8. `$.model.complete`、`$.agent.spawn` 的真實行為、費用與子代理最終回覆的取得（我用 `turn.complete` 的 `agentId` 比對，是從型別檔推出來的）。
9. 攔截在真實工具名稱與輸入上命不命中（DSH 規則用 DSH 的工具名稱撰寫，假說：與 Claude 內建工具名稱不同時可能不命中）。
10. 技能（`skills/`）的內容在 Claude 裡是否合用；那些內容原樣複製，可能提到 DSH 專屬工具。
11. 這四個插件在 Claude Code 裡的實用性（只驗證到「接得起來、能呼叫」，沒有驗證模型是否會正確使用）。

## 8. 試用單一轉換結果（只列指令，沒有執行）

已轉換好、加了 `--lenient-output` 的資料夾：`tmp/e2e-lenient/finance-data`（另有 `academic-writing`、`education`、`translation`）。在新的終端機，用單次工作階段載入（不安裝）：

```
"<Claude Code 執行檔>" --plugin-dir "<本專案資料夾>/tmp/e2e-lenient/finance-data"
```

之後用 `/dsh-plugin-finance-data-status` 看子程序狀態（正常應顯示 `host: ready`），工具名稱是 `mcp__dsh-plugin-finance-data__finance_data`。注意：這會執行來源插件的程式、用你的模型額度；子程序的持久資料在 `%TEMP%\dsh-e2e-state`（轉換時由 `--state-root` 指定）。要重新轉換別的插件：

```
node bin/d-sh-are-in-cc.mjs convert <來源資料夾> --out <新資料夾> --lenient-output --state-root <絕對路徑>
```

## 9. 重跑

```
node --test tests/*.test.mjs                  # 含 tests/e2e-claude.test.mjs（語料不在時各自乾淨地略過；DSH_E2E_CORPUS 可指定語料位置）
node --test tests/claude-mod/*.test.mjs
claude plugin test tests/claude-mod/fixture
```

`DSH_E2E_KEEP=1` 保留 e2e 的暫存資料夾。

## 真實 Claude Code 對話測試（Haiku 5.5，2026-10-23）

用 `claude -p --model claude-haiku-5-5 --plugin-dir <轉換結果>` 跑真的對話，總花費約 0.07 美元。紀錄在 `tmp/haiku-run/`。

| 項目 | 結果 |
|---|---|
| finance-data（寬鬆輸出）| 3 次呼叫都正確：`pe` 50/5 = 10.00、`pe` 150/6 = 25.00、報酬率 100→121 兩期 = 21% / 年化 10% |
| education（寬鬆輸出）| 2 次都正確（`classstats`、`grade`）。`stdev` 用的是母體標準差，輸出沒標明，這是插件本身的行為 |
| translation（寬鬆輸出）| 2 次都正確（`check`、`segment`） |
| academic-writing（寬鬆輸出）| 子程序啟動失敗：`The service was stopped: spawn ...\esbuild.exe ENOENT`。同一個插件複製到較短的路徑就能啟動。`tmp\e2e-lenient\academic-writing\...\esbuild.exe` 長 265 字元，finance-data 是 257，原因是 Windows 路徑長度限制（確切是哪一層出錯是假說）。實際安裝到 `~/.claude/plugins/cache/...` 的路徑短很多 |
| finance-data（預設嚴格）`format` | 照預期失敗，模型看到 `tool "finance_data" returned invalid output: value is not lossless JSON` |
| 系統提示 | 插件的「Finance data guidance」6 條有進入模型的系統提示（模型逐字引用，和原始碼一致） |
| `/dsh-plugin-finance-data-status` | 指令有註冊，但在 `-p` 模式下沒有被執行，模型把它當成一般文字。要用互動模式再試（假說：`-p` 不分派 mod 的斜線指令） |
| 殘留子程序 | 全部對話結束後沒有殘留 |

確認了：工具結果 `{ result: [{ type: 'text', text }] }` 模型能正確讀到；`prompt.compose` 加的段落會進入系統提示。

建議修正：轉換時就先把插件入口編譯好，執行時不必再啟動 esbuild，可避開路徑長度問題，啟動也更快。
