---
name: market
description: 打開 DSH（DeepSeek Harness）插件市場網頁：在 Claude 桌面版右邊的內建瀏覽器瀏覽社群插件、看自述文件、下載原始碼、腳本安全掃描、交給 Claude 審查並安裝。使用者說「打開 DSH 插件市場」「我要逛 DSH 插件」時使用。
allowed-tools:
  - mcp__plugin_d-sh-are-in-cc_DSH-market__dsh_market_open
  - mcp__Claude_Browser__preview_start
---

# 打開 DSH 插件市場

市場網站由這個插件附帶的伺服器在本機開；網頁上按的下載、掃描、審查，外掛會在這個對話裡接手。這裡只負責把網頁打開。

1. 呼叫 `mcp__plugin_d-sh-are-in-cc_DSH-market__dsh_market_open`（不帶參數）。回傳的 JSON 裡有 `url`，形如 `http://127.0.0.1:<埠號>/#access=<64 個字元>`。拿不到網址就把工具回傳的錯誤原樣告訴使用者，到此為止。
2. 用內建瀏覽器打開：呼叫 `mcp__Claude_Browser__preview_start`，參數 `{ "url": <第 1 步的 url> }`。
   - 沒有這個工具（例如在終端機裡用 Claude Code）：把網址給使用者，請他用自己的瀏覽器打開，並說明這個網址只在他自己的電腦上有效、關掉 Claude Code 就失效。
   - 工具回報錯誤：把錯誤原樣告訴使用者，不要重試別的方法。
3. 打開後只回一句：已在右邊的內建瀏覽器打開 DSH 插件市場，在網頁上按「Claude 審查並安裝」後，Claude 會在這個對話裡接手。

不要讀網頁內容、不要截圖、不要呼叫其他市場工具；使用者在網頁上的操作由外掛處理。
