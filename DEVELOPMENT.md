# D_sh-are_in_cc 開發說明

> 給要修改或檢查轉換器的人看。一般使用方式見 [README.md](README.md)。

把 DSH（DeepSeek Harness）插件轉成 **Claude Code 插件**的固定規則轉換器。轉換過程不呼叫任何模型，也不會執行 DSH 來源的程式碼。

本專案一開始由 `dsh-to-codex` 0.4.0 複製而來，沿用它的來源檢查、依賴安裝和官方 DSH 宿主；輸出端換成 Claude Code 插件。只給 Codex 用的部分（轉換入口、Codex 的 MCP 宿主與掛鉤、DSH 宿主裡的 Codex 模式和 Codex 版服務模組）都已經移除。DSH 宿主在每個插件狀態資料夾裡用的名稱（`profiles/codex-bridge` 等）沒有改，因為已安裝的插件已經用這些名稱存資料。

> 狀態說明：這份文件只寫已經做出來、有測試或實際跑過的部分。尚未在真正的 Claude Code 工作階段裡驗證過的地方，會明確標示「未驗證」。完整清單見最後一節。

## 它做什麼

輸入一個 DSH 插件（本機資料夾、公開的 GitHub 倉庫網址，或 npm 套件 `npm:<名稱>[@<版本>]`），輸出一個資料夾，裡面是可以用 `claude --plugin-dir` 載入的 Claude Code 插件。

DSH 插件跑在 DSH 的宿主（host，執行插件的框架）裡，使用 DSH 的服務（工具、系統提示、命令、模型呼叫……）。Claude Code 沒有這些服務，所以轉換器產生**兩個程式**，讓它們合作：

| 程式 | 跑在哪裡 | 做什麼 |
|---|---|---|
| **mod**（Claude Code 的 JavaScript 擴充模組，`hooks/register.ts`） | Claude Code 裡面，沒有 Node.js、沒有 DOM，只能用引擎給的 `$` 介面 | 把 DSH 插件的能力接到 Claude Code：註冊工具、加系統提示、攔截工具呼叫、斜線指令、代辦模型呼叫與子代理、顯示狀態 |
| **子程序宿主**（child host，`runtime/claude-host.mjs`） | 由 mod 在對話開始時用 `$.process.spawn` 啟動的 Node 程式 | 裡面跑「官方 DSH 宿主」（Cordis 外掛框架加官方服務模組），真正執行 DSH 插件的程式碼 |

兩邊的通訊：子程序在標準輸出每行送一個 JSON 物件（`ready`、`fatal`、`toolsChanged`、`promptChanged`、`request`、`log`）；mod 用 HTTP 呼叫子程序（只綁 127.0.0.1、隨機埠、隨機權杖）。子程序遇到只有 Claude Code 才做得到的事（問使用者、呼叫模型、啟動子代理、顯示通知），就送 `request` 請 mod 代辦。完整協定寫在 `SPEC.md`。

## 轉換

需求：Node.js 22 以上；在本專案資料夾先執行過 `npm ci --ignore-scripts --legacy-peer-deps`。`package.json` 的 `@deepseek-ai/*` 套件與 `esbuild`、`typescript` 在轉換時會複製進插件的 `runtime/host-env/`（`lib/host-files.mjs`）；React、picomatch 在打包原插件畫面時包進 `runtime/ui/browser.js`。各套件的授權與作者列在 README 的「感謝」一節。

```
node bin/d-sh-are-in-cc.mjs inspect <來源>
node bin/d-sh-are-in-cc.mjs scan <來源> [--package-dir <子目錄>] [--outbound-tool <名稱>] [--not-outbound-tool <名稱>]
node bin/d-sh-are-in-cc.mjs convert <來源> --out <新資料夾> [--package-dir <子目錄>] [--no-install-deps] [--allow-unreviewable]
node bin/d-sh-are-in-cc.mjs validate <插件資料夾> [--no-cli]
```

- `inspect`：只讀來源，輸出靜態分析結果（工具、技能、命令、用到的 DSH 服務、問題清單）。
- `scan`：只做安全掃描，不轉換、不安裝依賴、不執行來源，輸出 JSON（見下方「安全」一節）。安裝前審查就是讀這份結果。
- `convert`：輸出資料夾必須不存在。預設會從 npm 公開登錄安裝來源的正式依賴到 `runtime/source-deps/`，一律加 `--ignore-scripts`（不執行任何安裝腳本）；`--no-install-deps` 略過。`--package-dir` 用於來源是多套件倉庫時，指定 DSH 套件所在的子目錄。其他選項：`--name`、`--entry`、`--config`、`--allow-tool`、`--home-mode isolated|real`、`--pass-env`、`--initialize-timeout-ms`、`--call-timeout-ms`、`--cancel-grace-ms`、`--lenient-output`、`--state-root`，意義和 `dsh-to-codex` 相同。
- `validate`：結構檢查，找得到 Claude Code 命令列程式時再加跑 `claude plugin validate <資料夾> --json`。命令列程式的路徑可用環境變數 `DSH_TO_CLAUDE_CLI` 指定。`--no-cli` 只做結構檢查。
- 都輸出 JSON（`scan --markdown` 除外）。結束碼：0 成功；2 轉換結果是 `unsupported`、驗證未通過、`install-local` 沒有登記、無法審查或名稱衝突；1 其他錯誤。

### npm 來源與安裝前審查用的子命令

```
node bin/d-sh-are-in-cc.mjs search <關鍵字...> [--limit 數量] [--sort updated|downloads|stars]
node bin/d-sh-are-in-cc.mjs fetch <來源>
node bin/d-sh-are-in-cc.mjs scan <來源> --markdown [--report-out <JSON檔>]
node bin/d-sh-are-in-cc.mjs install-local <來源> [--home <資料夾>] [--replace] [convert 的選項，--out 除外]
node bin/d-sh-are-in-cc.mjs capabilities [--types <claude-code.d.ts 的路徑>]
node bin/d-sh-are-in-cc.mjs delete-download <npm 套件名稱>
```

