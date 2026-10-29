import test from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteServices, RemoteError} from '../ui/remote.mjs';

const strictCodec = {mode:'strict',create:() => ({parse:value => value})};
function descriptor(method = 'read', overrides = {}) {
  return {id:`sample/${method}`,service:'sample',namespace:'sample',method,invocation:{kind:'direct'},parameters:[{name:'value',wire:'wireValue',source:'json',codec:strictCodec}],result:{mode:'src-json'},...overrides};
}
const contribution = (descriptors, name = 'sample-plugin') => ({package:name,descriptors});
function harness(options = {}) {
  const calls = [];
  const services = createRemoteServices({builtins:false,rpc:async (...args) => {calls.push(args);return {ok:true,value:{received:true}};},...options});
  return {...services,calls};
}

test('Connection preserves endpoint result envelopes and carries AbortSignal separately', async () => {
  const wire = {ok:false,error:{code:'owner/custom',message:'refused',details:{reason:'test'}}};
  const services = harness({rpc:async (...args) => {services.calls.push(args);return wire;}});
  const signal = new AbortController().signal;
  assert.equal(await services.connection.rpc.call('/roundtable','status/get',{id:4},signal),wire);
  assert.deepEqual(services.calls[0].slice(0,2),['ui.connection.call',{channel:'/roundtable',endpoint:'status/get',payload:{id:4}}]);
  assert.equal(services.calls[0][2].signal,signal);
  assert.equal(typeof services.connection.rpc.open,'function');
});

test('Connection refuses path traversal, malformed results and transport faults without fake success', async () => {
  let count = 0;
  const services = harness({rpc:async () => {count++;return {ok:true,result:42};}});
  for (const [channel,endpoint] of [['api','valid'],['/api','../settings'],['/api','a//b'],['/api','a?x=1'],['/api/sub','valid']]) {
    await assert.rejects(services.connection.rpc.call(channel,endpoint,{}),{code:'UI_CONNECTION_TARGET'});
  }
  assert.equal(count,0);
  // A successful void method may omit value after JSON serialization, as DSH does.
  assert.deepEqual(await services.connection.rpc.call('/api','valid',{}),{ok:true,result:42});
  const malformed = harness({rpc:async () => ({ok:false,error:{message:'missing code/details'}})});
  await assert.rejects(malformed.connection.rpc.call('/api','valid',{}),{code:'UI_CONNECTION_RESULT'});
  const offline = harness({rpc:async () => {throw new Error('offline');}});
  await assert.rejects(offline.connection.rpc.call('/api','valid',{}),/offline/);
});

test('$mount projects positional arguments into named wire fields, retaining dotted method names', async () => {
  const services = harness();
  const dispose = await services.remote.$mount(contribution([descriptor('sessions.list',{parameters:[
    {name:'session',wire:'sessionId',source:'lookup',lookup:'agent',codec:strictCodec},
    {name:'unused',wire:'optional',source:'json',codec:strictCodec},
  ]})]));
  const result = await services.remote.sample['sessions.list']('abc',undefined);
  assert.deepEqual(result,{ok:true,value:{received:true}});
  const [method,params] = services.calls[0];
  assert.equal(method,'ui.connection.call');assert.equal(params.channel,'/api');assert.equal(params.endpoint,'sample/sessions.list');
  assert.deepEqual({...params.payload.args},{sessionId:'abc'});
  assert.equal(services.remote.sample.sessions,undefined);
  assert.equal(services.lookup('remote.sample'),services.remote.sample);
  await dispose();assert.equal(services.remote.sample,undefined);
});

test('Client matches DSH codecs: input parsing stays on Host; result decode runs only for strict results', async () => {
  let parsed = 0, decoded = 0;
  const codec = {mode:'strict',create:() => {parsed++;throw new Error('must not parse on Client');}};
  const services = harness({rpc:async () => ({ok:true,value:'42'})});
  await services.remote.$mount(contribution([descriptor('read',{parameters:[{name:'value',wire:'value',source:'json',codec}],result:{mode:'strict',decode:value => {decoded++;return Number(value);}}})]));
  assert.deepEqual(await services.remote.sample.read('raw'),{ok:true,value:42});
  assert.equal(parsed,0);assert.equal(decoded,1);
  await assert.rejects(services.remote.$mount(contribution([descriptor('bad',{parameters:[{name:'value',wire:'value',source:'json',codec:{mode:'src-json'}}]})],'bad-plugin')),/strict codec/);
  assert.equal(services.remote.sample.bad,undefined);
});

