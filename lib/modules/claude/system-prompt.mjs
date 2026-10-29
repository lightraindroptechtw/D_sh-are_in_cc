export const descriptor={
  id:'systemPrompt',displayName:'提示詞模組（Claude Code）',services:['systemPrompt'],
  requires:{capabilities:[]},
  methods:{
    register:{support:'full',reason:'沿用官方插件段落登記與組裝'},
    assemble:{support:'full',reason:'由官方組裝內容'},
    injectContext:{support:'partial',reason:'組裝後的段落由 mod 經 prompt.compose 附加到 Claude Code 系統提示詞；不取代 Claude Code 的原有提示詞'},
  },
  requirements:['mod 需在每次組裝系統提示詞時附加 ready.promptSections'],
};
export async function install({root}){
  const service=root.get('systemPrompt');
  return {services:{systemPrompt:service},diagnostics:[]};
}

/** Collect the plugin's own prompt sections as {id,text}; contexts follow as ctx:<name>. */
export function collectPromptSections(sections=[],contexts=[]){
  const rows=[];
  for(const section of sections)if(typeof section?.text==='string'&&section.text.trim())rows.push({id:String(section.name),text:section.text});
  for(const context of contexts)if(typeof context?.text==='string'&&context.text.trim())rows.push({id:`ctx:${context.name}`,text:context.text});
  return rows;
}
