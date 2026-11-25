'use strict';
/**
 * env-saaf — zero-dependency env validator.
 * v0.2.0 adds: parseEnvFile, scanCode (process.env usage in code),
 * diffEnv (used vs documented), and a CLI (bin: env-saaf).
 * v0.1.0 core: validateEnv with typed coercion.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { isProxy } = require('node:util').types;

// Issue #294: expose the structured form of every diagnostic alongside the
// printable `errors` strings. A leading `KEY: ` is recognised only when the key
// is the whole first token (no spaces or extra colons), so global messages such
// as `unknown option "x" (validateEnv accepts: ...)` are not split at the colon
// inside them. Grouped keys are already full env names (e.g. `DB_HOST`), and
// dotted names are left intact.
function errorDetails(errors) {
  return errors.map(message => {
    const match = /^([^\s:]+): ([\s\S]*)$/.exec(message);
    return match
      ? { key: match[1], message: match[2] }
      : { key: '', message };
  });
}

// Issue #350: build printable `KEY (from path): ...` strings and structured
// `details` from the original path in parallel. Never recover `source` by
// parsing the printable form - paths may contain `): ` and must round-trip.
function applyFileSources(errors, errorSources) {
  const reported = [];
  const details = [];
  for (let i = 0; i < errors.length; i++) {
    const message = errors[i];
    const source = errorSources[i];
    const match = /^([^\s:]+): ([\s\S]*)$/.exec(message);
    if (!match) {
      reported.push(message);
      details.push({ key: '', message });
      continue;
    }
    const key = match[1];
    const body = match[2];
    if (source) {
      reported.push(`${key} (from ${source}): ${body}`);
      details.push({ key, message: body, source });
    } else {
      reported.push(message);
      details.push({ key, message: body });
    }
  }
  return { reported, details };
}

class EnvSaafError extends Error {
  constructor(errors, message, details) {
    super(typeof message === 'string' ? message : 'Invalid environment variables:\n' + errors.map(e => `  - ${e}`).join('\n'));
    this.name = 'EnvSaafError';
    this.errors = errors;
    this.details = details !== undefined ? details : errorDetails(errors);
  }
}

// Format examples per built-in type, kept in one place so every type's error
// message shows an example and schema validation cannot drift apart from
// coercion when a new type is added (issue #58).
const TYPE_EXAMPLES = {
  string: 'hello',
  email: 'user@example.com',
  number: '3.14',
  int: '42',
  json: '{"key":"value"}',
  boolean: 'true/false, yes/no, on/off, 1/0, y/n',
  url: 'https://example.com',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  hex: 'deadbeef',
  ipv4: '192.168.0.1',
  ipv6: '::1',
  semver: '1.2.3',
  base64: 'aGVsbG8=',
  port: '3000',
  date: '2026-01-31',
  file: './config.json',
  duration: '500ms, 30s, 15m, 2h, 1d, 1w, 1h30m',
  host: 'db.internal, localhost, 10.0.0.5',
  array: 'a,b,c',
};

const KNOWN_TYPES = new Set(Object.keys(TYPE_EXAMPLES));

// Types whose coerced value is always a string. String-only options
// (`pattern`, `minLength`, `maxLength`) are rejected up front on any other
// type so they cannot sit silently ignored as dead config (issue #211).
const STRING_TYPES = new Set([
  'string', 'email', 'url', 'file', 'uuid', 'hex', 'ipv4', 'ipv6', 'semver', 'base64', 'host',
]);
const KNOWN_RULE_OPTIONS = new Set([
  'type',
  'required',
  'description',
  'deprecated',
  'requiredIf',
  'conflictsWith',
  'default',
  'choices',
  'min',
  'max',
  'minLength',
  'maxLength',
  'length',
  'protocols',
  'pattern',
  'validate',
  'transform',
  'trim',
  'sensitive',
  'of',
  'separator',
  'minItems',
  'maxItems',
  'unique',
  'skipEmpty',
  'aliases',
]);

// Issue #250: option names `validateEnv` accepts — a typo'd option must fail
// fast instead of running silently as if it was never passed (same class of
// bug as #218, one layer up: there the rule options, here the options object).
const KNOWN_VALIDATE_OPTIONS = new Set(['throwOnError', 'strict', 'onWarn', 'formatError', 'rules']);
// `loadEnv` forwards its validateEnv options, plus its own file options.
const KNOWN_LOAD_ENV_OPTIONS = new Set([
  ...KNOWN_VALIDATE_OPTIONS, 'path', 'paths', 'env', 'override', 'assign',
]);

// Only string duration bounds need coercion; numeric bounds retain their contract.
function numericBound(key, rule, value) {
  return rule.type === 'duration' && typeof value === 'string'
    ? coerce(key, value, 'duration') : value;
}

// Issue #228: a group rule nests a sub-schema under one prefix, so
// { DB: { prefix: 'DB_', schema: { HOST: {...} } } } reads the env var
// DB_HOST and returns { DB: { HOST: ... } }. A rule carrying a `schema`
// property is always treated as a group attempt — malformed ones are
// rejected up front in validateSchema rather than silently ignored.
function groupShape(rule) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (rule.schema === undefined) return false;
  return rule.type === undefined
    && rule.schema !== null && typeof rule.schema === 'object' && !Array.isArray(rule.schema);
}

function invalidSchema(errors) {
  const unique = [...new Set(errors)];
  return new EnvSaafError(unique, 'Invalid schema:\n' + unique.map(e => `  - ${e}`).join('\n'));
}

// Keep env prefixes separate from result paths: APP_DB_HOST becomes APP.DB.HOST.
// Only active ancestors are circular; a shared sub-schema can appear in several groups.
function walkSchema(schema, onRule, onGroup = () => {}, prefix = '', path = [], ancestors = new Set()) {
  if (ancestors.has(schema)) throw invalidSchema([`${path.join('.')}: group "schema" contains a circular reference`]);
  ancestors.add(schema);
  for (const [key, rule] of Object.entries(schema)) {
    if (groupShape(rule)) {
      if (typeof rule.prefix !== 'string' || rule.prefix.trim() === '') continue; // shape validation reports it
      const groupPath = [...path, key];
      const groupPrefix = prefix + rule.prefix;
      onGroup(groupPath, groupPrefix);
      walkSchema(rule.schema, onRule, onGroup, groupPrefix, groupPath, ancestors);
    } else {
      onRule(prefix + key, rule, [...path, key], prefix);
    }
  }
  ancestors.delete(schema);
}

// Flatten a (valid) schema into plain rules keyed by full env name, plus a
// map back to each grouped result path for re-nesting.
function flattenSchema(schema, prefix = '') {
  const entries = [];
  const groupOf = new Map();
  walkSchema(schema, (key, rule, path) => {
    entries.push([key, rule]);
    if (path.length > 1) groupOf.set(key, path);
  }, undefined, prefix);
  return { flat: Object.fromEntries(entries), groupOf };
}

// Re-nest flat results: DB_HOST -> out.DB.HOST. Groups whose keys all
// validated absent simply do not appear, same as flat optional keys.
function nestGroups(out, groupOf) {
  const nested = {};
  const groups = [];
  const put = (object, key, value) => Object.defineProperty(object, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
  for (const [k, v] of Object.entries(out)) {
    const path = groupOf.get(k) || [k];
    let current = nested;
    for (const key of path.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        put(current, key, {});
        groups.push(current[key]);
      }
      current = current[key];
    }
    put(current, path[path.length - 1], v);
  }
  // Freeze only the containers we created, leaving rule values untouched.
  for (const group of groups) Object.freeze(group);
  return nested;
}

function compilePattern(pattern, key, errors, patterns) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern !== 'string') {
    errors.push(`${key}: "pattern" must be a RegExp or string`);
    return;
  }
  const cached = patterns.get(pattern);
  if (cached !== undefined) return cached;
  try {
    const compiled = new RegExp(pattern);
    patterns.set(pattern, compiled);
    return compiled;
  } catch {
    errors.push(`${key}: "pattern" is not a valid regular expression string`);
  }
}

// Issue #345: `conflictsWith` accepts one non-empty key name or a non-empty
// list of non-empty key names. Indexed iteration rejects sparse array holes.
function normalizeConflictsWith(conflictsWith) {
  if (conflictsWith === undefined) return [];
  if (typeof conflictsWith === 'string') {
    return conflictsWith.trim() === '' ? null : [conflictsWith];
  }
  if (!Array.isArray(conflictsWith) || conflictsWith.length === 0) return null;
  const list = [];
  for (let i = 0; i < conflictsWith.length; i++) {
    const entry = conflictsWith[i];
    if (typeof entry !== 'string' || entry.trim() === '') return null;
    list.push(entry);
  }
  return list;
}

// Issue #346: `options.rules` accepts a single cross-field hook or an array of
// hooks. Indexed iteration rejects sparse holes as non-functions.
function normalizeRules(rules) {
  if (rules === undefined) return [];
  if (typeof rules === 'function') return [rules];
  if (Array.isArray(rules)) {
    const list = [];
    for (let i = 0; i < rules.length; i++) {
      if (typeof rules[i] !== 'function') {
        throw new TypeError('env-saaf: "rules" option must be a function or an array of functions');
      }
      list.push(rules[i]);
    }
    return list;
  }
  throw new TypeError('env-saaf: "rules" option must be a function or an array of functions');
}

// Validate the shape of the schema itself, independent of any env values.
// These checks used to live only inside the per-key coercion loop, so an
// invalid rule on an absent optional key was never reached and slipped through
// silently (issue #134). Errors name the key and the offending option.
function validateSchema(schema) {
  validateSchemaRules(schema, msg => console.warn(msg));
}

function validateSchemaRules(schema, warn, patterns = new Map(), prefix = '', ancestors = new Set(), isRoot = true) {
  if (ancestors.has(schema)) throw invalidSchema([`${prefix}: group "schema" contains a circular reference`]);
  ancestors = new Set(ancestors).add(schema);
  const errors = [];
  const keys = new Set(Object.keys(schema).map(key => prefix + key));
  const aliasOwners = new Map();
  for (const [name, rule] of Object.entries(schema)) {
    const key = prefix + name;
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) continue;
    // Issue #228: group rule — validate its shape, then its inner rules under
    // their full (prefixed) names so errors read `DB_HOST: ...`, not `HOST`.
    if (rule.schema !== undefined) {
      if (rule.type !== undefined) {
        errors.push(`${key}: a group rule cannot also set "type" — put types on the inner rules`);
      }
      for (const opt of Object.keys(rule)) {
        if (opt !== 'schema' && opt !== 'prefix') {
          errors.push(`${key}: group rules only support "prefix" and "schema" (unexpected "${opt}")`);
        }
      }
      if (typeof rule.prefix !== 'string' || rule.prefix.trim() === '') {
        errors.push(`${key}: group rule needs a non-empty string "prefix" (e.g. "DB_")`);
      }
      const inner = rule.schema;
      if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
        errors.push(`${key}: group "schema" must be an object mapping inner names to rules`);
      } else {
        const innerKeys = Object.keys(inner);
        if (innerKeys.length === 0) errors.push(`${key}: group "schema" must not be empty`);
        if (typeof rule.prefix === 'string' && rule.prefix.trim() !== '') {
          try {
            validateSchemaRules(inner, () => {}, patterns, prefix + rule.prefix, ancestors, false);
          } catch (e) {
            if (e instanceof EnvSaafError) errors.push(...e.errors);
            else throw e;
          }
        }
      }
      continue;
    }
    for (const opt of Object.keys(rule)) {
      if (!KNOWN_RULE_OPTIONS.has(opt)) {
        errors.push(`${key}: unknown option "${opt}"`);
      }
    }
    if (rule.description !== undefined && typeof rule.description !== 'string') {
      errors.push(`${key}: "description" must be a string`);
    }
    if (rule.deprecated !== undefined && typeof rule.deprecated !== 'boolean' && typeof rule.deprecated !== 'string') {
      errors.push(`${key}: "deprecated" must be a boolean or a string`);
    }
    if (rule.type !== undefined && !KNOWN_TYPES.has(rule.type)) {
      errors.push(`${key}: unknown type "${rule.type}"`);
    }
    const effectiveType = rule.type === undefined ? 'string' : rule.type;
    if (KNOWN_TYPES.has(effectiveType) && !STRING_TYPES.has(effectiveType)) {
      for (const opt of ['pattern', 'minLength', 'maxLength']) {
        if (rule[opt] !== undefined) {
          errors.push(`${key}: "${opt}" only applies to string types (cannot be used with type '${effectiveType}')`);
        }
      }
    }
    // Issue #282: the mirror image of the check above — `of` / `separator` /
    // `unique` are only read for `array` rules, and `protocols` only for
    // `url` rules (and for `array` rules, where it flows to `of: 'url'`
    // items). Anywhere else they are dead config that looks like it does
    // something, so reject them up front. `min` / `max` are deliberately NOT
    // rejected off the numeric types: they apply to any numeric *value* (see
    // the runtime check in validateEnvCore), whatever the declared type.
    if (KNOWN_TYPES.has(effectiveType)) {
      if (effectiveType !== 'array') {
        for (const opt of ['of', 'separator', 'unique', 'skipEmpty']) {
          if (rule[opt] !== undefined) {
            errors.push(`${key}: "${opt}" only applies to type 'array' (cannot be used with type '${effectiveType}')`);
          }
        }
      }
      if (effectiveType !== 'url' && effectiveType !== 'array' && rule.protocols !== undefined) {
        errors.push(`${key}: "protocols" only applies to type 'url' (cannot be used with type '${effectiveType}')`);
      }
    }
    const pattern = rule.pattern;
    if (pattern !== undefined) compilePattern(pattern, key, errors, patterns);
    if (rule.validate !== undefined && typeof rule.validate !== 'function') {
      errors.push(`${key}: "validate" must be a function`);
    }
    if (rule.transform !== undefined && typeof rule.transform !== 'function') {
      errors.push(`${key}: "transform" must be a function`);
    }
    // Issue #292: for `date` rules, `min` / `max` are ISO date (or
    // datetime) strings — or Date objects — compared chronologically
    // against the parsed value. A number is rejected with a clear message
    // rather than accepted with unclear meaning, and a bound that is not
    // a valid date is a schema error.
    if (effectiveType === 'date') {
      for (const opt of ['min', 'max']) {
        if (rule[opt] === undefined) continue;
        if (typeof rule[opt] === 'number') {
          errors.push(`${key}: "${opt}" must be an ISO date string for type 'date' (e.g. '2026-01-01'), not a number`);
        } else {
          let parsed = null;
          try { parsed = coerce(key, rule[opt], 'date'); } catch (_) { /* not a date */ }
          if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
            errors.push(`${key}: "${opt}" must be a valid ISO 8601 date for type 'date' (e.g. '2026-01-01')`);
          }
        }
      }
      // Issue #220, for dates: `min` above `max` describes a range that
      // can never match, so it is a schema bug.
      if (rule.min !== undefined && rule.max !== undefined) {
        let lo = null, hi = null;
        try { lo = coerce(key, rule.min, 'date'); } catch (_) {}
        try { hi = coerce(key, rule.max, 'date'); } catch (_) {}
        if (lo instanceof Date && hi instanceof Date && lo.getTime() > hi.getTime()) {
          errors.push(`${key}: "min" must not exceed "max"`);
        }
      }
    } else if (effectiveType === 'duration') {
      const parsed = {};
      for (const opt of ['min', 'max']) {
        if (rule[opt] === undefined) continue;
        try {
          if (typeof rule[opt] !== 'number' && typeof rule[opt] !== 'string') throw new Error();
          const bound = numericBound(key, rule, rule[opt]);
          if (!Number.isFinite(bound)) throw new Error();
          parsed[opt] = bound;
        } catch (_) {
          errors.push(`${key}: "${opt}" must be a number or valid duration string for type 'duration'`);
        }
      }
      if (parsed.min !== undefined && parsed.max !== undefined && parsed.min > parsed.max) {
        errors.push(`${key}: "min" must not exceed "max"`);
      }
    } else {
      for (const opt of ['min', 'max']) {
        if (rule[opt] !== undefined && (typeof rule[opt] !== 'number' || !Number.isFinite(rule[opt]))) {
          errors.push(`${key}: "${opt}" must be a number`);
        }
      }
      // Issue #220: `min` above `max` describes a range that can never match,
      // so it is a schema bug — reject it up front instead of failing oddly
      // (or never) when the variable is checked.
      if (rule.min !== undefined && rule.max !== undefined
        && typeof rule.min === 'number' && typeof rule.max === 'number'
        && Number.isFinite(rule.min) && Number.isFinite(rule.max)
        && rule.min > rule.max) {
        errors.push(`${key}: "min" must not exceed "max"`);
      }
    }
    for (const opt of ['minLength', 'maxLength']) {
      if (rule[opt] !== undefined && (!Number.isInteger(rule[opt]) || rule[opt] < 0)) {
        errors.push(`${key}: "minLength" and "maxLength" must be non-negative integers`);
      }
    }
    // Issue #220: same as `min`/`max` — a length range that can never match.
    if (rule.minLength !== undefined && rule.maxLength !== undefined
      && Number.isInteger(rule.minLength) && Number.isInteger(rule.maxLength)
      && rule.minLength > rule.maxLength) {
      errors.push(`${key}: "minLength" must not exceed "maxLength"`);
    }
    if (rule.length !== undefined && (!Number.isInteger(rule.length) || rule.length < 0)) {
      errors.push(`${key}: "length" must be a non-negative integer`);
    }
    // Issue #220: an empty `choices` list can never match any value — it is
    // a schema bug, not a value that fails validation.
    if (rule.choices !== undefined && Array.isArray(rule.choices) && rule.choices.length === 0) {
      errors.push(`${key}: "choices" must be a non-empty array`);
    }
    // Issue #305: a choice is compared against the *coerced* value
    // (`rule.choices.includes(val)`), so a choice written in the wrong shape
    // can never match any real input: the string '1' for an `int`, 'true' for
    // a `boolean`. Coerce each choice the way a value is coerced and reject
    // the ones that fail or come back different from what was written.
    // Issue #320: on an `array` rule choices apply to each coerced item, so
    // validate them against `of` (the item type) instead of 'array'.
    // String-typed rules are fine. A `date` value is always a freshly parsed
    // Date object, so no choice (Date or string) can ever be equal to it.
    // Non-finite numbers (Infinity, NaN) are left alone: toJsonSchema() drops
    // them from the generated `enum` on purpose, so they stay valid here.
    if (Array.isArray(rule.choices) && rule.choices.length > 0) {
      const choiceType = effectiveType === 'array' ? (rule.of || 'string') : effectiveType;
      if (choiceType === 'date') {
        errors.push(`${key}: "choices" cannot be used with type 'date' (a parsed date is a new Date object, so no choice can ever match)`);
      } else if (['number', 'int', 'port', 'boolean', 'duration'].includes(choiceType)) {
        for (const choice of rule.choices) {
          if (typeof choice === 'number' && !Number.isFinite(choice)) continue;
          let matches = false;
          try { matches = coerce(key, choice, choiceType) === choice; }
          catch { /* not a value this type can produce */ }
          if (!matches) {
            const shownChoice = typeof choice === 'string' ? JSON.stringify(choice) : String(choice);
            errors.push(`${key}: "choices" entry ${shownChoice} can never match type '${choiceType}' (a choice must be a value this type can produce)`);
          }
        }
      }
    }
    // Issue #50: `protocols` is a non-empty array of schemes (e.g. ['https']);
    // a bare string, an empty array or a non-scheme entry is a schema bug.
    if (rule.protocols !== undefined) {
      const bad = !Array.isArray(rule.protocols) || rule.protocols.length === 0
        || rule.protocols.some(p => typeof p !== 'string' || !/^[a-zA-Z][a-zA-Z0-9+.-]*:?$/.test(p));
      if (bad) {
        errors.push(`${key}: "protocols" must be a non-empty array of schemes, e.g. ['https']`);
      }
    }
    if (rule.sensitive !== undefined && typeof rule.sensitive !== 'boolean') {
      errors.push(`${key}: "sensitive" must be a boolean`);
    }
    // Issue #291: `unique` is a boolean flag for `array` rules.
    if (rule.unique !== undefined && typeof rule.unique !== 'boolean') {
      errors.push(`${key}: "unique" must be a boolean`);
    }
    if (rule.skipEmpty !== undefined && typeof rule.skipEmpty !== 'boolean') {
      errors.push(`${key}: "skipEmpty" must be a boolean`);
    }
    if (rule.requiredIf !== undefined) {
      const cond = rule.requiredIf;
      const isObj = cond !== null && typeof cond === 'object' && !Array.isArray(cond);
      if (!isObj || typeof cond.key !== 'string' || cond.key.trim() === '') {
        errors.push(`${key}: "requiredIf" must be an object with a non-empty string "key" and either "equals" or "in"`);
      } else {
        const hasEquals = Object.prototype.hasOwnProperty.call(cond, 'equals') && cond.equals !== undefined;
        const hasIn = Object.prototype.hasOwnProperty.call(cond, 'in') && cond.in !== undefined;
        if (hasEquals === hasIn) {
          errors.push(`${key}: "requiredIf" must specify either "equals" or "in" (not both)`);
        } else if (hasIn && (!Array.isArray(cond.in) || cond.in.length === 0)) {
          errors.push(`${key}: "requiredIf.in" must be a non-empty array`);
        }
        // Issue #204: a `requiredIf` naming its own key can never fire — absent
        // means the condition is false, present means the key is satisfied.
        if (cond.key === key) {
          errors.push(`${key}: "requiredIf" must name a different key, not itself`);
        }
      }
    }
    // Issue #204: `required: true` together with `requiredIf` is contradictory
    // (`required` would silently win and the condition would be dead config).
    if (rule.required && rule.requiredIf !== undefined) {
      errors.push(`${key}: "required" and "requiredIf" cannot be used together (use one or the other)`);
    }
    // Issue #340: a key with a `default` can never be missing, so `required`
    // would never fire. `requiredIf` + `default` is left alone on purpose.
    if (rule.required && rule.default !== undefined) {
      errors.push(`${key}: "required" and "default" cannot be used together (remove one of them)`);
    }
    // Issue #345: validate `conflictsWith` shape and self-references up front;
    // undeclared targets are checked against the complete flattened root schema
    // below so inner group rules can reference top-level or sibling-group keys.
    if (rule.conflictsWith !== undefined) {
      const conflicts = normalizeConflictsWith(rule.conflictsWith);
      if (conflicts === null) {
        errors.push(`${key}: "conflictsWith" must be a non-empty string or a non-empty array of non-empty strings`);
      } else {
        for (const target of new Set(conflicts)) {
          if (target === key) {
            errors.push(`${key}: "conflictsWith" must name a different key, not itself`);
          }
        }
      }
    }
    if (rule.of !== undefined && (typeof rule.of !== 'string' || !KNOWN_TYPES.has(rule.of) || rule.of === 'array')) {
      errors.push(`${key}: "of" must be a valid item type (e.g. 'string', 'number', 'url')`);
    }
    if (rule.separator !== undefined && (typeof rule.separator !== 'string' || rule.separator.length === 0)) {
      errors.push(`${key}: "separator" must be a non-empty string`);
    }
    // Issue #207: `minItems` / `maxItems` bound the item count of an `array`
    // rule. Both must be non-negative integers, `minItems` must not exceed
    // `maxItems`, and the options only apply to `type: 'array'` — on any
    // other type they would be dead config, so they are rejected up front.
    for (const opt of ['minItems', 'maxItems']) {
      if (rule[opt] !== undefined && (!Number.isInteger(rule[opt]) || rule[opt] < 0)) {
        errors.push(`${key}: "${opt}" must be a non-negative integer`);
      }
    }
    if (rule.minItems !== undefined && rule.maxItems !== undefined
      && Number.isInteger(rule.minItems) && Number.isInteger(rule.maxItems)
      && rule.minItems > rule.maxItems) {
      errors.push(`${key}: "minItems" must not exceed "maxItems"`);
    }
    if ((rule.minItems !== undefined || rule.maxItems !== undefined) && rule.type !== 'array') {
      errors.push(`${key}: "minItems" and "maxItems" only apply to type 'array'`);
    }
    if (rule.aliases !== undefined) {
      const bad = !Array.isArray(rule.aliases)
        || rule.aliases.some(a => typeof a !== 'string' || a.trim() === '');
      if (bad) {
        errors.push(`${key}: "aliases" must be an array of non-empty strings`);
      } else {
        for (const alias of rule.aliases) {
          if (keys.has(alias)) {
            errors.push(`${key}: alias "${alias}" conflicts with a declared schema key`);
          } else if (aliasOwners.has(alias) && aliasOwners.get(alias) !== key) {
            errors.push(`${key}: alias "${alias}" is already used by "${aliasOwners.get(alias)}"`);
          } else {
            aliasOwners.set(alias, key);
          }
        }
      }
    }
  }
  // Issue #228: after flattening, no two schema entries may produce the same
  // env name (a group prefix colliding with a declared key, or two groups
  // overlapping) — that would silently read one env var for two rules.
  const flatOwners = new Map();
  for (const key of keys) flatOwners.set(key, `"${key}"`);
  walkSchema(schema, (key, rule, path, fullPrefix) => {
    if (path.length === 1) return; // flat names and group names were reserved above
    const group = prefix + path.slice(0, -1).join('.');
    if (flatOwners.has(key)) {
      errors.push(`${group}: prefix "${fullPrefix}" makes "${key}" collide with ${flatOwners.get(key)}`);
    } else {
      flatOwners.set(key, `the "${group}" group`);
    }
  }, undefined, prefix);
  // Issue #228: aliases inside a group are FULL env names, and each group used
  // to be validated with its own fresh alias map — so an alias in one group
  // could name another group's key (or a flat key) and one env var would then
  // silently feed two rules. Run the alias collision check over the FLATTENED
  // schema as well; the per-group recursion above already reports the
  // within-group cases, and the dedupe below keeps every message single.
  const { flat } = flattenSchema(schema, prefix);
  const flatKeys = new Set(Object.keys(flat));
  const flatAliasOwners = new Map();
  for (const [fkey, frule] of Object.entries(flat)) {
    if (frule === null || typeof frule !== 'object' || Array.isArray(frule)
      || !Array.isArray(frule.aliases)
      || frule.aliases.some(a => typeof a !== 'string' || a.trim() === '')) continue; // already reported above
    for (const alias of frule.aliases) {
      if (flatKeys.has(alias)) {
        errors.push(`${fkey}: alias "${alias}" conflicts with a declared schema key`);
      } else if (flatAliasOwners.has(alias) && flatAliasOwners.get(alias) !== fkey) {
        errors.push(`${fkey}: alias "${alias}" is already used by "${flatAliasOwners.get(alias)}"`);
      } else {
        flatAliasOwners.set(alias, fkey);
      }
    }
  }
  // Issue #345: reject `conflictsWith` targets that are not declared anywhere
  // in the root flattened schema (unlike `requiredIf`, external undeclared
  // variables are not allowed here).
  if (isRoot) {
    for (const [fkey, frule] of Object.entries(flat)) {
      if (!frule || frule.conflictsWith === undefined) continue;
      const conflicts = normalizeConflictsWith(frule.conflictsWith);
      if (conflicts === null) continue;
      for (const target of new Set(conflicts)) {
        if (target !== fkey && !flatKeys.has(target)) {
          errors.push(`${fkey}: "conflictsWith" references undeclared key "${target}"`);
        }
      }
    }
  }
  if (errors.length) {
    // Issue #283: a schema problem is a bug in the schema, not a bad env value.
    // Label it "Invalid schema:" so users debug the right thing; the errors
    // array is unchanged, only the header differs from genuine value errors.
    throw invalidSchema(errors);
  }
  // Check only the complete flattened schema: a group may reference a key
  // in another group or at the top level. External flags remain supported.
  for (const [key, rule] of Object.entries(flat)) {
    if (rule && rule.requiredIf && !flatKeys.has(rule.requiredIf.key)) {
      warn(`env-saaf: ${key}: requiredIf references undeclared key "${rule.requiredIf.key}"; check for a typo or declare the key (external env flags still work)`);
    }
  }
  return patterns;
}

