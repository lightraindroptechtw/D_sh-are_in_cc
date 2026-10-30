# D_sh-are_in_cc

> **0.2.0-beta.2 — 公開測試版。尚未在真正的 Claude Code 中完成重新安裝、載入及操作驗證；不能視為已確認完整可用。此次發布沒有啟動 Claude 或呼叫模型，歷史測試結果不等於本次實機驗證。**
>
> **Public beta: fresh installation, loading, and interaction in a real Claude Code session have not been verified. This publication did not launch Claude or call a model. Historical tests are not fresh installed-client verification.**

**讓 DSH 社群的插件能夠在 Claude Code 使用。**

**Use DSH (DeepSeek Harness) community plugins in Claude Code.**

[English](#english) · MIT 授權

---

DSH（DeepSeek Harness）社群已經有好幾千個插件，但它們是為 DSH 寫的，不能直接裝進 Claude Code。D_sh-are_in_cc 是一個 Claude Code 插件：它先下載插件的原始碼、檢查它會做什麼並用白話告訴你；你同意之後，才把它轉換成 Claude Code 插件並安裝。

- **先看再裝**：只下載、不執行。先用固定規則掃描，再請 Claude 讀程式碼，白話說明風險。
- **你決定**：每個插件都要你同意才會裝。
- **裝了之後也有保護**：插件自己開程式、讀寫其他資料夾、會用你的帳號對外發文的工具，預設都會先擋下或先問你。
- **原插件的畫面也能開**：插件原本在 DSH 裡的設定頁、主頁、側欄頁籤，可以在 Claude 桌面版的內建瀏覽器打開（見「原插件的畫面」）。

> 審查是輔助判斷，不是保證。插件執行的是第三方程式碼，權限和你的使用者帳號一樣。

## 需要什麼

- Claude Code。桌面版會在右邊的內建瀏覽器打開插件市場和插件畫面；終端機版的插件市場改成對話旁的面板。
- Node.js 22 以上。
- 目前只在 Windows 上實際用過。

## 安裝

在終端機執行這兩行，把這個倉庫加成插件市場，再安裝：

```bash
claude plugin marketplace add lightraindroptechtw/D_sh-are_in_cc
```

```bash
claude plugin install d-sh-are-in-cc@d-sh-are-in-cc
```

然後在 Claude Code 輸入 `/reload-plugins`，或重開 Claude Code。也可以在 Claude Code 裡輸入 `/plugin`，從畫面上加入插件市場和安裝。

### 第一次轉換插件前

轉換插件需要 DSH 官方的程式零件和幾個公開套件（合計約 80 MB），要在本插件的資料夾執行一次：

```bash
npm ci --ignore-scripts --legacy-peer-deps
```

不用自己找資料夾：第一次審查或轉換時，Claude 發現還沒裝，會告訴你要裝什麼、裝在哪裡，問過你才執行。`--ignore-scripts` 表示安裝時不執行任何套件附帶的腳本。更新 D_sh-are_in_cc 之後如果又提示缺少套件，照同樣方式再執行一次。

## 怎麼用

### 1. 打開插件市場

輸入 `/d-sh-are-in-cc-market`。

插件市場讀兩份社群維護的清單：開放插件市場（dshopen.org）和 Awesome DSH 插件精選（awesome-dsh-plugin.com），合併後約七千個插件。這兩份都不是 DeepSeek 官方的清單，清單上的說明是作者自己寫的，不代表安全。

在插件市場裡可以：

- 搜尋，依最近更新、下載最多、星數最多或名稱排序
- 在「篩選」裡依狀態（全部、已安裝、未安裝、已下載未安裝、收藏）、分類、清單來源篩選
- 用「Haiku 搜尋」以白話描述想做的事，請 Claude Haiku 幫你挑插件（每次會用到一點 Claude 額度）
- 點開插件看說明和自述文件，收藏插件
- 按「重新讀取清單」取得社群清單的最新內容
- 切換介面語言（9 種）

### 2. 審查並安裝

在插件頁按 **「交給 Claude 審查並安裝」**，接下來由 Claude 在對話裡進行：

1. **只下載原始碼**：不安裝、不執行。
2. **固定規則掃描**：列出它會不會開程式、連網路、讀寫哪些檔案、需要哪些金鑰、有沒有會用你的帳號發文的工具。表格原樣給你看，沒有經過 AI 改寫。
3. **Claude 讀程式碼**：一個只能讀檔案的子代理去看掃描標出的位置，判斷每一項是「正常需要」還是「可疑」，也會確認每個工具是不是真的會對外發文。有 Claude Code 裝不進來的部分時，它會對照 Claude Code 現有的功能，判斷能不能照原始碼補寫。
4. **白話報告與建議**：「可以裝」「可以裝，但要注意」或「不建議裝」。
5. **問你要不要安裝**：你同意才會繼續。

同意後，Claude 會把插件轉換成 Claude Code 插件，登記到本機的插件市場 `dsh-local`，再裝進 Claude Code。裝好之後**所有對話**都會有這個插件，不只目前這一個。最後輸入 `/reload-plugins` 載入新插件。

插件頁還有兩個按鈕，不想安裝時可以用：

- **腳本安全掃描**：只做第 2 步。
- **只下載原始碼**：只做第 1 步，下載後可以自己開資料夾看。

不用插件市場也可以直接請 Claude 處理：

- `/d-sh-are-in-cc:install <插件>`：審查並安裝
- `/d-sh-are-in-cc:scan <插件>`：只審查、不安裝

`<插件>` 可以是 npm 套件名稱（例如 `npm:dsh-plugin-finance-data`）、GitHub 網址或本機資料夾。

### 3. 使用裝好的插件

插件帶來的工具、技能、指令會出現在 Claude Code 裡。平常照樣跟 Claude 說話，需要時 Claude 會自己呼叫插件的工具；插件自己的指令用 `/指令名稱` 執行。

每個轉換過的插件都附這些指令：

| 指令 | 作用 |
|---|---|
| `/<插件名稱>-status` | 看插件現在的狀態、哪些功能受限、最近的通知 |
| `/<插件名稱>-restart` | 重新啟動插件 |
| `/<插件名稱>-trust` | 完全信任這個插件，或取消信任（見「遇到被擋下怎麼辦」） |
| `/<插件名稱>-ui` | 打開原插件的畫面（只有原插件有畫面時才有，見下一節） |

## 原插件的畫面

DSH 插件常有自己的畫面，例如設定頁、資料館主頁、側欄頁籤、浮窗。轉換時會把原插件的畫面程式一起打包（只打包，不執行）；安裝後輸入 `/<插件名稱>-ui`，畫面會在 Claude 桌面版右邊的內建瀏覽器打開。沒有內建瀏覽器或打不開時，指令會給你一個本機網址，可以用一般瀏覽器開。開畫面不會用到 Claude 額度。

畫面裡的按鈕呼叫的是原插件自己的後端。畫面要用到工具時，一樣走 Claude Code 這邊的確認流程（例如對外發文先問你）。不過插件自己寫的網頁路由是第三方程式碼，不能保證裡面每個動作都會先問你。

### 支援到哪裡

D_sh-are_in_cc 在 Claude Code 這邊重做了 DSH 給插件畫面用的一部分功能：

- 畫面位置：設定頁、主頁、側欄、右側分頁、浮窗、下方面板、插件管理頁
- DSH 的介面元件：按鈕、輸入框、選單、開關、對話框、提示框、設定表單、常用圖示等
- 畫面呼叫插件自己的後端、讀寫插件設定與金鑰、執行插件的指令
- 語言切換、計時器、讀取插件自己的檔案

用 381 個 DSH 插件的原始碼做靜態統計，其中 145 個有自己的畫面。統計只比對程式碼裡的寫法，沒有實際打開插件，所以只是估計：

| 情況 | 插件數 |
|---|---|
| 畫面要放的位置和需要的程式庫都有提供 | 約 107 |
| 其中用到的畫面位置、服務、程式庫全都有提供 | 約 37 |
| 畫面要放的位置一個都沒提供 | 約 30 |

- 前兩列的插件，畫面有機會打開；但如果插件一啟動就用到還沒提供的服務，或用到沒做的元件，畫面還是可能出不來。真正打不打得開，要實際開過才知道。
- 畫面出得來，也不代表每個按鈕都能用：按到還沒支援的功能時，會明確顯示缺了什麼，不會假裝成功。
- 位置一個都沒提供的約 30 個裡，約 18 個的畫面全部放在 DSH 聊天裡（見下一節）；其他約 12 個用到 DSH 設定頁或插件管理頁裡的位置，這些還沒做。

### 目前不支援的

| 項目 | 為什麼 |
|---|---|
| 放在 DSH 聊天裡的畫面（訊息旁、輸入框裡、工具呼叫結果上），以及改 DSH 聊天外觀的主題 | 插件畫面是另外開的網頁，放不進 Claude Code 的聊天裡 |
| DSH 的對話列表、切換工作資料夾、選模型 | 這是 DSH 管理代理和對話的方式；Claude Code 的插件只看得到目前這一個對話 |
| 在 DSH 輸入框打特定符號跳出的選單 | 同上，輸入框是 Claude Code 的 |
| DSH 設定頁、插件管理頁裡的部分位置（每個插件的設定格、插件清單每一列的設定按鈕、插件詳細頁的區塊） | 還沒做 |
| 依名稱找「目前情境」或「某個物件」、右側分頁的檔案導覽 | 還沒做 |

### 之後的規劃

以下是規劃，不是承諾，也還沒有時間表：

- 用真實插件在桌面版逐一驗證，把「打得開」和「完整可用」的名單公開出來
- 補上 DSH 設定頁、插件管理頁裡還沒做的位置，以及情境查找與右側分頁檔案導覽
- 後端持續回傳資料（串流）和回傳檔案已有初步支援，會再用真實插件驗證
- 如果 Claude Code 之後開放讀取其他對話，再接上 DSH 的對話列表

這項功能只作用於轉換時就有畫面支援的插件。舊版轉換的插件要重新轉換一次才會有。

## 管理已安裝的插件

在插件市場的「篩選」選「已安裝」或「已下載未安裝」，插件卡片上會有這些按鈕：

| 插件狀態 | 可以做的事 |
|---|---|
| 已下載未安裝 | 安裝、刪除（刪掉下載的原始碼） |
| 已轉換未安裝 | 安裝、移除 |
| 已啟用 | 停用、移除 |
| 已停用 | 啟用、移除 |
| 清單上有新版 | 多一個「更新到 x」，按下去會重新審查新版 |

「移除」會把插件從 Claude Code 解除安裝，並一起刪掉它下載的原始碼。移除還在目前對話裡執行的插件時，插件的資料夾會暫時刪不掉；輸入 `/reload-plugins` 之後，下次打開會自動刪掉。

也可以用指令移除：

```bash
claude plugin uninstall <插件名稱>@dsh-local
```

## 遇到「被擋下」怎麼辦

插件做了受限的事時，狀態列和通知會出現「[被擋下]」，並寫出原因和放行方式。

| 被擋下的原因 | 怎麼辦 |
|---|---|
| 插件想自己開程式 | 會跳出詢問視窗，選「完全信任這個插件」就放行 |
| 缺少金鑰 | 執行 `/plugin configure <插件名稱>@dsh-local`，填 `secret_` 開頭的欄位 |
| 想讀寫其他資料夾 | 同一個設定畫面，在 `extraFolders` 加上資料夾 |
| 已辨識的對外發文工具 | 預設每次確認；也可設定自動發或不准發 |
| 用到 DSH 才有的功能 | **無法放行**，這個功能在 Claude Code 裡不能用 |

### 完全信任這個插件

DSH 本身對裝好的插件是完全信任的：插件想開什麼程式就開什麼。轉換成 Claude Code 插件後，預設會擋下插件自己開程式，因為它開出來的程式不經過 Claude Code 的權限檢查，也不受讀寫範圍限制。

插件第一次被擋下時會問你要不要「完全信任這個插件」：

- Claude 正在使用插件的工具時被擋下，工具會**停住等你回答**。你選了完全信任，插件會重新啟動，自動再執行一次剛才的功能，Claude 直接拿到結果繼續做事；選「先不要」，Claude 會收到「被擋下」的說明。
- 自動再執行一次時，那個功能在被擋下之前做過的步驟也會再做一次。

選了完全信任之後，這個插件可以開任何程式、讀寫任何檔案，不會再問你。只對這個插件有效，下次開 Claude Code 也有效；要取消，執行 `/<插件名稱>-trust`。完全信任之前，請先看過安裝時的審查報告。

### 插件選項

執行 `/plugin configure <插件名稱>@dsh-local` 可以調整：

| 選項 | 作用 | 預設 |
|---|---|---|
| `allowModelCalls` | 插件可以呼叫 Claude 模型（用你的額度） | 開 |
| `allowAgents` | 插件可以開 Claude Code 子代理（用你的額度） | 開 |
| `shareConversation` | 跟著對話的插件可以收到對話內容 | 開 |
| `allowFollowups` | 插件可以自己送出訊息（例如夥伴類插件主動說話） | 關 |
| `allowInterception` | 插件可以在 Claude 使用工具前檢查並擋下 | 關 |
| `outboundMode` | 對外發文：`ask` 每次問、`auto` 自動發、`deny` 不准發 | `ask` |
| `outboundHourlyLimit`、`outboundDailyLimit` | 自動發文的每小時、每天上限（`0` 表示不限） | 10、50 |
| `allowDirectExec` | 插件可以自己開程式，效果和「完全信任這個插件」相同 | 關 |
| `extraFolders` | 額外允許讀寫的資料夾，以 `;` 分隔 | 空 |
| `secret_<名稱>` | 插件需要的金鑰，存在系統的安全儲存區 | 空 |

## 照原始碼補寫裝不進來的部分

連原插件畫面都承載不了的部分（例如要放進 Claude Code 自己畫面裡的功能），可以請 Claude 照原始碼，用 Claude Code 自己的功能（面板、狀態列、提示訊息、斜線指令）補寫。不用另外按按鈕：「審查並安裝」時 Claude 會一起判斷能不能實作，值得補寫才在對話裡問你。

- **模型和思考強度由你決定**，例如 `sonnet high`。開始前會先確認你的帳號能用這個模型。補寫會用到你的額度。
- **先看授權**：MIT、Apache 這類開放授權可以補寫，並保留原作者；GPL 這類傳染性授權也可以，但**補寫的程式只能自己用，如果公開必須按照原授權**（插件裡會放一份《授權注意.md》）；沒寫授權或作者自訂授權的插件不補寫。
- **Claude Code 做不到的部分會照實說明**，例如浮在桌面上的透明視窗，不會用假按鈕假裝做到。
- 補寫完會先給你看：做到了哪些、哪些做不到、補寫的程式用到哪些能力（連網路、開程式、寫檔案等）。你同意才安裝，插件會標成「Claude 補寫版」並寫上原作者。

## 有些插件裝不了或不能用

- **用到 DSH 才有的功能的插件**：例如把 Claude 接成 DSH 模型、改造 DSH 代理流程的插件，那些功能在 Claude Code 裡沒有對應，會顯示「[被擋下] 用到 DSH 才有的功能」。
- **混淆過的程式碼**：看不出實際在做什麼，預設不轉換。
- **GitHub 發布檔（.tgz）**：還不能下載，只能看說明。

## 安全須知

- 轉換後的插件執行的是**第三方程式碼**，沒有經過 Anthropic 或 DeepSeek 審核。
- 預設的保護（擋下開程式、限制讀寫資料夾、對外發文先問）能降低風險，不能消除風險。**網路連線目前沒有限制。**
- 審查不是保證：固定規則抓不到用變數組出來的行為，讀程式的 AI 也可能被原始碼裡的文字誤導。
- 不建議在「略過權限確認」模式下使用會對外發文或會開子代理的插件。
- 每個轉換過的插件資料夾裡都有 `SECURITY.md`（安全摘要）和 `README.md`（被擋下時去哪裡放行）。

## 更新 D_sh-are_in_cc

```bash
claude plugin marketplace update d-sh-are-in-cc
```

```bash
claude plugin update d-sh-are-in-cc@d-sh-are-in-cc
```

更新後如果 Claude 或插件市場說缺少套件，照提示再執行一次 `npm ci --ignore-scripts --legacy-peer-deps`。

## 檔案放在哪裡

都在你家目錄下的 `.dsh-to-claude` 資料夾：

| 位置 | 內容 |
|---|---|
| `cache/` | 下載的原始碼 |
| `reports/` | 掃描報告 |
| `plugins/` | 轉換好的插件（本機插件市場 `dsh-local`） |
| `state/` | 插件自己的資料、插件市場的收藏 |

## 移除 D_sh-are_in_cc

```bash
claude plugin uninstall d-sh-are-in-cc@d-sh-are-in-cc
```

用它裝的 DSH 插件不會跟著移除，要另外移除；`.dsh-to-claude` 資料夾不需要時可以自己刪掉。

## 開發

轉換器的命令列用法、轉換方式、原插件畫面的運作方式、安全掃描規則和測試，寫在 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 感謝

本插件市場的來源依賴以下 2 個網站，特此感謝。清單與插件的著作權屬於清單維護者和插件作者：

- [開放插件市場（dshopen.org）](https://dshopen.org/)
- [Awesome DSH 插件精選（awesome-dsh-plugin.com）](https://awesome-dsh-plugin.com/)

轉換和原插件畫面用到以下開放原始碼套件，特此感謝（安裝時由 npm 一併取得，各自附有授權檔）：

| 套件 | 用途 | 授權與作者 |
|---|---|---|
| DSH 官方套件（`@deepseek-ai/*`，35 個） | 在 Claude Code 裡執行原插件 | MIT，Copyright (c) 2026 DeepSeek |
| [React](https://react.dev/)、React DOM | 顯示原插件畫面 | MIT，Copyright (c) Meta Platforms, Inc. and affiliates |
| [picomatch](https://github.com/micromatch/picomatch) | 判斷檔案該交給哪個插件頁籤開啟 | MIT，Copyright (c) 2017-present, Jon Schlinkert |
| [esbuild](https://esbuild.github.io/) | 打包插件程式與畫面 | MIT，Copyright (c) 2020 Evan Wallace |
| [TypeScript](https://www.typescriptlang.org/) | 讀取插件的型別宣告 | Apache-2.0，Microsoft |
| [Ajv](https://ajv.js.org/) | 檢查工具參數格式 | MIT，Copyright (c) 2015-2021 Evgeny Poberezkin |
| [Zod](https://zod.dev/) | DSH 官方套件使用的資料檢查 | MIT，Copyright (c) 2025 Colin McDonnell |
| [semver](https://github.com/npm/node-semver) | 比對版本號 | ISC，Copyright (c) Isaac Z. Schlueter and Contributors |
| [yaml](https://eemeli.org/yaml/) | 讀取插件設定檔 | ISC，Copyright Eemeli Aro |

## 授權

D_sh-are_in_cc 本身以 [MIT 授權](LICENSE) 釋出。

- 上面列出的套件各自適用自己的授權。
- 你用它轉換的每個 DSH 插件，仍然適用那個插件作者自己的授權，不會因為轉換而改變。

---

## English

**D_sh-are_in_cc** is a Claude Code plugin that lets you use plugins from the DSH (DeepSeek Harness) community in Claude Code.

DSH plugins are written for DSH and can't be installed in Claude Code directly. This plugin downloads a plugin's source without running it, scans it with fixed rules, has a read-only Claude subagent read the flagged code, and gives you a plain-language risk report. Only after you agree does it convert the plugin into a Claude Code plugin and install it. The interface and reports are mainly in Traditional Chinese; the market page has 9 languages.

**Install**

```bash
claude plugin marketplace add lightraindroptechtw/D_sh-are_in_cc
```

```bash
claude plugin install d-sh-are-in-cc@d-sh-are-in-cc
```

Then run `/reload-plugins` in Claude Code. Converting needs the official DSH packages and a few open-source packages (about 80 MB, `npm ci --ignore-scripts --legacy-peer-deps` in the plugin folder); Claude tells you and asks before running it.

**Use**

- `/d-sh-are-in-cc-market` opens the plugin market (about 7,000 plugins from two community lists). Filter by status (installed, not installed, downloaded, favorites), category or list.
- `/d-sh-are-in-cc:install <plugin>` reviews and installs a plugin; `/d-sh-are-in-cc:scan <plugin>` only reviews it.
- Each converted plugin gets `/<name>-status`, `/<name>-restart`, `/<name>-trust`, and `/<name>-ui` when the original plugin has its own screens.

**Original plugin screens**

`/<name>-ui` opens the plugin's original DSH screens (settings, main page, sidebar tabs, overlays) in the Claude desktop app's built-in browser, backed by the plugin's own backend. Common DSH UI components and backend calls are provided. A static analysis of 381 DSH plugins (code patterns only, no plugin was actually opened) found 145 with screens: for about 107, the screen positions and libraries they need are provided, and about 37 of those use only provided positions, services and libraries; about 30 use no provided position at all (about 18 of them live entirely inside the DSH chat). A screen may still fail if the plugin uses a missing service at startup. Screens inside the DSH chat (message cards, input box, chat themes), DSH's conversation list, workspace switching and model selection are not supported, because plugin screens are a separate page and Claude Code plugins only see the current conversation. Missing features are reported, never faked. Not yet verified plugin by plugin in the desktop app.

**Rewrite**

Parts that can't be converted can be rewritten by Claude from the source using Claude Code's own panels, status line and commands. You pick the model and thinking effort. Open licenses only; with GPL-type licenses the rewritten code is for your own use. What Claude Code cannot do is reported as such.

**Safety**

Converted plugins run third-party code with your user account's permissions. By default, programs the plugin starts by itself are blocked, file access is limited to certain folders, and posting with your accounts asks you first; network access is not limited. The review helps you decide but is not a guarantee. Only tested on Windows so far.

**Thanks**

This plugin market relies on [dshopen.org](https://dshopen.org/) and [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com/); the lists and plugins are copyright of their maintainers and authors. It also uses the official DSH packages (MIT, DeepSeek), React, picomatch, esbuild, TypeScript, Ajv, Zod, semver and yaml; see the table in the Chinese section for licenses and authors.

**License**

MIT. Each package above keeps its own license, and each converted DSH plugin keeps its own author's license.
