import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown,safeUrl,escapeHtml} from '../market-web/markdown.js';

const BASE='https://cdn.jsdelivr.net/npm/x@1.0.0/';
// 產生的 HTML 只能有這些標籤，屬性只能是這些。
const TAGS=new Set(['p','h1','h2','h3','h4','h5','h6','a','img','code','pre','em','strong','del','ul','ol','li','blockquote','hr','br','table','thead','tbody','tr','th','td','div','span']);
const ATTRS=new Set(['href','src','alt','target','rel','loading','referrerpolicy','class','data-lang']);
function assertSafe(html){
  for(const m of html.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)){
    assert.ok(TAGS.has(m[1].toLowerCase()),`不該出現標籤 ${m[1]}`);
    assert.match(m[2],/^(\s[a-zA-Z-]+(="[^"<>]*")?)*\s?\/?$/,`屬性格式不對：${m[2]}`);
    for(const a of m[2].matchAll(/\s([a-zA-Z-]+)(?==|\s|$)/g)) assert.ok(ATTRS.has(a[1].toLowerCase()),`不該出現屬性 ${a[1]}`);
  }
  assert.ok(!/javascript:|data:text|vbscript:/i.test(html.replace(/&[a-z#0-9]+;/g,'')),'沒有危險網址');
}

test('作者寫的 HTML、腳本、事件屬性、危險網址都不會變成標籤', () => {
  const evil=[
    '<script>alert(1)</script>','<img src=x onerror=alert(1)>','<img src="javascript:alert(1)">','<a href="javascript:alert(1)">點我</a>',
    '[點我](javascript:alert(1))','![x](javascript:alert(1))','![x](data:image/svg+xml;base64,AAAA)','[x](data:text/html,<script>alert(1)</script>)',
    '<iframe src="https://evil"></iframe>','<svg onload=alert(1)></svg>','<style>body{}</style>','"><script>alert(1)</script>',
    '[a](https://e.com" onmouseover="alert(1))','`<script>`','<details><summary>s</summary>x</details>','<div style="x" onclick="y">文字</div>',
    '[x](//evil.com)','![x](http://insecure.example/a.png)','<a href="https://ok.example/" onclick="x">ok</a>',
  ].join('\n\n');
  const html=renderMarkdown(evil,BASE);
  assertSafe(html);
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'),'程式碼裡的標籤顯示成文字');
  assert.ok(html.includes('href="https://ok.example/"'));
  assert.ok(!html.includes('insecure.example'),'圖片只接受 https');
  assert.ok(html.includes('文字'),'標籤拿掉，文字留下');
});

test('常見 Markdown：標題、清單、程式碼、表格、引用、連結與圖片的相對路徑', () => {
  const md=[
    '# 標題','<p align="center"><img src="docs/logo.png" alt="logo" width="80"></p>','',
    '**粗體** *斜體* ~~刪除~~ `code` 參考 https://example.com/a?b=1&c=2','',
    '- 一\n- 二\n  - 二之一\n- [x] 完成','','1. 第一\n2. 第二','',
    '```js\nconst a = "<b>";\n```','',
    '| 名稱 | 說明 |\n|:---|---:|\n| a | b \\| c |','',
    '> 引用\n> 第二行','',
    '[![badge](https://img.shields.io/x.svg)](https://github.com/o/r)','---','[文件](docs/guide.md) 與 [錨點](#install)',
  ].join('\n');
  const html=renderMarkdown(md,BASE);
  assertSafe(html);
  assert.match(html,/<h1>標題<\/h1>/);
  assert.ok(html.includes('src="https://cdn.jsdelivr.net/npm/x@1.0.0/docs/logo.png"'),'相對圖片補成完整網址');
  assert.match(html,/<strong>粗體<\/strong> <em>斜體<\/em> <del>刪除<\/del> <code>code<\/code>/);
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'),'網址自動變連結');
  assert.match(html,/<ul><li>一<\/li><li>二<ul><li>二之一<\/li><\/ul><\/li><li><span class="task">☑<\/span> 完成<\/li><\/ul>/);
  assert.match(html,/<ol><li>第一<\/li><li>第二<\/li><\/ol>/);
  assert.ok(html.includes('<pre><code data-lang="js">const a = &quot;&lt;b&gt;&quot;;</code></pre>'));
  assert.ok(html.includes('<th class="a-left">名稱</th>')===false);
  assert.ok(html.includes('<td class="a-right">b | c</td>'),'表格靠右與跳脫的直線');
  assert.match(html,/<blockquote><p>引用\n第二行<\/p><\/blockquote>/);
  assert.ok(html.includes('<a href="https://github.com/o/r" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/x.svg"'),'圖片連結');
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('href="https://cdn.jsdelivr.net/npm/x@1.0.0/docs/guide.md"'));
  assert.ok(html.includes('錨點')&&!html.includes('#install'),'頁內錨點只留文字');
});

test('網址檢查', () => {
  assert.equal(safeUrl('https://a.com/x',''),'https://a.com/x');
  assert.equal(safeUrl('http://a.com/x',''),'http://a.com/x');
  assert.equal(safeUrl('http://a.com/x','',{image:true}),'');
  assert.equal(safeUrl('a.png',BASE,{image:true}),BASE+'a.png');
  assert.equal(safeUrl('a.png',''),'');
  assert.equal(safeUrl('JaVaScRiPt:alert(1)',BASE),'');
  assert.equal(safeUrl('https://u:p@a.com/',''),'');
  assert.equal(escapeHtml(`<"'&>`),'&lt;&quot;&#39;&amp;&gt;');
});
