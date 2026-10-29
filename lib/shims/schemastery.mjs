// Config-schema subset only. Unsupported methods fail instead of erasing meaning.
export const CONFIG_SCHEMA = Symbol.for('d-sh-are-in-cc.config-schema');
class Node {
  constructor(schema, children) { this[CONFIG_SCHEMA] = true; this.schema = schema; this.children = children; this.metadata = {}; }
  description(text) { this.schema.description = text; return this; }
  default(value) { this.schema.default = value; return this; }
  required() { this.isRequired = true; return this; }
  min(value) { this.schema[this.schema.type === 'string' ? 'minLength' : this.schema.type === 'array' ? 'minItems' : 'minimum'] = value; return this; }
  max(value) { this.schema[this.schema.type === 'string' ? 'maxLength' : this.schema.type === 'array' ? 'maxItems' : 'maximum'] = value; return this; }
  step(value) { this.schema.multipleOf = value; return this; }
  pattern(value) { if (!(value instanceof RegExp) || value.flags) throw new Error('schemastery.pattern supports an unflagged RegExp only'); this.schema.pattern = value.source; return this; }
  // Display metadata does not supply a settings service.
  extra(key, value) { this.metadata[key] = value; return this; }
  role(value) { return this.extra('role', value); }
  hidden(value = true) { return this.extra('hidden', value); }
  collapse(value = true) { return this.extra('collapse', value); }
  toJSON() { return this.schema; }
}
function child(value) { if (!value?.[CONFIG_SCHEMA]) throw new Error('Expected a supported schemastery node'); return value; }
function scalar(type) { return new Node({ type }); }
const Schema = {
  string: () => scalar('string'), number: () => scalar('number'), boolean: () => scalar('boolean'),
  natural: () => new Node({ type: 'integer', minimum: 0 }), integer: () => scalar('integer'),
  any: () => new Node({}),
  const: value => new Node({ const: value }),
  object(properties = {}) {
    const children = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, child(value)]));
    return new Node({ type: 'object', properties: Object.fromEntries(Object.entries(children).map(([k, v]) => [k, v.schema])), ...(Object.values(children).some(n => n.isRequired) ? { required: Object.keys(children).filter(k => children[k].isRequired) } : {}) }, children);
  },
  array: value => new Node({ type: 'array', items: child(value).schema }),
  union: values => new Node({ anyOf: values.map(v => child(v).schema) }),
  intersect: values => new Node({ allOf: values.map(v => child(v).schema) }),
};
export { Schema };
export const z = Schema;
export default Schema;
