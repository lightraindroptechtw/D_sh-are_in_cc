import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {copyHostEnvironment} from '../lib/host-files.mjs';
test('host dependency copying keeps nested versions and licenses without running package scripts',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'host packages '));t.after(()=>fs.rm(root,{recursive:true,force:true}));const fromRoot=path.join(root,'installed'),toRoot=path.join(root,'portable');
  const put=async(file,text)=>{const target=path.join(fromRoot,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);};
  await put('package.json',JSON.stringify({dependencies:{'@deepseek-ai/alpha':'1','@deepseek-ai/beta':'1'}}));
  for(const name of ['alpha','beta'])await put(`node_modules/@deepseek-ai/${name}/package.json`,JSON.stringify({name:'@deepseek-ai/'+name,version:'1.0.0',dependencies:{shared:name==='alpha'?'1':'2'},scripts:{postinstall:'MUST NOT RUN'}}));
  await put('node_modules/@deepseek-ai/alpha/node_modules/shared/package.json',JSON.stringify({name:'shared',version:'1.0.0'}));await put('node_modules/shared/package.json',JSON.stringify({name:'shared',version:'2.0.0'}));await put('node_modules/@deepseek-ai/alpha/LICENSE','License alpha');
  const result=await copyHostEnvironment({fromRoot,toRoot});assert.equal(result.packages.length,4);assert.equal(result.installScriptsExecuted,false);assert.equal(JSON.parse(await fs.readFile(path.join(toRoot,'node_modules/@deepseek-ai/alpha/node_modules/shared/package.json'),'utf8')).version,'1.0.0');assert.equal(JSON.parse(await fs.readFile(path.join(toRoot,'node_modules/shared/package.json'),'utf8')).version,'2.0.0');assert.equal(await fs.readFile(path.join(toRoot,'node_modules/@deepseek-ai/alpha/LICENSE'),'utf8'),'License alpha');
});