- `capabilities`（`lib/capabilities.mjs`）：從 Claude Code 的型別檔（plugin-authoring 技能載入時寫到暫存資料夾的 `claude-code.d.ts`，或 `~/.claude/dev-mods/` 下的 `index.d.ts`，取版本最新的）整理出功能摘要，寫到 `~/.dsh-to-claude/capabilities/claude-code-<版本>.md`：`$` 的名詞與方法、事件、畫面位置、各種畫面（終端機、桌面版、VS Code、手機）能用的元件、內建工具名稱，每項只取說明的前一兩句。審查子代理用它判斷裝不進來的部分 Claude Code 做不做得到。找不到型別檔時 `found` 是 false，安裝技能會先載入 plugin-authoring 技能讓型別檔被寫出來，再試一次。
- `delete-download`：刪掉審查時下載的原始碼（所有版本），連同掃描報告和補寫的資料夾；已安裝的插件有自己的一份，不受影響。

- **npm 來源**：`<來源>` 寫成 `npm:<名稱>` 或 `npm:<名稱>@<版本>`，所有子命令（`inspect`、`scan`、`convert`、`install-local`）都接受。只用 `npm pack <名稱>@<版本> --ignore-scripts` 下載壓縮檔，再由轉換器自己解開（`lib/npm-source.mjs`：拿掉第一層資料夾、拒絕 `..` 與絕對路徑、不解開連結、上限 200 MiB／20000 個項目），不安裝、不執行任何腳本。快取在 `~/.dsh-to-claude/cache/<名稱>-<版本>`（旁邊的 `<名稱>-<版本>.json` 記下完整性雜湊）；指定精確版本且快取已在時不再連網路。來源的 `origin` 記成 `npm:<名稱>`（不含版本），換版本後持久資料沿用同一份。不接受 git、網址、檔案路徑或 `npm:` 別名。
- **`~/.dsh-to-claude`**：轉換器自己的資料夾（路徑短，避免 Windows 路徑過長），可用 `--home` 或環境變數 `DSH_TO_CLAUDE_HOME` 改。
- `search`：跟插件市場讀同一套社群清單（開放插件市場 `https://dshopen.org/index.json`；Awesome 精選的 npm 索引 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 與網站完整清單 `https://awesome-dsh-plugin.com/catalog.json`），npm 和只在 GitHub 上的插件都找得到。輸出名稱、說明、下載次數、來自哪份清單，以及交給 `fetch`／`scan`／`install-local` 的來源寫法（`source`，GitHub 子目錄另附 `packageDir`；GitHub 發布檔還不能下載，`source` 是 null）。整理清單的程式在 `hooks/catalog.ts`、`hooks/markets.ts`，用 Node.js 直接執行 TypeScript 載入。清單的描述是作者寫的，不代表安全。
- `fetch`：只下載原始碼，輸出下載位置與 `pinnedSource`（固定版本的來源寫法；之後掃描與安裝都用它，確保審查的就是安裝的）。
- `scan --markdown`：標準輸出改印白話表格（一覽、需要的金鑰、裝了之後預設會受限的功能、Claude Code 不支援的 DSH 功能；逐項位置不列），完整 JSON（每項附檔案與行號） 寫到 `--report-out`，預設 `~/.dsh-to-claude/reports/<名稱>-<版本>.security.json`。有混淆程式碼時結束碼 2。
- `install-local`：轉換到 `~/.dsh-to-claude/plugins/<插件名稱>`，再把它登記到轉換器管理的本機插件市場 `~/.dsh-to-claude/.claude-plugin/marketplace.json`（市場名稱 `dsh-local`，項目 `source` 是 `./plugins/<插件名稱>`）。先轉換到暫存資料夾，成功後才替換舊資料夾，所以重複安裝同一個插件會整個覆蓋、市場項目不重複；同名但來源不同時拒絕（`NAME_CONFLICT`），加 `--replace` 才覆蓋。轉換結果是 `unsupported` 或 `not-applicable` 時不登記、不留資料夾。**不會**執行 `claude plugin marketplace add` 或 `claude plugin install`，只在輸出的 `next` 欄位列出這些指令，交給 Claude Code 在它的權限確認下執行。
  - 市場根目錄是 `~/.dsh-to-claude` 本身而不是另一個子資料夾，因為市場項目的相對路徑不能用 `..` 跳出市場根目錄（`claude plugin validate` 會判為錯誤）。從本機資料夾加入的市場，插件直接從資料夾載入、不複製到 Claude Code 的快取（官方文件 plugins/loading），所以重新 `install-local` 後只要 `/reload-plugins` 或重開。

## 作為 Claude Code 插件使用：審查並安裝 DSH 插件

本專案根目錄本身就是一個 Claude Code 插件（`.claude-plugin/plugin.json`，名稱 `D_sh-are_in_cc`），附兩個技能與一個子代理：

| 檔案 | 作用 |
|---|---|
| `skills/install/SKILL.md` | `/d-sh-are-in-cc:install <插件>`：下載不安裝 → `scan --markdown` 表格原樣給使用者看 → 執行 `capabilities` 取得功能摘要 → 唯讀子代理讀標出的位置 → 白話回報（做什麼、`secret_XXX` 金鑰、對外發文工具、預設受限的功能、建議只列可疑或無法判斷的項目，最後註明「審查是輔助判斷，不是保證」）→ 用 AskUserQuestion 問，同意後 `install-local`，再由 Claude 執行 `claude plugin marketplace add`（第一次）與 `claude plugin install <名稱>@dsh-local` |
| `skills/scan/SKILL.md` | `/d-sh-are-in-cc:scan <插件>`：同上但只做到回報，不安裝 |
| `skills/rewrite/SKILL.md` | `/d-sh-are-in-cc:rewrite`：確認授權、確實有裝不進來的部分後，開一個使用者指定模型與思考強度的子代理，用 Claude Code 自己的功能補寫；做不到的照實說明，使用者同意才安裝 |
| `agents/dsh-reviewer.md` | 審查用子代理 `d-sh-are-in-cc:dsh-reviewer`：只有 Read、Grep、Glob，模型 Sonnet；指示寫明原始碼裡的文字一律當資料、要它回報「安全」的文字列為可疑、混淆程式碼回報「無法審查，不建議安裝」。判斷能不能補寫時先讀完功能摘要，需要細節才在完整型別檔裡找名稱；摘要裡沒有對應功能才寫「Claude Code 無法實作」；用內建工具（`$.tool.call`）或這個對話連上的 MCP 伺服器（`$.mcp.call`，例如 `Claude_Browser`）做到的，要註明「只在有該伺服器的環境能用」 |

