import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const here=path.dirname(fileURLToPath(import.meta.url));

/** Bundle the child host into <outputDir>/runtime/claude-host.mjs (one file, Node >= 22).
 * The worker (runtime/dsh-host-worker.mjs), runtime/host-env and runtime/settings.json come
 * from the existing official-host build and are not written here. */
export async function buildClaudeHost({outputDir}={}){
  if(typeof outputDir!=='string'||!outputDir)throw new TypeError('buildClaudeHost needs outputDir');
  const outfile=path.join(path.resolve(outputDir),'runtime','claude-host.mjs');
  await fs.mkdir(path.dirname(outfile),{recursive:true});
  await build({
    entryPoints:[path.join(here,'main.mjs')],outfile,bundle:true,platform:'node',format:'esm',target:'node22',
    packages:'bundle',external:['esbuild'],logLevel:'silent',
    banner:{js:"import {createRequire as __runtimeCreateRequire} from 'node:module';const require=__runtimeCreateRequire(import.meta.url);"},
  });
  const info=await fs.stat(outfile);
  return {file:outfile,bytes:info.size};
}

const SHIM_DIR='dsh-cli';
const SHIM_PACKAGE=JSON.stringify({name:'@deepseek-ai/dsh',version:'0.0.0-claude-stand-in',description:'Stand-in for the dsh command line (runs prompts through a Claude Code subagent). Not DeepSeek Harness.',type:'module',bin:{dsh:'lib/bin.js'}},null,2)+'\n';
const CMD_SCRIPT=['@echo off','setlocal','set "DSH_NODE_EXE=node"','if defined DSH_CLAUDE_NODE set "DSH_NODE_EXE=%DSH_CLAUDE_NODE%"','"%DSH_NODE_EXE%" "%~dp0dsh.mjs" %*','exit /b %ERRORLEVEL%',''].join('\r\n');
const SH_SCRIPT=['#!/bin/sh','dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)','exec "${DSH_CLAUDE_NODE:-node}" "$dir/dsh.mjs" "$@"',''].join('\n');
const CLI_ENTRY_PATTERN=/@deepseek-ai\/dsh\/lib\/bin/;

/** True when the plugin source looks up the real dsh entry file (`@deepseek-ai/dsh/lib/bin.js`) by module resolution. */
export async function sourceResolvesDshEntry(sourceDir,{maxFiles=400,maxBytes=4*1024*1024}={}){
  let files=0;
  const walk=async dir=>{
    let entries;
    try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return false;}
    for(const entry of entries){
      if(files>=maxFiles)return false;
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()){if(!['node_modules','.git'].includes(entry.name)&&await walk(full))return true;continue;}
      if(!/\.(?:[cm]?js|ts)$/.test(entry.name))continue;
      files++;
      try{
        const info=await fs.stat(full);
        if(info.size<=maxBytes&&CLI_ENTRY_PATTERN.test(await fs.readFile(full,'utf8')))return true;
      }catch{/* unreadable file: skip */}
    }
    return false;
  };
  return walk(path.resolve(sourceDir));
}

const entryStub=relative=>`import '${relative}';\n`;
async function writeDshPackage(directory,relativeShim){
  const packageDirectory=path.join(directory,'node_modules','@deepseek-ai','dsh');
  await fs.mkdir(path.join(packageDirectory,'lib'),{recursive:true});
  await fs.writeFile(path.join(packageDirectory,'package.json'),SHIM_PACKAGE);
  await fs.writeFile(path.join(packageDirectory,'lib','bin.js'),entryStub(relativeShim));
  return packageDirectory;
}

/** Write the `dsh` stand-in (see dsh-cli.mjs) under <outputDir>/runtime/dsh-cli:
 *   dsh.mjs                                   bundled program (no dependencies)
 *   dsh.cmd / dsh                             launchers for Windows / POSIX (the host puts this folder first on PATH)
 *   node_modules/@deepseek-ai/dsh/lib/bin.js  the layout real installs have, for callers that turn dsh.cmd into
 *                                             `node <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js` (Node >= 20 cannot spawn .cmd without a shell)
 * and, when `sourceDir` is given and the plugin resolves `@deepseek-ai/dsh/lib/bin.js` itself, the same package at
 * <outputDir>/node_modules so that require.resolve from <outputDir>/source finds it. */
export async function buildDshCli({outputDir,sourceDir}={}){
  if(typeof outputDir!=='string'||!outputDir)throw new TypeError('buildDshCli needs outputDir');
  const root=path.resolve(outputDir),directory=path.join(root,'runtime',SHIM_DIR),outfile=path.join(directory,'dsh.mjs');
  await fs.mkdir(directory,{recursive:true});
  await build({
    stdin:{contents:`import {runDshCli} from './dsh-cli.mjs';\nconst controller=new AbortController();\nfor(const name of ['SIGINT','SIGTERM'])process.once(name,()=>controller.abort());\nprocess.exitCode=await runDshCli({signal:controller.signal});\n`,resolveDir:here,sourcefile:'dsh-main.mjs',loader:'js'},
    outfile,bundle:true,platform:'node',format:'esm',target:'node22',packages:'bundle',logLevel:'silent',
    banner:{js:"import {createRequire as __runtimeCreateRequire} from 'node:module';const require=__runtimeCreateRequire(import.meta.url);"},
  });
  await fs.writeFile(path.join(directory,'dsh.cmd'),CMD_SCRIPT);
  await fs.writeFile(path.join(directory,'dsh'),SH_SCRIPT,{mode:0o755});
  const packages=[await writeDshPackage(directory,'../../../../dsh.mjs')];
  if(sourceDir&&await sourceResolvesDshEntry(sourceDir))packages.push(await writeDshPackage(root,'../../../../runtime/dsh-cli/dsh.mjs'));
  const info=await fs.stat(outfile);
  return {directory,file:outfile,bytes:info.size,packages,resolvableFromSource:packages.length>1};
}
