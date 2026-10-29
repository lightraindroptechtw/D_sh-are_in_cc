# 修正計畫：轉換時預先編譯插件入口（避開 Windows 路徑長度問題）

狀態：只做完調查，程式還沒改。

## 問題

`lib/dsh-host-worker.mjs` 的 `initialize()`（約第 113–115 行）每次啟動都呼叫 `compileEntry()`，用 esbuild 把插件入口編譯到 `<stateDir>/compiled/plugin.mjs`。插件放在很深的路徑時（academic-writing 的 esbuild.exe 路徑 265 字元），esbuild 會出現 `The service was stopped: spawn ...esbuild.exe ENOENT`。同一個插件複製到較短的路徑就能啟動。

## 做法

1. **轉換時編譯**：在 `lib/converter-claude.mjs` 呼叫 `buildOfficialHost` 之後（約第 199 行），用跟 `compileEntry` 相同的 esbuild 設定，把入口編譯成 `<outputDir>/runtime/plugin.mjs`。編譯結果要能搬家：
   - `@deepseek-ai/*` 保持裸套件名稱並設為外部（external），不要換成絕對 file URL。執行時靠 `<stateDir>/compiled/node_modules/@deepseek-ai` 這個 junction 解析（worker 已經會建立）。
   - banner 裡 `createRequire(...)` 的入口 URL，以及每個來源檔的 `import.meta.url`，都改成佔位字串 `__DSH_SOURCE_ROOT_URL__/<相對路徑>`，不要寫死轉換時的絕對路徑。
   - 把 `lazyDependencies` 寫進 `<outputDir>/runtime/plugin.meta.json`。
2. **worker 使用預編譯檔**：`initialize()` 如果有 `options.precompiledEntry` 而且檔案存在，就讀出內容，把 `__DSH_SOURCE_ROOT_URL__` 換成 `pathToFileURL(options.sourceRoot).href`，寫到 `<stateDir>/compiled/plugin.mjs`，從 meta 檔載入 `lazyDependencies`，然後跳過 `compileEntry`。沒有預編譯檔就沿用原本的執行時編譯，Codex 版的路徑不變。
3. **傳入選項**：`lib/claude-host/host.mjs` 呼叫 `loadDshHost` 時（約第 63 行），檔案存在就加上 `precompiledEntry: path.resolve(root,'runtime','plugin.mjs')`。確認 `lib/dsh-host.mjs` 第 59 行的 `payload` 會把這個欄位傳給 worker。
4. **測試**：加一個單元測試，確認預編譯的插件搬到別的資料夾後仍能啟動，而且執行時不會呼叫 esbuild。跑 `node --test tests/*.test.mjs` 和 `node --test tests/claude-mod/*.test.mjs`。
5. **重新轉換與重測**：用 `bin/d-sh-are-in-cc.mjs convert --lenient-output` 重轉四個來源到 `tmp/e2e-lenient/`。再用 Haiku 重測 academic-writing：
   `claude -p --model claude-haiku-5-5 --plugin-dir <tmp/e2e-lenient/academic-writing> --allowedTools "mcp__dsh-plugin-academic-writing__academic_writing" --max-budget-usd 0.3 --output-format stream-json --verbose "<提示>"`
