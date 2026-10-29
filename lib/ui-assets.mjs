import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

const slash=value=>value.split(path.sep).join('/');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const contained=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const urlFor=relative=>'/__dsh_ui/source/'+relative.split('/').map(encodeURIComponent).join('/');
const blocked=relative=>relative.split(/[\\/]/).some(part=>part.startsWith('.')||part==='node_modules')||/\.(?:pem|key|log|pyc)$/i.test(relative);
async function safeFile(root,relative){
  if(typeof relative!=='string'||!relative||relative.includes('\0')||path.isAbsolute(relative))throw new Error('UI entry must be a package-relative path');
  const file=path.resolve(root,relative);if(!contained(root,file))throw new Error('UI entry escapes the source package');
  const real=await fs.realpath(file);if(!contained(root,real))throw new Error('UI source symlink escapes the source package');
  if(!(await fs.stat(real)).isFile())throw new Error('UI entry is not a file');
  if(blocked(path.relative(root,file)))throw new Error('UI entry points to a private source file');
  return file;
}
function target(value){
  if(typeof value==='string')return value;
  if(Array.isArray(value))return value.map(target).find(Boolean);
  if(value&&typeof value==='object')for(const key of ['browser','import','default','require','entry','file','path','main']){const result=target(value[key]);if(result)return result;}
  return null;
}

/** Read declarative browser entries only. Never imports source modules or runs package scripts. */
export async function discoverPluginUi({sourceRoot,packageDir='.'}){
  const source=await fs.realpath(path.resolve(sourceRoot)),root=await fs.realpath(path.resolve(source,packageDir));
  if(!contained(source,root))throw new Error('UI package directory escapes the source root');
  let pkg;try{pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const candidates=[];
  for(const [name,value]of Object.entries(pkg.exports??{}))if(name==='./client'||name.startsWith('./client/')){const entry=target(value);if(entry)candidates.push({id:name==='./client'?(pkg.name??'client'):(pkg.name??'client')+name.slice(1),entry});}
  const client=pkg.dsh?.client;
  const declared=typeof client==='string'?client:target(client);
  if(declared&&!candidates.some(row=>row.entry===declared))candidates.push({id:pkg.name??'client',entry:declared});
  if(!candidates.length&&client){for(const entry of ['client.js','lib/client.js','dist/client.js'])try{await fs.access(path.join(root,entry));candidates.push({id:pkg.name??'client',entry});break;}catch{}}
  if(!candidates.length)return null;
  const clients=[];
  for(const row of candidates){const file=await safeFile(root,row.entry),source=slash(path.relative(root,file));if(clients.some(client=>client.source===source))continue;clients.push({id:row.id,source,url:urlFor(source),sha256:hash(await fs.readFile(file))});}
  return {format:1,name:pkg.name??path.basename(root),version:pkg.version??'0.0.0',packageDir:slash(path.relative(source,root))||'.',clients,sourceExecuted:false};
}

/** Bundle only the trusted host. Original frontend files are copied byte-for-byte. */
export async function preparePluginUi({converterRoot,outputDir,sourceRoot,packageDir='.'}){
  const manifest=await discoverPluginUi({sourceRoot,packageDir});if(!manifest)return null;
  const root=await fs.realpath(path.resolve(sourceRoot,packageDir)),destination=path.join(outputDir,'runtime/ui'),files=new Map();
  const add=async(relative,{required=false}={})=>{
    relative=slash(path.normalize(relative));if(files.has(relative)||blocked(relative))return;
    let file;try{file=await safeFile(root,relative);}catch(error){if(!required&&error.code==='ENOENT')return;throw error;}
    const bytes=await fs.readFile(file);files.set(relative,bytes);
    if(/\.(?:[cm]?js|jsx|tsx?|css|html)$/i.test(relative)){
      const text=bytes.toString('utf8'),references=[];
      const patterns=[/(?:\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|\b(?:import|require)\s*\()\s*["'](\.[^"']+)["']/g,/\bnew\s+URL\s*\(\s*["'](\.[^"']+)["']/g,/\burl\(\s*["']?([^\s'"()]+)["']?\s*\)/g,/\b(?:src|href)\s*=\s*["'](\.[^"']+)["']/g];
      for(const pattern of patterns)for(const match of text.matchAll(pattern))references.push(match[1]);
      for(const ref of references){if(/^(?:data:|https?:|#|\/)/i.test(ref))continue;const clean=ref.split(/[?#]/)[0];if(clean)await add(path.join(path.dirname(relative),clean));}
    }
  };
  for(const client of manifest.clients)await add(client.source,{required:true});
  // Static assets beside client bundles, plus customary public trees. Never
  // expose arbitrary backend code, configuration, dotfiles or dependency trees.
  const walkAssets=async(relative,all=false)=>{
    const dir=path.resolve(root,relative);if(!contained(root,dir))throw new Error('UI asset path escapes package');
    let rows;try{rows=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const row of rows){const rel=path.join(relative,row.name);if(blocked(rel))continue;if(row.isSymbolicLink())throw new Error('UI assets cannot contain symbolic links');if(row.isDirectory())await walkAssets(rel,all);else if(row.isFile()&&(all||/\.(?:css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|wasm|mp[34]|ogg|webm)$/i.test(row.name)))await add(rel);}
  };
  for(const directory of new Set(manifest.clients.map(client=>path.dirname(client.source))))await walkAssets(directory);
  for(const directory of ['public','assets','static'])await walkAssets(directory,true);
  for(const row of await fs.readdir(root,{withFileTypes:true}))if(row.isFile()&&/^(?:licen[sc]e|notice|copying)(?:[.-]|$)/i.test(row.name))await add(row.name);
  await fs.mkdir(destination,{recursive:true});
  const compiled=await build({entryPoints:[path.join(converterRoot,'ui/browser.jsx')],outfile:path.join(destination,'browser.js'),bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',define:{'process.env.NODE_ENV':'"production"'},legalComments:'linked',logLevel:'silent'});
  for(const output of compiled.outputFiles)await fs.writeFile(output.path,output.contents);
  await fs.copyFile(path.join(converterRoot,'ui/host.css'),path.join(destination,'host.css'));
  const assets=[];
  for(const [relative,bytes]of files){const file=path.join(destination,'source',relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);assets.push({source:relative,url:urlFor(relative),sha256:hash(bytes),bytes:bytes.length});}
  manifest.assets=assets;manifest.runtime={entry:'/__dsh_ui/browser.js',css:'/__dsh_ui/host.css'};
  const title=manifest.name.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  await fs.writeFile(path.join(destination,'index.html'),`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/__dsh_ui/host.css">${compiled.outputFiles.some(file=>file.path.endsWith('browser.css'))?'<link rel="stylesheet" href="/__dsh_ui/browser.css">':''}</head><body><div id="app"></div><script src="/__dsh_ui/browser.js"></script></body></html>\n`);
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