test('Remote failures rebuild real errors with stable codes, details and structural marker', async () => {
  const services = harness({rpc:async () => ({ok:false,error:{code:'plugin/new-error',message:'no permission',details:{file:'x'}}})});
  await services.remote.$mount(contribution([descriptor()]));
  const result = await services.remote.sample.read(1);
  assert.equal(result.ok,false);assert.ok(result.error instanceof Error);assert.ok(result.error instanceof RemoteError);
  assert.equal(result.error.code,'plugin/new-error');assert.equal(result.error.isDSHRemoteError,true);
  assert.deepEqual(result.error.details,{file:'x'});
});

test('Transport and decoder failures become gateway/internal; bad arity remains a programming error', async () => {
  const services = harness({rpc:async () => {throw new Error('socket closed');}});
  await services.remote.$mount(contribution([descriptor()]));
  const result = await services.remote.sample.read(1);
  assert.equal(result.error.code,'gateway/internal');assert.match(result.error.message,/sample\/read failed: socket closed/);
  await assert.rejects(services.remote.sample.read(),/需要 1 個/);
  assert.equal(services.calls.length,0);
  const decoder = harness();
  await decoder.remote.$mount(contribution([descriptor('read',{result:{mode:'strict',decode:() => {throw new Error('bad bytes');}}})]));
  assert.match((await decoder.remote.sample.read(1)).error.message,/bad bytes/);
});

test('Declared cancellation travels outside business payload and yields gateway/cancelled', async () => {
  let requestSignal;
  const services = harness({rpc:async (method,params,{signal}) => {
    requestSignal = signal;
    return new Promise((resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));
  }});
  await services.remote.$mount(contribution([descriptor('read',{cancellation:{parameter:'signal'}})]));
  const controller = new AbortController(), pending = services.remote.sample.read(3,controller.signal);
  controller.abort(new Error('cancelled by test'));
  const result = await pending;
  assert.equal(result.error.code,'gateway/cancelled');assert.equal(requestSignal.aborted,true);
  const before = harness();await before.remote.$mount(contribution([descriptor('read',{cancellation:{parameter:'signal'}})]));
  assert.equal((await before.remote.sample.read(1,controller.signal)).error.code,'gateway/cancelled');
  assert.equal(before.calls.length,0);
  await assert.rejects(before.remote.sample.read(1,{}),/AbortSignal/);
});

test('Unmount withdraws saved functions and in-flight calls, preserving unrelated contributions', async () => {
  let finish,signal;
  const services = harness({rpc:async (method,params,options) => {signal=options.signal;return new Promise(resolve => {finish=resolve;});}});
  const off = await services.remote.$mount(contribution([descriptor('first')]));
  const secondOff = await services.remote.$mount(contribution([descriptor('second')],'second-plugin'));
  const saved = services.remote.sample.first, pending = saved(1);
  off();off();assert.equal(signal.aborted,true);assert.equal(services.remote.sample.first,undefined);
  assert.equal(typeof services.remote.sample.second,'function');
  finish({ok:true,value:'late'});
  assert.match((await pending).error.message,/no longer mounted/);
  assert.match((await saved(1)).error.message,/no longer mounted/);
  secondOff();assert.equal(services.remote.sample,undefined);
});

test('Mount validates every descriptor before publishing; duplicate packages and methods are rejected', async () => {
  const services = harness();
  await assert.rejects(services.remote.$mount(contribution([descriptor('good'),descriptor('remove')])),{code:'UI_REMOTE_CONFLICT'});
  assert.equal(services.remote.sample,undefined);
  const off = await services.remote.$mount(contribution([descriptor('good')]));
  await assert.rejects(services.remote.$mount(contribution([descriptor('other')])),{code:'UI_REMOTE_CONFLICT'});
  await assert.rejects(services.remote.$mount(contribution([descriptor('first'),descriptor('good')],'second')), {code:'UI_REMOTE_CONFLICT'});
  assert.equal(services.remote.sample.first,undefined);
  off();await services.remote.$mount(contribution([descriptor('good')]));
  assert.equal(typeof services.remote.sample.good,'function');
});