// Numeric configuration strings are decimal; Number() alone also accepts
// JavaScript radix prefixes. Numeric values (including defaults) stay unchanged.
function decimalNumber(value) {
  return typeof value === 'string' && /^\s*0[xob]/i.test(value) ? NaN : Number(value);
}

// Issue #412: values copied out of code keep JavaScript's digit separators
// ('1_000', '1_000.5'). For 'int' and 'number' a single '_' between two digits
// is dropped before the numeric checks; any other '_' ('_100', '100_',
// '1__000', '1_.5') leaves the value as-is, so it is rejected as before.
function withoutDigitSeparators(value) {
  if (typeof value !== 'string' || !value.includes('_')) return value;
  return /(^|[^0-9])_|_([^0-9]|$)/.test(value) ? value : value.replace(/_/g, '');
}

// Semantic version: MAJOR.MINOR.PATCH, no leading zeroes in numeric parts;
// optional pre-release/build suffixes and one optional lowercase 'v' prefix.
// Shared by coerce() and toJsonSchema() so runtime and schema checks match.
// Issue #351: the JSON Schema pattern for base64 mirrors the runtime check
// (standard or URL-safe alphabet, no mixing, unpadded lengths 4n+2/4n+3, and
// padding only on a multiple of four).
const B64_STD = '[A-Za-z0-9+/]';
const B64_URL = '[A-Za-z0-9_-]';
const BASE64_RE = new RegExp(
  `^(?:(?:${B64_STD}{4})+(?:${B64_STD}{2}==|${B64_STD}{3}=)?`
  + `|${B64_STD}{2,3}(?:${B64_STD}{4})*`
  + `|(?:${B64_STD}{4})*(?:${B64_STD}{2}==|${B64_STD}{3}=)`
  + `|(?:${B64_URL}{4})+(?:${B64_URL}{2}==|${B64_URL}{3}=)?`
  + `|${B64_URL}{2,3}(?:${B64_URL}{4})*`
  + `|(?:${B64_URL}{4})*(?:${B64_URL}{2}==|${B64_URL}{3}=))$`);

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function coerce(key, raw, type, trim = true, protocols, sensitive = false, of = 'string', separator = ',', skipEmpty = false) {
  // trim: false (issue #84) keeps the raw value exactly as provided — for
  // values where the whitespace IS the value (a password with a significant
  // trailing space). The default stays true: stray spaces from pasted
  // secrets are trimmed. Numbers and booleans are unaffected either way —
  // Number() ignores surrounding whitespace, and the boolean spellings are
  // matched on the trimmed value below.
  const v = typeof raw === 'string' ? (trim ? raw.trim() : raw) : raw;
  const shown = sensitive ? maskValue(raw) : raw;
  switch (type) {
    case 'string': return String(v);
    case 'email': {
      // Pragmatic check, not full RFC 5322: one '@', a non-empty local
      // part and domain, a dot in the domain, and no whitespace.
      const s = String(v);
      const at = s.indexOf('@');
      if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1
        || !s.slice(at + 1).includes('.') || s.slice(at + 1).startsWith('.')
        || s.slice(at + 1).endsWith('.') || /\s/.test(s)) {
        throw new Error(`${key}: expected a valid email address (e.g. ${TYPE_EXAMPLES.email}), got "${shown}"`);
      }
      return s;
    }
    case 'number': {
      // Reject NaN as well as non-finite results (Infinity, -Infinity, and
      // exponent overflow like '1e999'): Number() parses them without error,
      // and a silent Infinity breaks downstream maths (issue #175).
      const n = decimalNumber(withoutDigitSeparators(v));
      if (v === '' || !Number.isFinite(n)) throw new Error(`${key}: expected a number (e.g. ${TYPE_EXAMPLES.number}), got "${shown}"`);
      return n;
    }
    case 'int': {
      // Whole numbers only: counts, retries, pool sizes. Only plain integer
      // literals pass — optional sign + digits ('42', '-3', '007'). Decimal
      // and scientific spellings ('1.0', '1e3', '1.5e2') are rejected even
      // when they happen to be whole numbers (issue #277): in a .env file
      // they are almost always a copied float or a formatted export, and
      // silently accepting them hides the mistake. Non-string values (a
      // number passed directly, e.g. as a default) still just need to be an
      // integer; '3.5', 'abc', and non-finite values ('Infinity', '1e999')
      // do not pass. The shape is checked on the trimmed spelling so
      // surrounding whitespace behaves the same with trim: false. Digit
      // separators ('1_000') are dropped first (issue #412).
      const digits = withoutDigitSeparators(v);
      if (typeof digits === 'string' && !/^[+-]?\d+$/.test(digits.trim())) throw new Error(`${key}: expected an integer (e.g. ${TYPE_EXAMPLES.int}), got "${shown}"`);
      const n = decimalNumber(digits);
      if (v === '' || !Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${key}: expected an integer (e.g. ${TYPE_EXAMPLES.int}), got "${shown}"`);
      return n;
    }
    case 'json': {
      // Structured config in one variable: '{"beta":true,"maxItems":3}'.
      // Valid JSON of any shape (object, array, primitive) is parsed and
      // returned as-is; a non-string value (e.g. an object passed directly
      // in the env argument) is already parsed, so it passes through.
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); }
      catch { throw new Error(`${key}: expected valid JSON (e.g. ${TYPE_EXAMPLES.json}), got "${shown}"`); }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', '1', 'yes', 'on', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'off', 'n'].includes(s)) return false;
      throw new Error(`${key}: expected a boolean (e.g. ${TYPE_EXAMPLES.boolean}), got "${shown}"`);
    }
    case 'url': {
      // Validate only — never modify: new URL(...).toString() normalizes
      // the value (a bare origin gains a trailing slash), which can break
      // the user's string comparisons.
      let parsed;
      try { parsed = new URL(String(v)); }
      catch { throw new Error(`${key}: expected a valid URL (e.g. ${TYPE_EXAMPLES.url}), got "${shown}"`); }
      // Issue #50: `protocols` allowlists the schemes (e.g. ['https']).
      // Schemes compare case-insensitively, with or without a trailing ':'.
      if (Array.isArray(protocols)) {
        const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
        const allowed = protocols.map(p => String(p).replace(/:$/, '').toLowerCase());
        if (!allowed.includes(scheme)) {
          throw new Error(`${key}: expected a URL with one of these protocols (${protocols.join(', ')}), got "${shown}"`);
        }
      }
      return String(v);
    }
    case 'file': {
      const s = String(v);
      try {
        if (fs.statSync(s).isFile()) {
          // Open read-only so actual filesystem permissions are checked on Windows too.
          const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
          fs.closeSync(fs.openSync(s, flags));
          return s;
        }
      } catch {
        // Report the variable and its path consistently for filesystem failures.
      }
      throw new Error(`${key}: expected a readable file (e.g. ${TYPE_EXAMPLES.file}), got "${sensitive ? maskValue(s) : s}"`);
    }
    case 'uuid': {
      // Canonical UUID: 8-4-4-4-12 hex groups. Upper- and lowercase hex
      // are both accepted, and the value is returned exactly as provided.
      const s = String(v);
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
        throw new Error(`${key}: expected a valid UUID (e.g. ${TYPE_EXAMPLES.uuid}), got "${shown}"`);
      }
      return s;
    }
    case 'hex': {
      // Hex strings only: API tokens, colour codes, hashes. An empty
      // value never reaches here (it counts as missing), so '+' is right.
      const s = String(v);
      if (!/^[0-9a-fA-F]+$/.test(s)) {
        throw new Error(`${key}: expected a hexadecimal string (e.g. ${TYPE_EXAMPLES.hex}), got "${shown}"`);
      }
      return s;
    }
    case 'ipv4': {
      // Dotted-quad IPv4: four decimal octets, each 0-255. A leading zero
      // is rejected (except a lone '0') because '010.0.0.1' is ambiguous —
      // some systems read it as octal. The value is returned unchanged.
      const s = String(v);
      const parts = s.split('.');
      const badOctet = parts.some(p => !/^(0|[1-9][0-9]*)$/.test(p) || Number(p) > 255);
      if (parts.length !== 4 || badOctet) {
        throw new Error(`${key}: expected a valid IPv4 address (e.g. ${TYPE_EXAMPLES.ipv4}), got "${shown}"`);
      }
      return s;
    }
    case 'ipv6': {
      // Whatever `host` already accepts as IPv6 (issue #342): compressed
      // forms, IPv4-mapped addresses and a scoped zone such as fe80::1%eth0.
      const s = String(v);
      if (net.isIP(s) !== 6) {
        throw new Error(`${key}: expected a valid IPv6 address (e.g. ${TYPE_EXAMPLES.ipv6}), got "${shown}"`);
      }
      return s;
    }
    case 'semver': {
      // Semantic version: MAJOR.MINOR.PATCH, no leading zeroes in the
      // numeric parts; pre-release and build suffixes are allowed
      // (1.2.3-beta.1, 1.2.3+build.5). One optional lowercase 'v' prefix
      // is accepted (v1.2.3 — what `git describe` and release pipelines
      // emit); an uppercase 'V' or a double 'vv' is rejected. The value
      // is returned unchanged, prefix included.
      const s = String(v);
      if (!SEMVER_RE.test(s)) {
        throw new Error(`${key}: expected a valid semantic version (e.g. ${TYPE_EXAMPLES.semver}), got "${shown}"`);
      }
      return s;
    }
    case 'base64': {
      const s = String(v);
      const match = /^([A-Za-z0-9+/_-]+)(={0,2})$/.exec(s);
      if (!match || (/[+/]/.test(s) && /[-_]/.test(s)) ||
          match[1].length % 4 === 1 || (match[2] && s.length % 4 !== 0)) {
        throw new Error(`${key}: expected a valid base64 string (e.g. ${TYPE_EXAMPLES.base64}), got "${shown}"`);
      }
      return s;
    }
    case 'date': {
      // ISO 8601 dates and datetimes: '2026-01-31' or
      // '2026-01-31T10:00:00Z' (seconds, fractional seconds and a Z or
      // ±HH:MM offset are optional). Returns a Date. Impossible dates are
      // rejected — new Date() would silently roll '2026-02-31' over to
      // March, so the components are checked against the calendar first
      // (leap years included). A Date passed directly (e.g. as a default)
      // passes through when it is valid.
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) throw new Error(`${key}: expected a valid ISO 8601 date (e.g. ${TYPE_EXAMPLES.date}), got "${shown}"`);
        return v;
      }
      const s = String(v);
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
      if (!m) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. ${TYPE_EXAMPLES.date}), got "${shown}"`);
      }
      const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      const hour = m[4] === undefined ? 0 : Number(m[4]);
      const minute = m[5] === undefined ? 0 : Number(m[5]);
      const second = m[6] === undefined ? 0 : Number(m[6]);
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      if (month < 1 || month > 12 || day < 1 || day > (daysInMonth || 0)
        || hour > 23 || minute > 59 || second > 59) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. ${TYPE_EXAMPLES.date}), got "${shown}"`);
      }
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. ${TYPE_EXAMPLES.date}), got "${shown}"`);
      }
      return d;
    }
    case 'duration': {
      // Human durations: '500ms', '30s', '15m', '2h', '1d', '1w' become
      // milliseconds; compounds ('1h30m', '2d12h') sum their parts. A bare
      // number is already milliseconds. Units are case-insensitive and
      // decimals are allowed ('1.5h'), negatives and unknown units are
      // rejected. A number passed directly (e.g. as a default) is taken
      // as milliseconds, like the number type.
      if (typeof v === 'number') {
        if (!Number.isFinite(v) || v < 0) {
          throw new Error(`${key}: expected a duration (e.g. ${TYPE_EXAMPLES.duration}), got "${shown}"`);
        }
        return v;
      }
      const s = String(v).trim();
      const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
      let ms;
      if (/^\d+(?:\.\d+)?$/.test(s)) {
        // A bare number is already milliseconds.
        ms = Number(s);
      } else {
        // Compound durations (issue #224): a sequence of number+unit parts
        // is summed — '1h30m', '1h 30m', '2d12h'. Every part needs an
        // explicit unit, so a trailing bare number ('1h30') is rejected,
        // as are unknown units, negatives and repeated units.
        const part = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/iy;
        const seenUnits = new Set();
        let pos = 0, total = 0, parts = 0;
        while (pos < s.length) {
          part.lastIndex = pos;
          const pm = part.exec(s);
          if (!pm) break;
          const unit = pm[2].toLowerCase();
          if (seenUnits.has(unit)) break;
          seenUnits.add(unit);
          total += Number(pm[1]) * mult[unit];
          parts++;
          pos = part.lastIndex;
          while (pos < s.length && s[pos] === ' ') pos++;
        }
        if (!parts || pos !== s.length) {
          throw new Error(`${key}: expected a duration (e.g. ${TYPE_EXAMPLES.duration}), got "${shown}"`);
        }
        ms = total;
      }
      if (!Number.isFinite(ms)) {
        throw new Error(`${key}: expected a duration (e.g. ${TYPE_EXAMPLES.duration}), got "${shown}"`);
      }
      return ms;
    }
    case 'host': {
      // A hostname or IP address, with no scheme, path or port:
      // 'db.internal', 'localhost', '10.0.0.5' and '::1' pass, while
      // 'https://x', 'db/x' and 'example.com:8080' fail. IPv6 is checked
      // with net.isIP, so a colon only passes as part of a real IPv6
      // address; anything else with a colon is host:port and is rejected.
      const s = String(v);
      if (s.includes('://') || s.includes('/')) {
        throw new Error(`${key}: expected a hostname or IP address (e.g. ${TYPE_EXAMPLES.host}), got "${shown}"`);
      }
      if (net.isIP(s) === 6 || net.isIP(s) === 4) return s;
      if (s.includes(':')) {
        throw new Error(`${key}: expected a hostname or IP address (e.g. ${TYPE_EXAMPLES.host}), got "${shown}"`);
      }
      const hostname = s.endsWith('.') ? s.slice(0, -1) : s;
      if (!/^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(hostname)) {
        throw new Error(`${key}: expected a hostname or IP address (e.g. ${TYPE_EXAMPLES.host}), got "${shown}"`);
      }
      return s;
    }
    case 'port': {
      // Issue #277: same plain-literal rule as 'int' — '8080.0' and '1e3'
      // are rejected even though they resolve to a port in range.
      if (typeof v === 'string' && !/^[+-]?\d+$/.test(v.trim())) {
        throw new Error(`${key}: expected a port (0-65535, e.g. ${TYPE_EXAMPLES.port}), got "${shown}"`);
      }
      const n = decimalNumber(v);
      const zeroWithoutValue = n === 0 && typeof v !== 'number'
        && (typeof v !== 'string' || v.trim() === '');
      if (zeroWithoutValue || !Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`${key}: expected a port (0-65535, e.g. ${TYPE_EXAMPLES.port}), got "${shown}"`);
      }
      return n;
    }
    case 'array': {
      // Split a delimited string (or validate an already-parsed array, e.g. a
      // default) and coerce each item with `of` (default 'string'). Empty items
      // are rejected rather than silently dropped so accidental double or
      // trailing separators fail fast with the offending index and value.
      let parts;
      if (Array.isArray(raw)) {
        parts = raw;
      } else if (typeof raw === 'string') {
        parts = raw.split(separator);
      } else {
        throw new Error(`${key}: expected a delimited list (e.g. ${TYPE_EXAMPLES.array}), got "${shown}"`);
      }
      if (skipEmpty) {
        // Issue #348: drop accidental empty items (trailing or doubled
        // separators) before indexing, so the error index and the counts match
        // the items that remain.
        parts = parts.filter((part) => typeof part === 'string' ? (trim ? part.trim() : part) !== '' : part !== undefined && part !== null);
      }
      const itemType = of || 'string';
      return parts.map((part, i) => {
        const itemKey = `${key}[${i}]`;
        const itemVal = typeof part === 'string' ? (trim ? part.trim() : part) : part;
        if (itemVal === undefined || itemVal === null || itemVal === '') {
          if (itemType === 'string') {
            const rawStr = part === undefined || part === null ? '' : String(part);
            const itemShown = sensitive ? maskValue(rawStr) : rawStr;
            throw new Error(`${itemKey}: expected a non-empty value, got "${itemShown}"`);
          }
          return coerce(itemKey, part === undefined || part === null ? '' : part, itemType, trim, protocols, sensitive);
        }
        return coerce(itemKey, part, itemType, trim, protocols, sensitive);
      });
    }
    default: throw new Error(`${key}: unknown type "${type}"`);
  }
}

