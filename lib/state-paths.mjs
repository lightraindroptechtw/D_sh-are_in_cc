import {createHash} from 'node:crypto';

/** A stable state identity for a converted plugin (same source, package folder and name give the same id). */
export function stablePluginId({origin,packageDir='.',name}){
  if(typeof origin!=='string'||!origin||typeof name!=='string'||!name)throw new TypeError('State identity requires source origin and plugin name');
  const label=name.replace(/^@[^/]+\//,'').toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'plugin';
  return label+'-'+createHash('sha256').update(origin+'\0'+packageDir+'\0'+name).digest('hex').slice(0,16);
}
