/** Safe evaluation of the small `!!js` expressions that appear in a DSH `cordis.patch.yml` (for example
 * `apiKey: !!js process.env.AGENTMAIL_API_KEY`). Nothing here uses eval or Function: the text is tokenized and
 * evaluated by a tiny parser that knows only
 *   process.env.NAME   process.env['NAME']   string / number / true / false / null / undefined literals
 *   ! && || ??  == != === !==  ( )  cond ? a : b   Number(x) String(x) Boolean(x)
 * Anything else throws `UnsupportedExpressionError`; callers turn that into `undefined` plus a visible note,
 * never into a guessed value.
 *
 * Values come from the environment given by the caller (the worker passes its own `process.env`, which only
 * holds variables listed in passEnv), so the converter never bakes a secret into a file. */

export class UnsupportedExpressionError extends Error {
  constructor(message){super(message);this.name='UnsupportedExpressionError';this.code='UNSUPPORTED_EXPRESSION';}
}

const ENV_NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment variable names an expression reads (text scan; used by the analyzer to forward them). */
export function expressionEnvNames(text){
  const names=new Set();
  if(typeof text!=='string')return [];
  for(const match of text.matchAll(/\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g))names.add(match[1]);
  for(const match of text.matchAll(/\bprocess\s*\.\s*env\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g))names.add(match[2]);
  return [...names];
}

function tokenize(text){
  const tokens=[];let i=0;
  const fail=message=>{throw new UnsupportedExpressionError(message);};
  while(i<text.length){
    const ch=text[i];
    if(/\s/.test(ch)){i++;continue;}
    if(ch==="'"||ch==='"'){
      let value='',j=i+1;
      for(;;){
        if(j>=text.length)fail('unterminated string');
        const c=text[j];
        if(c===ch)break;
        if(c==='\\'){const n=text[j+1];const map={n:'\n',t:'\t',r:'\r','\\':'\\',"'":"'",'"':'"'};if(!Object.hasOwn(map,n))fail('unsupported escape');value+=map[n];j+=2;continue;}
        value+=c;j++;
      }
      tokens.push({type:'value',value});i=j+1;continue;
    }
    const number=/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if(number){tokens.push({type:'value',value:Number(number[0])});i+=number[0].length;continue;}
    const word=/^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i));
    if(word){tokens.push({type:'word',value:word[0]});i+=word[0].length;continue;}
    const op=['===','!==','??','||','&&','==','!=','!','(',')','[',']','.','?',':',','].find(item=>text.startsWith(item,i));
    if(op){tokens.push({type:'op',value:op});i+=op.length;continue;}
    fail(`unsupported character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

/** Evaluate one expression against `env`. Throws UnsupportedExpressionError for anything outside the grammar above. */
export function evaluateDshExpression(text,env=process.env){
  if(typeof text!=='string'||!text.trim())throw new UnsupportedExpressionError('empty expression');
  if(text.length>2000)throw new UnsupportedExpressionError('expression is too long');
  const tokens=tokenize(text);let pos=0;
  const fail=message=>{throw new UnsupportedExpressionError(message);};
  const peek=()=>tokens[pos];
  const isOp=value=>peek()?.type==='op'&&peek().value===value;
  const take=value=>{if(!isOp(value))fail(`expected ${value}`);pos++;};
  const WORDS={true:true,false:false,null:null,undefined:undefined};
  const CASTS={Number,String,Boolean};
  function ternary(){
    const test=or();
    if(isOp('?')){pos++;const yes=ternary();take(':');const no=ternary();return test?yes:no;}
    return test;
  }
  function or(){
    let left=and();
    for(;;){
      if(isOp('||')){pos++;const right=and();left=left||right;}
      else if(isOp('??')){pos++;const right=and();left=left??right;}
      else return left;
    }
  }
  function and(){let left=equality();while(isOp('&&')){pos++;const right=equality();left=left&&right;}return left;}
  function equality(){
    let left=unary();
    for(;;){
      const op=['===','!==','==','!='].find(isOp);
      if(!op)return left;
      pos++;const right=unary();
      left=op==='==='?left===right:op==='!=='?left!==right:op==='=='?left==right:left!=right; // eslint-disable-line eqeqeq
    }
  }
  function unary(){if(isOp('!')){pos++;return !unary();}return primary();}
  function primary(){
    const token=peek();
    if(!token)fail('unexpected end');
    if(token.type==='value'){pos++;return token.value;}
    if(isOp('(')){pos++;const value=ternary();take(')');return value;}
    if(token.type!=='word')fail(`unexpected ${token.value}`);
    pos++;
    if(token.value==='process'){
      take('.');
      if(peek()?.type!=='word'||peek().value!=='env')fail('only process.env is supported');
      pos++;
      let name;
      if(isOp('.')){pos++;if(peek()?.type!=='word')fail('expected a variable name');name=peek().value;pos++;}
      else if(isOp('[')){pos++;if(peek()?.type!=='value'||typeof peek().value!=='string')fail('expected a quoted variable name');name=peek().value;pos++;take(']');}
      else fail('process.env alone is not supported');
      if(!ENV_NAME.test(name))fail('invalid variable name');
      return env?.[name];
    }
    if(Object.hasOwn(WORDS,token.value))return WORDS[token.value];
    if(Object.hasOwn(CASTS,token.value)&&isOp('(')){pos++;const value=ternary();take(')');return CASTS[token.value](value);}
    return fail(`unsupported identifier ${token.value}`);
  }
  const value=ternary();
  if(pos!==tokens.length)fail('unexpected trailing text');
  return value;
}

/** Walk a config value: `{ $dshExpression: text }` markers (what the analyzer stores for `!!js`) are evaluated, keys whose
 * value ends up `undefined` are dropped. `onUnsupported(text, error)` is called for expressions outside the grammar; they become undefined. */
export function resolveConfigExpressions(value,{env=process.env,onUnsupported}={}){
  const walk=item=>{
    if(Array.isArray(item))return item.map(walk).filter(entry=>entry!==undefined);
    if(!item||typeof item!=='object')return item;
    if(Object.hasOwn(item,'$dshExpression')&&Object.keys(item).length===1){
      try{return evaluateDshExpression(item.$dshExpression,env);}
      catch(error){if(!(error instanceof UnsupportedExpressionError))throw error;onUnsupported?.(item.$dshExpression,error);return undefined;}
    }
    const out={};
    for(const [key,child]of Object.entries(item)){const resolved=walk(child);if(resolved!==undefined)out[key]=resolved;}
    return out;
  };
  return walk(value);
}