### 瀏覽器版 DSH 插件市場（`/d-sh-are-in-cc-market`）

在 Claude 桌面版輸入 `/d-sh-are-in-cc-market`，市場會在右邊的內建瀏覽器打開；沒有內建瀏覽器（例如終端機）時改開下面的面板。

- `bin/market-server.mjs` 是插件附帶的 MCP 伺服器（`plugin.json` 的 `mcpServers.DSH-market`），跟著 Claude Code 啟動、結束；不需要 `npm ci`，用 Node.js 內建功能（`--experimental-strip-types` 直接載入 `hooks/*.ts` 的清單整理程式）。
- 它開一個只綁 `127.0.0.1` 的本機網站（`lib/market-web.mjs`），每次啟動產生新的存取鑰匙放在網址 `#access=` 後面。網頁把鑰匙存進分頁的 sessionStorage 並從網址拿掉；所有 `/api/` 請求都要帶鑰匙（`x-dsh-access`），Host 必須是 `127.0.0.1:<埠>`（擋 DNS rebinding），帶 Origin 或 `Sec-Fetch-Site` 時必須是同一個網站。頁面的內容安全政策只允許自己的腳本，自述文件的圖片只能從 https 載入，Referrer-Policy 是 no-referrer。
- 網頁（`market-web/`）在瀏覽器裡搜尋、篩選、排序全部清單；插件頁顯示下載次數、清單來源、自述文件（`market-web/markdown.js` 轉成安全的 HTML：作者寫的 HTML 不保留，連結只接受 http、https）。
- 「篩選」面板最上面是「狀態」：全部、已安裝、未安裝、已下載未安裝、收藏（`market-web/app.js` 的 `renderFilters`、`filtered`）。已安裝與已下載的資料由 `lib/market-installed.mjs`、`lib/downloads.mjs` 提供：已下載未安裝的卡片有「安裝」「刪除」（刪掉下載的原始碼，已安裝的插件不能刪下載）；已安裝的有「啟用／停用」「移除」（解除安裝，連同下載的原始碼一起刪）；清單上有新版時多一個「更新到 x」，會重新審查。
- 網頁上按「審查並安裝／腳本安全掃描／只下載原始碼」只是排隊：網站依清單自己產生來源寫法（不用網頁給的），外掛（`hooks/register.tsx`）每秒用 `$.mcp.call` 拿一次，再檢查一次格式後執行（審查交給 `/d-sh-are-in-cc:install`，下載與掃描交給轉換器命令列），結果回報給網頁。「開啟資料夾」只開這個工作階段下載過的資料夾。
- 介面文字有 9 種語言（`market-web/i18n.js`：繁體中文、简体中文、English、日本語、한국어、Español、Français、Русский、العربية），右上角選；選過會記住，阿拉伯文整頁由右往左排。插件的說明、分類、自述文件是作者寫的，原樣顯示。
- 搜尋框右邊的「Haiku 搜尋」：使用者用白話寫想找什麼，外掛用 `$.model.complete` 直接問 Haiku 兩題（沒有工具、沒有對話記錄）：先想出簡繁中文與英文的關鍵字並依意思分組，網站用關鍵字在清單找最多 40 個候選（`dsh_market_candidates`：越少插件有的詞分數越高，一組同義詞只算一次，第一組加重，短英文詞要整個詞對到），Haiku 再挑出符合的並各寫一句理由（用介面語言）。只採用候選裡有的插件；使用者的描述與插件資料都包在 `<<< >>>` 裡當資料。每次搜尋會用到使用者一點 Claude 額度。
- 外掛用 `$.mcp.call('Claude_Browser', 'preview_start', { url })` 打開內建瀏覽器（2026-10-25 實測可用）。市場伺服器的工具只給外掛用：外掛每次呼叫都帶一個隨機的 `caller`，`tool.check` 只放行帶對的呼叫，模型直接呼叫一律拒絕。
- 改了 `bin/market-server.mjs` 或 `lib/market-web.mjs` 後，要開新的工作階段才會換成新版（`/reload-plugins` 只重新載入外掛）。

### DSH 插件市場面板（`/d-sh-are-in-cc-market`）

`hooks/register.tsx` 是一個 mod，輸入 `/d-sh-are-in-cc-market` 會在對話旁開一個面板：

