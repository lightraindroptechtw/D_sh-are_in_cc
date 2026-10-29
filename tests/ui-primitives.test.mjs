import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createPrimitives} from '../ui/primitives.mjs';
import {SettingsFormModel,settingsNumberField,settingsTextField} from '../ui/primitives-settings.mjs';
import {createConfigForms} from '../ui/runtime.mjs';

// A deterministic hook harness tests the actual event handlers and subsequent
// renders without downloading a second DOM implementation. Server rendering below
// separately verifies these controls are valid real React/native markup.
function harness(name,props={}){
  const cells=[],effects=[];let cursor=0;
  const react={...React,useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],next=>{cells[i]=typeof next==='function'?next(cells[i]):next;}];},useRef(initial){const i=cursor++;return cells[i]??(cells[i]={current:initial});},useId(){return 'test-id';},useEffect(fn){effects.push(fn);},useLayoutEffect(){}};
  const library=createPrimitives(react);const render=()=>{cursor=0;return library[name](props);};return {render,effects,library};
}
const children=node=>React.Children.toArray(node?.props?.children);
test('native controls preserve props, refs, icon and disabled busy behavior',()=>{
  const ui=createPrimitives(React),ref=React.createRef();
  const button=ui.Button({children:'儲存',busy:true,'aria-label':'儲存設定',className:'custom',onClick:()=>{}});
  assert.equal(button.type,'button');assert.equal(button.props.disabled,true);assert.equal(button.props['aria-busy'],true);assert.match(button.props.className,/custom/);
  const input=ui.Input({value:'abc',ref,type:'password','aria-label':'金鑰'});assert.equal(input.type,'input');assert.equal(input.props.ref,ref);assert.equal(input.props.type,'password');
  const markup=renderToStaticMarkup(React.createElement(ui.Modal,{open:true,portal:false,title:'修改設定'},React.createElement(ui.Input,{defaultValue:'測試'})));
  assert.match(markup,/role="dialog"/);assert.match(markup,/aria-modal="true"/);assert.match(markup,/<input/);assert.ok(!markup.includes('[object Object]'));
});
test('switch toggles local state, honors controlled values and does not emit when disabled',()=>{
  const changes=[],props={label:'啟用',onChange:v=>changes.push(v)};const sw=harness('Switch',props);let out=sw.render();assert.equal(out.props['aria-checked'],false);out.props.onClick({});out=sw.render();assert.equal(out.props['aria-checked'],true);assert.deepEqual(changes,[true]);props.disabled=true;out=sw.render();out.props.onClick({});assert.deepEqual(changes,[true]);
  props.disabled=false;props.checked=false;out=sw.render();out.props.onClick({});assert.equal(sw.render().props['aria-checked'],false);assert.deepEqual(changes,[true,true]);
});
test('input receives DOM events while value callback receives text; select retains numeric values',()=>{
  const ui=createPrimitives(React),events=[],values=[],event={target:{value:'changed'}};ui.Input({onChange:e=>events.push(e),onValueChange:v=>values.push(v)}).props.onChange(event);assert.equal(events[0],event);assert.deepEqual(values,['changed']);
  const selected=[];const select=harness('Select',{options:[{value:1,label:'一'},{value:2,label:'二'}],defaultValue:1,onChange:v=>selected.push(v)});select.render().props.onChange({target:{value:'2'}});assert.deepEqual(selected,[2]);assert.equal(select.render().props.value,2);
});
test('segmented radio controls select enabled options and maintain state',()=>{
  const values=[];const control=harness('SegmentedControl',{defaultValue:'a',options:[{value:'a',label:'甲'},{value:'b',label:'乙'},{value:'c',label:'丙',disabled:true}],onChange:v=>values.push(v)});let out=control.render();const rows=children(out);rows[1].props.onClick();out=control.render();assert.equal(children(out)[1].props['aria-checked'],true);children(out)[2].props.onClick();assert.deepEqual(values,['b']);
});
test('menu selection invokes real item actions and closes; disabled items do not invoke',()=>{
  const actions=[],props={defaultOpen:true,items:[{id:'a',label:'甲',onClick:()=>actions.push('item')},{id:'b',label:'乙',disabled:true}],onSelect:id=>actions.push(id),onClose:()=>actions.push('close'),anchor:'選單'};const menu=harness('Menu',props);let surface=children(menu.render())[1];let rows=children(surface);rows[1].props.onClick({});assert.deepEqual(actions,[]);rows[0].props.onClick({});assert.deepEqual(actions,['item','a','close']);assert.equal(children(menu.render()).length,1);
});
test('modal backdrop only closes when directly clicked and closed dialogs render nothing',()=>{
  let closed=0;const props={open:true,portal:false,onClose:()=>closed++};const modal=harness('Modal',props);const out=modal.render(),target={};out.props.onMouseDown({target,currentTarget:{}});assert.equal(closed,0);out.props.onMouseDown({target,currentTarget:target});assert.equal(closed,1);props.open=false;assert.equal(modal.render(),null);
});
test('toast schedules completion, cleanup cancels timer, clipboard rejection is explicit',async()=>{
  let done=0;const toast=harness('Toast',{text:'完成',holdMs:10,onDone:()=>done++});toast.render();const cleanup=toast.effects[0]();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(done,1);cleanup();
  const ui=createPrimitives(React);const original=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{value:{},configurable:true});try{await assert.rejects(ui.writeClipboard('資料'),error=>error.code==='UI_CLIPBOARD_UNAVAILABLE');}finally{if(original)Object.defineProperty(globalThis,'navigator',original);else delete globalThis.navigator;}
});
test('settings model publishes edited/invalid state, rejects failed writes and keeps drafts',async()=>{
  let current={status:'ready',writable:true,revision:2,value:{count:1,title:'old'},user:{count:1}},fail=false;const calls=[],subscribers=new Set();const scope={getSnapshot:()=>current,subscribe:fn=>{subscribers.add(fn);return()=>subscribers.delete(fn);},async mutate(ops,revision){calls.push([ops,revision]);if(fail)throw new Error('來源拒絕');for(const op of ops){if(op.op==='set')current.value[op.path[0]]=op.value;else delete current.value[op.path[0]];}current={...current,revision:current.revision+1};for(const fn of subscribers)fn();}};
  const model=new SettingsFormModel(scope,[settingsNumberField('count'),settingsTextField('title')]);let notifications=0;const store=model.bind(()=>({...model.shell(),count:model.field('count')}));store.subscribe(()=>notifications++);model.edit('count','bad');assert.equal(store.getSnapshot().invalid,true);await assert.rejects(model.save(),/有效數字/);assert.equal(calls.length,0);model.edit('count','12');await model.save();assert.equal(current.value.count,12);assert.equal(model.shell().dirty,false);assert.equal(calls[0][1],2);model.edit('title','new');fail=true;await assert.rejects(model.save(),/來源拒絕/);assert.equal(model.field('title').text,'new');assert.equal(model.shell().dirty,true);assert.equal(model.shell().error,'來源拒絕');assert.ok(notifications>=5);model.dispose();assert.equal(subscribers.size,0);
});
test('settings clear operations remain explicit and unsupported backends never appear saved',async()=>{
  const calls=[];const scope={getSnapshot:()=>({status:'ready',writable:true,value:{count:1},revision:3}),subscribe:()=>()=>{},update:async patch=>calls.push(patch)};const model=new SettingsFormModel(scope,[settingsNumberField('count')]);model.resetField('count');await assert.rejects(model.save(),error=>error.code==='UI_SETTINGS_API_UNSUPPORTED');assert.equal(calls.length,0);assert.equal(model.shell().dirty,true);model.dispose();
});
test('corpus icons contain distinct SVG paths and markdown escapes raw HTML',()=>{
  const ui=createPrimitives(React);assert.notEqual(children(ui.IconPlusOutline16({}))[0].props.d,children(ui.IconTrashOutlineRegular({}))[0].props.d);
  const markup=renderToStaticMarkup(React.createElement(ui.MarkdownText,{text:'# 標題\n\n<script>alert(1)</script>'}));assert.match(markup,/<h1>標題<\/h1>/);assert.match(markup,/&lt;script&gt;/);assert.ok(!markup.includes('<script>'));
});
test('settings model works with host configForms revision and backend refresh',async()=>{
  let count=1,revision=7;const calls=[];const forms=createConfigForms(async(method,args)=>{calls.push([method,args]);if(method==='settings.describe')return [{ns:'sample',value:{count},revision}];assert.equal(args.revision,revision);count=args.patch.count;revision++;return {applied:true};});await forms.load();const model=new SettingsFormModel(forms.get('sample'),[settingsNumberField('count')]);model.edit('count','25');await model.save();assert.equal(count,25);assert.equal(model.field('count').text,'25');assert.equal(model.shell().dirty,false);assert.equal(calls.find(([method])=>method==='settings.update')[1].revision,7);model.dispose();
});
test('name ranking filters irrelevant models while preserving stable ties',()=>{const ui=createPrimitives(React),rows=[{name:'Beta'},{name:'Alpha'},{name:'Alpine'}];assert.deepEqual(ui.rankByName(rows,'al').map(row=>row.name),['Alpha','Alpine']);assert.deepEqual(ui.rankByName(rows,''),rows);assert.notEqual(ui.rankByName(rows,''),rows);});
