---
name: scan
description: 只審查、不安裝 DSH（DeepSeek Harness）插件：下載原始碼、固定規則掃描（表格原樣給使用者看）、唯讀子代理讀標出的位置，白話回報風險與建議。使用者說「幫我看看某某 DSH 插件安不安全」「審查這個 DSH 插件」但沒有要安裝時使用。
argument-hint: <npm 套件名稱｜npm:名稱@版本｜GitHub 網址｜本機資料夾>
allowed-tools:
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/d-sh-are-in-cc.mjs" search *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/d-sh-are-in-cc.mjs" fetch *)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/d-sh-are-in-cc.mjs" scan *)
---

# 審查 DSH 插件（不安裝）

要審查的插件：$ARGUMENTS

先讀 `${CLAUDE_PLUGIN_ROOT}/skills/install/SKILL.md`，照其中「整個流程都要遵守的原則」與第 0 到第 4 步做，**不做第 5 步**：不執行 `install-local`，不執行任何 `claude plugin` 指令。

回報最後加上一句：「要安裝的話，請執行 `/d-sh-are-in-cc:install <pinnedSource>`。」（`pinnedSource` 換成第 1 步 `fetch` 輸出的值。）表格最上方寫「裝不進 Claude Code」時不加這一句。