- 讀兩份社群維護的清單（都不是 DeepSeek 官方），共三個檔案，經 Claude Code 的網路功能（`$.http.fetch`）讀取：開放插件市場（`https://dshopen.org/index.json`）；Awesome DSH 插件精選的 npm 套件索引（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，只有發布在 npm 的插件，有版本清單和中文說明）與網站完整清單（`https://awesome-dsh-plugin.com/catalog.json`，網站本身用的清單，多了只放在 GitHub 的插件，說明只有英文）。同名插件合併成一筆，每張卡片標出來自哪份清單；2026-10-25 實測：開放 880、npm 索引 3444、網站 6770，合併後 7096 個（網站的全部收進來，另加只在開放插件市場的），整理約 50 毫秒。格式不對的條目略過。
- 網站清單每筆只有一條 DSH 安裝指令、沒有版本清單：npm 插件下載當下取最新版（轉換器回報實際版本號）；GitHub 插件（2782 個）下載當下取預設分支，轉換器的 `fetch` 回報的 `pinnedSource` 固定到那一次提交（`…/tree/<提交>`），之後的掃描與安裝都用它；`#path:/子目錄` 轉成 `--package-dir`。GitHub 發布檔（544 個 .tgz）轉換器還不能下載，只顯示介紹與自述文件，不給審查與安裝按鈕。
- 自述文件：插件頁自動讀選定版本的自述文件並寫明來源。npm 版本先向 jsDelivr 要檔案清單（`data.jsdelivr.com/v1/packages/npm/<名稱>@<版本>?structure=flat`），挑插件那一層的 README，繁中、簡中優先，再從 `cdn.jsdelivr.net` 讀；GitHub 固定提交同樣經 jsDelivr；GitHub 預設分支沒有檔案清單可查，依序試常見檔名（`raw.githubusercontent.com/<擁有者>/<倉庫>/HEAD/…`）。內容只顯示：拿掉 HTML 標籤與註解、圖片改成文字連結（面板不載入外部圖片），超過 6 萬字截斷。
- 不在本機存清單：每次用 `/d-sh-are-in-cc-market` 開啟面板、或按「清單來源」裡的「重新讀取」，都會重新讀兩份清單，所以內容跟著社群清單更新。「清單來源」卡片列出每份清單的名稱、網站、說明、實際讀取的網址、這次讀到幾個和讀取時間。某一份這次讀不到時，沿用這個工作階段上次讀到的內容並標明；兩份都沒讀到過才顯示錯誤。
- 下載次數：卡片與插件頁依序用 npm 官方統計（`api.npmjs.org/downloads/point/last-month/`）過去 30 天的精確次數（只查畫面上看得到的插件，同一個工作階段查過不再查）、Awesome 網站清單的下載數（`dl`，3425 個插件有；比對 billion-context 是 1,802,220，npm 過去 30 天是 1,816,192，所以當成同樣約 30 天）、開放插件市場的下載量級標籤（`downloads-100` 到 `downloads-100k`，清單沒寫是總數還是一段期間）。從 GitHub 安裝的插件沒有下載次數。「下載最多」排序先用網站清單的下載數，沒有才用量級。
- 卡片寬度：桌面版面板夠寬時一排 4 張、較窄時 2 張；終端機一排 2 張，面板太窄才 1 張。
- 可以搜尋（空白分開的關鍵字都要出現）、依分類或市場篩選、換頁。
- 插件頁顯示說明、作者、首頁與原始碼倉庫連結、版本選單，以及三個按鈕：
  - **下載原始碼**：執行 `fetch`，只下載選定的固定版本（npm 版本或 GitHub 提交），不安裝、不執行，完成後可以開啟資料夾或複製路徑。
  - **腳本安全掃描**：執行 `scan --markdown`，把固定規則的表格原樣顯示，不經 AI 改寫。
  - **交給 Claude 審查並安裝**：執行 `/d-sh-are-in-cc:install <固定版本>`，走安裝技能的審查流程，使用者同意後才安裝。
- 目錄內容一律當資料顯示，不當指令。面板上方註明「清單內容由插件作者提供，不代表插件安全」。
- 下載或掃描失敗時分四段說明：發生什麼、原因、怎麼處理、影響。例如轉換器缺依賴、找不到 Node.js。
- 手機版沒有輸入框，只顯示「請在電腦版開啟」。

目錄的整理與搜尋在 `hooks/catalog.ts`（純函式，不連網），狀態合約在 `types/index.d.ts`。

技能用 `${CLAUDE_PLUGIN_ROOT}/bin/d-sh-are-in-cc.mjs` 找到轉換器。`.claude-plugin/marketplace.json` 讓本專案也能當插件市場加入（項目 `source` 是 `./`，即根目錄本身）：

```
claude plugin marketplace add <本專案資料夾>
claude plugin install d-sh-are-in-cc@d-sh-are-in-cc
```

插件根目錄選在專案根目錄的原因：從本機資料夾加入時插件就地載入，`node_modules`（轉換器需要的官方 DSH 套件與 esbuild，約 80 MB）直接可用；放在子資料夾的話，日後從 GitHub 安裝時 Claude Code 只複製插件資料夾，拿不到上層的轉換器程式碼。代價：從 GitHub 安裝時整個倉庫內容（含 `tests/`）會被複製，`node_modules` 不在倉庫裡，要靠 Claude Code 依 `package-lock.json` 自動安裝依賴（停用安裝腳本、60 秒上限、不讀本專案的 `.npmrc`，所以 `legacy-peer-deps` 不生效；能不能裝成功沒有驗證）。裝不起來時技能會請使用者在插件資料夾執行 `npm ci --ignore-scripts --legacy-peer-deps`。上架前要把 `node_modules/`、`tmp/` 排除在倉庫外。根目錄有 `bin/`，Claude Code 會把它加進 Bash 的 PATH（無害），但 claude.ai 與 Cowork 不接受有頂層 `bin/` 的插件。

`claude plugin validate <本專案資料夾>`（2.1.308）通過，有三個警告：名稱含 claude 被提醒「像 Anthropic 自己的插件」（名稱是指定的，未改）、沒有圖示、README 沒有市場安裝指令。

程式介面：`convertToClaude(source, { outputDir, packageDir, installDependencies, homeMode, passEnv, ... })`（`lib/converter-claude.mjs`）、`validateClaudePackage(dir)`（`lib/claude-package.mjs`）。

### 輸出結構

```
<輸出資料夾>/
  .claude-plugin/plugin.json      name、version、description，加上 userConfig
  hooks/hooks.json                { "modules": ["./register.ts"] }
  hooks/register.ts               mod；設定以 JSON 字面值嵌入
  skills/                         DSH 插件原本的技能，原樣複製
  runtime/claude-host.mjs         子程序宿主入口（esbuild 打包成單檔）
  runtime/dsh-host-worker.mjs     官方宿主工作程序
  runtime/host-env/               內附的官方 DSH 套件
  runtime/source-deps/            來源的正式依賴（有安裝時）
  runtime/settings.json           子程序宿主的設定
  runtime/ui/                     原插件畫面（只有原插件有畫面時才有）：manifest.json、browser.js、
                                  browser.js.LEGAL.txt（打包進來的套件授權註解）、host.css、source/（原畫面檔案）
  source/                         DSH 插件原始碼（不修改）
  conversion-report.json          轉換報告
  security-report.json            安全掃描的完整結果（每項附檔案與行號）
  SECURITY.md                     安全掃描的白話摘要
  README.md                       給使用者看的說明：風險、插件選項、被擋下時去哪裡放行
```

