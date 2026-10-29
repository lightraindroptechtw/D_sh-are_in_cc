// Deliberately narrow compatibility surface, not the DSH registry/policy runtime.
const annotations = ['description', 'title', 'default', 'examples'];
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new TypeError(`${label} must be a plain object without symbol keys`);
}
function compileValue(spec, allowRequired = false) {
  record(spec, 'ValueSchemaSpec');
  const shapeKeys = spec.oneOf ? ['oneOf'] : ['type', ...(['string', 'number', 'integer', 'boolean', 'null'].includes(spec.type) ? ['enum', 'const'] : spec.type === 'object' ? ['properties', 'additionalProperties'] : spec.type === 'array' ? ['items'] : [])];
  const allowed = new Set([...annotations, ...shapeKeys, ...(allowRequired ? ['required'] : [])]);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) throw new Error(`Unsupported DSH schema keyword: ${key}`);
  const out = {};
  for (const key of annotations) if (Object.hasOwn(spec, key)) out[key] = spec[key];
  if (spec.oneOf) {
    if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) throw new Error('oneOf requires at least two branches');
    if (spec.type !== undefined) throw new Error('oneOf cannot also declare type');
    out.oneOf = spec.oneOf.map(node => compileValue(node));
    return out;
  }
  if (!['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'].includes(spec.type)) throw new Error(`Unsupported DSH schema type: ${spec.type}`);
  if (spec.type !== 'json') out.type = spec.type;
  if (Object.hasOwn(spec, 'enum')) out.enum = spec.enum;
  if (Object.hasOwn(spec, 'const')) out.const = spec.const;
  if (spec.type === 'array' && spec.items !== undefined) out.items = compileValue(spec.items);
  if (spec.type === 'object') {
    if (typeof spec.additionalProperties !== 'boolean') throw new Error('DSH object schema requires explicit additionalProperties');
    const root = parameterSchemaSpecToJsonSchema(spec.properties ?? {});
    Object.assign(out, root, { additionalProperties: spec.additionalProperties });
  }
  return out;
}
export function valueSchemaSpecToJsonSchema(spec) { return compileValue(spec); }
export function parameterSchemaSpecToJsonSchema(spec) {
  record(spec, 'ParameterSchemaSpec');
  const properties = Object.create(null), required = [];
  for (const [key, node] of Object.entries(spec)) {
    record(node, `parameter ${key}`);
    if (node.required !== undefined && node.required !== true) throw new Error(`parameter ${key}.required must be true or omitted`);
    if (node.required === true) required.push(key);
    properties[key] = compileValue(node, true);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
export function defineTool(options) {
  record(options, 'defineTool options');
  // Older DSH tools did not require output. Preserve their return contract.
  const output = options.output === undefined ? undefined : {
    ...options.output, schema: valueSchemaSpecToJsonSchema(options.output.schema),
  };
  return { ...options, parameters: parameterSchemaSpecToJsonSchema(options.parameters ?? {}), ...(output ? { output } : {}) };
}
export class ToolArgsError extends Error {
  constructor(violations) { super(`Invalid tool arguments: ${violations.join('; ')}`); this.name = 'ToolArgsError'; this.violations = violations; }
}
export const TOOL_ABORTED = 'ABORTED';
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