test('Scoped direct methods use explicit identity adapters while root calls retain the lookup argument', async () => {
  const services = harness();
  const d = descriptor('list',{parameters:[{name:'agent',wire:'agentId',source:'lookup',lookup:'agent',codec:strictCodec}],scope:{context:'agent',wire:'agentId'}});
  await services.remote.$mount(contribution([d]));
  await services.remote.sample.list('root-agent');
  const scoped = services.forContext({identities:{agent:'scoped-agent'}});
  await scoped.sample.list();
  assert.deepEqual(services.calls.map(call => ({...call[1].payload.args})),[{agentId:'root-agent'},{agentId:'scoped-agent'}]);
  await assert.rejects(scoped.sample.list('extra'),/需要 0 個/);
  const contextOnly = descriptor('contextOnly',{invocation:{kind:'context',context:'workspace',wire:'workspaceId',codec:strictCodec}});
  await services.remote.$mount(contribution([contextOnly],'context-only'));
  await assert.rejects(services.remote.sample.contextOnly(1),{code:'UI_REMOTE_CONTEXT'});
  await services.forContext({identities:{workspace:'folder'}}).sample.contextOnly(2);
  assert.deepEqual({...services.calls.at(-1)[1].payload.args},{workspaceId:'folder',wireValue:2});
  // Runtime Context throws on unknown services. Optional identities must not read
  // an absent Context service while selecting the ordinary direct signature.
  const throwingContext = new Proxy({}, {get(target,key) {throw new Error(`unknown service ${String(key)}`);}});
  await services.forContext(throwingContext).sample.list('direct-agent');
  assert.deepEqual({...services.calls.at(-1)[1].payload.args},{agentId:'direct-agent'});
});

test('Per-context mounts are owned by the caller effect and update all namespace views', async () => {
  const cleanups = [];
  const caller = {effect(callback) {const off=callback();cleanups.push(off);return off;}};
  const services = harness(), remote = services.forContext(caller);
  await remote.$mount(contribution([descriptor()]));
  assert.equal(typeof services.remote.sample.read,'function');assert.equal(cleanups.length,1);
  cleanups[0]();assert.equal(remote.sample,undefined);assert.equal(services.remote.sample,undefined);
});

test('Built-in remote services expose only official signatures and use named /api payloads', async () => {
  const services = harness({builtins:true});
  assert.deepEqual(Object.keys(services.remote.credentials).sort(),['describe','set','unset']);
  assert.deepEqual(Object.keys(services.remote.commands).sort(),['execute','list']);
  await services.remote.settings.update('plugin',{enabled:true},undefined);
  await services.remote.credentials.describe(['key-ref']);
  await services.remote.commands.execute('agent-1','/local-action',[]);
  assert.deepEqual(services.calls.map(call => [call[1].endpoint,{...call[1].payload.args}]),[
    ['settings/update',{ns:'plugin',patch:{enabled:true}}],
    ['credentials/describe',{refs:['key-ref']}],
    ['commands/execute',{agentId:'agent-1',line:'/local-action',submittedAttachments:[]}],
  ]);
  await assert.rejects(services.remote.settings.update('plugin',{enabled:true}),/需要 3 個/);
  assert.equal(services.remote.credentials.get,undefined);
});

test('Unknown subscriptions and Host facts report explicitly; stream options and arity are validated', async () => {
  const reports = [],services = harness({report:error => reports.push(error)});
  let called = false;
  const off = services.remote.$on('changed',() => {called = true;});
  assert.equal(off.supported,false);off();off();assert.equal(called,false);
  assert.equal(reports[0].code,'UI_REMOTE_EVENT_UNSUPPORTED');
  assert.throws(() => services.remote.$stream({}),{code:'UI_REMOTE_INVALID'});
  assert.throws(() => services.remote.$host,{code:'UI_REMOTE_UNSUPPORTED'});
  await services.remote.$mount(contribution([descriptor('watch',{mode:'stream'})]));
  assert.throws(() => services.remote.sample.watch(),/需要 1 個/);
  assert.equal(services.calls.length,0);
  const known = harness({context:{hostFacts:{home:'C:/example',isLoopback:true}}});
  assert.deepEqual(known.remote.$host,{home:'C:/example',isLoopback:true});
});

const waitFor = async (predicate, message = 'condition did not settle') => {
  const expires = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= expires) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve,2));
  }
};