不會有 `bin/` 資料夾（儲存到 claude.ai 的插件會被拒絕）。

插件名稱（`plugin.json` 的 `name`）由 DSH 套件名稱決定性地產生：小寫英文、數字、連字號，最多 64 字；`@scope/name` 變成 `scope-name`；沒有 `dsh-` 開頭就補上。例如 `@acme/Synthetic Tools` → `dsh-acme-synthetic-tools`，`dsh-plugin-finance-data` 維持原樣。

只有技能、沒有可執行入口的 DSH 插件，輸出只有 `plugin.json` 和 `skills/`，沒有 mod 與子程序宿主。只有畫面的 DSH 插件（沒有工具、技能、命令、MCP）只要找得到畫面程式，就打包成只有畫面的插件（`runtime/settings.json` 的 `claudeHost.uiOnly` 為 true，不建立假的後端）；找不到畫面程式時才不產生插件，報告狀態為 `not-applicable` 並附原因，這不是轉換失敗。

### 轉換報告

`conversion-report.json` 的 `conversion.status` 是 `converted`、`partial`、`unsupported` 或 `not-applicable`；`omitted` 列出沒轉的項目與原因（子程序宿主建不起來時，原因取第一行真正的錯誤訊息）。`warnings` 列相容性警告（例如來源宣告的官方套件版本與內附版本不同，`HOST_VERSION_MISMATCH`）。狀態規則：`omitted` 與 `warnings` 都是空的才是 `converted`，否則是 `partial`，原因寫在 `conversion.reason`。Codex 時代的「需要宿主服務 systemPrompt」（`HOST_SERVICES`）不再讓狀態變成 `partial`（Claude 版經 `prompt.compose` 提供），只留在 `notes`；真正不支援的服務由 `SERVICE_UNSUPPORTED` 列入 `omitted`。

`conversion.serviceMapping` 是**服務對應表**：這個 DSH 插件用到的每個 DSH 服務，由 Claude 端哪個能力負責，以及涵蓋程度（完整／部分／不支援）。目前的對應：

| DSH 服務 | Claude 端 | 程度 |
|---|---|---|
| tools | `$.tool.register` | 完整 |
| systemPrompt | `prompt.compose` | 部分 |
| tools/pre-execute、post-execute（攔截） | `tool.call` 掛鉤（僅偵測到時啟用） | 部分 |
| commands | `$.command.register` | 部分 |
| llm | `model.complete` 反向請求，預設開啟，每次通知 | 部分 |
| agents、subagents | `agent.spawn` 反向請求，預設開啟，每次通知 | 部分 |
| approval | 詢問使用者（`approval.request`） | 完整 |
| timer、fs | 官方宿主，在子程序內 | 完整 |
| settings、webServer、skills、credentials、web | 官方宿主，在子程序內 | 部分 |
| shell、subprocess | 子程序宿主執行，每次先經 `exec.check`（Claude Code 的 Bash 權限規則） | 部分 |
| session/event（對話事件）、agent/created（主對話代理） | `prompt.submit`、`tool.call`、`turn.complete` 掛鉤轉成官方事件（`session.event`），預設開啟，第一次通知 | 部分 |
| agent.followup（主動送訊息） | `prompt.submit` 反向請求 → `$.prompt.submit`，**預設關閉** | 部分 |
| sessionQuery | 只讀目前這個對話、插件啟動之後轉來的部分 | 部分 |
| agentDefaultModel | `$.session.model`，只能讀 | 部分 |
| connection | 有原插件畫面時，接到畫面呼叫（見「原插件畫面」）；沒有畫面時只是登記成功的替身 | 部分 |
| typert | 有原插件畫面時，用官方 `@deepseek-ai/dsh-typert-registry` 收下插件登記的方法，給畫面呼叫 | 部分 |
| workspaceRegistry、sessionController、sessions 等 | 無 | 不支援（附原因） |

「程度」是設計上的涵蓋範圍，**不是測試結果**；報告的 `verification` 欄位固定標明「未載入 Claude Code」。靜態分析無法確認是不是 DSH 服務的名稱（例如 Cordis 的方法名稱）列在 `uncertainServices`，不會被當成服務掛載。

## 載入轉換後的插件（單次工作階段）

```
claude --plugin-dir <輸出資料夾>
```

只對這一次工作階段有效，不安裝到使用者設定。載入後，mod 在 `session.start` 啟動子程序宿主，工具清單以子程序回報的為準。

### 使用者設定（userConfig）

`plugin.json` 的 `userConfig` 由 mod 範本宣告固定欄位（以 `templates/claude-mod/plugin.json` 為準），轉換器再把插件需要的金鑰欄位合併進輸出的 `plugin.json`：

| 選項 | 作用 |
|---|---|
| `allowModelCalls` | 允許 DSH 插件經由 mod 呼叫目前工作階段的模型（會用掉額度） |
| `allowAgents` | 允許 DSH 插件經由 mod 啟動 Claude Code 子代理（會用掉額度，子代理可使用工具，權限模式同你目前的） |
| `shareConversation` | 讓跟著對話的插件（DSH 的 `session/event`）收到你的訊息、Claude 的回答、工具呼叫和結果，預設開啟；只有這類插件會收到，第一次會通知 |
| `allowFollowups` | 允許插件在 Claude Code 閒置時以插件名義送出一則訊息（DSH 的 `agent.followup`，例如夥伴類插件主動說話），預設關閉 |
| `allowInterception` | 允許插件在 Claude 使用工具前檢查並擋下（不能改寫），預設關閉 |
| `outboundMode` | 對外發文模式：`ask` 每次問（預設）、`auto` 自動發、`deny` 不准發 |
| `outboundHourlyLimit`、`outboundDailyLimit` | 自動發文的每小時／每天上限，`0` 表示不限 |
| `allowDirectExec` | 允許插件自己直接開程式（不經 Claude Code 權限確認），預設關閉；被擋下時跳出的視窗選「完全信任這個插件」效果相同，可用 `/<插件名稱>-trust` 取消 |
| `extraFolders` | 額外允許插件讀寫的資料夾，以 `;` 分隔的絕對路徑 |
| `secret_<環境變數名稱>` | 轉換器依掃描結果加上的金鑰欄位（敏感欄位，存在系統安全儲存區），例如 `secret_TAVILY_API_KEY` |

