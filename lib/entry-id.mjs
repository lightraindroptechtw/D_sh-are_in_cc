/** A loader entry id must match /^[A-Za-z0-9_.-]+$/ (the profile patch uses it as a file name).
 * A scoped package name such as "@copylee/dsh-office" becomes "copylee-dsh-office"; anything else
 * that cannot be made valid falls back to a hex fingerprint of the original text. */
export const ENTRY_ID_PATTERN=/^[A-Za-z0-9_.-]+$/;
export function entryIdFor(name,fallback='target-plugin'){
  if(typeof name!=='string'||!name)return fallback;
  if(ENTRY_ID_PATTERN.test(name))return name;
  const scoped=name.match(/^@([^/]+)\/(.+)$/);
  const cleaned=(scoped?`${scoped[1]}-${scoped[2]}`:name).replace(/[^A-Za-z0-9_.-]+/g,'-').replace(/-{2,}/g,'-').replace(/^[-.]+|[-.]+$/g,'').slice(0,100);
  return cleaned&&ENTRY_ID_PATTERN.test(cleaned)?cleaned:'source-'+Buffer.from(name).toString('hex').slice(0,100);
}
