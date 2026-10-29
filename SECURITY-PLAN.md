# 安全與使用體驗計畫

狀態：第 1～8、10 項已實作，程式測試通過；第 9 項（上架前祕密掃描）是上架時的流程。尚未在真正的 Claude Code 對話中用模型實測。

## 原則

1. 風險定位：這個方案等於「安裝第三方 Claude Code 插件」，插件程式碼用使用者帳號的完整權限執行。所有保護都是降低風險，不是消除風險，說明文件要講清楚。
2. 保護不能讓第一次使用變難。能自動判斷的不問使用者；要問的，一次問清楚。
3. **每一個被擋下的動作，都要讓使用者知道「哪裡被擋、為什麼、怎麼放行」**（見下方「阻礙通知」）。不能出現「功能沒反應、也不知道為什麼」的情況。

## 要做的保護

| # | 項目 | 做法 |
|---|---|---|
| 1 | 子代理開關 | `allowAgents` 改為預設開啟；每次插件開子代理都顯示一則通知（哪個插件、做什麼）。`allowModelCalls` 同理 |
| 2 | 執行指令 | `shell`、`subprocess` 模組改用 `$.tool.check` 問 Claude Code，結果與 Claude 自己用 Bash 一致（略過權限模式就不問，一般模式跳 Claude Code 的確認，禁止清單照樣生效）。取代現在每次都跳的自製確認視窗 |
| 3 | 插件自己開程式、讀寫資料夾外的檔案 | 工作程序用 Node 權限模式（`--permission`）：只准讀寫插件資料夾、狀態資料夾、工作資料夾；禁止直接開程式（正當需求走第 2 項）。網路無法用此方式限制（假說） |
| 4 | 對外發文 | 每個插件一個選項，三種模式：每次確認（預設）、自動發、不准發。第一則發文的確認視窗提供「這次送出／以後都自動發／不要送出」三個按鈕。自動發時仍保留：發出後通知與發文紀錄、每小時／每天數量上限、插件自己的開關。工具清單由轉換器靜態偵測加上安裝前審查標記 |
| 5 | 攔截 Claude Code 的工具 | 預設關閉，要在插件選項開啟；開啟後也只准擋下，不准改寫輸入 |
| 6 | 金鑰存放 | 插件需要的金鑰改用 `userConfig` 的敏感欄位（存在系統安全儲存區），不再建議用 `--config` 寫進 `runtime/settings.json` |
| 7 | 金鑰遮蔽 | mod 把工具結果交給 Claude 前、核准視窗顯示指令前，用已知金鑰值精準替換成 `[已遮蔽]` |
| 8 | 安裝前審查 | 先下載不安裝 → 轉換器固定規則掃描（開程式、讀寫檔案、連網路、金鑰、對外發文、混淆程式碼，附檔案與行數）→ Claude 子代理讀標出的位置並用白話回報 → 使用者同意才轉換安裝。掃描結果直接顯示，不經 AI 轉述；審查指示寫明原始碼內的文字一律當資料。混淆程式碼回報「無法審查，不建議安裝」 |
| 9 | 上架前 | 一律跑 plugin-authoring 的祕密掃描；只上架授權允許轉發的插件並附原授權聲明 |
| 10 | 說明文件 | README 寫明：執行第三方程式碼、權限同使用者帳號、會先審查但不是保證、建議不要在略過權限確認模式下使用會發文或開子代理的插件 |

## 阻礙通知

### 每則通知都包含四件事

1. **什麼被擋了**：哪個插件、哪個動作（例如「B 站插件想發一則留言」）。
2. **為什麼**：哪一項保護擋的，一句白話。
3. **怎麼放行**：具體到哪個設定或按哪個按鈕；能一鍵放行的就給按鈕。
4. **不放行會怎樣**：哪個功能因此不能用。

用使用者的語言，不用代碼當主體（代碼可以放括號裡給除錯用）。

### 通知送到哪裡

| 情況 | 管道 |
|---|---|
| 工具呼叫被擋 | 寫進工具結果，Claude 會在對話裡轉述給使用者，使用者也可以直接問 Claude 怎麼辦 |
| 背景發生的事（子代理啟動、插件啟動失敗、工作程序重啟） | 畫面通知（`$.ui.toast`），同時記一筆到插件狀態 |
| 長期狀態（哪些功能目前受限） | 插件狀態指令與 DSH 插件市場面板：每個插件列出「目前受限的功能」與放行按鈕 |
| 安裝前就知道的限制 | 安裝前審查報告與市場面板的標籤 |

### 各種阻礙與通知內容

