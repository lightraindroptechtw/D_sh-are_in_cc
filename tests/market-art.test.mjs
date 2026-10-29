import test from 'node:test';
import assert from 'node:assert/strict';
import {avatarSvg,bannerSvg,pillsSvg,escapeXml,fitText,textWidth} from '../hooks/art.ts';

test('插件目錄的文字放進 SVG 前一律跳脫，不能變成標籤或屬性', () => {
  const evil='<script>alert(1)</script>" onload="x';
  const banner=bannerSvg({seed:'s',title:evil,subtitle:evil,stats:[evil],letter:'<',width:4000});
  const pills=pillsSvg([{label:evil,tone:'plain'}],{maxWidth:4000});
  const avatar=avatarSvg('s','<');
  for(const svg of [banner.source,pills.source,avatar.source]){
    assert.ok(!svg.includes('<script'),'沒有 script 標籤');
    assert.ok(!/onload=/.test(svg.replace(/&quot; onload=&quot;/g,'')),'沒有事件屬性');
  }
  assert.equal(escapeXml(`a&<>"'`),'a&amp;&lt;&gt;&quot;&#39;');
});

test('標籤放不下就略去，不截斷字；一個都放不下時不畫', () => {
  const pills=[{label:'工具與能力',tone:'accent'},{label:'★ 12',tone:'plain'},{label:'非常非常非常長的標籤文字',tone:'warning'}];
  const narrow=pillsSvg(pills,{maxWidth:130});
  assert.ok(narrow.source.includes('工具與能力'));
  assert.ok(!narrow.source.includes('非常'));
  assert.ok(narrow.width<=130);
  assert.equal(pillsSvg(pills,{maxWidth:10}),undefined);
});

test('字寬估算與截斷：中文一字一個字級，超出加省略號', () => {
  assert.equal(textWidth('中文',10),20);
  assert.equal(textWidth('ab',10),12);
  assert.equal(fitText('短',12,100),'短');
  const cut=fitText('這是一段很長很長的插件名稱',20,100);
  assert.ok(cut.endsWith('…'));
  assert.ok(textWidth(cut,20)<=100);
});

test('同一個插件每次都是同一個顏色', () => {
  assert.equal(avatarSvg('dsh-a','A').source,avatarSvg('dsh-a','A').source);
});
