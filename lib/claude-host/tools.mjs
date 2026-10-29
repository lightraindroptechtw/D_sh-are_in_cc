/** Claude Code tool names: letters, digits, `_` and `-`, at most 64 characters. */
const VALID=/^[A-Za-z0-9_-]{1,64}$/;

export function claudeToolName(dshName,used=new Set()){
  let base=String(dshName).replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64)||'tool';
  let name=base,n=1;
  while(used.has(name)||!VALID.test(name)){n+=1;const suffix=`_${n}`;name=base.slice(0,64-suffix.length)+suffix;}
  used.add(name);return name;
}

/** Stable descriptors for the `ready`/`toolsChanged` lines. A tool keeps its Claude name across refreshes. */
export function createToolCatalog(){
  const names=new Map(),used=new Set();
  return {
    describe(tools){
      return tools.map(tool=>{
        if(!names.has(tool.name))names.set(tool.name,claudeToolName(tool.name,used));
        return {dshName:tool.name,name:names.get(tool.name),description:typeof tool.description==='string'?tool.description:'',inputSchema:tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema:{type:'object'}};
      });
    },
    /** Accepts the Claude-visible name or the DSH name. */
    find(tools,name){
      for(const tool of tools)if(tool.name===name||names.get(tool.name)===name)return tool;
      return undefined;
    },
  };
}

/** Claude Code tool_result content: text only; other blocks are described, never dropped silently. */
export function shapeContent(content){
  const rows=[];
  for(const block of Array.isArray(content)?content:[]){
    if(block?.type==='text'&&typeof block.text==='string')rows.push({type:'text',text:block.text});
    else rows.push({type:'text',text:`[${block?.type??'unknown'} content omitted: Claude Code tool results carry text only]`});
  }
  return rows.length?rows:[{type:'text',text:''}];
}