function safeString(v) {
  try { return String(v); }
  catch { return Object.prototype.toString.call(v); }
}

// Verify a post-transform value still matches the rule's declared `type`
// (issue #210). Unlike `coerce()`, this never converts a wrong JS type such as
// turning `42` into `'42'` for `type: 'string'` or `'5'` into `5` for `type: 'int'`.
function verifyTransformedType(key, val, type, protocols, sensitive, of) {
  const rawStr = safeString(val);
  const shown = sensitive ? maskValue(rawStr) : rawStr;
  switch (type) {
    case 'string':
      if (typeof val !== 'string') {
        throw new Error(`${key}: expected a string (e.g. ${TYPE_EXAMPLES.string}), got "${shown}"`);
      }
      return val;
    case 'number':
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new Error(`${key}: expected a number (e.g. ${TYPE_EXAMPLES.number}), got "${shown}"`);
      }
      return val;
    case 'int':
      if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val)) {
        throw new Error(`${key}: expected an integer (e.g. ${TYPE_EXAMPLES.int}), got "${shown}"`);
      }
      return val;
    case 'port':
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 65535) {
        throw new Error(`${key}: expected a port (0-65535, e.g. ${TYPE_EXAMPLES.port}), got "${shown}"`);
      }
      return val;
    case 'duration':
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
        throw new Error(`${key}: expected a duration (e.g. ${TYPE_EXAMPLES.duration}), got "${shown}"`);
      }
      return val;
    case 'boolean':
      if (typeof val !== 'boolean') {
        throw new Error(`${key}: expected a boolean (e.g. ${TYPE_EXAMPLES.boolean}), got "${shown}"`);
      }
      return val;
    case 'date':
      if (!(val instanceof Date) || Number.isNaN(val.getTime())) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. ${TYPE_EXAMPLES.date}), got "${shown}"`);
      }
      return val;
    case 'json':
      if (val === undefined || typeof val === 'function' || typeof val === 'symbol'
        || typeof val === 'bigint' || (typeof val === 'number' && !Number.isFinite(val))) {
        throw new Error(`${key}: expected valid JSON (e.g. ${TYPE_EXAMPLES.json}), got "${shown}"`);
      }
      return val;
    case 'array': {
      if (!Array.isArray(val)) {
        throw new Error(`${key}: expected an array (e.g. ${TYPE_EXAMPLES.array}), got "${shown}"`);
      }
      const itemType = of || 'string';
      for (let i = 0; i < val.length; i++) {
        verifyTransformedType(`${key}[${i}]`, val[i], itemType, protocols, sensitive);
      }
      return val;
    }
    default:
      // Remaining built-in types ('email', 'url', 'file', 'uuid', 'hex',
      // 'ipv4', 'semver', 'base64', 'host') are string-valued: reject
      // non-strings before delegating to `coerce()` so e.g. `42` is never
      // silently stringified to `'42'`.
      if (typeof val !== 'string') {
        throw new Error(`${key}: expected a ${type} string (e.g. ${TYPE_EXAMPLES[type]}), got "${shown}"`);
      }
      return coerce(key, val, type, false, protocols, sensitive);
  }
}

function maskSensitiveMessage(msg, raw, val, sensitive) {
  if (!sensitive) return msg;
  const rawStr = String(raw);
  if (rawStr) msg = msg.split(rawStr).join(maskValue(rawStr));
  const valStr = String(val);
  if (valStr && valStr !== rawStr) msg = msg.split(valStr).join(maskValue(valStr));
  return msg;
}

// Core of validateEnv: validates the schema (issue #228 groups included),
// coerces every env value against the FLATTENED rules, and returns the flat
// result plus the group map so callers can re-nest. Never throws EnvSaafError.
// Issue #350: optional `valueSources` maps each env key whose merged value
// came from a loaded file to that path. Errors carry a parallel `errorSources`
// entry for the *selected* input origin (alias winner, not merely the schema
// key); schema defaults and ambient-only values leave it unset.
function validateEnvCore(schema, env, options, valueSources) {
  const out = {}; const errors = []; const errorSources = [];
  const pushErr = (message, source) => {
    errors.push(message);
    errorSources.push(source);
  };
  // Issue #250: reject a typo'd option up front, before looking at any values
  // — the check runs even when the variable is absent and even with
  // { throwOnError: false }, like schema errors.
  for (const opt of Object.keys(options)) {
    if (!KNOWN_VALIDATE_OPTIONS.has(opt)) {
      throw new EnvSaafError([`unknown option "${opt}" (validateEnv accepts: throwOnError, strict, onWarn, formatError, rules)`]);
    }
  }
  // Reject a malformed schema before looking at any values, so a typo on an
  // absent optional key fails immediately instead of passing silently.
  if (options.onWarn !== undefined && typeof options.onWarn !== 'function') {
    throw new TypeError('env-saaf: "onWarn" option must be a function');
  }
  const patterns = validateSchemaRules(schema, options.onWarn || (msg => console.warn(msg)));
  // Issue #228: groups are validated as groups above, then flattened, so the
  // whole existing pipeline (aliases, defaults, requiredIf, strict) works on
  // full env names unchanged and errors name DB_HOST, not DB.HOST.
  const { flat, groupOf } = flattenSchema(schema);
  if (options.formatError !== undefined && typeof options.formatError !== 'function') {
    throw new TypeError('env-saaf: "formatError" option must be a function');
  }
  const rules = normalizeRules(options.rules);
  const warn = options.onWarn || ((msg) => console.warn(msg));
  const setKeys = Object.keys(env).filter((k) => env[k] !== undefined && env[k] !== '');
  if (options.strict) {
    const knownAliases = new Set();
    for (const rule of Object.values(flat)) {
      if (rule && Array.isArray(rule.aliases)) {
        for (const alias of rule.aliases) knownAliases.add(alias);
      }
    }
    const declaredKeys = Object.keys(flat);
    for (const key of Object.keys(env)) {
      if (!Object.prototype.hasOwnProperty.call(flat, key)
        && !knownAliases.has(key)
        && env[key] !== undefined && env[key] !== '') {
        const hint = nearMissKey(key, declaredKeys);
        const src = valueSources && Object.prototype.hasOwnProperty.call(valueSources, key)
          ? valueSources[key] : undefined;
        pushErr(`${key}: set but not in schema (strict mode)`
          + (hint ? ` (did you mean ${hint}? it is declared in the schema)` : ''), src);
      }
    }
  }
  const pendingRequiredIf = [];
  const presentKeys = new Set();
  const presentSources = new Map();
  for (const [key, rule] of Object.entries(flat)) {
    let raw = env[key];
    // Issue #276: in a hand-built env object, `null` counts as "not set"
    // (exactly like `undefined`) — it must not reach coercion and become
    // the literal string "null".
    if (raw === null) raw = undefined;
    if (raw !== undefined && raw !== '') {
      const notice = deprecationNotice(rule.deprecated);
      if (notice) warn(`env-saaf: ${key} is ${notice}`);
    }
    // Issue #350: remember which env key supplied the selected input (canonical
    // or alias winner). Schema defaults clear this so a bad default is never
    // blamed on a file that only contributed an empty placeholder.
    let originKey;
    // Issue #53: aliases let a renamed variable migrate without a flag day.
    // If the canonical key is set it wins and any populated alias is noted
    // as ignored; if unset, the first populated alias supplies the value
    // with a deprecation warning. Empty strings count as unset everywhere.
    if (Array.isArray(rule.aliases) && rule.aliases.length) {
      const seenAliases = new Set([key]);
      const populatedAliases = [];
      for (const alias of rule.aliases) {
        if (seenAliases.has(alias)) continue;
        seenAliases.add(alias);
        if (env[alias] !== undefined && env[alias] !== null && env[alias] !== '') {
          populatedAliases.push(alias);
        }
      }
      if (raw !== undefined && raw !== '') {
        originKey = key;
        for (const alias of populatedAliases) {
          warn(`env-saaf: ${alias} is ignored because ${key} is set`);
        }
      } else if (populatedAliases.length) {
        const [winner, ...ignored] = populatedAliases;
        originKey = winner;
        raw = env[winner];
        warn(`env-saaf: ${winner} is deprecated; use ${key} instead`);
        for (const alias of ignored) {
          warn(`env-saaf: ${alias} is ignored because ${winner} is set; use ${key} instead`);
        }
      } else if (raw === '') {
        originKey = key;
      }
    } else if (raw !== undefined && raw !== '') {
      originKey = key;
    } else if (raw === '') {
      originKey = key;
    }
    const valueSource = () => (
      valueSources && originKey !== undefined
        && Object.prototype.hasOwnProperty.call(valueSources, originKey)
        ? valueSources[originKey] : undefined
    );
    // Issue #276: an object (or an array on a scalar rule) in a hand-built
    // env object can never be an env value — fail with an error naming the
    // key instead of coercing it to "[object Object]" or "". Two types are
    // exempt by design: `array` rules validate already-parsed arrays item
    // by item, and `json` rules pass already-parsed values through.
    if (raw !== undefined && typeof raw === 'object') {
      const ruleType = rule.type || 'string';
      const parsedOk = ruleType === 'json' || (ruleType === 'array' && Array.isArray(raw));
      if (!parsedOk) {
        pushErr(`${key}: expected a string value, got ${Array.isArray(raw) ? 'an array' : 'an object'}`, valueSource());
        continue;
      }
    }
    // A default goes through the same coercion and checks as a real value,
    // so a typo in it fails startup with the key named. A supplied value
    // still wins; transform is skipped for defaults (see below).
    let usingDefault = false;
    if (raw === undefined || raw === '') {
      if (rule.default !== undefined) {
        raw = rule.default;
        usingDefault = true;
        originKey = undefined;
      } else {
        if (rule.required) {
          // Issue #349: a set-but-undeclared near miss is the usual cause; a
          // case-only mismatch always qualifies. Names only, never values.
          const hint = nearMissKey(key, setKeys.filter((k) => k !== key));
          const where = hint && !Object.prototype.hasOwnProperty.call(flat, hint)
            ? 'it is set but not in the schema' : 'it is set';
          pushErr(`${key}: missing required variable`
            + (hint ? ` (did you mean ${hint}? ${where})` : ''), valueSource());
        }
        else if (rule.requiredIf !== undefined) pendingRequiredIf.push([key, rule.requiredIf]);
        continue;
      }
    }
    presentKeys.add(key);
    presentSources.set(key, valueSource());
    const sensitive = rule.sensitive === true;
    const shown = sensitive ? maskValue(raw) : raw;
    const type = rule.type || 'string';
    try {
      const val = coerce(key, raw, type, rule.trim !== false, rule.protocols, sensitive, rule.of, rule.separator, rule.skipEmpty === true);
      // min/max: allowed range for numeric values (number, int, port, duration).
      // Runs right after coercion, before choices/pattern/transform; the
      // error names the allowed range. min alone or max alone both work.
      if (typeof val === 'number' && (rule.min !== undefined || rule.max !== undefined)) {
        const lo = rule.min !== undefined ? numericBound(key, rule, rule.min) : -Infinity;
        const hi = rule.max !== undefined ? numericBound(key, rule, rule.max) : Infinity;
        if (val < lo || val > hi) {
          // Bare numbers and numeric strings are milliseconds; retain explicit duration units.
          const min = type === 'duration' && Number.isFinite(Number(rule.min)) ? `${lo}ms` : rule.min;
          const max = type === 'duration' && Number.isFinite(Number(rule.max)) ? `${hi}ms` : rule.max;
          const range = rule.min !== undefined && rule.max !== undefined ? `${min}–${max}`
            : rule.min !== undefined ? `at least ${min}` : `at most ${max}`;
          pushErr(`${key}: expected ${type === 'duration' ? 'a duration' : 'a number'} ${range}, got "${shown}"`, valueSource());
          continue;
        }
      }
      // Issue #292: min/max bounds for `date` values — ISO date/datetime
      // strings (or Date objects) from the rule, compared chronologically
      // against the parsed Date. Inclusive on both ends; a date-time value
      // compares against a date-only bound by its instant, so
      // '2026-01-01T00:00:00Z' is on the '2026-01-01' bound. Bounds are
      // validated up front in validateSchema, so an unparseable bound here
      // can only come from a schema that skipped validation; it is skipped
      // rather than crashing the run. Defaults go through the same check
      // because they are coerced here too.
      if (val instanceof Date && (rule.min !== undefined || rule.max !== undefined)) {
        let lo = null, hi = null;
        try { if (rule.min !== undefined) lo = coerce(key, rule.min, 'date'); } catch (_) {}
        try { if (rule.max !== undefined) hi = coerce(key, rule.max, 'date'); } catch (_) {}
        const t = val.getTime();
        if ((lo !== null && t < lo.getTime()) || (hi !== null && t > hi.getTime())) {
          const boundText = (b) => (b instanceof Date ? b.toISOString().slice(0, 10) : String(b));
          const range = lo !== null && hi !== null ? `between ${boundText(rule.min)} and ${boundText(rule.max)}`
            : lo !== null ? `on or after ${boundText(rule.min)}` : `on or before ${boundText(rule.max)}`;
          pushErr(`${key}: expected a date ${range}, got "${shown}"`, valueSource());
          continue;
        }
      }
      // minItems/maxItems: allowed item count for array values (issue #207).
      // Runs right after coercion, before choices/pattern; the error names
      // the count and the bound. Either option works alone, and defaults go
      // through the same check because they are coerced here too.
      if (Array.isArray(val) && (rule.minItems !== undefined || rule.maxItems !== undefined)) {
        const lo = rule.minItems !== undefined ? rule.minItems : 0;
        const hi = rule.maxItems !== undefined ? rule.maxItems : Infinity;
        if (val.length < lo || val.length > hi) {
          const range = rule.minItems !== undefined && rule.maxItems !== undefined ? `${rule.minItems}–${rule.maxItems} items`
            : rule.minItems !== undefined ? `at least ${rule.minItems} items` : `at most ${rule.maxItems} items`;
          pushErr(`${key}: expected ${range}, got ${val.length}`, valueSource());
          continue;
        }
      }
      // Issue #291: `unique: true` rejects repeated items, compared after
      // item coercion — so '1,01' for `of: 'int'` counts as a duplicate.
      // Runs right after coercion, next to minItems/maxItems; the error
      // names the key and the duplicated item. Defaults go through the
      // same check because they are coerced here too.
      if (Array.isArray(val) && rule.unique === true) {
        const seen = new Set();
        let duplicate;
        let found = false;
        for (const item of val) {
          // Objects (dates, parsed JSON items) compare by their JSON form.
          const itemKey = item !== null && typeof item === 'object' ? JSON.stringify(item) : item;
          if (seen.has(itemKey)) { duplicate = item; found = true; break; }
          seen.add(itemKey);
        }
        if (found) {
          const shownDup = sensitive ? maskValue(safeString(duplicate)) : safeString(duplicate);
          pushErr(`${key}: duplicate value "${shownDup}" (unique: true)`, valueSource());
          continue;
        }
      }
      // minLength/maxLength: allowed length for string values (string,
      // email, url, file, uuid, hex, ipv4, semver, base64, host). Checked
      // after coercion, before choices/pattern; the error names the allowed
      // length. Non-string types are rejected up front in validateSchema.
      if (typeof val === 'string' && (rule.minLength !== undefined || rule.maxLength !== undefined)) {
        if ((rule.minLength !== undefined && (!Number.isInteger(rule.minLength) || rule.minLength < 0))
          || (rule.maxLength !== undefined && (!Number.isInteger(rule.maxLength) || rule.maxLength < 0))) {
          pushErr(`${key}: "minLength" and "maxLength" must be non-negative integers`, valueSource());
          continue;
        }
        const lo = rule.minLength !== undefined ? rule.minLength : 0;
        const hi = rule.maxLength !== undefined ? rule.maxLength : Infinity;
        if (val.length < lo || val.length > hi) {
          const range = rule.minLength !== undefined && rule.maxLength !== undefined ? `${rule.minLength}–${rule.maxLength} characters`
            : rule.minLength !== undefined ? `at least ${rule.minLength} characters` : `at most ${rule.maxLength} characters`;
          pushErr(`${key}: expected a string ${range} long, got "${shown}"`, valueSource());
          continue;
        }
      }
      // length: exact length in characters for the hex type (fixed-size
      // tokens and hashes). Checked after coercion, before choices/pattern;
      // the error names the expected length.
      if (rule.type === 'hex' && rule.length !== undefined) {
        if (!Number.isInteger(rule.length) || rule.length < 0) {
          pushErr(`${key}: "length" must be a non-negative integer`, valueSource());
          continue;
        }
        if (typeof val === 'string' && val.length !== rule.length) {
          pushErr(`${key}: expected a string ${rule.length} characters long, got "${shown}"`, valueSource());
          continue;
        }
      }
      if (rule.choices) {
        if (Array.isArray(val)) {
          // Issue #320: `choices` on an array rule constrains each coerced
          // item, not the array itself. Name the key, the bad item and its
          // index so the failure is actionable (as `unique: true` does).
          const badIndex = val.findIndex(item => !rule.choices.includes(item));
          if (badIndex !== -1) {
            const item = val[badIndex];
            const shownItem = sensitive ? maskValue(safeString(item)) : safeString(item);
            pushErr(`${key}: expected one of [${rule.choices.join(', ')}], got "${shownItem}" (item ${badIndex})`, valueSource());
            continue;
          }
        } else if (!rule.choices.includes(val)) {
          pushErr(`${key}: expected one of [${rule.choices.join(', ')}], got "${shown}"`, valueSource());
          continue;
        }
      }
      // Keep compiled strings off the caller's rules so frozen schemas work
      // and later validations can see changes to the source.
      const source = rule.pattern;
      if (source !== undefined) {
        const pattern = compilePattern(source, key, errors, patterns);
        while (errorSources.length < errors.length) errorSources.push(valueSource());
        if (pattern === undefined) continue;
        if (typeof val === 'string' && !pattern.test(val)) {
          pushErr(`${key}: expected to match ${pattern}, got "${shown}"`, valueSource());
          continue;
        }
      }
      // validate: custom rule run after coercion and built-in checks (including
      // on defaults), before transform (issue #52). Receives (value, env);
      // return true/undefined/null to pass, false for a generic error, or a
      // non-empty string error message to fail. A thrown error is collected
      // like any other validation failure, naming the key.
      if (rule.validate !== undefined) {
        let valid;
        try {
          valid = rule.validate(val, env);
        } catch (e) {
          const rawMsg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
          const msg = maskSensitiveMessage(rawMsg, raw, val, sensitive);
          pushErr(`${key}: validation failed: ${msg}`, valueSource());
          continue;
        }
        if (valid === false) {
          pushErr(`${key}: failed custom validation, got "${shown}"`, valueSource());
          continue;
        }
        if (typeof valid === 'string' && valid.length > 0) {
          const msg = maskSensitiveMessage(valid, raw, val, sensitive);
          pushErr(`${key}: ${msg}`, valueSource());
          continue;
        }
      }
      // transform: one custom step after coercion and all validation checks.
      // It runs only on values actually provided (not on defaults, which are
      // still coerced and validated). A throwing transform is collected like
      // any other validation error, with the key named — never thrown raw.
      // Its return value is verified against the declared `type` (issue #210).
      if (rule.transform !== undefined && !usingDefault) {
        if (typeof rule.transform !== 'function') {
          pushErr(`${key}: "transform" must be a function`, valueSource());
          continue;
        }
        let transformed;
        try {
          transformed = rule.transform(val);
        } catch (e) {
          const msg = maskSensitiveMessage(e.message, raw, val, sensitive);
          pushErr(`${key}: transform failed: ${msg}`, valueSource());
          continue;
        }
        out[key] = verifyTransformedType(key, transformed, type, rule.protocols, sensitive, rule.of);
        continue;
      }
      out[key] = val;
    } catch (e) { pushErr(e.message, valueSource()); }
  }
  // Pass 2a (issue #345): evaluate `conflictsWith` across resolved keys (aliases
  // and defaults count as set). Symmetric even when declared on one side only,
  // de-duplicated for reciprocal declarations, and free of secret/raw values.
  const conflictedKeys = new Set();
  const reportedConflicts = new Set();
  for (const [key, rule] of Object.entries(flat)) {
    if (!presentKeys.has(key) || rule.conflictsWith === undefined) continue;
    for (const other of normalizeConflictsWith(rule.conflictsWith)) {
      if (!presentKeys.has(other)) continue;
      const pairKey = [key, other].sort().map(k => JSON.stringify(k)).join(':');
      if (reportedConflicts.has(pairKey)) continue;
      reportedConflicts.add(pairKey);
      conflictedKeys.add(key);
      conflictedKeys.add(other);
      pushErr(`${key}: conflicts with ${other} (cannot set both)`, presentSources.get(key));
    }
  }
  for (const key of conflictedKeys) {
    delete out[key];
  }
  // Pass 2b (issue #51): evaluate `requiredIf` after Pass 1 has coerced values
  // and applied defaults across the whole schema, so declaration order never
  // matters. If the referenced key is not declared in the schema, fall back to
  // the raw `env` object so external flags like NODE_ENV still work.
  for (const [key, cond] of pendingRequiredIf) {
    let hasRef = false;
    let refVal;
    if (Object.prototype.hasOwnProperty.call(out, cond.key)) {
      hasRef = true;
      refVal = out[cond.key];
    } else if (!Object.prototype.hasOwnProperty.call(flat, cond.key)
      && Object.prototype.hasOwnProperty.call(env, cond.key)
      && env[cond.key] !== undefined && env[cond.key] !== '') {
      hasRef = true;
      refVal = env[cond.key];
    }
    if (!hasRef) continue;
    const matched = Object.prototype.hasOwnProperty.call(cond, 'in') && cond.in !== undefined
      ? cond.in.includes(refVal)
      : refVal === cond.equals;
    if (matched) {
      const hint = nearMissKey(key, setKeys.filter((k) => k !== key));
      const where = hint && !Object.prototype.hasOwnProperty.call(flat, hint)
        ? 'it is set but not in the schema' : 'it is set';
      pushErr(`${key}: missing required variable`
        + (hint ? ` (did you mean ${hint}? ${where})` : ''), undefined);
    }
  }
  // Issue #228: re-nest grouped keys (DB_HOST -> { DB: { HOST } }) and freeze.
  const result = Object.freeze(groupOf.size ? nestGroups(out, groupOf) : out);
  // Pass 3 (issue #346): run cross-field `rules` only when earlier checks left
  // no errors, so hooks always inspect a complete coerced result snapshot.
  if (!errors.length) {
    for (const rule of rules) {
      const outcome = rule(result);
      if (outcome === undefined || outcome === null) continue;
      if (typeof outcome === 'string') {
        if (outcome) pushErr(outcome);
        continue;
      }
      if (Array.isArray(outcome)) {
        for (let i = 0; i < outcome.length; i++) {
          const item = outcome[i];
          if (typeof item !== 'string') {
            throw new TypeError('env-saaf: "rules" hook must return a string, an array of strings, or undefined');
          }
          if (item) pushErr(item);
        }
        continue;
      }
      throw new TypeError('env-saaf: "rules" hook must return a string, an array of strings, or undefined');
    }
  }
  // Non-throwing mode lives in the public wrapper below; the core always
  // returns both the values and the errors (issue #55).
  return { out, result, errors, errorSources };
}

// Issue #231: an opt-in hook may replace the message. It only ever sees an
// isolated copy of the error strings and the schema keys, never env values
// or the schema rules, and `error.errors` keeps the raw strings. Issue #279:
// a hook that throws is a programming error, so its error propagates out of
// validateEnv/loadEnv unchanged instead of vanishing behind the default
// message — the same way a non-function hook is a TypeError up front. A hook
// that returns a non-string still falls back to the default message.
// Shared by validateEnv and loadEnvSteps (which uses the core directly so
// `assign` writes the FLAT env names) so both honour the hook.
function formatErrorMessage(errors, schema, options) {
  let message;
  if (options.formatError) {
    const formatted = options.formatError(
      Object.freeze(errors.slice()),
      Object.freeze({ keys: Object.freeze(Object.keys(schema)) })
    );
    if (typeof formatted === 'string') message = formatted;
  }
  return message;
}

/** Damerau-Levenshtein distance (an adjacent swap is one edit), for key hints (issue #349). */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2; // only one-edit suggestions matter
  const d = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** One conservative near-miss for `key`, or null: same name ignoring case, or one edit. */
function nearMissKey(key, candidates) {
  if (key.length < 3) return null;
  let best = null;
  let bestDistance = 2;
  for (const candidate of candidates) {
    if (candidate === key || candidate.length < 3) continue;
    const distance = candidate.toLowerCase() === key.toLowerCase() ? 0 : editDistance(key, candidate);
    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      if (distance <= 1) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function validateEnv(schema, env = process.env, options = {}) {
  const { result, errors } = validateEnvCore(schema, env, options);
  if (options.throwOnError === false) return { env: result, errors, details: errorDetails(errors) };
  if (errors.length) {
    throw new EnvSaafError(errors, formatErrorMessage(errors, schema, options));
  }
  return result;
}

/**
 * Load a .env file and validate it in one call.
 * Options:
 *   path     — .env file to read (default '.env')
 *   env      — base env to merge with (default process.env); its values win unless override is true
 *   override — if true, values from the file win over `env` (default false)
 *   assign   — if true, write the validated values back into `env` as strings
 *              (objects/arrays from the json type are JSON-stringified)
 *              (default false — process.env is never mutated silently)
 * Any other options are passed through to validateEnv (e.g. { strict: true }).
 * An explicitly passed single `path` that does not exist always throws, naming
 * the path (a typo'd path must not boot the app silently). The implicit
 * default `.env` and list forms (`paths: [...]` or `path` as an array) skip
 * missing files; with a list the missing-file rule throws only when NO file is
 * found and every schema key is optional (has a default or is not required).
 */
function loadEnv(schema, options = {}) {
  const loader = loadEnvSteps(schema, options);
  let step = loader.next();
  while (!step.done) {
    let fileText;
    try {
      fileText = fs.readFileSync(step.value, 'utf8');
    } catch (error) {
      step = loader.throw(error);
      continue;
    }
    step = loader.next(fileText);
  }
  return step.value;
}

async function loadEnvAsync(schema, options = {}) {
  const loader = loadEnvSteps(schema, options);
  let step = loader.next();
  while (!step.done) {
    let fileText;
    try {
      fileText = await fs.promises.readFile(step.value, 'utf8');
    } catch (error) {
      step = loader.throw(error);
      continue;
    }
    step = loader.next(fileText);
  }
  return step.value;
}

// Yield each path in order so both loaders share parsing and error handling.
function* loadEnvSteps(schema, options) {
  if (schema === null || typeof schema !== 'object'
    || (Object.getPrototypeOf(schema) !== Object.prototype && Object.getPrototypeOf(schema) !== null)) {
    throw new TypeError(
      "loadEnv expects a schema object as the first argument — did you mean loadEnv(schema, { path: '.env' })?"
    );
  }
  const { path: pathOpt, paths: pathsOpt, env = process.env, override = false, assign = false, ...rest } = options;
  // Issue #250: reject a typo'd loadEnv option up front (e.g. `overide`),
  // before reading any file — the typo would otherwise flow through to
  // validateEnv as an unknown option, but the loadEnv names make the fix
  // obvious at the call site.
  for (const opt of Object.keys(options)) {
    if (!KNOWN_LOAD_ENV_OPTIONS.has(opt)) {
      throw new EnvSaafError([`unknown option "${opt}" (loadEnv accepts: path, paths, env, override, assign, throwOnError, strict, onWarn, formatError, rules)`]);
    }
  }
  // One file or several: `path` may be a string or an array of strings, or
  // pass `paths: [...]`. Files are read in order and LATER files win over
  // earlier ones (e.g. ['.env', '.env.local']). Missing files in a list are
  // skipped; only when NO file is found does the missing-file rule below run.
  // An explicitly passed single `path` string is a deliberate instruction, so
  // a missing file there is reported instead of silently skipped (issue #158);
  // the implicit default `.env` and list forms keep the skip behaviour.
  const explicitSinglePath = pathsOpt === undefined && pathOpt !== undefined && !Array.isArray(pathOpt) ? pathOpt : undefined;
  const fileList = pathsOpt !== undefined ? pathsOpt : (pathOpt !== undefined ? (Array.isArray(pathOpt) ? pathOpt : [pathOpt]) : ['.env']);
  const fileEnv = {};
  // Issue #350: remember the winning file path for each key under layering
  // (later files overwrite earlier ones). Ambient precedence is applied below.
  const fileSources = Object.create(null);
  let foundAny = false;
  for (const filePath of fileList) {
    let fileText;
    try {
      fileText = yield filePath;
    } catch (e) {
      // A missing file keeps its own behaviour (skipped in a list, reported
      // when a required variable is missing below). Any other read failure —
      // a directory (EISDIR), permission denied (EACCES/EPERM) — names the
      // path instead of escaping as a raw Node error (issue #157).
      if (e.code !== 'ENOENT') {
        throw new Error(`env-saaf: cannot read .env file at ${filePath}: ${e.message}`);
      }
      if (explicitSinglePath !== undefined) {
        throw new Error(`env-saaf: .env file not found: ${filePath}`);
      }
      continue;
    }
    foundAny = true;
    const parsed = parseEnvFileWithSource(fileText, filePath);
    for (const key of Object.keys(parsed)) {
      fileEnv[key] = parsed[key];
      fileSources[key] = filePath;
    }
  }
  if (!foundAny) {
    // Issue #228: count required rules across groups too, under their full
    // env names, so a required DB_HOST is not missed when no file was found.
    const { flat } = flattenSchema(schema);
    const needed = Object.entries(flat)
      .filter(([, rule]) => rule && rule.required && rule.default === undefined)
      .map(([key]) => key);
    if (needed.length) {
      throw new Error(`env-saaf: .env file not found: ${fileList.join(', ')} (required variables missing: ${needed.join(', ')})`);
    }
  }
  // Same enumerable own-key copy object spread uses for ambient. Non-enumerable
  // ambient props (and inherited ones) do not participate in the merge, so
  // provenance must not treat them as ambient wins via hasOwnProperty on `env`.
  const ambient = { ...env };
  const merged = override ? { ...ambient, ...fileEnv } : { ...fileEnv, ...ambient };
  // Issue #350: report a source only for values that actually came from a
  // file after ambient/override precedence. Ambient-winning keys keep today's
  // message shape with no `source` field.
  const sources = Object.create(null);
  for (const key of Object.keys(fileSources)) {
    if (override || !Object.prototype.hasOwnProperty.call(ambient, key)) {
      sources[key] = fileSources[key];
    }
  }
  // loadEnv always throws. It can write into the caller's env with
  // `assign: true`, and a half-applied write is not a degraded mode anyone
  // asked for, so `throwOnError: false` is accepted but ignored here — call
  // validateEnv directly when you want to collect the errors (issue #55).
  // The core is used directly so `assign` writes the FLAT env names (a group
  // result nested under DB must not be written back as "DB=[object Object]").
  const { out, result, errors, errorSources } = validateEnvCore(
    schema, merged, { ...rest, throwOnError: true }, sources
  );
  if (errors.length) {
    const { reported, details } = applyFileSources(errors, errorSources);
    throw new EnvSaafError(reported, formatErrorMessage(reported, schema, rest), details);
  }
  if (assign) {
    for (const [key, value] of Object.entries(out)) {
      // A json value (or a transform returning an object/array) must be written
      // back as JSON text so it round-trips through JSON.parse; String() on an
      // object would produce the useless "[object Object]".
      env[key] = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
    }
  }
  return result;
}

/**
 * Expand backslash escapes in the inner text of a double-quoted value
 * (issue #333, dotenv parity): `\n` becomes a real newline, `\r` a carriage
 * return, `\\` a single backslash, and `\"` a quote. Any other backslash
 * stays literal, so `C:\path` is unchanged and `\\n` (an escaped backslash
 * followed by `n`) stays the literal two characters `\n`.
 */
