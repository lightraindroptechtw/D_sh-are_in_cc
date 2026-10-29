import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkRuntimeVersions} from '../lib/runtime-versions.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'runtime version '));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('runtime requirement checks distinguish incompatible, matching, missing and non-semver declarations',async t=>{
 const root=await fixture(t);
 const installed={'dsh-tools':'0.2.1-rc.2','dsh-fs':'0.2.1-rc.2','cordis':'4.0.5'};
 for(const [name,version]of Object.entries(installed)){const dir=path.join(root,'node_modules/@deepseek-ai',name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'@deepseek-ai/'+name,version}));}
 const result=await checkRuntimeVersions({peerDependencies:{'@deepseek-ai/dsh-tools':'^0.1.0-rc.6','@deepseek-ai/cordis':'^4.0.1','@deepseek-ai/dsh-fs':'workspace:*','@deepseek-ai/dsh-unknown':'^0.1.0'},peerDependenciesMeta:{'@deepseek-ai/dsh-unknown':{optional:true}}},{runtimeRoot:root});
 assert.deepEqual(result.mismatches.map(x=>x.name),['@deepseek-ai/dsh-tools']);
 assert.equal(result.requirements.find(x=>x.name==='@deepseek-ai/cordis').status,'in-declared-range');
 assert.equal(result.unresolved.find(x=>x.name==='@deepseek-ai/dsh-fs').status,'uncomparable');
 assert.equal(result.unresolved.find(x=>x.name==='@deepseek-ai/dsh-unknown').optional,true);
 assert.equal(result.sourceExecuted,false);
 const matching=await checkRuntimeVersions({dependencies:{'@deepseek-ai/dsh-tools':'^0.2.1-rc.2'}},{runtimeRoot:root});
 assert.equal(matching.mismatches.length,0);
});