關閉時，子程序的請求會得到 `DISABLED` 錯誤，DSH 插件看到的是明確的錯誤，不是假成功。以 `--plugin-dir` 載入時，選項值從設定檔的 `pluginConfigs` 讀取，鍵是插件名稱或 `<名稱>@inline`（見 `docs/claude-mod-api/reference.md`）。

## 原插件畫面

DSH 插件的畫面寫在 `lib/client.js` 這類前端檔案裡，用 `window.__ModuleLoader__.load({ id, factory })` 登記；DSH 前端呼叫 `factory(require)` 拿到 `{ apply }`，再用 DSH 的情境物件 `ctx` 呼叫 `apply(ctx)`，插件就透過 `ctx` 把畫面掛到指定位置、取用 DSH 的服務。Claude Code 的外掛沒有網頁，所以這部分另外開一個本機網頁，在網頁裡重做一個 DSH 前端的替身。這一層的程式從 `dsh-to-codex` 0.10.0 移植過來，平台接合改成 Claude Code，對話列表沒有移植。

| 環節 | 檔案 | 做什麼 |
|---|---|---|
| 打包 | `lib/ui-assets.mjs` | 轉換時找出原插件的畫面程式（`dsh.client`），連同它引用的樣式、圖片與 `public`、`assets`、`static` 資料夾複製到 `runtime/ui/source/`，每個檔案記雜湊；不執行來源。再用 esbuild 把 `ui/browser.jsx` 打包成 `runtime/ui/browser.js`，打包進來的套件授權註解另存成 `browser.js.LEGAL.txt` |
| 開頁 | `templates/claude-mod/register.ts`、`lib/claude-host/ui.mjs` | `/<插件名稱>-ui` 請子程序宿主啟動畫面伺服器，再用 `$.mcp.call('Claude_Browser','preview_start',{url})` 在桌面版的內建瀏覽器打開；打不開時顯示本機網址 |
| 畫面伺服器 | `lib/ui-server.mjs` | 只綁本機，送出原畫面檔案（雜湊不符就不送）與 `/__dsh_ui/rpc`。畫面能呼叫的方法只限 `publicRpc` 清單；原插件登記的網頁路由轉給插件自己的後端 |
| 瀏覽器裡的替身 | `ui/runtime.mjs`、`ui/browser.jsx` | 提供 `window.__ModuleLoader__`、畫面位置（`HOST_SLOTS`）、服務與程式庫，逐一載入插件的畫面模組 |
| 後端 | `lib/dsh-host-worker.mjs` 的 `dispatchUi`、`lib/modules/connection.mjs`、`lib/modules/typert.mjs`、`lib/ui-official-services.mjs`、`lib/ui-event-journal.mjs`、`lib/ui-remote-streams.mjs`、`lib/ui-files.mjs` | 處理畫面送來的呼叫：插件自己的後端方法、DSH 的設定／金鑰／指令、事件、串流、檔案。只有帶畫面的插件（`runtime/ui/manifest.json` 存在）才掛上真的 connection 與 typert（`lib/modules/claude/index.mjs` 的 `claudeUiRegistry`） |

提供的東西：