function expandDoubleQuotedEscapes(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\' || i + 1 >= inner.length) { out += ch; continue; }
    const next = inner[i + 1];
    if (next === 'n') { out += '\n'; i++; }
    else if (next === 'r') { out += '\r'; i++; }
    else if (next === '\\') { out += '\\'; i++; }
    else if (next === '"') { out += '"'; i++; }
    else out += ch;
  }
  return out;
}

/** Parse .env text -> { KEY: value }. Handles quotes, `export `, comments,
 * multiline quoted values, and POSIX-style ${VAR} parameter expansion
 * (`:-`, `-`, `:?`, `?`, `:+`, `+`). */
/**
 * Index of the first `quote` in `text` that is not escaped by a backslash,
 * starting at `from`; -1 when the value is still unterminated (multiline).
 * A backslash escapes the single character after it, so `\\` before a quote
 * still lets that quote close the value.
 */
function closingQuoteIndex(text, quote, from = 1) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i;
  }
  return -1;
}

function parseEnvFile(text) {
  return parseEnvFileWithSource(text, undefined);
}

function parseEnvFileWithSource(text, sourceFile) {
  // A file path passed by mistake (e.g. parseEnvFile('.env')) used to silently
  // return {} because no line matched KEY=VALUE. Detect that confusion: a
  // single-line string with no '=' that looks like a path is almost certainly
  // a path, not .env content. Real .env text has '=' or a newline (or is empty),
  // so none of those trip this guard.
  const input = String(text);
  if (!input.includes('\n') && !input.includes('=') && !input.trimStart().startsWith('#')) {
    const pathLike = input.startsWith('.')
      || input.startsWith('/') || input.startsWith('\\')
      || input.includes('/') || input.includes('\\')
      || /^[A-Za-z]:[\\/]/.test(input)
      || /\.(env|local|properties|config)$/i.test(input);
    if (pathLike) {
      throw new Error(
        "parseEnvFile expects .env text, not a file path — did you mean loadEnv(schema, { path: '.env' })?"
      );
    }
  }
  const seen = new Map();
  const raw = {};     // key -> value with quotes removed and comments stripped
  const quoteOf = {}; // key -> 'single' | 'double' | 'none'
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) {
      // Reject malformed assignments as well as bare lines, without echoing values.
      throw new SyntaxError(`line ${i + 1}: expected KEY=VALUE`);
    }
    const key = m[1];
    if (seen.has(key)) {
      throw new Error(`env-saaf: duplicate key ${key} at line ${i + 1} (first defined at line ${seen.get(key)})`);
    }
    seen.set(key, i + 1);
    let val = m[2].trim();
    let quote = 'none';
    if (val.startsWith('"') || val.startsWith("'")) {
      // Quoted value: '#' inside quotes is safe; any comment after the closing
      // quote is dropped because only the quoted span is kept
      // (NAME="x # y" -> x # y; NAME="x" # note -> x)
      quote = val[0] === '"' ? 'double' : 'single';
      const q = val[0];
      let end = closingQuoteIndex(val, q);
      // Multiline value: the closing quote is not on this line, so keep
      // consuming lines (with their newlines) until it appears
      // (PRIVATE_KEY="-----BEGIN-----\n...\n-----END-----")
      while (end === -1 && i + 1 < lines.length) {
        i++;
        val += '\n' + lines[i];
        end = closingQuoteIndex(val, q);
      }
      // A backslash-escaped quote is part of the value, not the end of it
      // (B='it\'s' -> it's; D="it\"s" -> it"s). Single-quoted values stay
      // literal apart from that. Double-quoted values also expand \n and
      // \r (issue #333, dotenv parity); other backslashes are left
      // untouched (C:\path stays literal), and \\n stays literal too.
      const inner = end === -1 ? val.slice(1) : val.slice(1, end);
      val = quote === 'double' ? expandDoubleQuotedEscapes(inner)
        : inner.split(String.fromCharCode(92) + q).join(q);
    } else {
      // Unquoted value: a '#' at the start of the value or after whitespace begins an inline comment
      // (PORT=3000 # my port -> 3000; a '#frag' inside a URL without a preceding space is safe)
      const hash = val.search(/(^|\s)#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    raw[key] = val;
    quoteOf[key] = quote;
  }
  // Interpolation uses file values before process.env. Keep escaped references
  // protected until all expansion rounds are complete.
  const ESC = String.fromCharCode(92) + '${';
  const PH = String.fromCharCode(1);
  const openRef = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|:\?|:\+|-|\+|\?|(?=\}))/g;
  const expandRefs = (text, remaining, self) => {
    let result = '';
    let cursor = 0;
    for (const match of text.matchAll(openRef)) {
      if (match.index < cursor) continue;
      const [, name, operator] = match;
      const start = match.index + match[0].length;
      let end = start;
      let depth = 0;
      // Operands (defaults, alternates, error messages) may contain nested
      // references, literal brace pairs, or protected `\${` escapes.
      for (; end < text.length; end++) {
        if (text[end] === '{' || text[end] === PH) depth++;
        else if (text[end] === '}') {
          if (depth === 0) break;
          depth--;
        }
      }
      if (end === text.length) break; // Leave an unterminated reference literal.

      // While the line that sets `self` is being resolved, its own value is
      // not set yet (#185): with any parameter-expansion operator present, the
      // reference treats `self` as unset instead of re-reading the unresolved
      // raw text. Without an operator the raw text is read, as before.
      const value = name === self && operator ? undefined
        : Object.prototype.hasOwnProperty.call(raw, name)
          ? raw[name].split(ESC).join(PH)
          : (Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);
      const operand = text.slice(start, end);
      let replacement;
      if (!operator) {
        replacement = value ?? '';
      } else {
        const colon = operator[0] === ':';
        const missing = value === undefined || (colon && expandValue(value, remaining, self) === '');
        if (operator === ':-' || operator === '-') {
          replacement = missing ? operand : value;
        } else if (operator === ':+' || operator === '+') {
          replacement = missing ? '' : operand;
        } else {
          if (missing) {
            const detail = expandValue(operand, remaining, self).split(PH).join('${')
              || (colon ? 'is unset or empty' : 'is unset');
            const err = new Error(sourceFile !== undefined
              ? `env-saaf: ${self} (from ${sourceFile}) at line ${seen.get(self)}: ${name}: ${detail}`
              : `env-saaf: ${self} at line ${seen.get(self)}: ${name}: ${detail}`);
            if (sourceFile !== undefined) err.source = sourceFile;
            throw err;
          }
          replacement = value;
        }
      }
      result += text.slice(cursor, match.index) + replacement;
      cursor = end + 1;
    }
    return result + text.slice(cursor);
  };
  // Share the existing five-round budget with checks of interpolated values.
  const expandValue = (value, rounds, self) => {
    for (let remaining = rounds; remaining > 0; remaining--) {
      const next = expandRefs(value, remaining - 1, self);
      if (next === value) break;
      value = next;
    }
    return value;
  };
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (quoteOf[key] === 'single') { out[key] = val; continue; }
    const v = expandValue(val.split(ESC).join(PH), 5, key);
    out[key] = v.split(PH).join('${');
  }
  return out;
}

