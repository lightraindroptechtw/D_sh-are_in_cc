const read=(object,path)=>String(path).split('.').reduce((value,key)=>value?.[key],object);
const unsupported=message=>Object.assign(new Error(message),{code:'UI_SETTINGS_API_UNSUPPORTED'});
export function settingsTextField(field){return {field,format:value=>value===undefined||value===null?'':String(value),parse:text=>text===''?{kind:'clear'}:{kind:'set',value:String(text)}};}
export function settingsNumberField(field){return {field,format:value=>typeof value==='number'?String(value):'',parse:text=>{if(String(text).trim()==='')return {kind:'clear'};const value=Number(text);return Number.isFinite(value)?{kind:'set',value}:{kind:'invalid',message:'請輸入有效數字'};}};}

// Dirty text is retained after failed writes. Clear operations are never converted
// to undefined writes: they require the scope's explicit mutate/unset operation.
export class SettingsFormModel {
  constructor(scope,specs=[]){if(!scope?.getSnapshot||!scope?.subscribe)throw unsupported('設定模型需要 getSnapshot 與 subscribe。');this.scope=scope;this.specs=new Map(specs.map(spec=>[spec.field,spec]));this.drafts=new Map();this.bindings=new Set();this.saving=false;this.error=undefined;this.closed=false;this.off=scope.subscribe(()=>this.publish());this.edit=this.edit.bind(this);this.resetField=this.resetField.bind(this);this.discard=this.discard.bind(this);this.save=this.save.bind(this);}
  source(){return this.scope.getSnapshot();}
  field(field){const spec=this.specs.get(field);if(!spec)throw unsupported(`設定欄位「${field}」沒有宣告格式。`);const source=this.source(),value=read(source.value,field),text=this.drafts.has(field)?this.drafts.get(field):spec.format(value);const parsed=spec.parse(text);return {text,invalid:parsed.kind==='invalid',message:parsed.message,overridden:read(source.user,field)!==undefined,dirty:this.drafts.has(field),value};}
  shell(){const source=this.source();return {...source,available:source.status==='ready',writable:source.writable===true,dirty:this.drafts.size>0,invalid:[...this.specs.keys()].some(field=>this.field(field).invalid),saving:this.saving,failed:Boolean(this.error),error:this.error};}
  publish(){for(const binding of this.bindings){binding.snapshot=binding.project();for(const listener of binding.listeners)listener();}}
  bind(project){const binding={project,listeners:new Set(),snapshot:project()};this.bindings.add(binding);return {getSnapshot:()=>binding.snapshot,subscribe:listener=>{binding.listeners.add(listener);return()=>binding.listeners.delete(listener);}};}
  edit(field,text){if(this.closed)throw unsupported('設定模型已關閉。');if(!this.specs.has(field))throw unsupported(`未知設定欄位「${field}」。`);this.drafts.set(field,String(text));this.error=undefined;this.publish();}
  resetField(field){this.edit(field,'');}
  discard(){this.drafts.clear();this.error=undefined;this.publish();}
  actions(){return {edit:this.edit,resetField:this.resetField,discard:this.discard,save:this.save};}
  async save(){if(this.saving)throw unsupported('設定正在儲存。');const source=this.source();if(source.writable!==true)throw unsupported('設定目前不允許寫入。');const edits=[...this.drafts];if(!edits.length)return true;const ops=edits.map(([field,text])=>{const parsed=this.specs.get(field).parse(text);if(parsed.kind==='invalid')throw unsupported(parsed.message??`欄位「${field}」格式無效。`);return parsed.kind==='clear'?{op:'unset',path:field.split('.')}:{op:'set',path:field.split('.'),value:parsed.value};});this.saving=true;this.error=undefined;this.publish();try{if(this.scope.mutate)await this.scope.mutate(ops,source.revision);else if(ops.every(op=>op.op==='set'&&op.path.length===1)&&this.scope.update)await this.scope.update(Object.fromEntries(ops.map(op=>[op.path[0],op.value])),source.revision);else throw unsupported('設定來源沒有提供這次變更需要的修改介面。');for(const [field,text]of edits)if(this.drafts.get(field)===text)this.drafts.delete(field);return true;}catch(error){this.error=error?.message??String(error);throw error;}finally{this.saving=false;this.publish();}}
  dispose(){this.closed=true;this.off?.();for(const binding of this.bindings)binding.listeners.clear();this.bindings.clear();}
}