- 畫面位置：`settings.section`、`settings.general.item`、`plugins.bundle.config`、`plugins.item`、`main`、`sidebar.panellist`、`sidebar.footer.action`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`shell.overlay`、`shell.bottom`。`conversation.*`、`chat.*`、`tool.*` 等聊天裡的位置不提供（`EXCLUDED_SLOTS`）。
- 服務：`slots`、`locale`、`configForms`、`settingsScope`、`layout`、`timer`、`resources`、`sidebarRightTabs`、`sidebarRight`、`connection`、`remote`（含 `remote.<插件自己的服務>` 與 DSH 的 `remote.settings`、`remote.credentials`、`remote.commands`）。
- 程式庫：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`（`ui/primitives.mjs` 自己重寫的 DSH 介面元件：按鈕、輸入框、選單、開關、對話框、提示框、標籤、設定表單、常用圖示等，外觀接近原版；原版壓縮在 DSH 前端打包檔裡，沒有單獨的套件）。

不提供的東西一律明確報錯，不給假資料：插件取用沒有的服務或程式庫時丟 `UI_SERVICE_UNSUPPORTED`、`UI_LIBRARY_UNSUPPORTED`；`sessions`、`currentConversation`（DSH 的對話列表）丟 `UI_CONVERSATION_UNSUPPORTED`，因為 Claude Code 的外掛只看得到目前這一個對話。另外沒做的：`inputTriggers`（DSH 輸入框的符號選單）、`workspaces`、`modelDirectories`、依名稱找情境或物件、右側分頁的檔案導覽。

涵蓋率是靜態估計：用 381 個 DSH 插件的原始碼，以比對寫法的規則找出畫面模組（`__ModuleLoader__.load(`，170 個）、它們登記的畫面位置、取用的服務與 `require` 的程式庫，不執行插件。有登記畫面位置的 145 個裡：

| 判斷標準 | 插件數 |
|---|---|
| 至少一個畫面位置有提供 | 約 115 |
| 上一列再加上 `require` 的程式庫全都有提供 | 約 107（缺的主要是 `@deepseek-ai/dsh-client-store`，5 個） |
| 位置、服務、程式庫全都有提供 | 約 37 |
| 沒有任何畫面位置有提供 | 約 30：18 個只用聊天裡的位置（`conversation.*`、`tool.call.toolview`）；6 個只用設定或插件管理頁的位置（`settings.plugin.item`、`plugins.row.config`、`settings.plugins.tab`、`plugins.detail.section`、`sidebar.right.tab.document`），這些還沒提供；6 個兩種都有 |

統計沒有檢查：插件一啟動就取用沒提供的服務（那樣畫面會整個出不來）、用到 `ui/primitives.mjs` 沒做的元件名稱，以及執行時才組出名稱的位置或服務。所以這些數字只當參考，不能當成「打得開」的名單。

畫面呼叫工具時，回到 Claude Code 這邊既有的工具處理流程（對外發文確認、通知、金鑰遮蔽）；插件自己寫的網頁路由是第三方程式碼，裡面每個動作不保證都經過確認。

## 安全

### 使用前請先知道

- 轉換後的插件執行的是**第三方程式碼**（DSH 插件原作者寫的，沒有經過 Anthropic 審核，原本也不是為 Claude Code 寫的）。
- 插件程式的**權限和使用者帳號一樣**：可以讀寫使用者能讀寫的檔案、連網路。轉換後加的保護（限制直接開程式、限制讀寫的資料夾、對外發文先確認）只能降低風險，不能消除風險；網路連線目前沒有限制。
- 安裝前會先做固定規則掃描與審查，**但審查不是保證**：規則抓不到透過變數組出來的行為，審查的 AI 也可能被原始碼裡的文字誤導。
- **不建議在「略過權限確認」模式下使用會對外發文或會開子代理的插件**：那個模式下 Claude Code 不會再問使用者，插件開的子代理也沿用同樣的權限模式。
- 被保護擋下時，工具結果或畫面通知會寫出放行的方式；常見情況與對應的插件選項寫在每個輸出資料夾的 `README.md`（「被擋下時去哪裡放行」一節）。

### 安全掃描（`scan`，`lib/security-scan.mjs`）

固定規則，不呼叫模型、不執行來源。掃描插件套件資料夾（`--package-dir`）裡的檔案；`node_modules` 只統計檔案數與套件名稱，不掃描。每一項都附檔案與行號，程式片段裡像金鑰的字串會換成 `[已遮蔽]`，金鑰只記名稱不記值。

| 類別 | 規則 |
|---|---|
| 自己開程式 | `child_process` 的 `spawn`／`exec`／`execFile`／`fork`（含 Sync 版）、`execa` 等套件、`Bun.spawn`、`Bun.$`、`Deno.Command`、Python 的 `subprocess`／`os.system`，以及 `cordis.patch.yml`、`.mcp.json` 裡的 MCP 子程序 `command`。能從字面值或檔案內唯一的常數看出程式名稱就記下（例如 `python`、`cloudflared`、`uv`），看不出來就記參數的寫法 |
| 讀寫檔案 | `fs`、`fs/promises`、`fs-extra` 的讀、寫、刪除；路徑標出絕對路徑、使用者家目錄、`..` 往外、寫入／刪除。`os.homedir()` 與 `HOME`／`USERPROFILE`／`APPDATA` 另列 |
| 連網路 | `fetch`、`http(s).request/get`、`net`／`tls`、`WebSocket`、`EventSource`、`axios`／`got`／`undici` 等、Python 的 `requests`／`httpx`／`urllib`；能從網址字面值抽出網域就抽出。檔案裡出現的所有網址網域另列在 `mentionedDomains` |
| 金鑰與環境變數 | `process.env.X`（含解構）、Python `os.environ`、`cordis.patch.yml` 的 `!!js process.env.X`、DSH `credentials` 服務的 `resolve`／`describe` 名稱、寫死而像金鑰的字串（只記名稱與長度）、把整份 `process.env` 交出去的寫法。名稱含 KEY／TOKEN／SECRET／PASSWORD／COOKIE／SESSDATA 等詞才算金鑰；`MAX_TOKENS`、`*_URL`、`*_ID`、`PWD` 不算 |
| 對外發文工具 | 從插件註冊的工具（任何有 `name` 加 `execute`，或 `description` 加 `parameters` 的物件；包含用包裝函式註冊的）判斷：名稱含 reply／comment／send／post／publish／tweet／message／email／mail／dm 等，且不含 draft／search／list／get／read 等讀取類字詞（`send_draft` 例外），或描述的第一個子句含「發表／發送／留言／私信給／寄信／send／post」等。判斷 `kind`（comment／message／email／post／other）與 `targetFields`／`textFields`。插件內附 Python MCP 伺服器的 `@tool` 函式另列在 `internalTools`。`--outbound-tool`／`--not-outbound-tool` 可手動修正 |
| 混淆程式碼 | `_0x` 形式的識別字占 15% 以上且有 20 個以上、十六進位跳脫字元密度很高、`while(!![])`、packer、JSFuck、`eval(atob(...))`。只有很長的行（壓縮過）不算混淆，另列 `minified` |
| 其他語言 | 列出 Python、Shell、PowerShell 等檔案，以及檔名是否出現在插件程式或設定中（出現才算「可能會被執行」）；執行檔或二進位檔另列；`package.json` 的安裝腳本另列 |

檔案依位置分成 `runtime`（插件執行期）、`client`（DSH 前端畫面，依檔名與 `package.json` 判斷，轉成 Claude 插件後不執行，假說）、`test`（測試、範例，不算進摘要）、`python`。

### 轉換時怎麼用掃描結果

- 寫出 `security-report.json`（完整結果）與 `SECURITY.md`（白話摘要），以及輸出資料夾的 `README.md`。
- 嵌入 `register.ts` 的設定加上 `outboundTools`、`secretOptions`、`securityReport`（見 `SECURITY-PLAN.md` 約定 2）。
- 需要的金鑰合併進輸出的 `plugin.json` 的 `userConfig`：每把一個 `secret_<環境變數名稱>` 欄位，`type: "string"`、`sensitive: true`；這些變數名稱也加進轉送給子程序的環境變數清單。範本檔不修改。
- `--config` 裡看起來是金鑰的欄位會在標準錯誤輸出警告（只印欄位路徑，不印值），並記在報告的 `CONFIG_SECRET_IN_SETTINGS`，建議改用金鑰欄位。
- 偵測到混淆程式碼時**預設拒絕轉換**（結束碼 2，訊息列出檔案與原因，不產生輸出資料夾）；加 `--allow-unreviewable` 才繼續，報告會記下這件事。

## 限制

- DSH 原插件畫面只在另開的網頁裡顯示（見「原插件畫面」）；放在 DSH 聊天裡的畫面、改 DSH 聊天外觀的主題不轉換。
- 不替換 Claude Code 的模型供應商，也不改造它的代理迴圈。
- 工具結果只有文字內容；其他類型的內容會被改寫成一句說明，不會默默消失。
- 子程序宿主是 Node 程式，使用者電腦要有 `node`（mod 設定預設用 `node` 指令）。
- 技能內容原樣複製，沒有改寫；技能裡提到的 DSH 專屬工具或路徑在 Claude Code 裡不一定存在。
- 來源宣告的 MCP 連線、內附的 Python 服務目前不轉換，只在報告列出。
- DSH 插件的持久資料由子程序宿主決定存放位置：`--state-root` 寫進 `runtime/settings.json` 的 `claudeHost.stateRoot`；沒指定時，依子程序宿主的實作預設在使用者家目錄下的 `.dsh-to-claude/state`（以 `lib/claude-host/host.mjs` 為準）。
- 計時器、網頁路由等官方服務只在子程序存活期間有效；工作階段結束，子程序也結束。
- 子程序宿主具有目前使用者的檔案與網路權限，不是沙箱。轉換不執行來源，但載入插件後來源會被執行。
- 轉換器的 `convert` 會連網安裝來源的正式依賴（`npm ci`，停用安裝腳本）；`--no-install-deps` 可關閉，關閉後來源能不能編譯與啟動沒有確認。

## 驗證到哪裡

已驗證：

- 命名、範本佔位字串取代、輸出結構、服務對應表、純介面「不適用」、驗證器的各種失敗情形，有單元測試（`tests/claude-package-*.test.mjs`，使用自己寫的合成 DSH 來源，不使用第三方插件）。
- 用 `dsh-plugin-finance-data`、`dsh-plugin-academic-writing`、`dsh-plugin-education`、`dsh-plugin-translation`（0.3.2）各轉換一次，轉換狀態都是 `partial`（原因只剩一個：內附官方套件 0.2.1-rc.2 與來源宣告的 `^0.1.0-rc.6` 不同；「需要宿主服務 systemPrompt」已證實是過時的規則並移除）。整合測試 `tests/e2e-claude.test.mjs`（不呼叫模型）實測：預設轉換時，輸出含 `undefined` 欄位的動作（例如 finance_data 的 format、return、risk）會被官方輸出驗證拒絕（`value is not lossless JSON`），加 `--lenient-output` 轉換後這些動作可用；是否由版本差異造成是假說，結構驗證通過，`claude plugin validate`（Claude Code 2.1.308）回報成功、沒有錯誤。`claude plugin validate` 只讀 manifest 與 hooks 模組原始碼，不載入工作階段，所以這只證明檔案格式與 mod 原始碼被引擎讀得懂。
- `claude plugin validate` 的「插件目錄」上架檢查會指出缺 README、LICENSE 與圖示；轉換器沒有產生這些檔案，也沒有為上架做準備。這不影響 `--plugin-dir` 載入（假說：該檢查只用於上架）。
- 在真正的 Claude Code 工作階段（2.1.308，Windows）裡用插件市場與 `/d-sh-are-in-cc:install` 審查、安裝過 npm 插件（例如 `dsh-game-material-master`），`dsh-reviewer` 子代理照功能摘要判斷能不能補寫。同一個插件同時啟動兩份時建連結會撞到 EEXIST，已修正（`linkScope`，`tests/link-scope.test.mjs`）。
- 原插件畫面：瀏覽器替身、元件、畫面呼叫後端、串流、檔案的單元測試（見「測試」）；`dsh-to-codex` 0.10.0 用 6 個真實插件驗證過報告列出的畫面操作，CC 版移植後沒有重做這項驗證。

未驗證：

- 原插件畫面在 Claude 桌面版內建瀏覽器裡的實際顯示與操作；關掉畫面時取消後端操作，從子程序宿主到工作程序這一段只有程式推導，沒有專門的測試。
- 攔截、反向請求（模型、子代理、主動送訊息）在真正工作階段裡的完整行為，以及 `userConfig` 每個選項的實際效果。
- 在 Windows 以外的作業系統上的行為。
- `tests/e2e-claude.test.mjs` 目前跑很久不結束，原因還沒查清；跑完整測試時先排除這個檔案。

## 測試

```
node --test tests/claude-package-*.test.mjs tests/security-scan-*.test.mjs tests/install-local-*.test.mjs
```

原插件畫面：

```
node --test tests/ui-*.test.mjs tests/claude-ui.test.mjs tests/link-scope.test.mjs
```

`ui-resource-navigation`、`ui-backend` 有幾項需要真實插件原始碼，找不到時自動略過。

`tests/install-local-*.test.mjs` 用合成插件與替身 npm（不連網路），測 npm 來源解析與解開、`install-local` 的轉換、`marketplace.json` 更新、重複安裝覆蓋、名稱衝突、白話表格；home 一律是測試暫存資料夾，不碰真正的 `~/.dsh-to-claude` 與 `~/.claude`。

市場面板：`node --test tests/market-catalog.test.mjs`（目錄整理與搜尋）、`npx tsc -p tests/market-mod/tsconfig.json`（型別檢查），以及 mod 測試 `hooks/market.test.tsx`、`hooks/market-offline.test.tsx`（假造網路與命令列，測瀏覽、搜尋、下載、掃描、交給 Claude、失敗說明、目錄讀不到）。mod 測試要用 `claude plugin test`，但在根目錄執行會連 `tests/claude-mod/fixture/tests/` 一起跑，那些是範本插件的測試，在根目錄會失敗；請把 `.claude-plugin/`、`hooks/`、`types/` 複製到另一個資料夾再執行。

其餘 `tests/` 底下是 DSH 宿主（沿用自 `dsh-to-codex` 0.4.0）、子程序宿主與 mod 範本的測試。