| 阻礙 | 通知內容（範例） | 放行方式 |
|---|---|---|
| 插件直接開程式被權限模式擋 | 「網頁搜尋插件想直接執行 `cloudflared`，被安全限制擋下，所以『建立通道』功能無法使用。」 | 插件選項「允許插件直接執行程式」 |
| 插件讀寫資料夾外的檔案被擋 | 「Obsidian 插件想讀取 `D:\notes`，不在允許的資料夾內。」 | 插件選項「額外允許的資料夾」 |
| 指令被 Claude Code 權限拒絕 | 沿用 Claude Code 的拒絕原因，加上是哪個插件要執行 | Claude Code 的權限設定 |
| 對外發文等待確認／被拒 | 確認視窗顯示目的地與全文；拒絕後工具結果寫「使用者拒絕了這則留言，沒有送出」 | 視窗的「以後都自動發」按鈕，或插件選項 |
| 對外發文超過數量上限 | 「B 站插件這一小時已發 10 則留言，達到上限，暫停發文。」 | 插件選項調整上限 |
| 子代理或模型呼叫被關閉 | 「B 站插件想開一個子代理執行『刷 B 站值班』，但插件選項關閉了子代理。」 | 插件選項 `allowAgents` |
| 缺金鑰 | 「Tavily 插件缺少 API 金鑰，搜尋無法使用。」不能只寫 `invalid config` | 插件選項中對應的敏感欄位（直接點名欄位） |
| 攔截功能關閉 | 「這個插件有監督 Claude 工具使用的功能，目前關閉。」 | 插件選項開啟攔截 |
| 需要 DSH 才有的功能 | 「這個功能需要 DSH 的對話管理，Claude Code 沒有對應，無法使用。」 | 無法放行，說明替代方式（若有） |
| 插件啟動失敗 | 第一行真正原因加一句白話說明 | 視原因而定 |

### 實作前要確認

- `$.ui.toast` 是否支援按鈕；不支援就在通知文字裡寫明設定位置。
- 插件選項頁能否從面板直接開啟。
- mod 能否得知使用者的介面語言；不能就預設繁體中文，並讓 Claude 在轉述時翻譯。

## 實作分工與介面約定

三個子代理同時實作，各自只改自己的檔案。以下是彼此之間的約定，任何一方需要改約定，先停下來回報，不要自行改。

### 檔案歸屬

| 負責 | 檔案 |
|---|---|
| mod 端（甲） | `templates/claude-mod/**`、`tests/claude-mod/**` |
| 背景程式端（乙） | `lib/dsh-host.mjs`、`lib/dsh-host-worker.mjs`、`lib/modules/**`、`lib/claude-host/**`、`tests/claude-host-*.test.mjs`、`tests/claude-modules-*.test.mjs`、新增 `tests/sandbox-*.test.mjs` |
| 轉換器端（丙） | `lib/converter-claude.mjs`、`lib/inspect.mjs`、`lib/claude-package.mjs`、`bin/d-sh-are-in-cc.mjs`、新增 `lib/security-scan.mjs`、`tests/security-scan-*.test.mjs`、`tests/claude-package-*.test.mjs`、`README.md` |

`SECURITY-PLAN.md` 本身只由協調者修改。

### 約定 1：插件選項（`plugin.json` 的 `userConfig`）

甲在範本 `templates/claude-mod/plugin.json` 定義固定欄位：

| 欄位 | 型別 | 預設 | 用途 |
|---|---|---|---|
| `allowModelCalls` | 布林 | `true` | 插件呼叫模型 |
| `allowAgents` | 布林 | `true` | 插件開子代理 |
| `allowInterception` | 布林 | `false` | 插件攔截 Claude Code 的工具（只准擋下） |
| `outboundMode` | 字串，選項 `ask`／`auto`／`deny` | `ask` | 對外發文模式 |
| `outboundHourlyLimit` | 數字 | `10` | 自動發時每小時上限，`0` 表示不限 |
| `outboundDailyLimit` | 數字 | `50` | 自動發時每天上限，`0` 表示不限 |
| `allowDirectExec` | 布林 | `false` | 允許插件自己直接開程式（關閉 Node 權限模式的這一項限制） |
| `extraFolders` | 字串，以 `;` 分隔的絕對路徑 | 空 | 額外允許插件讀寫的資料夾 |

甲要先查 `docs/claude-mod-api/types/claude-code.d.ts` 確認 `userConfig` 支援的型別（數字、選項、`sensitive`）；不支援的型別改用字串並在回報說明。

