import test from 'node:test';
import assert from 'node:assert/strict';
import {createUiEventJournal,UI_EVENT_NAMES} from '../lib/ui-event-journal.mjs';

test('UI event journal retains only ordered metadata, bounds history, and reports missing cursors',async()=>{
  const listeners=new Map(),context={on(name,listener){listeners.set(name,listener);return()=>listeners.delete(name);}};
  const journal=createUiEventJournal({context,capacity:3});
  assert.deepEqual([...listeners.keys()],UI_EVENT_NAMES);
  assert.deepEqual(journal.poll(),{cursor:0,events:[],lost:false});
  listeners.get('credentials/reference-updated')('FIRST_KEY','must-not-be-copied');
  listeners.get('credentials/record-updated')('plugin/provider',{key:'must-not-be-copied'});
  listeners.get('settings/document-updated')('plugin-settings',2,{chat:'must-not-be-copied'});
  listeners.get('credentials/reference-updated')('LAST_KEY');
  assert.deepEqual(journal.poll({after:0}),{cursor:4,lost:true,events:[
    {id:2,name:'credentials/record-updated',args:['plugin/provider']},
    {id:3,name:'settings/document-updated',args:['plugin-settings',2]},
    {id:4,name:'credentials/reference-updated',args:['LAST_KEY']},
  ]});
  assert.deepEqual(journal.poll({after:3}),{cursor:4,events:[{id:4,name:'credentials/reference-updated',args:['LAST_KEY']}],lost:false});
  assert.deepEqual(journal.poll({after:4}),{cursor:4,events:[],lost:false});
  assert.equal(journal.poll({after:99}).lost,true);
  assert.throws(()=>journal.poll({after:-1}),{code:'UI_EVENTS_INVALID'});
  const listener=listeners.get('credentials/reference-updated');
  await journal.dispose();assert.equal(listeners.size,0);listener('AFTER_DISPOSE');
  assert.throws(()=>journal.poll(),{code:'UI_EVENTS_DISPOSED'});
  await journal.dispose();
});

test('official command and model-adapter notices forward no source payload',async()=>{
  const listeners=new Map(),context={on(name,listener){listeners.set(name,listener);return()=>listeners.delete(name);}};
  const journal=createUiEventJournal({context});
  listeners.get('commands/change')({untrusted:'source payload'});
  listeners.get('llm/adapters-updated')('not part of official payload');
  assert.deepEqual(journal.poll().events,[{id:1,name:'commands/change',args:[]},{id:2,name:'llm/adapters-updated',args:[]}]);await journal.dispose();
});