test('Known Remote events use one poller and deliver actual args in order with a monotone cursor', async t => {
  const requests = [],delivered = [];let nextId = 1;
  const services = harness({pollIntervalMs:2,rpc:async (method,params,{signal}) => {
    requests.push({method,params,signal});
    if (nextId <= 2) {
      const id = nextId++;
      return {cursor:id,events:[{id,name:'credentials/reference-updated',args:[`ref-${id}`,{set:true}]}],lost:false};
    }
    return {cursor:2,events:[],lost:false};
  }});
  t.after(services.dispose);
  assert.equal(requests.length,0);
  const off = services.remote.$on('credentials/reference-updated',(...args) => delivered.push(args));
  const otherOff = services.remote.$on('credentials/record-updated',() => assert.fail('wrong event listener'));
  assert.equal(off.supported,true);assert.equal(otherOff.supported,true);
  await waitFor(() => delivered.length === 2);
  assert.deepEqual(delivered,[['ref-1',{set:true}],['ref-2',{set:true}]]);
  assert.deepEqual(requests.slice(0,2).map(row => [row.method,row.params]),[['ui.events.poll',{after:0}],['ui.events.poll',{after:1}]]);
  assert.ok(requests.every(row => row.signal instanceof AbortSignal));
  off();otherOff();const count = requests.length;
  await new Promise(resolve => setTimeout(resolve,8));assert.equal(requests.length,count);
});

test('Polling retries transport failures without advancing the cursor or fabricating callbacks', async t => {
  const reports = [],requests = [],delivered = [];
  const services = harness({pollIntervalMs:2,report:error => reports.push(error),rpc:async (method,params) => {
    requests.push(params.after);
    if (requests.length === 1) throw new Error('poll carrier offline');
    return {cursor:7,events:params.after === 0 ? [{id:7,name:'settings/document-updated',args:[{revision:3}]}] : [],lost:false};
  }});
  t.after(services.dispose);
  const off = services.remote.$on('settings/document-updated',update => delivered.push(update));
  assert.equal(delivered.length,0);
  await waitFor(() => delivered.length === 1 && requests.length >= 3);
  assert.deepEqual(requests.slice(0,3),[0,0,7]);assert.deepEqual(delivered,[{revision:3}]);
  assert.match(reports[0].message,/poll carrier offline/);off();
});

test('Event listener exceptions and async rejection do not interrupt other listeners or cursor advancement', async t => {
  const reports = [],delivered = [],requests = [];
  const services = harness({pollIntervalMs:2,report:error => reports.push(error),rpc:async (method,params) => {
    requests.push(params.after);
    return {cursor:1,events:params.after === 0 ? [{id:1,name:'credentials/record-updated',args:['credential-ref']}] : [],lost:false};
  }});
  t.after(services.dispose);
  services.remote.$on('credentials/record-updated',() => {throw new Error('sync listener failed');});
  services.remote.$on('credentials/record-updated',async () => {throw new Error('async listener failed');});
  services.remote.$on('credentials/record-updated',ref => delivered.push(ref));
  await waitFor(() => reports.length >= 2 && requests.length >= 2);
  assert.deepEqual(delivered,['credential-ref']);assert.deepEqual(requests.slice(0,2),[0,1]);
  assert.deepEqual(reports.map(row => row.message).sort(),['async listener failed','sync listener failed']);
});

test('Removing the last subscription cancels an in-flight poll and rejects late delivery', async t => {
  const requests = [],delivered = [];let finish;
  const services = harness({pollIntervalMs:2,rpc:async (method,params,{signal}) => {
    requests.push({params,signal});return new Promise(resolve => {finish=resolve;});
  }});
  t.after(services.dispose);
  const first = services.remote.$on('credentials/reference-updated',arg => delivered.push(arg));
  const second = services.remote.$on('credentials/reference-updated',arg => delivered.push(arg));
  assert.equal(requests.length,1);first();assert.equal(requests[0].signal.aborted,false);
  second();second();assert.equal(requests[0].signal.aborted,true);
  finish({cursor:1,events:[{id:1,name:'credentials/reference-updated',args:['too late']}],lost:false});
  await new Promise(resolve => setTimeout(resolve,8));
  assert.deepEqual(delivered,[]);assert.equal(requests.length,1);
});

test('Context effect owns known event subscriptions and service disposal cancels all contexts', async t => {
  const cleanups = [],requests = [];
  const caller = {effect(callback) {const off=callback();cleanups.push(off);return off;}};
  const services = harness({pollIntervalMs:2,rpc:async (method,params,{signal}) => {
    requests.push(signal);return new Promise((resolve,reject) => signal.addEventListener('abort',() => reject(signal.reason),{once:true}));
  }});
  t.after(services.dispose);
  const remote = services.forContext(caller);
  remote.$on('credentials/reference-updated',() => assert.fail('no event arrived'));
  assert.equal(cleanups.length,1);assert.equal(requests.length,1);
  cleanups[0]();assert.equal(requests[0].aborted,true);
  const off = services.remote.$on('settings/document-updated',() => assert.fail('no event arrived'));
  assert.equal(requests.length,2);services.dispose();assert.equal(requests[1].aborted,true);
  off();cleanups[0]();
  await new Promise(resolve => setTimeout(resolve,8));assert.equal(requests.length,2);
  assert.throws(() => remote.$on('settings/document-updated',() => {}),{code:'UI_REMOTE_DISPOSED'});
});