// A masked character: a position inside a comment or a literal. It is neither
// code nor whitespace, so nothing matches across it and it never looks like code.
const MASKED = '\u0000';

// Keywords after which a `/` opens a regular expression literal, not a division.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw']);

// Punctuation after which a `/` opens a regular expression literal.
const REGEX_PUNCTUATION = '([{,;:=!&|?+-*%<>~^';

/**
 * The text of `src` with every comment and every literal's content turned into
 * MASKED, at the same offsets, so what is left is the code. A template literal's
 * `${...}` bodies stay code (a read inside one is a real read), and a newline
 * always survives, so the mask has the text's shape. A `/` where an expression
 * may start is read as a regular expression literal, so a quote inside it cannot
 * open a string (fixes #115).
 */
function codeOnly(src) {
  const out = src.split('');   // rewritten in place, so every offset stays where it was
  const stack = [{ mode: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];
  const mayStartRegex = (prev, word) => REGEX_AFTER.has(word)
    || (!word && (!prev || REGEX_PUNCTUATION.includes(prev)));
  // A newline is never masked: the mask keeps the text's shape for anything that
  // reads it line by line.
  const mask = (at) => {
    if (at < src.length && src[at] !== '\n' && src[at] !== '\r') out[at] = MASKED;
  };
  let prev = '';   // the last code character
  let word = '';   // the identifier or keyword just read in code
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n' || c === '\r') { i++; continue; }
    if (top().mode === 'template') {
      if (c === '\\') { mask(i); mask(i + 1); i += 2; continue; }
      if (c === '`') { stack.pop(); mask(i); i++; prev = '`'; word = ''; continue; }
      if (c === '$' && n === '{') {
        stack.push({ mode: 'code', braces: 0 }); i += 2; prev = '{'; word = ''; continue;
      }
      mask(i); i++; continue;
    }
    if (c === '/' && n === '/') {
      // End at LF, bare CR, or CRLF (stop before the break; do not swallow the next line).
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') { mask(i); i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      mask(i); mask(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { mask(i); i++; }
      if (i < src.length) { mask(i); mask(i + 1); i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      mask(i); i++;
      while (i < src.length) {
        if (src[i] === '\n') break;   // an unterminated string ends at the line
        if (src[i] === '\\') { mask(i); mask(i + 1); i += 2; continue; }
        const ch = src[i]; mask(i); i++;
        if (ch === quote) break;
      }
      prev = quote; word = ''; continue;
    }
    if (c === '`') { stack.push({ mode: 'template' }); mask(i); i++; prev = '`'; word = ''; continue; }
    if (c === '/' && mayStartRegex(prev, word)) {
      mask(i); i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\n') break;
        if (ch === '\\') { mask(i); mask(i + 1); i += 2; continue; }
        mask(i); i++;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      prev = '/'; word = ''; continue;
    }
    if (c === '{') { top().braces++; i++; prev = c; word = ''; continue; }
    if (c === '}') {
      if (top().braces === 0 && stack.length > 1) stack.pop();   // the end of a `${...}`
      else top().braces = Math.max(0, top().braces - 1);
      i++; prev = c; word = ''; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { word += c; prev = c; }
    else if (!/\s/.test(c)) { word = ''; prev = c; }   // whitespace leaves both as they were
    i++;
  }
  return out.join('');
}

/**
 * 1-based line number of a character index in `text`.
 * Counts LF, CRLF, and bare CR (without double-counting CRLF).
 */
function lineNumberAt(text, index) {
  const s = String(text);
  let line = 1;
  for (let i = 0; i < index; i++) {
    const c = s[i];
    if (c === '\r') {
      line++;
      if (s[i + 1] === '\n') i++;
    } else if (c === '\n') {
      line++;
    }
  }
  return line;
}

/**
 * Every env read in source text with its character index (same lexical rules as
 * scanCode). Hits keep encounter order so callers can attach file/line metadata.
 */
function collectEnvReads(text) {
  const src = String(text);
  const code = codeOnly(src);
  const isCode = (start, end) => {
    for (let i = start; i < end; i++) if (code[i] === MASKED) return false;
    return true;
  };
  const hits = [];
  const add = (key, index) => { hits.push({ key, index }); };
  // Each pattern is paired with the head whose span must be real code.
  const patterns = [
    [/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, 'process.env'],
    [/process\.env\[['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]\]/g, 'process.env'],
    // Backtick bracket access with a static key — `process.env[`KEY`]`:
    // a template with ${} interpolation cannot be known statically and
    // stays unmatched (the identifier charset excludes $ and {).
    [/process\.env\[`([A-Za-z_][A-Za-z0-9_.-]*)`\]/g, 'process.env'],
    // Vite exposes env through import.meta.env (issue #225) — same shapes.
    [/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, 'import.meta.env'],
    [/import\.meta\.env\[['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]\]/g, 'import.meta.env'],
    [/import\.meta\.env\[`([A-Za-z_][A-Za-z0-9_.-]*)`\]/g, 'import.meta.env'],
    // Optional chaining (issue #222): `process.env?.KEY`, `process.env?.['KEY']`,
    // `process.env?.[`KEY`]` — valid and increasingly common reads, same shapes
    // as the plain forms above.
    [/process\.env\?\.([A-Za-z_][A-Za-z0-9_]*)/g, 'process.env'],
    [/process\.env\?\.\[['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]\]/g, 'process.env'],
    [/process\.env\?\.\[`([A-Za-z_][A-Za-z0-9_.-]*)`\]/g, 'process.env'],
    // Optional chaining on import.meta.env (issue #222) as well.
    [/import\.meta\.env\?\.([A-Za-z_][A-Za-z0-9_]*)/g, 'import.meta.env'],
    [/import\.meta\.env\?\.\[['"]([A-Za-z_][A-Za-z0-9_.-]*)['"]\]/g, 'import.meta.env'],
    [/import\.meta\.env\?\.\[`([A-Za-z_][A-Za-z0-9_.-]*)`\]/g, 'import.meta.env'],
  ];
  // The read itself must be code: a `process.env.X` in a comment or a string is
  // not a read. Bracket and destructured reads keep their key in a literal, so
  // only the env object they hang off has to be code.
  for (const [re, head] of patterns) {
    for (const m of src.matchAll(re)) {
      if (isCode(m.index, m.index + head.length)) add(m[1], m.index);
    }
  }
  const codeView = code.split(MASKED).join(' ');
  const destructure = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:process\.env|import\.meta\.env)/g;
  for (const m of codeView.matchAll(destructure)) {
    const start = m.index + m[0].indexOf('{') + 1;
    let offset = 0;
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        add(name, start + offset + part.indexOf(name));
      }
      // Split the masked view so commas in defaults cannot invent properties.
      if (part.trim().startsWith(':')) {
        const original = src.slice(start + offset, start + offset + part.length);
        const quoted = /^\s*(['"])([A-Za-z_][A-Za-z0-9_.-]*)\1\s*:/.exec(original);
        if (quoted) add(quoted[2], start + offset + original.indexOf(quoted[2]));
      }
      offset += part.length + 1;
    }
  }
  const aliases = new Map();
  const declaration = /(?<![$\p{ID_Continue}.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gu;
  const trivia = /(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n\u2028\u2029]*)*/y;
  const source = /(?:process\.env|import\.meta\.env)/y;
  const continuation = /(?!\+\+|--)(?:[.([+*\/%&|^?=<>-]|\x60|!=|(?:in|instanceof)\b)/y;
  for (const m of src.matchAll(declaration)) {
    const afterEquals = m.index + m[0].length;
    if (!isCode(m.index, afterEquals) || aliases.has(m[1])) continue;
    // Skip comments without hiding strings or consuming the next declaration.
    trivia.lastIndex = afterEquals;
    trivia.exec(src);
    const sourceStart = trivia.lastIndex;
    source.lastIndex = sourceStart;
    if (!source.test(src) || !isCode(sourceStart, source.lastIndex)) continue;
    const end = source.lastIndex;
    trivia.lastIndex = end;
    const [spacing] = trivia.exec(src);
    const next = trivia.lastIndex;
    continuation.lastIndex = next;
    // A line break ends the initializer only when the expression cannot continue.
    if (next === src.length || /[;,}]/.test(src[next]) ||
        (/[\r\n\u2028\u2029]/.test(spacing) && !continuation.test(src))) {
      aliases.set(m[1], end);
    }
  }
  if (aliases.size) {
    const access = /(?<![#$\p{ID_Continue}])([A-Za-z_$][\w$]*)(?:\.([A-Za-z_]\w*)(?![$\p{ID_Continue}])|\[(['"\x60])([A-Za-z_][\w.-]*)\3\])/gu;
    for (const m of src.matchAll(access)) {
      const declaredAt = aliases.get(m[1]);
      if (declaredAt === undefined || declaredAt > m.index || !isCode(m.index, m.index + m[1].length)) continue;
      let previous = m.index - 1;
      while (previous >= 0 && /\s/.test(codeView[previous])) previous--;
      if (codeView[previous] === '.' && codeView.slice(previous - 2, previous + 1) !== '...') continue;
      add(m[2] ?? m[4], m.index);
    }
  }
  return hits;
}

function compareLocations(a, b) {
  // Primary: locale path order (documented relative-path sort).
  const byFile = a.file.localeCompare(b.file);
  if (byFile !== 0) return byFile;
  // Tie-break: UTF-16 ordinal so collating-equal but distinct paths (e.g. NFC vs NFD) stay deterministic.
  if (a.file !== b.file) {
    if (a.file < b.file) return -1;
    if (a.file > b.file) return 1;
  }
  if (a.line < b.line) return -1;
  if (a.line > b.line) return 1;
  return 0;
}

/** Own-property write so keys like `__proto__` / `constructor` cannot hit Object.prototype. */
function setLocationEntries(target, key, entries) {
  Object.defineProperty(target, key, {
    value: entries,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function buildLocationsMap(reads, file) {
  // Map accumulation is prototype-safe for keys like constructor / __proto__ / toString.
  const byKey = new Map();
  // Push in reverse encounter order so sorting must restore file/line order.
  for (let i = reads.length - 1; i >= 0; i--) {
    const { key, index, text } = reads[i];
    const entry = { file, line: lineNumberAt(text, index) };
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push(entry);
  }
  const locations = {};
  for (const [key, entries] of byKey) {
    entries.sort(compareLocations);
    setLocationEntries(locations, key, entries);
  }
  return locations;
}

/** Find every env read in JS/TS source text - `process.env.KEY` and Vite-style `import.meta.env.KEY`. Returns sorted unique names. */
function scanCode(text) {
  const keys = new Set();
  for (const hit of collectEnvReads(text)) keys.add(hit.key);
  return [...keys].sort();
}

/**
 * Issue #335: same reads as `scanCode`, plus a `locations` map from each key to
 * `{ file, line }` entries (1-based lines). `file` defaults to `-` for piped text.
 */
function scanCodeLocations(text, file = '-') {
  const src = String(text);
  const reads = collectEnvReads(src).map(({ key, index }) => ({ key, index, text: src }));
  const vars = [...new Set(reads.map((r) => r.key))].sort();
  const locations = buildLocationsMap(reads, file);
  // Every reported variable gets a locations entry, even when somehow empty.
  for (const key of vars) {
    if (!Object.prototype.hasOwnProperty.call(locations, key)) {
      setLocationEntries(locations, key, []);
    }
  }
  return { vars, locations };
}

// Issue #235: single-file components (.vue/.svelte/.astro) hold code too —
// <script> blocks, Svelte instance scripts and Astro frontmatter all read
// process.env / import.meta.env — so the directory walk includes them.
// scanCode is text-based and already ignores comments/strings, so template
// markup does not produce false positives in the common cases.
const SCAN_EXTENSIONS = /\.(js|cjs|mjs|ts|mts|cts|tsx|jsx|vue|svelte|astro)$/;

/** Scan a folder (recursive) for env usage in .js/.cjs/.mjs/.ts/.mts/.cts/.tsx/.jsx/.vue/.svelte/.astro files. */
// Directories a scan never enters: installed packages, VCS metadata and build
// output. A stale bundle in one of these mentions keys the source no longer
// uses, which hides real drift from `check`.
const SCAN_SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', '.next', 'out', 'target',
]);

/** Turn one exclusion glob into an anchored RegExp over a relative path. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;   // `**/` also matches zero directories
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** A predicate over a path relative to the scanned root (issue #355). */
function scanExcluder(patterns) {
  if (!patterns || !patterns.length) return () => false;
  const tests = patterns.map((pattern) => {
    const glob = String(pattern).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!glob) return () => false;
    const re = globToRegExp(glob);
    // A bare name matches that segment anywhere in the tree; a path with a
    // slash matches the relative path.
    return glob.includes('/')
      ? (rel) => re.test(rel)
      : (rel) => rel.split('/').some((segment) => re.test(segment));
  });
  return (rel) => tests.some((test) => test(rel));
}

function listScanFiles(dir, options = {}) {
  const files = [];
  const excluded = scanExcluder(options.exclude);
  // A real path is walked once, so a symlinked package is included but a
  // symlink cycle cannot loop forever (issue #339).
  const visited = new Set();
  const walk = (d) => {
    let real;
    try {
      real = fs.realpathSync(d);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SCAN_SKIP_DIRECTORIES.has(e.name) || e.name.startsWith('.git')) continue;
      const p = path.join(d, e.name);
      if (excluded(path.relative(dir, p))) continue;
      let isDirectory = e.isDirectory();
      if (!isDirectory && e.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(p).isDirectory();
        } catch {
          continue;   // a broken link is not an error for the scan
        }
      }
      if (isDirectory) walk(p);
      else if (SCAN_EXTENSIONS.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  return files;
}

function scanDir(dir, options = {}) {
  const found = new Set();
  for (const p of listScanFiles(dir, options)) {
    scanCode(fs.readFileSync(p, 'utf8')).forEach(k => found.add(k));
  }
  return [...found].sort();
}

/**
 * Issue #335: directory scan with a `locations` map. File paths are relative to
 * `dir` using forward slashes; lines are 1-based. `vars` matches `scanDir`.
 */
function scanDirLocations(dir, options = {}) {
  const root = path.resolve(dir);
  const files = listScanFiles(dir, options)
    .map((abs) => ({
      abs,
      rel: path.relative(root, abs).split(path.sep).join('/'),
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  const reads = [];
  for (const { abs, rel } of files) {
    const text = fs.readFileSync(abs, 'utf8');
    for (const { key, index } of collectEnvReads(text)) {
      reads.push({ key, index, text, file: rel });
    }
  }
  const vars = [...new Set(reads.map((r) => r.key))].sort();
  const byKey = new Map();
  for (let i = reads.length - 1; i >= 0; i--) {
    const { key, index, text, file } = reads[i];
    const entry = { file, line: lineNumberAt(text, index) };
    let list = byKey.get(key);
    if (!list) {
      list = [];
      byKey.set(key, list);
    }
    list.push(entry);
  }
  const locations = {};
  for (const key of vars) {
    const entries = byKey.get(key) || [];
    entries.sort(compareLocations);
    setLocationEntries(locations, key, entries);
  }
  return { vars, locations };
}

/** Compare code usage vs a documented set (e.g. keys of .env.example). */
function diffEnv(usedKeys, documentedKeys) {
  const doc = new Set(documentedKeys);
  const used = new Set(usedKeys);
  return {
    usedNotDocumented: usedKeys.filter(k => !doc.has(k)),
    documentedNotUsed: documentedKeys.filter(k => !used.has(k)),
  };
}

/** Mask a string; non-string inputs are returned unchanged. String examples: "sk_live_123456" -> "sk***56". Short values are fully masked; an empty string is returned unchanged — there is nothing to hide. */
function maskValue(v) {
  if (typeof v !== 'string') return v;
  const s = v;
  if (s.length === 0) return '';
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

/** Return a copy of an env object with string values masked.
 *  Plain objects and arrays are walked recursively (issue #234), so the masked
 *  structure mirrors the input shape; scalar leaves use the maskValue rules.
 *  Non-string primitives and non-plain objects stay unchanged.
 *  A repeated reference (e.g. a cycle) is replaced with a fixed placeholder
 *  instead of hanging. The input is never mutated. */
function maskSecrets(obj) {
  const seen = new Set();
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return maskValue(value);
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v);
    return out;
  };
  return walk(obj);
}

// Placeholder items for `type: 'array'`, per `of` item type (issue #223): every
// item is a literal that itself validates against that item type, so a generated
// .env.example passes `check` out of the box. No item contains a comma, so the
// default separator never splits one item in two (JSON items are single-key
// objects for the same reason).
const ARRAY_ITEM_EXAMPLES = {
  string: ['a', 'b', 'c'],
  email: ['user@example.com', 'admin@example.com', 'dev@example.com'],
  number: ['1.5', '2.5', '3.5'],
  int: ['1', '2', '3'],
  boolean: ['true', 'false', 'true'],
  url: ['https://a.example', 'https://b.example', 'https://c.example'],
  uuid: ['550e8400-e29b-41d4-a716-446655440000', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', '7c9e6679-7425-40de-944b-e07fc1f90ae7'],
  hex: ['deadbeef', 'cafebabe', '0123abcd'],
  ipv4: ['192.168.0.1', '10.0.0.1', '172.16.0.1'],
  ipv6: ['::1', '2001:db8::1', 'fe80::1%eth0'],
  semver: ['1.0.0', '2.0.0', '0.1.0'],
  base64: ['aGVsbG8=', 'd29ybGQ=', 'Zm9vYmFy'],
  port: ['3000', '8080', '5432'],
  date: ['2026-01-31', '2026-06-30', '2026-12-31'],
  duration: ['500ms', '30s', '15m'],
  host: ['localhost', 'db.internal', '10.0.0.5'],
  json: ['{"a":1}', '{"b":2}', '{"c":3}'],
  file: ['./a.json', './b.json', './c.json'],
};

/** Placeholder for an `array` rule: example items of the `of` type (or the rule's `choices`), sized to fit minItems/maxItems, joined by `separator`. */
function arrayPlaceholder(rule) {
  const separator = rule.separator || ',';
  const hasChoices = Array.isArray(rule.choices) && rule.choices.length > 0;
  let examples;
  if (hasChoices) {
    // Issue #320: use allowed choices so the generated example validates.
    // A choice containing the separator cannot be represented in a delimited
    // value, so prefer ones that can. Dedupe keeps `unique: true` examples valid.
    const strings = rule.choices.map(choice => String(choice));
    const usable = [...new Set(strings.filter(s => !s.includes(separator)))];
    examples = usable.length ? usable : [...new Set(strings)];
  } else {
    examples = ARRAY_ITEM_EXAMPLES[rule.of || 'string'] || ARRAY_ITEM_EXAMPLES.string;
  }
  // Without choices, keep the old three-example placeholder. With choices,
  // suggest each allowed item once and only cycle when minItems needs more.
  let count = hasChoices ? examples.length : Math.max(3, rule.minItems || 0);
  if (hasChoices && rule.minItems !== undefined) count = Math.max(count, rule.minItems);
  if (rule.maxItems !== undefined) count = Math.min(count, Math.max(1, rule.maxItems));
  // A unique array cannot repeat a choice, so do not ask for more items than
  // there are distinct choices (the schema itself is contradictory otherwise).
  if (hasChoices && rule.unique === true) count = Math.min(count, examples.length);
  const items = [];
  for (let i = 0; i < count; i++) items.push(examples[i % examples.length]);
  return items.join(separator);
}

// A template should not materialize arbitrarily large padding from schema bounds.
const MAX_STRING_EXAMPLE_LENGTH = 4 * 1024;
const STRING_EXAMPLE_GROWTH_BUDGET = 16 * 1024;

function resizeExample(example, length, pad = 'x') {
  return example.slice(0, length).padEnd(length, pad);
}

function boundedUrlPlaceholder(example, min, max, protocols) {
  const schemes = protocols === undefined ? ['https', 'x']
    : Array.isArray(protocols) ? protocols.filter(p => typeof p === 'string' && /^[a-z][a-z0-9+.-]*:?$/i.test(p))
      .filter(p => p.length <= max).map(p => p.replace(/:$/, '').toLowerCase()) : [];
  if (schemes.includes('https') && example.length >= min && example.length <= max) return example;
  for (const scheme of schemes) {
    const prefix = `${scheme}:`;
    const origin = `${prefix}//example.com`;
    const length = Math.min(max, Math.max(min, origin.length));
    if (length === origin.length) return origin;
    if (length > origin.length) return `${origin}/`.padEnd(length, 'x');
    const hostLength = length - prefix.length - 2;
    if (hostLength > 0) return `${prefix}//${resizeExample('example', hostLength)}`;
    if (length < prefix.length) continue;
    // WHATWG URLs accept short forms such as https:x and opaque URLs such as x:.
    const short = prefix.padEnd(length, 'x');
    try { new URL(short); return short; }
    catch { /* This scheme needs more room. Try the next one. */ }
  }
  return example;
}

function boundedHostPlaceholder(example, length) {
  // Host also accepts scoped IPv6 addresses, which do not share the hostname limit.
  if (length > 253) return 'fe80::1%example'.padEnd(length, 'x');
  let host = '';
  while (length > 63) {
    const labelLength = Math.min(63, length - 2);
    host += resizeExample(example, labelLength) + '.';
    length -= labelLength + 1;
  }
  return host + resizeExample(example, length);
}

function boundedStringPlaceholder(type, example, rule, limit) {
  const { minLength, maxLength } = rule;
  for (const bound of [minLength, maxLength]) {
    if (bound !== undefined && (!Number.isInteger(bound) || bound < 0)) return example;
  }
  let min = minLength ?? 0;
  let max = Math.min(maxLength ?? Infinity, limit);
  if (type === 'hex' && rule.length !== undefined) {
    if (!Number.isInteger(rule.length) || rule.length < min || rule.length > max) return example;
    min = max = rule.length;
  }
  // The effective range must fit the budget before any type-specific padding.
  if (min > max) return example;
  if (type === 'url') return boundedUrlPlaceholder(example, min, max, rule.protocols);
  if (example.length >= min && example.length <= max) return example;
  if (type === 'base64') {
    // Padded or not, a base64 value can never be 1 modulo 4 characters long.
    if (min % 4 === 1) min++;
    if (max % 4 === 1) max--;
    if (min > max) return example;
  }
  const length = Math.min(max, Math.max(min, example.length));
  if (length === 0) {
    // An empty assignment is missing, but a quoted space survives parsing and trims to ''.
    return type === 'string' && rule.trim !== false ? "' '" : example;
  }
  // Only built-in ASCII examples are resized. Author-supplied values are left alone.
  switch (type) {
    case 'string': return resizeExample(example, length);
    case 'hex': return resizeExample(example, length, '0');
    case 'base64': return 'A'.repeat(length);
    case 'host': return boundedHostPlaceholder(example, length);
    case 'email': {
      const at = example.indexOf('@');
      const suffix = length > example.length - at ? example.slice(at) : '@x.y';
      return length > suffix.length ? resizeExample(example.slice(0, at), length - suffix.length) + suffix : example;
    }
    case 'ipv4':
      return ['0.0.0.0', '10.0.0.1', '10.0.0.10', '10.0.0.100', example,
        '192.168.0.10', '192.168.0.100', '192.168.10.100', '192.168.100.100'][length - 7] ?? example;
    case 'semver':
      return length < 6 ? example : length === 6 ? `v${example}` : `${example}+`.padEnd(length, 'x');
    case 'file':
      if (length > example.length) return resizeExample('./config', length - 5) + '.json';
      return length > 2 ? `./${resizeExample('config', length - 2)}` : 'config'.slice(0, length);
    default: return example; // UUIDs have a fixed length.
  }
}

/** Placeholder for a scalar (non-array) rule, per its declared type. Every
 * value is a literal that itself validates against the type (issue #251),
 * so a generated .env.example passes `check` out of the box — except `file`,
 * whose './config.json' path the user must create. */
function scalarPlaceholder(rule, stringGrowth) {
  const type = rule.type === undefined ? 'string' : rule.type;
  const placeholder = type === 'port' ? '3000' : type === 'url' ? 'https://example.com'
    : type === 'ipv4' ? '192.168.0.1' : type === 'ipv6' ? '::1' : type === 'semver' ? '1.0.0'
    : type === 'date' ? '2026-01-31' : type === 'duration' ? '15m' : type === 'host' ? 'localhost'
    : type === 'file' ? './config.json'
    : type === 'email' ? 'user@example.com' : type === 'uuid' ? '550e8400-e29b-41d4-a716-446655440000'
    : type === 'number' ? '3.14' : type === 'int' ? '42' : type === 'boolean' ? 'true'
    : type === 'json' ? '{"key":"value"}' : type === 'base64' ? 'aGVsbG8=' : type === 'hex' ? 'deadbeef'
    : 'your_value_here';
  if (STRING_TYPES.has(type) && (rule.minLength !== undefined || rule.maxLength !== undefined)) {
    const limit = Math.min(MAX_STRING_EXAMPLE_LENGTH, placeholder.length + stringGrowth.remaining);
    const bounded = boundedStringPlaceholder(type, placeholder, rule, limit);
    stringGrowth.remaining -= Math.max(0, bounded.length - placeholder.length);
    return bounded;
  }
  // Issue #292: a date placeholder outside its own min/max would fail its
  // own check — use the bound itself when the default example is out of
  // range. An unparseable bound leaves the default example (the schema
  // check rejects it up front anyway).
  if (type === 'date') {
    let example = placeholder;
    try {
      const exampleDate = coerce('placeholder', placeholder, 'date');
      if (typeof rule.min === 'string') {
        if (exampleDate < coerce('placeholder', rule.min, 'date')) example = rule.min;
      }
      if (typeof rule.max === 'string') {
        if (exampleDate > coerce('placeholder', rule.max, 'date')) example = rule.max;
      }
    } catch (_) { /* keep the default example */ }
    return example;
  }
  if (!['number', 'int', 'port', 'duration'].includes(type)) return placeholder;

  const lower = numericBound('placeholder', rule, rule.min);
  const upper = numericBound('placeholder', rule, rule.max);
  let min = Number.isFinite(lower) ? lower : -Infinity;
  let max = Number.isFinite(upper) ? upper : Infinity;
  if (type === 'port' || type === 'duration') min = Math.max(0, min);
  if (type === 'port') max = Math.min(65535, max);
  if (type === 'int' || type === 'port') {
    min = Math.ceil(min);
    max = Math.floor(max);
  }
  // Some bounds leave no value allowed by the type; no placeholder can fix them.
  if (min > max) return placeholder;

  const sample = type === 'duration' ? 15 * 60000 : Number(placeholder);
  const value = Math.min(max, Math.max(min, sample));
  if (value === sample) return placeholder;
  if (value === 0) return '0';
  // int/port and duration reject exponent notation, even for a valid value.
  return value.toLocaleString('en-US', { useGrouping: false, maximumSignificantDigits: 21 });
}

function deprecationNotice(option) {
  if (option === true) return 'deprecated';
  if (typeof option !== 'string') return '';
  const reason = option.trim().replace(/[\r\n]+/g, ' ');
  return reason ? `deprecated: ${reason}` : 'deprecated';
}

/** Generate .env.example text from a schema. Values are placeholders/defaults only — never real secrets. */
function generateExample(schema) {
  // A key that looks like a secret gets an empty placeholder — there is
  // nothing safe to suggest for it. Whole underscore-separated words only:
  // API_KEY and DB_PASSWORD match, but MONKEY does not (it merely contains
  // "KEY"). An explicit default still wins — the schema author chose it.
  const SECRET_WORDS = new Set(['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'PASSWD', 'PRIVATE', 'CREDENTIAL']);
  const lines = ['# Generated by env-saaf — put real values in .env (never commit .env)'];
  // Budget only growth from synthesized string bounds, not supplied values or normal examples.
  const stringGrowth = { remaining: STRING_EXAMPLE_GROWTH_BUDGET };
  // One entry's comment + KEY=value lines. `key` is always the FULL env name.
  const entry = (key, rule) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) rule = {};
    // Issue #206: note aliases and requiredIf in the comment, so the
    // generated file documents the fallbacks and conditions a reader needs.
    let comment = `# type: ${rule.type || 'string'}${rule.required ? ', required' : ''}${rule.choices ? ', one of: ' + rule.choices.join('|') : ''}`;
    // Issue #343: the rule's own text leads the comment a reader sees.
    if (typeof rule.description === 'string' && rule.description.trim() !== '') {
      comment = `# ${rule.description.trim()}; ${comment.slice(2)}`;
    }
    // Issue #223: name the item type on array rules, so the generated file
    // documents what each comma-separated item must look like.
    if (rule.type === 'array') comment += `, items: ${rule.of || 'string'}`;
    if (typeof rule.pattern === 'string' || rule.pattern instanceof RegExp) comment += `, pattern: ${rule.pattern}`;
    if (Array.isArray(rule.aliases) && rule.aliases.length) {
      comment += `; also accepts ${rule.aliases.join(', ')} (deprecated)`;
    }
    if (rule.requiredIf !== undefined && rule.requiredIf !== null && typeof rule.requiredIf === 'object') {
      const cond = rule.requiredIf;
      const fmt = v => typeof v === 'string' ? `'${v}'` : String(v);
      if (cond.equals !== undefined) {
        comment += `; required when ${cond.key} is ${fmt(cond.equals)}`;
      } else if (Array.isArray(cond.in)) {
        comment += `; required when ${cond.key} is one of ${cond.in.map(fmt).join(', ')}`;
      }
    }
    const notice = deprecationNotice(rule.deprecated);
    if (notice) comment += `; ${notice}`;
    const looksSecret = rule.sensitive === true || key.split('_').some(part => SECRET_WORDS.has(part.toUpperCase()));
    const placeholder = rule.default !== undefined
      ? (rule.type === 'array' && Array.isArray(rule.default) ? rule.default.join(rule.separator || ',') : rule.default)
      : looksSecret ? ''
      // Issue #223/#320: build the array placeholder from the `of` item type's
      // own examples, or from the allowed choices when present, so each
      // suggested item validates (fallback: string items). The item count
      // respects minItems/maxItems so the placeholder passes those bounds too
      // — examples cycle when more than three are needed.
      : rule.type === 'array'
        ? arrayPlaceholder(rule)
      : Array.isArray(rule.choices) && rule.choices.length ? rule.choices[0]
      : scalarPlaceholder(rule, stringGrowth);
      return [comment, `${key}=${placeholder}`];
  };
  // The .env file stays flat; each group level documents its complete prefix.
  walkSchema(schema, (key, rule) => lines.push(...entry(key, rule)), (path, prefix) => {
    lines.push(`# group ${path.join('.')} — the keys below are read from env vars prefixed with '${prefix}'`);
  });
  return lines.join('\n') + '\n';
}

function jsonSchemaForScalar(type, protocols) {
  switch (type) {
    case 'int': return { type: 'integer' };
    case 'port': return { type: 'integer', minimum: 0, maximum: 65535 };
    case 'number': return { type: 'number' };
    case 'duration': return { type: 'number', minimum: 0 };
    case 'boolean': return { type: 'boolean' };
    case 'json': return {};
    case 'date': return { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] };
    case 'host': return { type: 'string', anyOf: [{ format: 'hostname' }, { format: 'ipv4' }, { format: 'ipv6' }] };
    case 'email': case 'uuid': case 'ipv4': case 'ipv6': return { type: 'string', format: type };
    case 'hex': return { type: 'string', pattern: '^[0-9a-fA-F]+$' };
    case 'semver': return { type: 'string', pattern: SEMVER_RE.source };
    case 'base64': return { type: 'string', pattern: BASE64_RE.source };
    case 'url': {
      const property = { type: 'string', format: 'uri' };
      if (protocols) {
        // Pattern has no flags. Spell out ASCII case folding and escape scheme punctuation.
        const schemes = protocols.map(protocol => protocol.replace(/:$/, '').toLowerCase()
          .replace(/[+.]/g, '\\$&').replace(/[a-z]/g, ch => `[${ch}${ch.toUpperCase()}]`));
        property.pattern = `^(?:${schemes.join('|')}):`;
      }
      return property;
    }
    default: return { type: 'string' };
  }
}

function isJsonPrimitive(value) {
  return value === null || typeof value === 'boolean' || typeof value === 'string' || Number.isFinite(value);
}

// Copy plain data without invoking user-defined getters or toJSON methods,
// and do not silently turn unsupported values into null or missing keys.
function copyJsonDefault(value, seen = new Set()) {
  if (isJsonPrimitive(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object') throw new TypeError('not JSON data');
  if (seen.has(value)) throw new TypeError('circular JSON data');
  seen.add(value);
  const copyEntry = key => copyJsonDefault(Object.getOwnPropertyDescriptor(value, key)?.value, seen);
  let copy;
  if (Array.isArray(value)) {
    copy = Array.from({ length: value.length }, (_, i) => copyEntry(i));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) throw new TypeError('not JSON data');
    copy = Object.fromEntries(Object.keys(value).map(key => [key, copyEntry(key)]));
  }
  seen.delete(value);
  return copy;
}

function jsonSchemaDefault(key, rule, type) {
  const trim = rule.trim !== false;
  const convert = (raw, valueType) => {
    if (valueType === 'json') return copyJsonDefault(coerce(key, raw, valueType, trim));
    if (valueType === 'date' && raw instanceof Date) return Date.prototype.toISOString.call(raw);
    if (!isJsonPrimitive(raw)) throw new TypeError('not a primitive default');
    if (valueType === 'date' && typeof raw === 'string' && raw.includes('T')
      && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(trim ? raw.trim() : raw)) {
      // A date-time with no offset is local time; don't consult the host timezone.
      return undefined;
    }
    // A file default can document the path without checking the filesystem.
    const value = coerce(key, raw, valueType === 'file' ? 'string' : valueType, trim, rule.protocols);
    return valueType === 'date' ? value.toISOString() : value === 0 ? 0 : value;
  };
  try {
    if (type !== 'array') return convert(rule.default, type);
    const raw = rule.default;
    const parts = typeof raw === 'string' ? raw.split(rule.separator ?? ',') : raw;
    if (!Array.isArray(parts)) return undefined;
    return Array.from({ length: parts.length }, (_, i) => {
      const part = Object.getOwnPropertyDescriptor(parts, i)?.value;
      if (part === undefined || part === null || (trim && typeof part === 'string' ? part.trim() : part) === '') {
        throw new TypeError('empty array item');
      }
      const value = convert(part, rule.of ?? 'string');
      if (value === undefined) throw new TypeError('unsupported array item');
      return value;
    });
  } catch {
    return undefined;
  }
}

/** Describe coerced values as JSON Schema, without reading the environment. */
// Convert one rule to its JSON Schema property, pushing `key` onto `required`
// when the rule demands it. A group rule nests its inner rules as one object
// schema instead of falling through to a plain string (issue #262).
function jsonSchemaForRule(key, rule, required) {
  if (groupShape(rule)) {
    const nestedRequired = [];
    const properties = Object.fromEntries(Object.entries(rule.schema).map(([innerKey, innerRule]) =>
      [innerKey, jsonSchemaForRule(innerKey, innerRule, nestedRequired)]));
    const property = { type: 'object', properties };
    if (nestedRequired.length) property.required = nestedRequired;
    return property;
  }
  const type = rule.type ?? 'string';
  let property;
  if (type === 'array') {
    const itemType = rule.of ?? 'string';
    const items = jsonSchemaForScalar(itemType, rule.protocols);
    if (itemType === 'string') items.minLength = 1;
    property = { type: 'array', items };
    if (rule.minItems !== undefined) property.minItems = rule.minItems;
    if (rule.maxItems !== undefined) property.maxItems = rule.maxItems;
    if (rule.unique === true) property.uniqueItems = true;
  } else {
    property = jsonSchemaForScalar(type, rule.protocols);
  }
  // JSON Schema numerical bounds also apply to numbers in an otherwise unconstrained `json` rule.
  if (type === 'json' || property.type === 'number' || property.type === 'integer') {
    if (rule.min !== undefined) property.minimum = Math.max(numericBound('schema', rule, rule.min), property.minimum ?? -Infinity);
    if (rule.max !== undefined) property.maximum = Math.min(numericBound('schema', rule, rule.max), property.maximum ?? Infinity);
  }
  if (rule.minLength !== undefined) property.minLength = rule.minLength;
  if (rule.maxLength !== undefined) property.maxLength = rule.maxLength;
  if (type === 'hex' && rule.length !== undefined) {
    property.minLength = Math.max(rule.length, property.minLength ?? 0);
    property.maxLength = Math.min(rule.length, property.maxLength ?? Infinity);
  }
  if (typeof rule.description === 'string' && rule.description.trim() !== '') {
    property.description = rule.description.trim();
  }
  const pattern = rule.pattern;
  if (typeof pattern === 'string' || (pattern && !pattern.flags)) {
    if (property.pattern) property.allOf = [{ pattern: property.pattern }];
    property.pattern = typeof pattern === 'string' ? pattern : pattern.source;
  }
  if (Array.isArray(rule.choices)) {
    const choices = [...new Set(rule.choices.filter(isJsonPrimitive))];
    if (choices.length) {
      // Issue #320: on an array rule the enum constrains each item. A
      // top-level enum would mean the whole array must equal a single choice.
      if (type === 'array') property.items.enum = choices;
      else property.enum = choices;
    }
  }
  if (rule.default !== undefined) {
    const value = jsonSchemaDefault(key, rule, type);
    if (value !== undefined) property.default = value;
  }
  if (rule.sensitive === true) property.writeOnly = true;
  if (rule.required) required.push(key);
  return property;
}

function jsonSchemaRequiredPath(key, groupOf, match) {
  const path = groupOf.get(key) || [key];
  let constraint = { required: [path[path.length - 1]] };
  if (match) constraint.properties = { [path[path.length - 1]]: match };
  for (let i = path.length - 2; i >= 0; i--) {
    constraint = {
      required: [path[i]],
      properties: { [path[i]]: { type: 'object', ...constraint } },
    };
  }
  return constraint;
}

function isArrayIncludes(method) {
  const includes = Array.prototype.includes;
  if (method === includes) return true;
  if (typeof method !== 'function'
    || Function.prototype.toString.call(method) !== Function.prototype.toString.call(includes)) return false;
  // A different realm has its own native function. Other built-ins called
  // includes (String, TypedArray) do not compare a symbol on an array-like object.
  try {
    const entry = Symbol();
    return Reflect.apply(method, { 0: entry, length: 1 }, [entry]) === true;
  } catch {
    return false;
  }
}

function jsonSchemaMembershipValues(list) {
  // A proxy can change membership lookups without changing its descriptors.
  for (let owner = list; owner !== null; owner = Object.getPrototypeOf(owner)) {
    if (isProxy(owner)) return;
  }
  const descriptor = key => {
    for (let owner = list; owner !== null; owner = Object.getPrototypeOf(owner)) {
      const property = Object.getOwnPropertyDescriptor(owner, key);
      if (property) return property;
    }
  };
  // Array#includes visits indices, not the iterator. Don't infer results
  // from overridden membership or execute accessors during schema export.
  if (!isArrayIncludes(descriptor('includes')?.value)) return;
  const values = [];
  for (let i = 0; i < list.length; i++) {
    const entry = descriptor(i);
    if (!entry) continue;
    if (!Object.prototype.hasOwnProperty.call(entry, 'value')) return;
    values.push(entry.value);
  }
  return values;
}

function jsonSchemaRequiredIfMatch(source, condition) {
  const type = source.type ?? 'string';
  if (source.validate !== undefined || source.transform !== undefined || type === 'date' || type === 'array') return;
  const membership = Object.prototype.hasOwnProperty.call(condition, 'in') && condition.in !== undefined;
  const candidates = membership ? jsonSchemaMembershipValues(condition.in) : [condition.equals];
  if (!candidates) return;
  // JSON Schema compares structures; runtime object comparisons use identity.
  if (type === 'json' && candidates.some(value => value !== null && typeof value === 'object')) return;
  // Non-JSON primitives cannot match canonical values. Keep other list entries
  // as typed literals, not env spellings such as 'false' or '01'.
  const valueType = STRING_TYPES.has(type) ? 'string' : type === 'boolean' ? 'boolean' : 'number';
  const values = [...new Set(candidates.filter(value => isJsonPrimitive(value)
    && (type === 'json' || typeof value === valueType)))];
  if (values.length) return membership ? { enum: values } : { const: values[0] };
}

function addJsonSchemaRequiredIf(schema, result) {
  const { flat, groupOf } = flattenSchema(schema);
  const clauses = [];
  let grouped = false;
  for (const [key, rule] of Object.entries(flat)) {
    const condition = rule.requiredIf;
    // Runtime consults requiredIf only for a missing key with no default.
    if (!condition || rule.default !== undefined || !Object.prototype.hasOwnProperty.call(flat, condition.key)) continue;
    const match = jsonSchemaRequiredIfMatch(flat[condition.key], condition);
    if (!match) continue;
    // `properties` alone matches absent values. Require every step of the
    // source path, as well as the full target path when the condition matches.
    clauses.push({
      if: jsonSchemaRequiredPath(condition.key, groupOf, match),
      then: jsonSchemaRequiredPath(key, groupOf),
    });
    grouped = grouped || groupOf.has(key) || groupOf.has(condition.key);
  }
  if (clauses.length === 1 && !grouped) Object.assign(result, clauses[0]);
  else if (clauses.length) result.allOf = clauses;
}

function toJsonSchema(schema) {
  validateSchema(schema);
  const required = [];
  const properties = Object.fromEntries(Object.entries(schema).map(([key, rule]) =>
    [key, jsonSchemaForRule(key, rule, required)]));
  const result = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties };
  if (required.length) result.required = required;
  addJsonSchemaRequiredIf(schema, result);
  return result;
}

module.exports = { validateEnv, validateSchema, loadEnv, loadEnvAsync, EnvSaafError, parseEnvFile, scanCode, scanCodeLocations, scanDir, scanDirLocations, diffEnv, maskValue, maskSecrets, generateExample, toJsonSchema };
