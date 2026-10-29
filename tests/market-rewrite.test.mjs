// 照原始碼補寫用的模型與思考強度：解析「模型 思考強度」，實際試打一次模型時各種結果的白話原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelSpec,checkRewriteModel,REWRITE_MODELS,REWRITE_EFFORTS} from '../hooks/rewrite.ts';

test('解析：不分大小寫、順序固定、中間空白；其他寫法都不對', () => {
  assert.deepEqual(parseModelSpec('sonnet high'),{ok:true,model:'sonnet',effort:'high'});
  assert.deepEqual(parseModelSpec('  Opus   Medium '),{ok:true,model:'opus',effort:'medium'});
  assert.deepEqual(parseModelSpec('FABLE MAX'),{ok:true,model:'fable',effort:'max'});
  assert.deepEqual(parseModelSpec('haiku\txhigh'),{ok:true,model:'haiku',effort:'xhigh'});
  for(const bad of ['high sonnet','sonnet','sonnet high extra','gpt high','sonnet ultra','sonnethigh','',undefined,42,'sonnet-high']){
    const parsed=parseModelSpec(bad);
    assert.equal(parsed.ok,false,String(bad));
    assert.equal(parsed.code,'msg.rewrite.badFormat');
    assert.match(parsed.text,/例如 sonnet high/);
  }
  assert.deepEqual(REWRITE_MODELS,['haiku','sonnet','opus','fable']);
  assert.deepEqual(REWRITE_EFFORTS,['low','medium','high','xhigh','max']);
});

const usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
const answered={isAnswered:true,text:'ok',usage};
const apiError=(error,status=400)=>({isAnswered:false,reason:'api-error',status,error,usage});
/** 假的 $.model.complete：依序回傳 replies（函式就丟出），記下每次的請求。 */
function fake(...replies){
  const asked=[];
  const complete=async request=>{asked.push(request);const next=replies.shift();if(typeof next==='function')return next();return next;};
  return {asked,complete};
}

test('試打：回答了、回答是空的都算能用；請求帶模型、思考強度、2048 上限、60 秒逾時', async () => {
  const {asked,complete}=fake(answered);
  assert.deepEqual(await checkRewriteModel(complete,'sonnet','high'),{ok:true,model:'sonnet',effort:'high'});
  assert.deepEqual(asked,[{model:'sonnet',prompt:'只回覆 ok',maxTokens:2048,effort:'high',timeoutMs:60000}]);
  const empty=fake({isAnswered:false,reason:'empty-reply',usage});
  assert.equal((await checkRewriteModel(empty.complete,'opus','low')).ok,true);
});

test('試打：引擎拒絕送出（模型被封鎖）→ 不允許使用', async () => {
  const {complete}=fake(()=>{throw new Error('blocked by policy');});
  assert.deepEqual(await checkRewriteModel(complete,'fable','max'),{ok:false,text:'你的 Claude Code 不允許使用 fable。',code:'msg.rewrite.notAllowed',params:{model:'fable'}});
});

test('試打：invalid_request 時不帶思考強度再試，分得出是強度不支援還是帳號不能用', async () => {
  const effortOnly=fake(apiError('invalid_request'),answered);
  const result=await checkRewriteModel(effortOnly.complete,'haiku','max');
  assert.deepEqual(result,{ok:false,text:'haiku 不支援思考強度 max，換一個強度再試。',code:'msg.rewrite.effortUnsupported',params:{model:'haiku',effort:'max'}});
  assert.equal(effortOnly.asked.length,2);
  assert.equal('effort' in effortOnly.asked[1],false,'第二次不帶思考強度');
  const both=fake(apiError('invalid_request'),apiError('invalid_request'));
  assert.deepEqual(await checkRewriteModel(both.complete,'fable','high'),{ok:false,text:'你的帳號目前不能使用 fable。',code:'msg.rewrite.noAccess',params:{model:'fable'}});
  const busyAgain=fake(apiError('invalid_request'),apiError('rate_limit',429));
  assert.equal((await checkRewriteModel(busyAgain.complete,'opus','high')).code,'msg.rewrite.busy');
});

test('試打：其他 API 錯誤附原因；忙碌、用量到上限、60 秒沒回應另外說', async () => {
  const notFound=await checkRewriteModel(fake(apiError('model_not_found',404)).complete,'fable','high');
  assert.deepEqual(notFound,{ok:false,text:'你的帳號目前不能使用 fable（原因：model_not_found，404）。',code:'msg.rewrite.unavailable',params:{model:'fable',why:'model_not_found，404'}});
  const auth=await checkRewriteModel(fake(apiError('authentication_failed',null)).complete,'opus','high');
  assert.equal(auth.code,'msg.rewrite.unavailable');
  assert.equal(auth.params.why,'authentication_failed');
  for(const error of ['rate_limit','overloaded']){
    const busy=await checkRewriteModel(fake(apiError(error,529)).complete,'sonnet','high');
    assert.deepEqual(busy,{ok:false,text:'sonnet 現在忙碌或用量到上限，稍後再試。',code:'msg.rewrite.busy',params:{model:'sonnet'}});
  }
  const slow=await checkRewriteModel(fake({isAnswered:false,reason:'aborted',usage}).complete,'opus','max');
  assert.deepEqual(slow,{ok:false,text:'opus 60 秒沒回應。',code:'msg.rewrite.timeout',params:{model:'opus'}});
});