test('Ring overflow reports lost events and continues with retained real events, without replaying duplicates', async t => {
  const delivered = [],reports = [],requests = [];
  const services = harness({pollIntervalMs:2,report:error => reports.push(error),rpc:async (method,params) => {
    requests.push(params.after);
    return {cursor:300,events:params.after === 0 ? [{id:299,name:'settings/document-updated',args:[299]},{id:300,name:'settings/document-updated',args:[300]}] : [],lost:params.after === 0};
  }});
  t.after(services.dispose);
  const off = services.remote.$on('settings/document-updated',revision => delivered.push(revision));
  await waitFor(() => requests.length >= 2);
  assert.deepEqual(delivered,[299,300]);assert.deepEqual(requests.slice(0,2),[0,300]);
  assert.equal(reports[0].code,'UI_REMOTE_EVENTS_LOST');off();
});

test('Malformed event batches are refused atomically and retry from the last accepted cursor', async t => {
  const delivered = [],reports = [],requests = [];
  const services = harness({pollIntervalMs:2,report:error => reports.push(error),rpc:async (method,params) => {
    requests.push(params.after);
    if (requests.length === 1) return {cursor:2,events:[{id:2,name:'settings/document-updated',args:['must not deliver']},{id:1,name:'settings/document-updated',args:['out of order']}],lost:false};
    return {cursor:2,events:params.after === 0 ? [{id:2,name:'settings/document-updated',args:['valid']}]:[],lost:false};
  }});
  t.after(services.dispose);
  const off = services.remote.$on('settings/document-updated',event => delivered.push(event));
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered,['valid']);assert.deepEqual(requests.slice(0,2),[0,0]);
  assert.equal(reports[0].code,'UI_REMOTE_EVENTS_FORMAT');off();
});

test('Host cursor resets recover only with explicit lost history and continue polling the new sequence', async t => {
  const delivered = [],reports = [],requests = [];
  const services = harness({pollIntervalMs:2,report:error => reports.push(error),rpc:async (method,params) => {
    requests.push(params.after);
    if (requests.length === 1) return {cursor:50,events:[{id:50,name:'settings/document-updated',args:['old host']}],lost:false};
    // An unexplained backwards cursor must not deliver or change the accepted cursor.
    if (requests.length === 2) return {cursor:1,events:[{id:1,name:'settings/document-updated',args:['invalid reset']}],lost:false};
    // The same reset becomes valid when the Host explicitly acknowledges lost history.
    if (requests.length === 3) return {cursor:2,events:[{id:1,name:'settings/document-updated',args:['new host 1']},{id:2,name:'settings/document-updated',args:['new host 2']}],lost:true};
    return {cursor:3,events:params.after === 2 ? [{id:3,name:'settings/document-updated',args:['new host 3']}] : [],lost:false};
  }});
  t.after(services.dispose);
  const off = services.remote.$on('settings/document-updated',event => delivered.push(event));
  await waitFor(() => delivered.length === 4 && requests.length >= 5);
  assert.deepEqual(delivered,['old host','new host 1','new host 2','new host 3']);
  assert.deepEqual(requests.slice(0,5),[0,50,50,2,3]);
  assert.deepEqual(reports.map(error => error.code),['UI_REMOTE_EVENTS_FORMAT','UI_REMOTE_EVENTS_LOST']);
  off();
});

test('Service disposal aborts requests, removes namespace projections and refuses later work', async () => {
  const services = harness();await services.remote.$mount(contribution([descriptor()]));
  const saved = services.remote.sample.read;
  services.dispose();services.dispose();
  assert.equal(services.remote.sample,undefined);
  assert.match((await saved(1)).error.message,/no longer mounted/);
  await assert.rejects(services.connection.rpc.call('/api','read',{}),{code:'UI_CONNECTION_DISPOSED'});
  await assert.rejects(services.remote.$mount(contribution([descriptor()])),{code:'UI_REMOTE_DISPOSED'});
});
