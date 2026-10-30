import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {transform} from 'esbuild';
import {preparePluginUi} from '../lib/ui-assets.mjs';

test('generated UI ships a complete light palette with readable plugin text without modifying the client',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-theme-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:3}));
  const sourceRoot=path.join(root,'source'),outputDir=path.join(root,'out');
  await fs.mkdir(sourceRoot);await fs.writeFile(path.join(sourceRoot,'package.json'),JSON.stringify({name:'theme-probe',dsh:{client:{entry:'./client.js'}}}));
  const client='export default {}; // color:var(--dsw-alias-label-primary,#e6e6e6)';
  await fs.writeFile(path.join(sourceRoot,'client.js'),client);
  await preparePluginUi({sourceRoot,outputDir,converterRoot:path.resolve(import.meta.dirname,'..')});
  const css=await fs.readFile(path.join(outputDir,'runtime/ui/host.css'),'utf8');
  await transform(css,{loader:'css'});
  const tokens=new Map([...css.matchAll(/(--dsw-[\w-]+)\s*:\s*([^;]+);/g)].map(([,key,value])=>[key,value.trim()]));
  for(const name of css.matchAll(/var\((--dsw-[\w-]+)/g))assert.ok(tokens.has(name[1]),`unresolved palette dependency ${name[1]}`);
  const resolve=name=>{let value=tokens.get(name),seen=new Set();while(value?.startsWith('var(')){assert.ok(!seen.has(value));seen.add(value);value=tokens.get(value.match(/var\((--[\w-]+)\)/)[1]);}return value;};
  const rgb=name=>resolve(name).match(/[\d.]+/g).map(Number).map(value=>{value/=255;return value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;});
  const luminance=name=>rgb(name).reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
  const fg=luminance('--dsw-alias-label-primary'),bg=luminance('--dsw-alias-bg-base');
  assert.ok((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05)>=4.5);
  assert.equal(await fs.readFile(path.join(outputDir,'runtime/ui/source/client.js'),'utf8'),client);
  assert.match(await fs.readFile(path.join(outputDir,'runtime/ui/index.html'),'utf8'),/host\.css/);
});
