import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {findTypesFile,summarizeTypes,writeCapabilities} from '../lib/capabilities.mjs';

// 照 Claude Code 型別檔的寫法做的迷你版：功能、事件、畫面位置、各畫面的元件、元件說明。
const TYPES=(version)=>`// Written by Claude Code ${version}.
declare module 'claude-code' {
  export interface CoreEngineInterface {
      /**
       * Display: panes and lines.
       */
      ui: {
          /**
           * Opens a pane. More detail here.
           *
           * @example $.ui.open({ id })
           */
          open: (args: unknown) => Promise<unknown>;
          /**
           * Shows \`text\` for a few seconds.
           */
          toast: (text: string) => void;
      };
  }
  export type EngineEventOf = {
      /**
       * Fires when the engine is about to run a tool. Each next runs the rest.
       */
      'tool.call': ToolCallInput;
  };
  export type Components = {
      /**
       * The band above the prompt.
       */
      AbovePrompt: {
          hasSurvey: boolean;
      };
      /**
       * The framed region a plugin opened.
       */
      Pane: {
          requestId: string;
      };
  };
  export type Elements = {
      terminal: {
          Box: ElementConstructor<BoxProps>;
          Image: ElementConstructor<ImageProps>;
      };
      desktop: {
          Box: ElementConstructor<BoxProps>;
      };
  };
  /**
   * The props of \`Image\`, the terminal surface's picture leaf. Keyed, it swaps fast.
   */
  export type ImageProps = {
      alt: string;
  };
}
declare module 'claude-code' {
  interface BuiltinToolInputs {
    WebFetch: {
      /** The URL */
      url: string
    }
    Monitor: {
      command: string
    }
  }
}
`;

test('功能摘要：抽出功能、事件、畫面位置、各畫面的元件和元件說明，只留第一句', ()=>{
  const {markdown,missing}=summarizeTypes(TYPES('9.9.9'));
  assert.match(markdown,/- \*\*ui\*\*：Display: panes and lines\./);
  assert.match(markdown,/`\$\.ui\.open`：Opens a pane\.\n/,'只留第一句');
  assert.match(markdown,/`\$\.ui\.toast`：Shows `text` for a few seconds\./);
  assert.match(markdown,/`tool\.call`：Fires when the engine is about to run a tool\.\n/);
  assert.match(markdown,/`Pane`：The framed region a plugin opened\./);
  assert.match(markdown,/`AbovePrompt`：The band above the prompt\./);
  assert.match(markdown,/- terminal：Box、Image\n- desktop：Box/);
  assert.match(markdown,/`Image`：The props of `Image`, the terminal surface's picture leaf\. Keyed, it swaps fast\./);
  assert.match(markdown,/內建工具.*\n\nWebFetch、Monitor$/,'只有工具名稱，不含參數');
  assert.deepEqual(missing,['自訂畫面區塊（`Client` 的模組）']);
  assert.doesNotMatch(markdown,/@example|More detail/);
});

test('功能摘要：從暫存資料夾找版本最新的型別檔，寫到 <home>/capabilities；找不到時 found 是 false', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-cap-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const tmp=path.join(dir,'tmp');const userHome=path.join(dir,'user');const home=path.join(dir,'home');
  assert.equal((await writeCapabilities({home,tmp,userHome})).found,false);
  for(const version of ['2.1.9','2.1.10']){
    const folder=path.join(tmp,'claude','bundled-skills',version,'abc','plugin-authoring','types');
    await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'claude-code.d.ts'),TYPES(version));
  }
  assert.equal((await findTypesFile({tmp,userHome})).version,'2.1.10','2.1.10 比 2.1.9 新');
  const result=await writeCapabilities({home,tmp,userHome});
  assert.equal(result.found,true);
  assert.equal(result.path,path.join(home,'capabilities','claude-code-2.1.10.md'));
  assert.match(await fs.readFile(result.path,'utf8'),/^# Claude Code 2\.1\.10 外掛能用的功能/);
});
