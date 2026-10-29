/** Host-side half of the official local file service on Windows (sandboxed worker).
 * `@deepseek-ai/dsh-fs-local` replaces an existing file by copying its DACL onto the staged file (GetFileSecurityW /
 * SetFileSecurityW) and publishing it with ReplaceFileW, through koffi, a native addon. Under the Node permission model the worker
 * may not load addons, so the worker hands these two steps to this process. The calls and their arguments are the official ones;
 * both paths must lie inside a folder the worker may write. */
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const DACL_SECURITY_INFORMATION=4;
const errnoCode=code=>code===2||code===3?'ENOENT':code===5?'EACCES':'EIO';
const failure=(syscall,code,file)=>Object.assign(new Error(`${syscall} ${errnoCode(code)} (Win32 ${code}): ${file}`),{code:errnoCode(code),errno:code,syscall});

/** The nearest existing ancestor's real path plus the missing rest (same idea as the official resolver). */
function realOf(file){
  let current=path.resolve(file);const rest=[];
  for(;;){
    try{return path.join(realpathSync.native(current),...rest);}catch{}
    const parent=path.dirname(current);if(parent===current)return path.resolve(file);
    rest.unshift(path.basename(current));current=parent;
  }
}
const inside=(base,file)=>{const rel=path.relative(base,file);return rel===''||!rel.startsWith('..')&&!path.isAbsolute(rel);};

export function createWin32FsOps({runtimeRoot,writeFolders=[]}){
  let api;
  const folders=[...new Set(writeFolders.map(dir=>realOf(dir).toLowerCase()))];
  async function load(){
    if(api)return api;
    const requireFromRuntime=createRequire(path.join(runtimeRoot,'package.json'));
    const koffi=(await import(pathToFileURL(requireFromRuntime.resolve('koffi')).href)).default;
    const advapi32=koffi.load('advapi32.dll'),kernel32=koffi.load('kernel32.dll');
    api={
      getFileSecurityW:advapi32.func('int __stdcall GetFileSecurityW(const char16_t *path, uint32_t requested, void *descriptor, uint32_t length, _Out_ uint32_t *needed)'),
      setFileSecurityW:advapi32.func('int __stdcall SetFileSecurityW(const char16_t *path, uint32_t information, const void *descriptor)'),
      replaceFileW:kernel32.func('int __stdcall ReplaceFileW(const char16_t *replaced, const char16_t *replacement, const char16_t *backup, uint32_t flags, void *exclude, void *reserved)'),
      getLastError:kernel32.func('uint32_t __stdcall GetLastError()'),
    };
    return api;
  }
  const allowed=file=>typeof file==='string'&&path.isAbsolute(file)&&folders.some(dir=>inside(dir,realOf(file).toLowerCase()));
  return async function win32Fs(params){
    if(process.platform!=='win32')throw Object.assign(new Error('fs.win32 is only used on Windows'),{code:'HOST_RPC_UNSUPPORTED'});
    const {op,a,b}=params??{};
    if(!allowed(a)||!allowed(b))throw Object.assign(new Error('fs.win32: both paths must be inside a folder the plugin may write'),{code:'EACCES'});
    const win=await load();
    if(op==='copyDacl'){
      const source=path.toNamespacedPath(a),needed=[0];
      win.getFileSecurityW(source,DACL_SECURITY_INFORMATION,null,0,needed);
      if(needed[0]===0)throw failure('GetFileSecurityW',win.getLastError(),a);
      const descriptor=Buffer.alloc(needed[0]);
      if(win.getFileSecurityW(source,DACL_SECURITY_INFORMATION,descriptor,descriptor.length,needed)===0)throw failure('GetFileSecurityW',win.getLastError(),a);
      // Same flags as the official copyFileDaclWin32: DACL + PROTECTED_DACL.
      if(win.setFileSecurityW(path.toNamespacedPath(b),2147483652,descriptor.subarray(0,needed[0]))===0)throw failure('SetFileSecurityW',win.getLastError(),b);
      return {};
    }
    if(op==='replace'){
      if(win.replaceFileW(path.toNamespacedPath(a),path.toNamespacedPath(b),null,0,null,null)===0)throw failure('ReplaceFileW',win.getLastError(),a);
      return {};
    }
    throw Object.assign(new Error(`fs.win32: unknown operation ${String(op).slice(0,40)}`),{code:'INVALID_PARAMS'});
  };
}
