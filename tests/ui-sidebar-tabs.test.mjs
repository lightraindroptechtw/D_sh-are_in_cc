import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntime,createSidebarTabs} from '../ui/runtime.mjs';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('page tabs open by kind, reveal an existing tab and keep independent mounted identities',()=>{
  const tabs=createSidebarTabs();let updates=0;tabs.state.subscribe(()=>updates++);
  tabs.registry.register({id:'dsh-diff-approval',kind:'diff-approval',title:()=> 'Review',guide:[{order:40}]});
  tabs.registry.register({id:'git-panel',kind:'git',title:()=> 'Git',guide:[{id:'git',order:12}]});
  tabs.service.openTab('diff-approval',{revealIfOpened:true});const first=tabs.state.getSnapshot().tabs[0];
  tabs.service.openTab('git');const second=tabs.state.getSnapshot().tabs[1];
  tabs.service.openTab('diff-approval',{revealIfOpened:true});
  assert.equal(tabs.state.getSnapshot().tabs.length,2);assert.equal(tabs.state.getSnapshot().tabs[0].id,first.id);
  assert.equal(tabs.state.getSnapshot().activeId,first.id);assert.equal(first.contentId,'sidebar://diff-approval');
  assert.equal(first.navigation.address,first.contentId);
  tabs.info(first.id,true).tab.actions.close();assert.equal(tabs.state.getSnapshot().activeId,second.id);
  tabs.close(first.id);assert.equal(tabs.state.getSnapshot().tabs.length,1);assert.ok(updates>=4);
});

test('original-style body/title registration, injected dependencies, visibility and owner cleanup',()=>{
  const runtime=createRuntime();let scope;
  const Body=()=>null,Title=()=>null;
  runtime.load({id:'original-dock',factory:()=>({inject:['slots','sidebarRightTabs','sidebarRight'],apply(ctx){
    scope=ctx;ctx.sidebarRightTabs.register({id:'original-dock',kind:'review',title:()=> 'Review',guide:[{order:40}]});
    ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:'original-dock',inject:()=>({api:'owned'})},Body));
    ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:'original-dock'},Title));
    ctx.sidebarRight.openTab('review',{revealIfOpened:true});
  }})});
  assert.equal(runtime.modules.get('original-dock').status,'loaded');assert.deepEqual(runtime.diagnostics,[]);
  const tab=runtime.sidebarTabs.state.getSnapshot().tabs[0];
  assert.equal(runtime.slots.selected('sidebar.right.pane.tab',tab.registrationId)[0].component,Body);
  assert.deepEqual(runtime.slots.selected('sidebar.right.pane.tab',tab.registrationId)[0].inject(),{api:'owned'});
  assert.equal(runtime.slots.selected('sidebar.right.pane.tab.title',tab.registrationId)[0].component,Title);
  assert.equal(runtime.sidebarTabs.info(tab.id,false).tab.visible,false);
  const info=runtime.sidebarTabs.info(tab.id,true);assert.equal(info.tab.visible,true);info.tab.actions.close();
  scope.sidebarRight.openTab('review');scope.dispose();
  assert.equal(runtime.sidebarTabs.catalog.getSnapshot().length,0);assert.equal(runtime.sidebarTabs.state.getSnapshot().tabs.length,0);
  assert.equal(runtime.slots.entries('sidebar.right.pane.tab').length,0);runtime.dispose();
});

test('unregistering a type closes its tabs and rejects conflicts or invalid resource addresses',()=>{
  const tabs=createSidebarTabs();const off=tabs.registry.register({id:'page',kind:'page'});tabs.service.openTab('page');
  assert.throws(()=>tabs.registry.register({id:'page',kind:'other'}),{code:'UI_TAB_CONFLICT'});
  assert.throws(()=>tabs.info(tabs.state.getSnapshot().activeId,true).tab.actions.openResource('file://x'),{code:'UI_RESOURCE_ADDRESS_INVALID'});
  off();off();assert.equal(tabs.state.getSnapshot().tabs.length,0);assert.throws(()=>tabs.service.openTab('page'),{code:'UI_TAB_UNAVAILABLE'});
  tabs.registry.register({id:'resource',kind:'file',patterns:['**/*.drawio']});
  tabs.service.openTab('file');assert.equal(tabs.service.active().navigation.address,'sidebar://file');
  assert.throws(()=>tabs.registry.register({id:'bad'}),{code:'UI_TAB_INVALID'});tabs.dispose();
});

test('updated browser renders JSX through the production bundler',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const result=await build({entryPoints:[path.join(root,'ui/browser.jsx')],outfile:path.join(root,'unused-browser.js'),bundle:true,write:false,platform:'browser',format:'iife',target:'es2022',logLevel:'silent'});
  assert.ok(result.outputFiles.find(file=>file.path.endsWith('.js')).contents.length>0);
  assert.ok(result.outputFiles.find(file=>file.path.endsWith('.css')).contents.length>0);
});