丙在轉換時，把插件需要的金鑰**合併**進輸出的 `plugin.json`（不改範本檔）：每把金鑰一個欄位，名稱 `secret_<環境變數名稱>`（例如 `secret_TAVILY_API_KEY`），`type: "string"`、`sensitive: true`，`title`／`description` 用白話寫出是哪個服務的金鑰、哪些功能需要它。

### 約定 2：嵌入 `register.ts` 的設定新增欄位（丙產生，甲讀取）

```json
{
  "outboundTools": [
    { "name": "<Claude 工具名稱>", "dshName": "<DSH 工具名稱>", "kind": "comment|message|email|post|other",
      "targetFields": ["bvid", "rpid"], "textFields": ["text"], "summary": "在 B 站影片底下發留言" }
  ],
  "secretOptions": [
    { "option": "secret_TAVILY_API_KEY", "env": "TAVILY_API_KEY", "title": "Tavily API 金鑰", "features": "網頁搜尋", "required": false }
  ],
  "securityReport": "security-report.json"
}
```

`targetFields`／`textFields` 找不到時，確認視窗顯示全部參數。

### 約定 3：mod 傳給背景程式的環境變數（甲設定，乙讀取）

| 變數 | 內容 |
|---|---|
| `<金鑰的環境變數名稱>` | `secretOptions` 中使用者有填的金鑰值 |
| `DSH_CLAUDE_SECRET_NAMES` | 上面那些變數名稱，以 `,` 分隔。乙要把它們加進傳給工作程序的環境變數白名單 |
| `DSH_CLAUDE_ALLOW_DIRECT_EXEC` | `1` 表示 `allowDirectExec` 開啟 |
| `DSH_CLAUDE_EXTRA_FOLDERS` | `extraFolders` 原樣 |
| `DSH_CLAUDE_ALLOW_INTERCEPTION` | `1` 表示 `allowInterception` 開啟；關閉時乙回報的 `ready.interception` 一律為 `false` |

### 約定 4：新的反向請求 `exec.check`（乙送出，甲處理）

- 乙的 `shell`、`subprocess` 模組執行前送 `exec.check`，`params`：`{ tool: "Bash", command: "<完整指令>", cwd: "<工作目錄>", why: "<哪個插件、哪個功能要執行>" }`。
- 甲收到後呼叫 `$.tool.check({ tool: "Bash", input: { command } })`：
  - `allow` → 回 `{ decision: "allow" }`
  - `deny` → 回 `{ decision: "deny", reason }`
  - `ask` → 用 `$.ui.ask` 問使用者，顯示指令與工作目錄（金鑰值先遮蔽），回 `allow` 或 `deny`
- mod 太舊不認得 `exec.check`（回 `UNKNOWN_METHOD`）時，乙退回原本的 `approval.request`。

### 約定 5：被擋下時的訊息格式

- 乙在工具結果或錯誤中，用這個格式（繁體中文）：
  ```
  [被擋下] <什麼被擋了>
  原因：<一句白話>
  怎麼放行：<設定名稱或做法>
  影響：<哪個功能因此不能用>
  （代碼：<CODE>）
  ```
  並同時送 `ui.notify`（`level: "warning"`）讓 mod 顯示畫面通知。
- 甲在 mod 端擋下的動作（發文、子代理、模型呼叫、攔截關閉）用同樣格式寫進工具結果，並用 `$.ui.toast` 顯示。
- 缺金鑰：乙的 `credentials` 模組與啟動失敗訊息，要點名 `secret_<變數名稱>` 這個插件選項欄位。

### 約定 6：Node 權限模式（乙）

- 工作程序以 `--permission` 啟動，允許讀：插件資料夾、狀態資料夾、工作資料夾、`extraFolders`、Node 自身需要的位置；允許寫：狀態資料夾、工作資料夾、`extraFolders`、暫存資料夾。不給 `--allow-child-process`、`--allow-worker`，除非 `DSH_CLAUDE_ALLOW_DIRECT_EXEC=1`。
- `shell`、`subprocess` 模組的實際執行搬到工作程序外面（宿主程序），工作程序透過既有的通道請宿主代為執行，所以權限模式下仍能用（經過約定 4 的檢查）。
- 權限錯誤（`ERR_ACCESS_DENIED`）要翻成約定 5 的訊息，點名被擋的路徑或程式，以及 `allowDirectExec`／`extraFolders` 選項。
- 例外：Node 版本不支援 `--permission` 時，照常啟動並在 `ready.metadata` 與狀態裡註明「此電腦的 Node 版本不支援權限限制」。
