// Pinned Cordis 4.0.5 Context, reflection, event, registry and fiber surface,
// plus timer accessors supplied by cordis-plugin-timer. These are context API
// members, never injectable replacement service names.
export const CORDIS_CONTEXT_API_NAMES=Object.freeze([
  'get','set','provide','accessor','mixin','inject','plugin','effect',
  'on','once','emit','parallel','serial','bail','waterfall',
  'extend','isolate','intercept','root','baseUrl','fiber','runtime','reflect','registry','events','logger',
  'interval','timeout','setInterval','setTimeout','throttle','debounce',
  // Older Cordis APIs (including ctx.scope) remain reserved even though absent from the pinned build.
  'before','after','collect','accept','dispose','scope',
]);
const names=new Set([...CORDIS_CONTEXT_API_NAMES,...Object.getOwnPropertyNames(Object.prototype),'prototype']);
export function isCordisContextName(name){return typeof name==='string'&&names.has(name);}
export const CORDIS_TIMER_ACCESSORS=Object.freeze(['interval','timeout','setInterval','setTimeout','throttle','debounce']);
