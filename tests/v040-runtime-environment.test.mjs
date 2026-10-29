import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {copyHostEnvironment} from '../lib/host-files.mjs';

test('every bundled official SDK imports from the copied environment with runtime peer dependencies present',async t=>{
  const fromRoot=fileURLToPath(new URL('../',import.meta.url)),temp=await fs.mkdtemp(path.join(os.tmpdir(),'v040-sdk-copy-')),toRoot=path.join(temp,'runtime');
  t.after(()=>fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const manifest=JSON.parse(await fs.readFile(path.join(fromRoot,'package.json'),'utf8'));
  const names=Object.keys(manifest.dependencies).filter(name=>name.startsWith('@deepseek-ai/'));
  const copied=await copyHostEnvironment({fromRoot,toRoot});assert.equal(copied.installScriptsExecuted,false);
  const requireFromCopy=createRequire(path.join(toRoot,'package.json'));
  // Import definitions only: do not construct services, start sources or call a model.
  for(const name of names){const resolved=requireFromCopy.resolve(name);assert.ok(resolved.startsWith(toRoot+path.sep));await import(pathToFileURL(resolved).href);}
});
