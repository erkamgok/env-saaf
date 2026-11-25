'use strict';
const assert = require('node:assert');
const { loadEnv, validateEnv, validateSchema, EnvSaafError, parseEnvFile, scanCode, scanCodeLocations, scanDir, scanDirLocations, diffEnv, maskSecrets, maskValue, generateExample, toJsonSchema } = require('./index');

// Issue #344: deprecating a variable warns about supplied values, never defaults.
{
  const schema = {
    OLD_PORT: { type: 'port', default: 80, deprecated: true, aliases: ['OLDER_PORT'] },
    LEGACY: { description: 'Legacy setting', deprecated: 'Use MODE instead' },
    CURRENT: { deprecated: false },
  };
  const warnings = [];
  const options = { onWarn: message => warnings.push(message) };
  const env = validateEnv(schema, { OLD_PORT: '8080', LEGACY: 'yes', CURRENT: 'ok' }, options);
  assert.strictEqual(env.OLD_PORT, 8080);
  assert.deepStrictEqual(warnings.splice(0), [
    'env-saaf: OLD_PORT is deprecated', 'env-saaf: LEGACY is deprecated: Use MODE instead',
  ]);
  for (const source of [{}, { OLD_PORT: '' }, { OLD_PORT: null }]) {
    assert.strictEqual(validateEnv(schema, source, options).OLD_PORT, 80);
  }
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(validateEnv(schema, { OLDER_PORT: '90' }, options).OLD_PORT, 90);
  assert.deepStrictEqual(warnings.splice(0), ['env-saaf: OLDER_PORT is deprecated; use OLD_PORT instead']);
  assert.throws(() => validateEnv(schema, { OLD_PORT: 'bad' }, options), EnvSaafError);
  assert.deepStrictEqual(warnings, ['env-saaf: OLD_PORT is deprecated']);
  for (const bad of [1, null, [], {}]) {
    assert.throws(() => validateSchema({ A: { deprecated: bad } }), /"deprecated" must be a boolean or a string/);
  }
  const example = generateExample(schema);
  assert.match(example, /; deprecated\nOLD_PORT=/);
  assert.match(example, /# Legacy setting; type: string; deprecated: Use MODE instead\nLEGACY=/);
  assert.match(example, /# type: string\nCURRENT=/);
}

// Issue #322: duration bounds use the value parser without changing numeric bounds.
{
  const rule = Object.freeze({ type: 'duration', min: '30s', max: '1h30m' });
  const schema = Object.freeze({ TIMEOUT: rule });
  assert.doesNotThrow(() => validateSchema(schema));
  for (const [raw, expected] of [['30s', 30000], ['1h30m', 5400000], ['1m', 60000]]) {
    assert.strictEqual(validateEnv(schema, { TIMEOUT: raw }).TIMEOUT, expected);
  }
  assert.throws(() => validateEnv(schema, { TIMEOUT: '29s' }), /30s/);
  assert.throws(() => validateEnv(schema, { TIMEOUT: '2h' }), /1h30m/);
  assert.throws(() => validateEnv({ T: { type: 'duration', min: '500ms' } }, { T: '499ms' }), /at least 500ms/);
  assert.strictEqual(validateEnv({ T: { type: 'duration', max: '500ms' } }, { T: '500ms' }).T, 500);
  assert.strictEqual(validateEnv({ T: { type: 'duration', min: 30000, max: '1m' } }, { T: '30s' }).T, 30000);
  assert.strictEqual(validateEnv({ T: { type: 'duration', min: '30s', max: 60000 } }, { T: '1m' }).T, 60000);
  for (const bound of ['soon', '', '1h30', '1h2h', '-1s', '1e3', true, null, {}, [], Infinity, NaN]) {
    for (const opt of ['min', 'max']) {
      assert.throws(() => validateSchema({ T: { type: 'duration', [opt]: bound } }), EnvSaafError);
    }
  }
  for (const [min, max] of [['2m', '30s'], ['2m', 30000], [120000, '30s']]) {
    assert.throws(() => validateSchema({ T: { type: 'duration', min, max } }), /must not exceed/);
  }
  assert.strictEqual(validateEnv({ T: { type: 'duration', min: '500ms', max: 500 } }, { T: '500ms' }).T, 500);
  assert.throws(() => validateEnv({ T: { type: 'duration', min: 'soon' } }, {}, { throwOnError: false }), /Invalid schema/);
  assert.throws(() => validateEnv({ T: { type: 'duration', min: '30s', default: '1s' } }, {}), /at least 30s/);
  assert.strictEqual(validateEnv({ T: { type: 'duration', min: -1, max: 500 } }, { T: '500' }).T, 500);
  assert.throws(() => validateEnv({ T: { type: 'duration', min: 1000 } }, { T: '500' }), /at least 1000/);
  assert.throws(() => validateSchema({ T: { type: 'number', min: '30s' } }), /must be a number/);
  const grouped = { API: { prefix: 'API_', schema: { TIMEOUT: rule } } };
  assert.strictEqual(validateEnv(grouped, { API_TIMEOUT: '30s' }).API.TIMEOUT, 30000);
  const errors = validateEnv(schema, { TIMEOUT: '1s' }, { throwOnError: false }).errors;
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /30s/);
  for (const bounds of [{ min: '1h' }, { max: '500ms' }, { min: '1h', max: '2h' }]) {
    const s = { TIMEOUT: { type: 'duration', ...bounds } };
    assert.doesNotThrow(() => validateEnv(s, parseEnvFile(generateExample(s))));
    const property = toJsonSchema(s).properties.TIMEOUT;
    if (bounds.min) assert.strictEqual(property.minimum, bounds.min === '1h' ? 3600000 : 0);
    if (bounds.max) assert.strictEqual(property.maximum, bounds.max === '2h' ? 7200000 : 500);
    assert.ok(!JSON.stringify(property).includes('null'));
  }
  assert.deepStrictEqual(toJsonSchema(grouped).properties.API.properties.TIMEOUT,
    { type: 'number', minimum: 30000, maximum: 5400000 });
  assert.deepStrictEqual(rule, { type: 'duration', min: '30s', max: '1h30m' });
}

// Issue #341: duration bounds name their units; other numeric messages stay the same.
{
  for (const type of ['number', 'int', 'port']) {
    for (const [bounds, raw, range] of [
      [{ min: 1000, max: 2000 }, '500', '1000–2000'],
      [{ min: 1000, max: 2000 }, '2500', '1000–2000'],
      [{ min: 1000 }, '500', 'at least 1000'],
      [{ max: 2000 }, '2500', 'at most 2000'],
    ]) {
      const result = validateEnv({ N: { type, ...bounds } }, { N: raw }, { throwOnError: false });
      assert.deepStrictEqual(result.errors, [`N: expected a number ${range}, got "${raw}"`]);
    }
  }
  for (const [bounds, raw, range] of [
    [{ min: 1000, max: 2000 }, '500ms', '1000ms–2000ms'],
    [{ min: 1000, max: 2000 }, '2500ms', '1000ms–2000ms'],
    [{ min: 1000 }, '500ms', 'at least 1000ms'],
    [{ max: 2000 }, '2500ms', 'at most 2000ms'],
    [{ min: '1s', max: '2s' }, '500ms', '1s–2s'],
    [{ min: '1s', max: '2s' }, '2500ms', '1s–2s'],
    [{ min: '1s' }, '500ms', 'at least 1s'],
    [{ max: '2s' }, '2500ms', 'at most 2s'],
    [{ min: 1000, max: '2s' }, '500ms', '1000ms–2s'],
    [{ min: '1s', max: 2000 }, '2500ms', '1s–2000ms'],
    [{ min: ' 1000 ', max: '2000' }, '500ms', '1000ms–2000ms'],
  ]) {
    const schema = { TIMEOUT: { type: 'duration', ...bounds } };
    const expected = `TIMEOUT: expected a duration ${range}, got "${raw}"`;
    const result = validateEnv(schema, { TIMEOUT: raw }, { throwOnError: false });
    assert.deepStrictEqual(result.errors, [expected]);
    assert.throws(() => validateEnv(schema, { TIMEOUT: raw }),
      err => err instanceof EnvSaafError && err.errors[0] === expected);
  }
}

// Issue #296: a hand-rolled structural check for the draft 2020-12 keywords
// env-saaf emits. Keeping the keyword map local means the whole exported
// document is checked without adding a schema-validator dependency.
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const JSON_SCHEMA_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  const next = new Set(seen);
  next.add(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, next));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value).every(([, item]) => isJsonValue(item, next));
}

function assertDraft202012Schema(schema, path = '#', root = true) {
  assert.ok(schema && typeof schema === 'object' && !Array.isArray(schema), `${path}: expected a schema object`);
  for (const [keyword, value] of Object.entries(schema)) {
    const at = `${path}.${keyword}`;
    switch (keyword) {
      case '$schema':
        assert.ok(root, `${at}: $schema is only allowed at the document root`);
        assert.strictEqual(value, DRAFT_2020_12, `${at}: expected the draft 2020-12 dialect`);
        break;
      case 'type': {
        const types = Array.isArray(value) ? value : [value];
        assert.ok(types.length > 0, `${at}: expected at least one type`);
        for (const type of types) assert.ok(JSON_SCHEMA_TYPES.has(type), `${at}: unknown JSON Schema type ${JSON.stringify(type)}`);
        break;
      }
      case 'properties':
        assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${at}: expected an object`);
        for (const [key, child] of Object.entries(value)) {
          assertDraft202012Schema(child, `${path}.properties[${JSON.stringify(key)}]`, false);
        }
        break;
      case 'required':
        assert.ok(Array.isArray(value) && value.length > 0, `${at}: expected a non-empty array`);
        assert.ok(value.every(key => typeof key === 'string'), `${at}: expected an array of strings`);
        assert.strictEqual(new Set(value).size, value.length, `${at}: duplicate entries`);
        break;
      case 'items':
        assertDraft202012Schema(value, `${path}.items`, false);
        break;
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${at}: expected a non-empty array`);
        assert.ok(value.every(item => isJsonValue(item)), `${at}: expected JSON values`);
        break;
      case 'const':
      case 'default':
        assert.ok(isJsonValue(value), `${at}: expected a JSON value`);
        break;
      case 'minimum':
      case 'maximum':
        assert.ok(typeof value === 'number' && Number.isFinite(value), `${at}: expected a finite number`);
        break;
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
        assert.ok(Number.isInteger(value) && value >= 0, `${at}: expected a non-negative integer`);
        break;
      case 'uniqueItems':
      case 'writeOnly':
        assert.strictEqual(typeof value, 'boolean', `${at}: expected a boolean`);
        break;
      case 'pattern':
      case 'format':
        assert.strictEqual(typeof value, 'string', `${at}: expected a string`);
        break;
      case 'allOf':
      case 'anyOf':
        assert.ok(Array.isArray(value) && value.length > 0, `${at}: expected a non-empty array`);
        value.forEach((child, i) => assertDraft202012Schema(child, `${at}[${i}]`, false));
        break;
      case 'if':
      case 'then':
      case 'else':
        assertDraft202012Schema(value, at, false);
        break;
      default:
        assert.fail(`${at}: unknown keyword ${JSON.stringify(keyword)}`);
    }
  }
  if (root) {
    assert.strictEqual(schema.$schema, DRAFT_2020_12, `${path}: missing $schema`);
    assert.strictEqual(schema.type, 'object', `${path}: root must be an object schema`);
  }
}

// Issue #229: JSON Schema export
{
  const draft = 'https://json-schema.org/draft/2020-12/schema';
  assert.deepStrictEqual(toJsonSchema({ PORT: { type: 'port', required: true } }), {
    $schema: draft,
    type: 'object',
    properties: { PORT: { type: 'integer', minimum: 0, maximum: 65535 } },
    required: ['PORT'],
  });
  assert.deepStrictEqual(toJsonSchema({}), { $schema: draft, type: 'object', properties: {} });

  const base64Pattern = toJsonSchema({ B: { type: 'base64' } }).properties.B.pattern;
  assert.strictEqual(typeof base64Pattern, 'string', 'base64 needs a JSON Schema pattern (issue #351)');
  const types = {
    string: { type: 'string' },
    number: { type: 'number' },
    int: { type: 'integer' },
    boolean: { type: 'boolean' },
    url: { type: 'string', format: 'uri' },
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    email: { type: 'string', format: 'email' },
    json: {},
    uuid: { type: 'string', format: 'uuid' },
    hex: { type: 'string', pattern: '^[0-9a-fA-F]+$' },
    ipv4: { type: 'string', format: 'ipv4' },
    semver: {
      type: 'string',
      pattern: '^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$',
    },
    base64: { type: 'string', pattern: base64Pattern },
    date: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
    file: { type: 'string' },
    duration: { type: 'number', minimum: 0 },
    host: { type: 'string', anyOf: [{ format: 'hostname' }, { format: 'ipv4' }, { format: 'ipv6' }] },
    array: { type: 'array', items: { type: 'string', minLength: 1 } },
  };
  const rules = Object.fromEntries(Object.keys(types).map(type => [type, { type }]));
  assert.deepStrictEqual(toJsonSchema(rules).properties, types);

  // Issue #351: the schema pattern and the runtime validator must agree.
  // An empty value is treated as missing, so it is not in this corpus.
  {
    const pattern = new RegExp(base64Pattern);
    const samples = [
      'aGVsbG8=', 'aGVsbG8', 'aGVsbG8h', 'AA==', 'AAA=', 'AAAA', 'ab', 'abc', 'abcd',
      'a-b_', 'a-b=', '__==', '--', 'A+/=', 'AB+/', 'AAAAXX==', 'AAAABBB=',
      'a', 'abcde', 'AAAA==', 'A+B_', 'a b', 'AAAAA', 'A===', 'aGVsbG8===', 'a-b_=', '=AAA', 'AA=A',
    ];
    for (const value of samples) {
      let runtimeOk = true;
      try {
        validateEnv({ B: { type: 'base64' } }, { B: value });
      } catch {
        runtimeOk = false;
      }
      assert.strictEqual(pattern.test(value), runtimeOk,
        `JSON Schema pattern and runtime disagree on ${JSON.stringify(value)}`);
    }
  }

  const options = toJsonSchema({
    MODE: { required: true, minLength: 0, maxLength: 6, pattern: /^\w+$/, choices: ['local', 'test', 'local'] },
    RETRIES: { type: 'int', min: 0, max: 5, choices: [0, 2], default: '0' },
    RATIO: { type: 'number', min: -0.5, max: 0 },
    FEATURE: { type: 'boolean', choices: [false, true], default: 'no' },
    PAYLOAD: { type: 'json', max: 0, choices: ['text', false, 0, null] },
    PORT: { type: 'port', min: 1000, max: 99999 },
    NARROW_PORT: { type: 'port', min: -1, max: 1024 },
    TIMEOUT: { type: 'duration', min: -1, max: 100000, default: '1m30s' },
    HEX: { type: 'hex', length: 4, minLength: 2, maxLength: 6, pattern: /^fe/ },
    PORTS: { type: 'array', of: 'port', minItems: 0, maxItems: 2, separator: ';', default: '0;443' },
    EMPTY: { type: 'array', maxItems: 0, default: [] },
    RAW: { trim: false, default: ' text ', max: 1, length: 1 },
  });
  assert.deepStrictEqual(options.required, ['MODE']);
  assert.deepStrictEqual(options.properties, {
    MODE: { type: 'string', minLength: 0, maxLength: 6, pattern: '^\\w+$', enum: ['local', 'test'] },
    RETRIES: { type: 'integer', minimum: 0, maximum: 5, enum: [0, 2], default: 0 },
    RATIO: { type: 'number', minimum: -0.5, maximum: 0 },
    FEATURE: { type: 'boolean', enum: [false, true], default: false },
    PAYLOAD: { maximum: 0, enum: ['text', false, 0, null] },
    PORT: { type: 'integer', minimum: 1000, maximum: 65535 },
    NARROW_PORT: { type: 'integer', minimum: 0, maximum: 1024 },
    TIMEOUT: { type: 'number', minimum: 0, maximum: 100000, default: 90000 },
    HEX: { type: 'string', minLength: 4, maxLength: 4, pattern: '^fe', allOf: [{ pattern: '^[0-9a-fA-F]+$' }] },
    PORTS: { type: 'array', minItems: 0, maxItems: 2, default: [0, 443], items: { type: 'integer', minimum: 0, maximum: 65535 } },
    EMPTY: { type: 'array', maxItems: 0, default: [], items: { type: 'string', minLength: 1 } },
    RAW: { type: 'string', default: ' text ' },
  });

  const urls = toJsonSchema({
    URL: { type: 'url', protocols: ['HTTPS:', 'git+ssh', 'tool.v1-4'], pattern: /example\.org/ },
    MIRRORS: { type: 'array', of: 'url', protocols: ['https'] },
  }).properties;
  assert.strictEqual(urls.URL.pattern, 'example\\.org');
  const schemes = new RegExp(urls.URL.allOf[0].pattern, 'u');
  for (const url of ['https://x', 'HTTPS://x', 'git+SSH://x', 'tool.V1-4:x']) assert.match(url, schemes);
  for (const url of ['http://x', 'gitXssh://x', 'toolXv1-4:x', 'prefix-https://x']) assert.doesNotMatch(url, schemes);
  assert.strictEqual(urls.MIRRORS.items.format, 'uri');
  const itemScheme = new RegExp(urls.MIRRORS.items.pattern, 'u');
  assert.match('https://x', itemScheme);
  assert.doesNotMatch('http://x', itemScheme);

  const data = Object.freeze({ ['__proto__']: Object.freeze({ enabled: true }), count: 0 });
  let calls = 0;
  const callback = () => { calls++; throw new Error('must not run'); };
  const flagged = /ok/gi;
  flagged.lastIndex = 2;
  const source = Object.freeze({
    ['__proto__']: Object.freeze({ type: 'json', default: data }),
    constructor: { type: 'date', default: '2026-01-31' },
    toString: { type: 'date', default: new Date('2026-02-01T02:00:00+02:00') },
    toJSON: { type: 'json', default: '[false, null, 0]' },
    'slash/~': { type: 'file', default: './not-a-real-file.example' },
    valueOf: { type: 'string', required: true },
    'hash/#': { type: 'file', required: true },
    '': { default: '', required: false },
    FLAGS: { pattern: flagged, validate: callback, transform: callback, aliases: ['OLD'], requiredIf: { key: 'SWITCH', equals: 'enabled' } },
  });
  const result = toJsonSchema(source);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepStrictEqual(Object.keys(result.properties), Object.keys(source));
  assert.deepStrictEqual(result.required, ['valueOf', 'hash/#']);
  assert.deepStrictEqual(result.properties.__proto__.default, data);
  assert.notStrictEqual(result.properties.__proto__.default, data);
  assert.notStrictEqual(result.properties.__proto__.default.__proto__, data.__proto__);
  assert.strictEqual(result.properties.__proto__.default.__proto__.enabled, true);
  assert.strictEqual(result.properties.constructor.default, '2026-01-31T00:00:00.000Z');
  assert.strictEqual(result.properties.toString.default, '2026-02-01T00:00:00.000Z');
  assert.deepStrictEqual(result.properties.toJSON.default, [false, null, 0]);
  assert.strictEqual(result.properties['slash/~'].default, './not-a-real-file.example');
  assert.strictEqual(result.properties[''].default, '');
  assert.deepStrictEqual(result.properties.FLAGS, { type: 'string' });
  assert.strictEqual(calls, 0);
  assert.strictEqual(flagged.lastIndex, 2);

  const circular = {};
  circular.self = circular;
  const unrepresentable = toJsonSchema({
    BAD_JSON: { type: 'json', default: '{' },
    CIRCULAR: { type: 'json', default: circular },
    NON_FINITE: { type: 'json', default: { count: Infinity } },
    UNDEFINED: { type: 'json', default: [undefined] },
    CUSTOM: { type: 'json', default: { toJSON: callback } },
    CLASS_INSTANCE: { type: 'json', default: new RegExp('not JSON data') },
    GETTER: { type: 'json', default: Object.defineProperty({}, 'value', { get: callback, enumerable: true }) },
    INVALID_DATE: { type: 'date', default: new Date(NaN) },
    LOCAL_TIME: { type: 'date', default: '2026-01-31T10:00' },
    BAD_NUMBER: { type: 'number', default: '0x10' },
    BAD_ITEMS: { type: 'array', of: 'file', default: ['example.txt', ''] },
    NULL_ITEM: { type: 'array', of: 'int', default: [null] },
    SPARSE: { type: 'array', default: Array(1) },
  });
  for (const property of Object.values(unrepresentable.properties)) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(property, 'default'), false);
  }
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(toJsonSchema({
    FILES: { type: 'array', of: 'file', default: ['./example.txt'] },
    DATES: { type: 'array', of: 'date', default: ['2026-01-31T10:00Z'] },
    CONFIG: { type: 'json', default: null },
    DICTIONARY: { type: 'json', default: Object.assign(Object.create(null), { enabled: false }) },
    MIXED: { type: 'array', of: 'int', default: [0, '2'] },
    SPACES: { type: 'array', trim: false, default: ' x , ' },
    COUNT: { type: 'int', choices: [2, Infinity, 0, NaN] },
    UNSUPPORTED: { type: 'json', choices: [Infinity] },
  }).properties, {
    FILES: { type: 'array', items: { type: 'string' }, default: ['./example.txt'] },
    DATES: { type: 'array', items: types.date, default: ['2026-01-31T10:00:00.000Z'] },
    CONFIG: { default: null },
    DICTIONARY: { default: { enabled: false } },
    MIXED: { type: 'array', items: { type: 'integer' }, default: [0, 2] },
    SPACES: { type: 'array', items: { type: 'string', minLength: 1 }, default: [' x ', ' '] },
    COUNT: { type: 'integer', enum: [2, 0] },
    UNSUPPORTED: {},
  });
  assert.throws(() => toJsonSchema({ BROKEN: { type: 'port', min: NaN } }), EnvSaafError);

  // Issue #262: grouped schemas nest as object schemas instead of collapsing to `string`.
  assert.deepStrictEqual(toJsonSchema({
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },
    NAME: { type: 'string' },
  }), {
    $schema: draft,
    type: 'object',
    properties: {
      DB: {
        type: 'object',
        properties: {
          HOST: types.host,
          PORT: { type: 'integer', minimum: 0, maximum: 65535, default: 5432 },
        },
        required: ['HOST'],
      },
      NAME: { type: 'string' },
    },
  });
  // A group with no required inner rules has no nested `required`, and the
  // group key itself never lands in the top-level `required` list.
  assert.deepStrictEqual(toJsonSchema({
    CACHE: { prefix: 'CACHE_', schema: { TTL: { type: 'duration', min: 0, max: 60, choices: [5, 30] } } },
  }), {
    $schema: draft,
    type: 'object',
    properties: {
      CACHE: {
        type: 'object',
        properties: { TTL: { type: 'number', minimum: 0, maximum: 60, enum: [5, 30] } },
      },
    },
  });
  // Flat schemas are unchanged by the group handling above.
  assert.deepStrictEqual(toJsonSchema({ PORT: { type: 'port', required: true }, NAME: { type: 'string' } }), {
    $schema: draft,
    type: 'object',
    properties: { PORT: { type: 'integer', minimum: 0, maximum: 65535 }, NAME: { type: 'string' } },
    required: ['PORT'],
  });

  // Issue #296: check the complete exported documents, not just keyword mappings.
  {
    const comprehensive = {
      NAME: { type: 'string', required: true, minLength: 1 },
      MODE: { type: 'string', choices: ['dev', 'prod'], default: 'dev', minLength: 2, maxLength: 8, pattern: /^[a-z]+$/ },
      RETRIES: { type: 'int', min: 0, max: 5, choices: [0, 2], default: '0' },
      RATIO: { type: 'number', min: -0.5, max: 0, default: '-0.25' },
      DEBUG: { type: 'boolean', default: 'no' },
      PAYLOAD: { type: 'json', default: '{"ok":true}' },
      WHEN: { type: 'date', default: '2026-01-31' },
      URL: { type: 'url', protocols: ['https'] },
      TAGS: { type: 'array', of: 'string', choices: ['a', 'b'], minItems: 1, maxItems: 3, unique: true, default: ['a'] },
      PORTS: { type: 'array', of: 'port', minItems: 0, maxItems: 2, default: '0;443' },
      SECRET: { type: 'string', sensitive: true },
      HEX: { type: 'hex', length: 4 },
      DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },
      TOKEN: { type: 'string', requiredIf: { key: 'MODE', equals: 'prod' } },
    };
    for (const document of [toJsonSchema(rules), options, result, toJsonSchema(comprehensive)]) {
      assertDraft202012Schema(document);
    }

    // Prove the checker rejects malformed output rather than rubber-stamping it.
    const broken = toJsonSchema({ PORT: { type: 'port', required: true } });
    broken.properties.PORT.minimum = 'x';
    assert.throws(() => assertDraft202012Schema(broken), /minimum: expected a finite number/);
    const typo = toJsonSchema({ PORT: { type: 'port' } });
    typo.properties.PORT.minumum = 0;
    assert.throws(() => assertDraft202012Schema(typo), /unknown keyword "minumum"/);
    const badRequired = toJsonSchema({ PORT: { type: 'port', required: true } });
    badRequired.required = 'PORT';
    assert.throws(() => assertDraft202012Schema(badRequired), /#\.required: expected a non-empty array/);
    const missingDraft = toJsonSchema({ PORT: { type: 'port' } });
    delete missingDraft.$schema;
    assert.throws(() => assertDraft202012Schema(missingDraft), /missing \$schema/);
  }
}

// v0.1.0 core
const env = validateEnv({
  PORT: { type: 'port', required: true },
  DEBUG: { type: 'boolean', default: false },
  API_URL: { type: 'url', required: true },
}, { PORT: '3000', DEBUG: 'false', API_URL: 'https://example.com' });
assert.strictEqual(env.PORT + 1, 3001);
assert.strictEqual(env.DEBUG, false);
assert.throws(() => validateEnv({ A: { required: true } }, {}), EnvSaafError);

// Issue #57: a file rule validates readability and preserves the path string.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(__dirname, 'file-type-test-'));
  const schema = { CONFIG_FILE: { type: 'file', required: true } };
  const file = path.join(dir, 'my config.json');
  function assertInvalid(input) {
    assert.throws(
      () => validateEnv(schema, { CONFIG_FILE: input }),
      err => err instanceof EnvSaafError && err.errors[0].includes('expected a readable file')
        && err.errors[0].includes(input),
    );
  }
  try {
    fs.writeFileSync(file, '{}');
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: file }).CONFIG_FILE, file);
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: ` ${file} ` }).CONFIG_FILE, file);
    const relative = path.relative(process.cwd(), file);
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: relative }).CONFIG_FILE, relative);
    const defaults = { CONFIG_FILE: { type: 'file', default: file } };
    assert.strictEqual(validateEnv(defaults, {}).CONFIG_FILE, file);
    assertInvalid(path.join(dir, 'missing.json'));
    assertInvalid(dir);
    assert.match(generateExample(schema), /^CONFIG_FILE=\.\/config\.json$/m);
    if (process.platform !== 'win32' && process.getuid() !== 0) {
      fs.chmodSync(file, 0o000);
      assertInvalid(file);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Port zero requests an ephemeral listener. Blank values still fail validation.
{
  const schema = { PORT: { type: 'port', required: true } };
  assert.strictEqual(validateEnv(schema, { PORT: '0' }).PORT, 0);
  assert.strictEqual(validateEnv(schema, { PORT: '65535' }).PORT, 65535);
  for (const raw of ['-1', '65536', '3.5', 'abc', ' \t ', false]) {
    assert.throws(() => validateEnv(schema, { PORT: raw }), /expected a port \(0-65535, e\.g\. 3000\)/);
  }
  // Issue #276: `null` counts as "not set", not as the string "null".
  assert.throws(() => validateEnv(schema, { PORT: null }), /missing required variable/);
  const untrimmed = { PORT: { ...schema.PORT, trim: false } };
  assert.throws(() => validateEnv(untrimmed, { PORT: ' \t ' }), /expected a port \(0-65535, e\.g\. 3000\)/);
  assert.throws(() => validateEnv(schema, { PORT: '' }), /missing required variable/);
}

// v0.2.0
assert.deepStrictEqual(parseEnvFile('PORT=3000\nNAME="my app"\n'), { PORT: '3000', NAME: 'my app' });
assert.deepStrictEqual(scanCode('process.env.API_URL; const { PORT } = process.env;'), ['API_URL', 'PORT']);
assert.deepStrictEqual(diffEnv(['A', 'B'], ['A', 'C']), { usedNotDocumented: ['B'], documentedNotUsed: ['C'] });

// Issue #221: assignment-shaped lines with invalid keys must not disappear.
{
  const secret = 'do-not-echo-this-value';
  for (const key of ['MY KEY', '9NAME', '.NAME', '-NAME', '', '?', '??', 'A?B']) {
    assert.throws(
      () => parseEnvFile(`${key}=${secret}`),
      err => err instanceof SyntaxError && err.message === 'line 1: expected KEY=VALUE',
    );
    for (const newline of ['\n', '\r\n']) {
      for (const prefix of ['', 'export ', 'export\t']) {
        const input = ['# comment with KEY=VALUE', '', 'CERT="one', 'two"',
          ` ${prefix}${key}=${secret} # trailing`, 'PLAIN=1'].join(newline);
        assert.throws(
          () => parseEnvFile(input),
          err => err instanceof SyntaxError && err.message === 'line 5: expected KEY=VALUE'
            && !err.message.includes(secret),
        );
      }
    }
  }
  // Invalid-looking assignments inside comments and quoted values are data.
  for (const newline of ['\n', '\r\n']) {
    const input = ['# app.name=ignored', '\t# MY-KEY=ignored', '',
      'export _NAME9 = "a=b # literal" # MY KEY=ignored',
      "SINGLE='MY KEY=literal'", 'MULTI="first', 'app.name=literal',
      'MY-KEY=literal', 'MY KEY=literal', 'last" # ignored=comment',
      'PLAIN=1 # app.name=ignored', 'EMPTY= # MY-KEY=ignored'].join(newline);
    assert.deepStrictEqual(parseEnvFile(input), {
      _NAME9: 'a=b # literal', SINGLE: 'MY KEY=literal',
      MULTI: 'first\napp.name=literal\nMY-KEY=literal\nMY KEY=literal\nlast',
      PLAIN: '1', EMPTY: '',
    });
  }
}

// Issue #290: dotted and dashed dotenv names stay flat.
{
  assert.deepStrictEqual(parseEnvFile('DB.PORT=1\nMY-KEY=2\nA.B-C_D=3\n'), {
    'DB.PORT': '1', 'MY-KEY': '2', 'A.B-C_D': '3',
  });

  const input = 'export\tapp.name = "first # literal\r\n${_NAME9}" # trailing\r\n'
    + '_NAME9=second\r\nDB.PORT=1\r\nMY=plain\r\nMY-KEY=2\r\n'
    + 'REF=${DB.PORT}/${MY-KEY}\r\n';
  assert.deepStrictEqual(parseEnvFile(input), {
    'app.name': 'first # literal\nsecond', _NAME9: 'second', 'DB.PORT': '1',
    MY: 'plain', 'MY-KEY': '2', REF: '${DB.PORT}/plain',
  });

  for (const key of ['DB.PORT', 'MY-KEY']) {
    assert.throws(() => parseEnvFile(`${key}=1\n# comment\nexport ${key}=2`), {
      message: `env-saaf: duplicate key ${key} at line 3 (first defined at line 1)`,
    });
  }
}

// Issue #69: deterministic combinations of the documented .env syntax.
{
  let seed = 0x62a47f21;
  const pick = (choices) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return choices[Math.floor(seed / 0x100000000 * choices.length)];
  };
  const spaces = ['', ' ', '  ', '\t'];
  const fragments = ['sample', '42', 'x=y', 'with#hash', 'café', 'path\\part'];
  // Malformed assignments are errors (#221); only use them as comments here.
  const noise = ['', '# comment', '# ? = value', "UNCLOSED='", '# ??='];

  for (let sample = 0; sample < 128; sample++) {
    const newline = pick(['\n', '\r\n']);
    const anchor = 'FUZZ_BASE_' + sample;
    const local = 'demo' + sample;
    const reference = '${' + anchor + '}';
    const expected = { [anchor]: local };
    const lines = [anchor + '=' + local];

    for (let index = 0; index < 8; index++) {
      const key = pick(['FUZZ_KEY_', '_FUZZ_', 'Case_']) + sample + '_' + index;
      const word = pick(fragments) + '-' + pick(fragments);
      const phrase = ' ' + word + ' # literal ';
      const [encoded, value] = pick([
        [word, word],
        ['"' + phrase + '"', phrase],
        ["'" + phrase + "'", phrase],
        ['"' + word + newline + 'next line"', word + '\nnext line'],
        [reference + '/suffix', local + '/suffix'],
        ['"' + reference + ' ' + word + '"', local + ' ' + word],
        ['\\' + reference, reference],
        ["'" + reference + "'", reference],
        ['', ''],
      ]);
      const prefix = pick(['', 'export ', 'export\t']);
      const comment = pick(['', ' # trailing', '\t# trailing']);
      lines.push(pick(spaces) + prefix + key + pick(spaces) + '=' + pick(spaces) + encoded + comment);
      expected[key] = value;
    }

    const valid = lines.join(newline) + newline;
    let parsed;
    assert.doesNotThrow(() => { parsed = parseEnvFile(valid); }, JSON.stringify(valid));
    assert.deepStrictEqual(parsed, expected, JSON.stringify(valid));

    const pickDistinctNoise = (position) => pick(noise).replace('UNCLOSED', 'UNCLOSED_' + position);
    const mixed = [
      pickDistinctNoise('START'), ...lines.slice(0, 5),
      pickDistinctNoise('MIDDLE'), ...lines.slice(5), pickDistinctNoise('END'),
    ].join(newline);
    assert.doesNotThrow(() => parseEnvFile(mixed), JSON.stringify(mixed));
  }
}

// v1.0.0: masking — a real secret is never printed in full
assert.strictEqual(maskValue('sk_live_123456'), 'sk***56');
assert.strictEqual(maskValue('abc'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456' }), { KEY: 'sk***56' });
// an empty value has nothing to hide — it stays empty instead of looking set
assert.strictEqual(maskValue(''), '');
assert.strictEqual(maskValue('x'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: '' }), { KEY: '' });
// v1.0.0: generateExample — placeholders/defaults only, never a real secret
const ex = generateExample({ PORT: { type: 'port', required: true }, API_KEY: { type: 'string', required: true } });
assert.ok(ex.includes('PORT=3000'));
assert.ok(ex.includes('API_KEY=\n'));
assert.ok(!ex.includes('sk_live'));

// Issue #56: secret-looking keys get an empty placeholder in the generated example.
{
  const { generateExample } = require('./index');
  const ex2 = generateExample({
    API_KEY: { type: 'string', required: true },
    DB_PASSWORD: { type: 'string' },
    MONKEY: { type: 'string' },
    PORT: { type: 'port' },
    TOKEN_WITH_DEFAULT: { type: 'string', default: 'abc' },
  });
  assert.ok(ex2.includes('API_KEY=\n'));
  assert.ok(ex2.includes('DB_PASSWORD=\n'));
  // 'KEY' inside another word does not count as a secret-looking key.
  assert.ok(ex2.includes('MONKEY=your_value_here'));
  assert.ok(ex2.includes('PORT=3000'));
  // An explicit default wins over the secret rule.
  assert.ok(ex2.includes('TOKEN_WITH_DEFAULT=abc'));
}

// Issue #206: generateExample annotates aliases and requiredIf in comments.
{
  const { generateExample } = require('./index');
  const ex3 = generateExample({
    DB_URL: { type: 'url', required: true, aliases: ['DATABASE_URL'] },
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    FEATURE_X: { type: 'string', requiredIf: { key: 'MODE', in: ['staging', 'production'] } },
    MULTI: { type: 'string', aliases: ['OLD_A', 'OLD_B'] },
    PLAIN: { type: 'string' },
  });
  assert.ok(ex3.includes('# type: url, required; also accepts DATABASE_URL (deprecated)'));
  assert.ok(ex3.includes("# type: url; required when MODE is 'production'"));
  assert.ok(ex3.includes("# type: string; required when MODE is one of 'staging', 'production'"));
  assert.ok(ex3.includes('# type: string; also accepts OLD_A, OLD_B (deprecated)'));
  // Keys without these options keep the existing format.
  assert.ok(ex3.includes('# type: string\nPLAIN=your_value_here'));
}

// Issue #84: trim: false keeps leading/trailing whitespace for string-like types.
{
  const { validateEnv } = require('./index');
  assert.strictEqual(validateEnv({ T: { type: 'string', trim: false } }, { T: '  abc  ' }).T, '  abc  ');
  // Default behaviour is unchanged: values are trimmed.
  assert.strictEqual(validateEnv({ T: { type: 'string' } }, { T: '  abc  ' }).T, 'abc');
  // With trim: false a padded URL is kept exactly as provided (the URL parser itself tolerates the spaces).
  assert.strictEqual(validateEnv({ U: { type: 'url', trim: false } }, { U: ' https://example.com ' }).U, ' https://example.com ');
  assert.strictEqual(validateEnv({ U: { type: 'url', trim: false } }, { U: 'https://example.com' }).U, 'https://example.com');
  // A padded email is kept as-is, so it fails the no-whitespace rule instead of being silently fixed.
  assert.throws(() => validateEnv({ E: { type: 'email', trim: false } }, { E: ' a@example.com ' }), /expected a valid email/);
  // Numeric and boolean coercion is unaffected by trim: false.
  assert.strictEqual(validateEnv({ N: { type: 'number', trim: false } }, { N: ' 42 ' }).N, 42);
  assert.strictEqual(validateEnv({ B: { type: 'boolean', trim: false } }, { B: ' true ' }).B, true);
  // Choices and length checks see the kept whitespace.
  assert.throws(() => validateEnv({ M: { type: 'string', trim: false, choices: ['dev'] } }, { M: ' dev ' }), /expected one of/);
  assert.throws(() => validateEnv({ S: { type: 'string', trim: false, maxLength: 3 } }, { S: '  ab  ' }), /at most 3 characters/);
}

// scanDir also scans .mts/.cts files
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-'));
  fs.writeFileSync(path.join(dir, 'a.mts'), 'export const x = process.env.FROM_MTS;');
  fs.writeFileSync(path.join(dir, 'b.cts'), 'export const y = process.env.FROM_CTS;');
  fs.writeFileSync(path.join(dir, 'c.ts'), 'export const z = process.env.FROM_TS;');
  assert.deepStrictEqual(scanDir(dir), ['FROM_CTS', 'FROM_MTS', 'FROM_TS']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// scanDir skips build output so a stale bundle cannot make an unused key look used (issue #334)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-skip-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const a = process.env.FROM_SOURCE;');
    for (const skipped of ['dist', 'build', 'coverage', '.next', 'out', 'target']) {
      fs.mkdirSync(path.join(dir, skipped), { recursive: true });
      fs.writeFileSync(path.join(dir, skipped, 'bundle.js'), 'const b = process.env.FROM_' + skipped.replace('.', '') + ';');
    }
    fs.mkdirSync(path.join(dir, 'nested', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'dist', 'bundle.js'), 'process.env.FROM_NESTED_DIST');
    assert.deepStrictEqual(scanDir(dir), ['FROM_SOURCE']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #355: user exclusions, on top of the built-in skips
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-exclude-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'process.env.FROM_APP');
    fs.mkdirSync(path.join(dir, 'fixtures'));
    fs.writeFileSync(path.join(dir, 'fixtures', 'a.js'), 'process.env.FROM_FIXTURES');
    fs.mkdirSync(path.join(dir, 'src', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'generated', 'g.js'), 'process.env.FROM_GENERATED');
    fs.mkdirSync(path.join(dir, 'src', 'keep'));
    fs.writeFileSync(path.join(dir, 'src', 'keep', 'k.js'), 'process.env.FROM_KEEP');
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'i.js'), 'process.env.FROM_NODE_MODULES');

    assert.deepStrictEqual(scanDir(dir), ['FROM_APP', 'FROM_FIXTURES', 'FROM_GENERATED', 'FROM_KEEP']);
    // A bare name matches that directory anywhere; a glob is relative to the root.
    assert.deepStrictEqual(scanDir(dir, { exclude: ['fixtures'] }), ['FROM_APP', 'FROM_GENERATED', 'FROM_KEEP']);
    assert.deepStrictEqual(scanDir(dir, { exclude: ['src/generated/**'] }), ['FROM_APP', 'FROM_FIXTURES', 'FROM_KEEP']);
    assert.deepStrictEqual(scanDir(dir, { exclude: ['src/gen*'] }), ['FROM_APP', 'FROM_FIXTURES', 'FROM_KEEP']);
    // Built-in skips still apply when exclusions are present.
    assert.deepStrictEqual(scanDir(dir, { exclude: ['fixtures', 'src/generated/**'] }), ['FROM_APP', 'FROM_KEEP']);
    assert.deepStrictEqual(scanDir(dir, { exclude: [] }), ['FROM_APP', 'FROM_FIXTURES', 'FROM_GENERATED', 'FROM_KEEP']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #339: scanDir follows a symlinked package once and survives a cycle
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-link-'));
  const real = path.join(root, 'real');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(real, 'real.js'), 'process.env.REAL_SECRET;');
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'process.env.PORT;');
  try {
    fs.symlinkSync(path.relative(path.join(proj, 'src'), real), path.join(proj, 'src', 'linked'), 'dir');
    // A cycle must not hang the walk.
    fs.symlinkSync('..', path.join(proj, 'src', 'loop'), 'dir');
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    console.log('symlink tests skipped (no symlink permission)');
  }
  try {
    assert.deepStrictEqual(scanDir(proj), ['PORT', 'REAL_SECRET']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });

  }
}

// Issue #235: scanDir also scans single-file components (.vue/.svelte/.astro)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-sfc-'));
  try {
    // Vue: <script> block reads. Comments and string literals inside the
    // script do not count (the same scanCode masking as for .js files).
    fs.writeFileSync(path.join(dir, 'App.vue'), [
      '<template><p>{{ title }}</p></template>',
      '<script setup>',
      "const api = process.env.VITE_API_URL;",
      "const key = import.meta.env.VITE_PUBLIC_KEY;",
      '// process.env.IN_VUE_COMMENT',
      'const doc = "process.env.IN_VUE_STRING";',
      '</script>',
      '',
    ].join('\n'));
    // Svelte: instance script reads.
    fs.writeFileSync(path.join(dir, 'Widget.svelte'), [
      '<script>let host = process.env.SVELTE_HOST;</script>',
      '<p>hello</p>',
      '',
    ].join('\n'));
    // Astro: frontmatter reads.
    fs.writeFileSync(path.join(dir, 'Page.astro'), [
      '---',
      "const db = process.env.DATABASE_URL;",
      '---',
      '<html></html>',
      '',
    ].join('\n'));
    // Nested directory: the walk is recursive.
    fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'components', 'Nested.vue'), 'export const x = process.env.NESTED_VUE;\n');
    // Skips stay intact: node_modules and .git* are never scanned.
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'process.env.IN_NODE_MODULES;\n');
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'h.js'), 'process.env.IN_GIT;\n');
    // Non-code extensions are still ignored.
    fs.writeFileSync(path.join(dir, 'page.html'), '<script>process.env.IN_HTML;</script>\n');
    fs.writeFileSync(path.join(dir, 'styles.css'), '/* process.env.IN_CSS */\n');

    assert.deepStrictEqual(scanDir(dir), [
      'DATABASE_URL',
      'NESTED_VUE',
      'SVELTE_HOST',
      'VITE_API_URL',
      'VITE_PUBLIC_KEY',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #14: parseEnvFile — strip inline comments after unquoted values;
// '#' inside quotes is safe; a comment after a quoted value is stripped too
{
  const { parseEnvFile, loadEnv } = require('./index');
  assert.deepStrictEqual(
    parseEnvFile('PORT=3000 # my port\nDEBUG=true # enable logs\nNAME="x # y"\nNOTE=\'a # b\' # trailing\nEMPTY= # nothing\nURL=https://example.com/#frag\n'),
    { PORT: '3000', DEBUG: 'true', NAME: 'x # y', NOTE: 'a # b', EMPTY: '', URL: 'https://example.com/#frag' }
  );
  // end-to-end: a .env file with inline comments validates via loadEnv
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-inline-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000 # app port\nDEBUG=true # verbose\n');
  const envInline = loadEnv(
    { PORT: { type: 'port', required: true }, DEBUG: { type: 'boolean', default: false } },
    { path: file, env: {} }
  );
  assert.strictEqual(envInline.PORT, 4000);
  assert.strictEqual(envInline.DEBUG, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// feat: loadEnv — read a .env file and validate it in one call (fixes #2)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-loadenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000\nDEBUG=true\nAPI_URL=https://api.example.com/v1\n');
  const schema = {
    PORT: { type: 'port', required: true },
    DEBUG: { type: 'boolean', default: false },
    API_URL: { type: 'url', required: true },
  };
  // basic: file se typed values
  const env1 = loadEnv(schema, { path: file, env: {} });
  assert.strictEqual(env1.PORT, 4000);
  assert.strictEqual(env1.DEBUG, true);
  assert.strictEqual(env1.API_URL, 'https://api.example.com/v1');
  assert.ok(Object.isFrozen(env1));
  // override: false (default) — the base env wins; true — the file wins
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' } }).PORT, 5000);
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' }, override: true }).PORT, 4000);
  // assign: validated values are written back into the base env as strings
  const target = {};
  loadEnv(schema, { path: file, env: target, assign: true });
  assert.strictEqual(target.PORT, '4000');
  assert.strictEqual(target.DEBUG, 'true');
  // without assign, a process.env-like base env stays untouched
  const untouched = { PORT: '5000' };
  loadEnv(schema, { path: file, env: untouched });
  assert.strictEqual(untouched.PORT, '5000');
  assert.strictEqual(untouched.DEBUG, undefined);
  // missing file + required schema -> saaf error
  assert.throws(() => loadEnv(schema, { path: path.join(dir, 'nope.env'), env: {} }), /file not found/);
  // Issue #158: an explicitly passed single `path` that does not exist throws
  // naming the path even when every variable is optional — a typo'd path is a
  // deliberate instruction, and ignoring it silently would boot with defaults.
  assert.throws(
    () => loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: path.join(dir, 'nope.env'), env: {} }),
    (e) => e.message === `env-saaf: .env file not found: ${path.join(dir, 'nope.env')}`
  );
  // the implicit default `.env` stays optional: nothing required -> defaults
  const env4 = loadEnv({ PORT: { type: 'port', default: 3000 } }, { env: {} });
  assert.strictEqual(env4.PORT, 3000);
  // list forms keep skipping missing entries (no throw, defaults apply)
  assert.strictEqual(
    loadEnv({ PORT: { type: 'port', default: 3000 } }, { paths: [path.join(dir, 'nope.env')], env: {} }).PORT, 3000
  );
  assert.strictEqual(
    loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: [path.join(dir, 'nope.env')], env: {} }).PORT, 3000
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #157: loadEnv names the path when a file exists but cannot be read —
// a directory (EISDIR) or a permission-denied file (EACCES) — instead of
// leaking the raw Node error. Missing files keep their behaviour above.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-eisdir-'));
  const schema = { PORT: { type: 'port', required: true } };
  // a directory passed as path reports the path, not a raw EISDIR
  assert.throws(
    () => loadEnv(schema, { path: dir, env: {} }),
    (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${dir}`)
  );
  // the same applies to every entry of a paths: [...] list
  assert.throws(
    () => loadEnv(schema, { paths: [path.join(dir, 'nope.env'), dir], env: {} }),
    (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${dir}`)
  );
  // a permission-denied file reports the path instead of a raw EACCES/EPERM
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const file = path.join(dir, '.env.sealed');
    fs.writeFileSync(file, 'PORT=4000\n');
    fs.chmodSync(file, 0o000);
    assert.throws(
      () => loadEnv(schema, { path: file, env: {} }),
      (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${file}`)
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #83: reject a misplaced path or other non-schema argument up front.
{
  const { loadEnv } = require('./index');
  const message = "loadEnv expects a schema object as the first argument — did you mean loadEnv(schema, { path: '.env' })?";
  assert.throws(() => loadEnv('.env', { PORT: { type: 'port' } }), { name: 'TypeError', message });
  for (const schema of [null, undefined, [], 42, false, 1n, Symbol('schema'), () => { }, new Date(), new Map(), new (class Schema { })()]) {
    assert.throws(() => loadEnv(schema), { name: 'TypeError', message });
  }
  // Argument validation must happen before reading options or files.
  assert.throws(() => loadEnv('.env', { get path() { throw new Error('options read too soon'); } }), { name: 'TypeError', message });
  assert.deepStrictEqual(loadEnv({}, { paths: [], env: {} }), {});
  const schema = Object.assign(Object.create(null), { PORT: { type: 'port' } });
  assert.strictEqual(loadEnv(schema, { paths: [], env: { PORT: '3000' } }).PORT, 3000);
}

// feat: strict mode — flag variables that are set but not in the schema (fixes #4)
{
  const schema = { PORT: { type: 'port', required: true } };
  // non-strict (default): extra keys are ignored
  assert.strictEqual(validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }).PORT, 3000);
  // strict: an unknown key becomes an error
  assert.throws(
    () => validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }, { strict: true }),
    /DATABSE_URL: set but not in schema/
  );
  // an empty value is ignored in strict mode too (treated as missing)
  assert.strictEqual(validateEnv(schema, { PORT: '3000', EMPTY_VAR: '' }, { strict: true }).PORT, 3000);
  // ek hi pass me saari problems: unknown + missing
  assert.throws(
    () => validateEnv(schema, { DATABSE_URL: 'x' }, { strict: true }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('DATABSE_URL'))
      && e.errors.some(m => m.includes('PORT: missing'))
  );
}

// Issue #3: a 'url' value must come back exactly as given —
// no normalization (no added trailing slash), but an invalid URL must error
{
  const out = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com' });
  assert.strictEqual(out.API_URL, 'https://api.example.com');
  const out2 = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com/v1?x=1' });
  assert.strictEqual(out2.API_URL, 'https://api.example.com/v1?x=1');
  assert.throws(() => validateEnv({ U: { type: 'url' } }, { U: 'not a url' }), /valid URL/);
}

// Issue #50: `protocols` allowlists the schemes a `url` value may use.
{
  // An allowed scheme passes, and the value comes back exactly as given.
  assert.strictEqual(
    validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'https://example.com' }).U,
    'https://example.com');
  // Several allowed schemes; matching is case-insensitive, with or without ':'.
  assert.strictEqual(
    validateEnv({ U: { type: 'url', protocols: ['http', 'https:'] } }, { U: 'HTTPS://example.com/x' }).U,
    'HTTPS://example.com/x');
  // A scheme outside the list is rejected, naming the allowed schemes.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'ftp://example.com/x' }),
    /expected a URL with one of these protocols \(https\), got "ftp:\/\/example\.com\/x"/);
  // Without the option, any valid URL still passes.
  assert.strictEqual(
    validateEnv({ U: { type: 'url' } }, { U: 'ftp://example.com/x' }).U, 'ftp://example.com/x');
  // A bad `protocols` option is rejected up front, naming the key — even
  // when the variable is absent.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: 'https' } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: [] } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['ht tp'] } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  // A default goes through the same check as a provided value.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['https'], default: 'ftp://example.com' } }, {}),
    /one of these protocols/);
}

// Issue #5: CLI 'check --file <name>' — compare against the given file instead of .env.example
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG;');
  fs.writeFileSync(path.join(dir, '.env.sample'), 'MY_FLAG=1\n');
  const cli = path.join(__dirname, 'cli.js');
  // --file .env.sample: everything is documented, exit 0 (must not throw)
  execFileSync('node', [cli, 'check', dir, '--file', '.env.sample'], { stdio: 'pipe' });
  // without --file: no .env.example present, exit 2
  let code = 0;
  try { execFileSync('node', [cli, 'check', dir], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #160: a template parse error must print the `env-saaf: ` prefix
// exactly once — parseEnvFile's duplicate-key error already carries it,
// and readEnvFile used to add it again (in text and --json output).
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-dbl-prefix-'));
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.PORT;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=3000\nPORT=3001\n');
    const human = run(['check', dir]);
    assert.strictEqual(human.status, 2);
    assert.strictEqual(human.stderr.trim(), 'env-saaf: .env.example: duplicate key PORT at line 2 (first defined at line 1)');
    assert.ok(!human.stderr.includes('env-saaf: .env.example: env-saaf:'));
    const json = run(['check', dir, '--json']);
    assert.strictEqual(json.status, 2);
    assert.strictEqual(JSON.parse(json.stdout).error, '.env.example: duplicate key PORT at line 2 (first defined at line 1)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #113: 'check' exits 1 whenever it reports a finding — including EXTRA /
// MISSING keys in .env, which used to print a line and still exit 0 — and
// --json 'ok' matches the exit code in every case. A clean project still exits 0.
// Decision: UNUSED (documented but never referenced in code) is a finding too.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-'));
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);

  write('app.js', 'const flag = process.env.KNOWN;');
  write('.env.example', 'KNOWN=1\n');

  // Clean project: exit 0, ok true.
  write('.env', 'KNOWN=1\n');
  const clean = run(['check', dir]);
  assert.strictEqual(clean.status, 0);
  assert.strictEqual(JSON.parse(run(['check', dir, '--json']).stdout.trim()).ok, true);

  // The only finding is EXTRA in .env: exit 1, and --json agrees.
  write('.env', 'KNOWN=1\nTYPO_KEY=2\n');
  const extra = run(['check', dir]);
  assert.strictEqual(extra.status, 1);
  assert.ok(extra.stdout.includes('EXTRA in .env: TYPO_KEY'));
  const extraJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
  assert.strictEqual(extraJson.ok, false);
  assert.deepStrictEqual(extraJson.envExtra, ['TYPO_KEY']);
  assert.strictEqual(run(['check', dir, '--json']).status, 1);

  // The only finding is MISSING in .env: exit 1.
  write('.env', '');
  const missing = run(['check', dir]);
  assert.strictEqual(missing.status, 1);
  assert.ok(missing.stdout.includes('MISSING in .env: KNOWN'));

  // UNUSED (documented, never used in code): exit 1 as well.
  write('.env.example', 'KNOWN=1\nUNUSED_KEY=2\n');
  write('.env', 'KNOWN=1\nUNUSED_KEY=2\n');
  const unused = run(['check', dir]);
  assert.strictEqual(unused.status, 1);
  assert.ok(unused.stdout.includes('UNUSED: UNUSED_KEY'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #102: CLI 'example --write' — save the draft to a file instead of printing it
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG;');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  // without --write: draft still goes to stdout and no file is created
  const plain = run(['example', dir]);
  assert.strictEqual(plain.status, 0);
  assert.ok(plain.stdout.includes('MY_FLAG='));
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  // --write: draft lands in .env.example, with a confirmation on stdout
  const wrote = run(['example', dir, '--write']);
  assert.strictEqual(wrote.status, 0);
  assert.ok(wrote.stdout.includes('wrote .env.example'));
  const saved = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
  assert.ok(saved.includes('MY_FLAG='));
  // --write again without --force: refuses, exit 1, file untouched
  const again = run(['example', dir, '--write']);
  assert.strictEqual(again.status, 1);
  assert.ok(again.stderr.includes('--force'));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), saved);
  // --write --force: overwrites with a fresh scan
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG; const y = process.env.OTHER;');
  const forced = run(['example', dir, '--write', '--force']);
  assert.strictEqual(forced.status, 0);
  assert.ok(fs.readFileSync(path.join(dir, '.env.example'), 'utf8').includes('OTHER='));
  // --write=<file>: writes to the named file instead
  const named = run(['example', dir, '--write=.env.local.example']);
  assert.strictEqual(named.status, 0);
  assert.ok(fs.readFileSync(path.join(dir, '.env.local.example'), 'utf8').includes('MY_FLAG='));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #116: 'example --write' on a directory with no variables refuses
// instead of writing a header-only file. Plain 'example' (stdout) is unchanged.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("nothing to see here");');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  // --write: warns on stderr, exits 1, and writes no file
  const refused = run(['example', dir, '--write']);
  assert.strictEqual(refused.status, 1);
  assert.ok(refused.stderr.includes('no process.env usage found'), refused.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  // plain example on the same directory is unchanged: exit 0, header only
  const plain = run(['example', dir]);
  assert.strictEqual(plain.status, 0);
  assert.ok(plain.stdout.includes('# Generated by env-saaf'));
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #206: 'example --schema <file>' generates from the schema, so the
// alias/requiredIf annotations show in CLI output too. Without --schema the
// scan draft is unchanged (see above).
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'env.schema.js'),
    "module.exports = {\n"
    + "  DB_URL: { type: 'url', required: true, aliases: ['DATABASE_URL'] },\n"
    + "  SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },\n"
    + "};\n");
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  const out = run(['example', dir, '--schema', 'env.schema.js']);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('# type: url, required; also accepts DATABASE_URL (deprecated)'), out.stdout);
  assert.ok(out.stdout.includes("# type: url; required when MODE is 'production'"), out.stdout);
  assert.ok(out.stdout.includes('DB_URL=https://example.com'), out.stdout);
  // --write saves the same annotated text, and refuses to overwrite without --force.
  const wrote = run(['example', dir, '--schema', 'env.schema.js', '--write']);
  assert.strictEqual(wrote.status, 0, wrote.stderr);
  assert.ok(fs.readFileSync(path.join(dir, '.env.example'), 'utf8').includes('also accepts DATABASE_URL (deprecated)'));
  const again = run(['example', dir, '--schema', 'env.schema.js', '--write']);
  assert.strictEqual(again.status, 1);
  assert.ok(again.stderr.includes('--force'));
  // A missing schema file fails with exit 2 and names the file.
  const missing = run(['example', dir, '--schema', 'nope.js']);
  assert.strictEqual(missing.status, 2);
  assert.ok(missing.stderr.includes('cannot load schema nope.js'), missing.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #15: scanCode — let aur var destructuring of process.env (previously only const)
{
  assert.deepStrictEqual(
    scanCode('let { A } = process.env; var { B } = process.env; const { C } = process.env;'),
    ['A', 'B', 'C']
  );
  assert.deepStrictEqual(
    scanCode('let { API_URL: api = "http://localhost" } = process.env; var { PORT = 3000 } = process.env;'),
    ['API_URL', 'PORT']
  );
}

// Issue #225: scanCode — Vite-style import.meta.env reads (dot, bracket, destructuring)
{
  assert.deepStrictEqual(scanCode('const k = import.meta.env.VITE_API_KEY;'), ['VITE_API_KEY']);
  assert.deepStrictEqual(
    scanCode("const a = import.meta.env['VITE_A']; const b = import.meta.env[`VITE_B`];"),
    ['VITE_A', 'VITE_B']
  );
  assert.deepStrictEqual(
    scanCode('const { VITE_MODE, VITE_NAME: name } = import.meta.env;'),
    ['VITE_MODE', 'VITE_NAME']
  );
  // Mixed with process.env reads in one source: one sorted, unique list.
  assert.deepStrictEqual(
    scanCode('import.meta.env.VITE_API_KEY; process.env.PORT; import.meta.env.VITE_API_KEY;'),
    ['PORT', 'VITE_API_KEY']
  );
  // Mentions inside comments and string literals are not reads.
  assert.deepStrictEqual(
    scanCode('// set import.meta.env.VITE_NOPE first\nconst s = "import.meta.env.VITE_ALSO_NOPE";'),
    []
  );
}

// Issue #18: boolean type — also accept 'on'/'off' (and 'y'/'n')
{
  const b = (v) => validateEnv({ F: { type: 'boolean' } }, { F: v }).F;
  assert.strictEqual(b('on'), true);
  assert.strictEqual(b('ON'), true);
  assert.strictEqual(b('On'), true);
  assert.strictEqual(b('off'), false);
  assert.strictEqual(b('OFF'), false);
  assert.strictEqual(b('Off'), false);
  assert.strictEqual(b('y'), true);
  assert.strictEqual(b('n'), false);
  assert.strictEqual(b('yes'), true);
  assert.strictEqual(b('no'), false);
  assert.strictEqual(b('1'), true);
  assert.strictEqual(b('0'), false);
  assert.throws(() => validateEnv({ F: { type: 'boolean' } }, { F: 'enabled' }), /expected a boolean/);
  // end-to-end: a .env file with FEATURE_X=on / DEBUG=off
  const { parseEnvFile } = require('./index');
  const parsed = validateEnv(
    { FEATURE_X: { type: 'boolean' }, DEBUG: { type: 'boolean' } },
    parseEnvFile('FEATURE_X=on\nDEBUG=off\n')
  );
  assert.strictEqual(parsed.FEATURE_X, true);
  assert.strictEqual(parsed.DEBUG, false);
}

// Issue #19: CLI '--help' / '-h' — print usage, exit 0 (asking for help is not an error)
{
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  // --help aur -h: exit 0, usage text stdout par
  const outHelp = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
  assert.ok(outHelp.includes('Usage: env-saaf'));
  const outH = execFileSync('node', [cli, '-h'], { encoding: 'utf8' });
  assert.ok(outH.includes('Usage: env-saaf'));
  // an unknown command still exits 2
  let code = 0;
  try { execFileSync('node', [cli, 'frobnicate'], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  // no-args ab bhi usage + exit 0
  const outNone = execFileSync('node', [cli], { encoding: 'utf8' });
  assert.ok(outNone.includes('Usage: env-saaf'));
}

// Issue #97: --help / -h recognised after a subcommand, not treated as a directory
{
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  for (const args of [
    ['scan', '--help'],
    ['check', '--help'],
    ['example', '--help'],
    ['scan', '-h'],
    ['scan', '--help', 'some-dir'],
  ]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, args.join(' ') + ' should exit 0: ' + run.stderr);
    assert.ok(run.stdout.includes('Usage: env-saaf'), args.join(' ') + ' should print usage');
    assert.ok(!/ENOENT|not found/.test(run.stderr + run.stdout), args.join(' ') + ' must not treat --help as a path');
  }
}

// Issue #62: --no-color is accepted globally and the CLI keeps its output plain.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-plain-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const value = process.env.PLAIN_OUTPUT;');
    const commands = [
      { args: ['--no-color', 'scan', dir] },
      { args: ['scan', '--no-color', dir] },
      { args: ['scan', dir, '--no-color'] },
      { args: ['scan', dir], env: { ...process.env, NO_COLOR: '1' } },
    ];
    for (const { args, env } of commands) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      assert.strictEqual(run.status, 0, args.join(' '));
      assert.strictEqual(run.stdout.trim(), 'PLAIN_OUTPUT');
      assert.strictEqual(run.stderr, '');
    }

    const json = spawnSync(process.execPath, [cli, 'scan', '--no-color', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: true,
      vars: ['PLAIN_OUTPUT'],
      locations: { PLAIN_OUTPUT: [{ file: 'app.js', line: 1 }] },
    });

    const help = spawnSync(process.execPath, [cli, '--no-color', '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('--no-color'));
    assert.strictEqual(help.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #98: global --version / -v flag — print the installed version and exit 0.
{
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const expected = `env-saaf ${require('./package.json').version}\n`;

  const commands = [
    ['--version'],
    ['-v'],
    ['check', '--version'],
    ['scan', '-v'],
    ['--no-color', '--version'],
  ];
  for (const args of commands) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, args.join(' '));
    assert.strictEqual(run.stdout, expected, args.join(' '));
    assert.strictEqual(run.stderr, '', args.join(' '));
  }

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.ok(help.stdout.includes('--version'));
}

// Issue #24: CLI --json output for check and scan
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-json-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MISSING_KEY;\nconst y = process.env.OK_KEY;');
  fs.writeFileSync(path.join(dir, '.env.example'), 'OK_KEY=1\nEXTRA_KEY=2\n');

  // check --json: missing used-not-documented, extra documented-not-used, ok false, exit 1
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [cli, 'check', dir, '--json'], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.strictEqual(code, 1);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, false);
  assert.deepStrictEqual(parsed.missing, ['MISSING_KEY']);
  assert.deepStrictEqual(parsed.extra, ['EXTRA_KEY']);
  assert.deepStrictEqual(parsed.invalid, []);
  // Issue #187: the same keys are also exposed as `unused`, the name scan --json uses
  assert.deepStrictEqual(parsed.unused, ['EXTRA_KEY']);

  // scan --json: lists vars, ok true, exit 0
  const scanOut = execFileSync('node', [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
  const scanParsed = JSON.parse(scanOut);
  assert.strictEqual(scanParsed.ok, true);
  assert.deepStrictEqual(scanParsed.vars.sort(), ['MISSING_KEY', 'OK_KEY']);

  // human output still default (no --json)
  const humanOut = execFileSync('node', [cli, 'scan', dir], { encoding: 'utf8', stdio: 'pipe' });
  assert.ok(humanOut.includes('MISSING_KEY'));
  assert.ok(!humanOut.includes('{'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #187: check --json exposes documented-but-unused keys as `unused`, the
// same name scan --json uses for them — `extra` keeps the same list so existing
// consumers of the old shape are untouched.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-unused-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const used = process.env.USED_KEY;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\nOLD_KEY=2\nANOTHER_OLD=3\n');

    const json = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.ok, false);
    assert.deepStrictEqual(parsed.extra, ['OLD_KEY', 'ANOTHER_OLD']);
    assert.deepStrictEqual(parsed.unused, ['OLD_KEY', 'ANOTHER_OLD']);
    assert.deepStrictEqual(parsed.missing, []);

    // Text mode is unchanged: UNUSED stays a finding with exit 1.
    const human = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(human.status, 1);
    assert.ok(human.stdout.includes('UNUSED: OLD_KEY'), human.stdout);
    assert.ok(human.stdout.includes('UNUSED: ANOTHER_OLD'), human.stdout);

    // scan --json: `unused` still sits next to `vars`, ok true, exit 0; locations added (#335).
    const scanJson = spawnSync(process.execPath, [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(scanJson.status, 0);
    assert.deepStrictEqual(JSON.parse(scanJson.stdout), {
      ok: true,
      vars: ['USED_KEY'],
      unused: ['OLD_KEY', 'ANOTHER_OLD'],
      locations: { USED_KEY: [{ file: 'app.js', line: 1 }] },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #100: CLI check also compares the real .env with the template keys.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-envkeys-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const db = process.env.DATABASE_URL;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'DATABSE_URL=postgres://localhost/app\n');

    const human = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.ok(human.stdout.includes('EXTRA in .env: DATABSE_URL (not in .env.example)'), human.stdout);
    assert.ok(human.stdout.includes('MISSING in .env: DATABASE_URL (in .env.example, not set locally)'), human.stdout);

    const json = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: false,
      missing: [],
      extra: [],
      unused: [],
      invalid: [],
      envExtra: ['DATABSE_URL'],
      envMissing: ['DATABASE_URL'],
    });

    // A matching .env is clean; the existing all-clean message still applies.
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    const clean = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(clean.status, 0);
    assert.ok(clean.stdout.includes('all clean'));
    assert.ok(!clean.stdout.includes('in .env:'));

    // Without .env the comparison is skipped and the old shape is unchanged except for empty fields.
    fs.rmSync(path.join(dir, '.env'));
    const noEnv = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(noEnv.stdout), {
      ok: true,
      missing: [],
      extra: [],
      unused: [],
      invalid: [],
      envExtra: [],
      envMissing: [],
    });

    // --file selects the template used for the comparison too.
    fs.writeFileSync(path.join(dir, '.env.sample'), 'SAMPLE_KEY=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SAMPLE_KEY=set\nTYPO_KEY=oops\n');
    const custom = spawnSync(process.execPath, [cli, 'check', dir, '--file', '.env.sample', '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(custom.stdout).envExtra, ['TYPO_KEY']);
    assert.deepStrictEqual(JSON.parse(custom.stdout).envMissing, []);
    assert.deepStrictEqual(JSON.parse(custom.stdout).missing, ['DATABASE_URL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #70: CLI scan finds literal env reads in TypeScript modules.
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-ts-cli-'));

  try {
    fs.writeFileSync(path.join(dir, 'service.ts'), [
      "enum Mode { Hosted = 'hosted' }",
      "export const hosts = { [Mode.Hosted]: process.env['SERVICE_HOST'] } as const;",
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'server.mts'), [
      'export namespace Server {',
      '  const { API_PORT: port } = process.env;',
      '  export const config = { port, endpoint: process.env.SERVICE_HOST } as const;',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'worker.cts'), [
      "const { QUEUE_NAME = 'default' } = process.env;",
      'export const config = { queue: QUEUE_NAME, tracing: process.env["TRACE_MODE"] } as const;',
    ].join('\n'));
    const output = execFileSync(process.execPath, [path.join(__dirname, 'cli.js'), 'scan', dir, '--json'], {
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(output), {
      ok: true,
      vars: ['API_PORT', 'QUEUE_NAME', 'SERVICE_HOST', 'TRACE_MODE'],
      locations: {
        API_PORT: [{ file: 'nested/server.mts', line: 2 }],
        QUEUE_NAME: [{ file: 'worker.cts', line: 1 }],
        SERVICE_HOST: [
          { file: 'nested/server.mts', line: 3 },
          { file: 'service.ts', line: 2 },
        ],
        TRACE_MODE: [{ file: 'worker.cts', line: 2 }],
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #30: parseEnvFile — multiline quoted values keep their newlines
// (PEM keys, JSON blobs); the key after the closing quote still parses.
assert.deepStrictEqual(
  parseEnvFile('KEY="-----BEGIN-----\nabc123\n-----END-----"\nNEXT=ok\n'),
  { KEY: '-----BEGIN-----\nabc123\n-----END-----', NEXT: 'ok' });
assert.deepStrictEqual(
  parseEnvFile("KEY='line1\nline2' # trailing\nNEXT=ok\n"),
  { KEY: 'line1\nline2', NEXT: 'ok' });

// Issue #333: parseEnvFile — double-quoted values expand \n and \r
// (dotenv parity); single-quoted values stay literal, and an escaped
// backslash keeps the next character literal.
assert.deepStrictEqual(
  parseEnvFile('KEY="line1\\nline2"\n'),
  { KEY: 'line1\nline2' });
assert.deepStrictEqual(
  parseEnvFile('KEY="a\\rb"\n'),
  { KEY: 'a\rb' });
assert.deepStrictEqual(
  parseEnvFile("KEY='a\\nb'\n"),
  { KEY: 'a\\nb' });
assert.deepStrictEqual(
  parseEnvFile('KEY="a\\\\nb"\n'),
  { KEY: 'a\\nb' });
assert.deepStrictEqual(
  parseEnvFile('KEY="-----BEGIN-----\\nabc123\\n-----END-----"\nNEXT=ok\n'),
  { KEY: '-----BEGIN-----\nabc123\n-----END-----', NEXT: 'ok' });
assert.deepStrictEqual(
  parseEnvFile('KEY="C:\\\\path"\n'),
  { KEY: 'C:\\path' });

// Issue #22: parseEnvFile — ${VAR} interpolation in double-quoted and
// unquoted values; the file's own values win over process.env; nested
// references expand; single-quoted and \${...} escapes stay literal;
// unknown names expand to an empty string.
assert.deepStrictEqual(
  parseEnvFile('HOST=example.com\nURL=https://${HOST}/api\n'),
  { HOST: 'example.com', URL: 'https://example.com/api' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=${A} world\nC=${B}!\n'),
  { A: 'hello', B: 'hello world', C: 'hello world!' });
assert.deepStrictEqual(
  parseEnvFile("A=hello\nB='${A}'\n"),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=\\${A}\n'),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('B=x${MISSING_VAR}y\n'),
  { B: 'xy' });

// Issue #136: unset and empty values have different defaults.
{
  const missing = 'ENV_SAAF_TEST_MISSING_DEFAULT';
  const external = 'ENV_SAAF_TEST_PROCESS_DEFAULT';
  const priorMissing = process.env[missing];
  const priorExternal = process.env[external];
  try {
    delete process.env[missing];
    process.env[external] = 'process-value';
    const values = parseEnvFile([
      'SET=value',
      'EMPTY=',
      'ALIAS=${ENV_SAAF_TEST_MISSING_DEFAULT}',
      'UNSET_COLON=${ENV_SAAF_TEST_MISSING_DEFAULT:-fallback}',
      'UNSET_DASH=${ENV_SAAF_TEST_MISSING_DEFAULT-fallback}',
      'SET_COLON="${SET:-ignored}"',
      'SET_DASH=${SET-ignored}',
      'EMPTY_COLON=${EMPTY:-fallback}',
      'EMPTY_DASH=${EMPTY-ignored}',
      'EXPANDED_EMPTY=${ALIAS:-fallback}',
      'EMPTY_DEFAULT=x${ENV_SAAF_TEST_MISSING_DEFAULT:-}y',
      'PROCESS=${ENV_SAAF_TEST_PROCESS_DEFAULT:-fallback}',
      'NESTED=${ENV_SAAF_TEST_MISSING_DEFAULT:-${SET}}',
      'UNUSED_NESTED=${SET:-${ENV_SAAF_TEST_MISSING_DEFAULT:-ignored}}',
      'ESCAPED=\\${SET:-ignored}',
      'NESTED_ESCAPED=${ENV_SAAF_TEST_MISSING_DEFAULT:-\\${SET}}',
      "SINGLE='${SET:-ignored}'",
      'UNTERMINATED=${SET} ${SET:-fallback',
    ].join('\n'));
    assert.deepStrictEqual(values, {
      SET: 'value',
      EMPTY: '',
      ALIAS: '',
      UNSET_COLON: 'fallback',
      UNSET_DASH: 'fallback',
      SET_COLON: 'value',
      SET_DASH: 'value',
      EMPTY_COLON: 'fallback',
      EMPTY_DASH: '',
      EXPANDED_EMPTY: 'fallback',
      EMPTY_DEFAULT: 'xy',
      PROCESS: 'process-value',
      NESTED: 'value',
      UNUSED_NESTED: 'value',
      ESCAPED: '${SET:-ignored}',
      NESTED_ESCAPED: '${SET}',
      SINGLE: '${SET:-ignored}',
      UNTERMINATED: 'value ${SET:-fallback',
    });
  } finally {
    if (priorMissing === undefined) delete process.env[missing];
    else process.env[missing] = priorMissing;
    if (priorExternal === undefined) delete process.env[external];
    else process.env[external] = priorExternal;
  }
}

// Issue #185: a self-reference with a default (`${A:-...}` / `${A-...}`) uses
// the default, because the key's own value is not set while its own line is
// being resolved — exactly as for a genuinely absent name. A self-reference
// without a default stays literal, and a genuine cycle (A=${B}, B=${A}) still
// resolves to literals without looping forever.
assert.deepStrictEqual(
  parseEnvFile('A=${A:-fallback}\n'),
  { A: 'fallback' });
assert.deepStrictEqual(
  parseEnvFile('A=${A-fallback}\n'),
  { A: 'fallback' });
assert.deepStrictEqual(
  parseEnvFile('A=${A}\n'),
  { A: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('A=${B}\nB=${A}\n'),
  { A: '${A}', B: '${B}' });
// the self-reference is unset at nesting depth too: it sits inside another
// key's default, reached while A's own line is being resolved
assert.deepStrictEqual(
  parseEnvFile('A=${ENV_SAAF_TEST_MISSING_NESTED:-${A:-q}}\n'),
  { A: 'q' });

// Issue #25: loadEnv — multiple files; later files override earlier ones,
// via `paths: [...]` or `path` as an array.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-multi-'));
  const f1 = path.join(dir, '.env');
  const f2 = path.join(dir, '.env.local');
  fs.writeFileSync(f1, 'PORT=3000\nHOST=base\n');
  fs.writeFileSync(f2, 'HOST=local\n');
  const merged = loadEnv(
    { PORT: { type: 'port', required: true }, HOST: { type: 'string', required: true } },
    { paths: [f1, f2], env: {} });
  assert.strictEqual(merged.PORT, 3000);
  assert.strictEqual(merged.HOST, 'local');
  const viaArray = loadEnv({ HOST: { type: 'string' } }, { path: [f1, f2], env: {} });
  assert.strictEqual(viaArray.HOST, 'local');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #34: per-key 'transform' — custom parsing after coercion
{
  const { validateEnv, loadEnv } = require('./index');
  // the issue's own examples: split a comma list, normalise case
  const t1 = validateEnv({
    ALLOWED_ORIGINS: { type: 'array', transform: xs => xs.map(s => s.toLowerCase()) },
    SHOUTY_NAME: { type: 'string', transform: v => v.toUpperCase() },
  }, { ALLOWED_ORIGINS: 'A.COM, B.COM ,c.com', SHOUTY_NAME: 'hello' });
  assert.deepStrictEqual(t1.ALLOWED_ORIGINS, ['a.com', 'b.com', 'c.com']);
  assert.strictEqual(t1.SHOUTY_NAME, 'HELLO');
  // transform runs AFTER coercion and the choices check: a port arrives as a number
  const t2 = validateEnv({ PORT_PLUS: { type: 'port', transform: n => n + 1 } }, { PORT_PLUS: '3000' });
  assert.strictEqual(t2.PORT_PLUS, 3001);
  // a choices failure skips the transform entirely
  let transformCalled = false;
  assert.throws(
    () => validateEnv(
      { MODE: { type: 'string', choices: ['a', 'b'], transform: v => { transformCalled = true; return v; } } },
      { MODE: 'c' }
    ),
    /expected one of/
  );
  assert.strictEqual(transformCalled, false);
  // a throwing transform is collected as a normal validation error, naming the key —
  // and it does not hide the other keys' errors
  assert.throws(
    () => validateEnv({
      BAD: { type: 'string', transform: () => { throw new Error('nope'); } },
      MISSING: { type: 'string', required: true },
    }, { BAD: 'x' }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('BAD: transform failed: nope'))
      && e.errors.some(m => m.includes('MISSING: missing'))
  );
  // transform does NOT run on defaults — a default passes through untouched
  let defaultTransformed = false;
  const t3 = validateEnv(
    { GREETING: { type: 'string', default: 'hi', transform: v => { defaultTransformed = true; return v + '!'; } } },
    {}
  );
  assert.strictEqual(t3.GREETING, 'hi');
  assert.strictEqual(defaultTransformed, false);
  // a non-function transform is a schema error naming the key
  assert.throws(
    () => validateEnv({ A: { type: 'string', transform: 'split' } }, { A: 'x' }),
    /A: "transform" must be a function/
  );
  // end-to-end: loadEnv applies transforms too (it validates through validateEnv)
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-transform-'));
  fs.writeFileSync(path.join(dir, '.env'), 'ALLOWED_ORIGINS=A.COM, B.COM\n');
  const loaded = loadEnv(
    { ALLOWED_ORIGINS: { type: 'array', required: true, transform: xs => xs.map(s => s.toLowerCase()) } },
    { path: path.join(dir, '.env'), env: {} }
  );
  assert.deepStrictEqual(loaded.ALLOWED_ORIGINS, ['a.com', 'b.com']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #23: 'email' type and 'pattern' option for strings
{
  const { validateEnv } = require('./index');
  // email: pragmatic validation — one '@', non-empty local/domain, a dot in the domain
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'a@b.co' }).E, 'a@b.co');
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'first.last+tag@sub.example.org' }).E, 'first.last+tag@sub.example.org');
  for (const bad of ['not-an-email', 'a@b', '@b.co', 'a@.co', 'a@b.', 'a@@b.co', 'a b@c.co', 'a@c']) {
    assert.throws(() => validateEnv({ E: { type: 'email' } }, { E: bad }), /expected a valid email address/);
  }
  // pattern: a slug and a prefixed key; the mismatch error names the pattern
  const p = validateEnv({
    SLUG: { type: 'string', pattern: /^[a-z0-9-]+$/ },
    API_KEY: { type: 'string', pattern: /^sk_[A-Za-z0-9]+$/ },
  }, { SLUG: 'my-post-2', API_KEY: 'sk_abc123' });
  assert.strictEqual(p.SLUG, 'my-post-2');
  assert.strictEqual(p.API_KEY, 'sk_abc123');
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: /^[a-z0-9-]+$/ } }, { S: 'Bad Slug!' }),
    (e) => e instanceof EnvSaafError && e.errors.some(m => m.includes('S: expected to match /^[a-z0-9-]+$/'))
  );
  // pattern also works with the email type, and runs after the choices check
  assert.strictEqual(
    validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@example.com' }).E, 'a@example.com');
  assert.throws(
    () => validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@other.com' }),
    /expected to match/
  );
  // A pattern that is neither a RegExp nor a string names the key.
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: 123 } }, { S: 'abc' }),
    /S: "pattern" must be a RegExp or string/
  );
}

// Issue #286: string patterns match and reject the same values as RegExp rules.
{
  for (const pattern of ['^[A-Z]+$', /^[A-Z]+$/]) {
    const schema = { S: { type: 'string', pattern } };
    assert.strictEqual(validateSchema(schema), undefined);
    assert.strictEqual(validateEnv(schema, { S: 'ABC' }).S, 'ABC');
    assert.throws(() => validateEnv(schema, { S: 'abc' }), /S: expected to match \/\^\[A-Z\]\+\$\//);
  }
  const email = { E: { type: 'email', pattern: '@example\\.com$' } };
  assert.strictEqual(validateEnv(email, { E: 'a@example.com' }).E, 'a@example.com');
  assert.throws(() => validateEnv(email, { E: 'a@example.org' }), /E: expected to match/);
}

// Issue #286: invalid patterns are schema errors even on absent keys.
{
  const invalid = { S: { pattern: '([' } };
  const invalidGroup = { DB: { prefix: 'DB_', schema: { HOST: { pattern: '([' } } } };
  for (const [schema, key] of [[invalid, 'S'], [invalidGroup, 'DB_HOST']]) {
    for (const check of [validateSchema, toJsonSchema, s => validateEnv(s, {}, { throwOnError: false })]) {
      assert.throws(() => check(schema), e => e instanceof EnvSaafError
        && e.errors.length === 1 && e.errors[0] === `${key}: "pattern" is not a valid regular expression string`);
    }
  }
}

// Issue #286: string sources cannot enable pattern on non-string rule types.
{
  assert.throws(() => validateSchema({ N: { type: 'int', pattern: '^4' } }), e => e instanceof EnvSaafError
    && e.errors.length === 1 && e.errors[0].startsWith('N: "pattern" only applies to string types'));
}

// Issue #286: frozen grouped schemas can be reused without rewriting the source.
{
  const rule = Object.freeze({ type: 'host', pattern: '^db\\.' });
  const schema = Object.freeze({ DB: Object.freeze({ prefix: 'DB_', schema: Object.freeze({ HOST: rule }) }) });
  for (const host of ['db.primary', 'db.replica']) {
    assert.deepStrictEqual(validateEnv(schema, { DB_HOST: host }), { DB: { HOST: host } });
  }
  assert.throws(() => validateEnv(schema, { DB_HOST: 'cache.internal' }), /DB_HOST: expected to match/);
  assert.strictEqual(toJsonSchema(schema).properties.DB.properties.HOST.pattern, '^db\\.');
  assert.strictEqual(rule.pattern, '^db\\.');
}

// Issue #286: changes to a mutable rule do not use a stale compiled pattern.
{
  const rule = { pattern: '^A+$' };
  const schema = { SWITCH: { validate: () => { rule.pattern = '^B+$'; } }, S: rule };
  assert.strictEqual(validateEnv(schema, { S: 'AAA' }).S, 'AAA');
  rule.pattern = '^C+$';
  assert.throws(() => validateEnv(schema, { S: 'AAA' }), /S: expected to match/);
  assert.strictEqual(validateEnv(schema, { S: 'CCC' }).S, 'CCC');
  assert.strictEqual(validateEnv(schema, { SWITCH: 'on', S: 'BBB' }).S, 'BBB');
}

// Issue #286: caller-supplied RegExp flags and state are unchanged.
{
  const pattern = /a/gi;
  const schema = { S: { pattern } };
  assert.strictEqual(validateSchema(schema), undefined);
  assert.strictEqual(validateEnv(schema, { S: 'A' }).S, 'A');
  assert.strictEqual(pattern.lastIndex, 1);
  assert.throws(() => validateEnv(schema, { S: 'A' }), /S: expected to match \/a\/gi/);
  assert.strictEqual(pattern.lastIndex, 0);
  assert.deepStrictEqual(toJsonSchema(schema).properties.S, { type: 'string' });
}

// Issue #286: JSON Schema keeps the input string and any built-in pattern.
{
  const schema = {
    PATH: { pattern: '^east/west$' },
    ANY: { pattern: '' },
    HEX: { type: 'hex', pattern: '^fe' },
    REGEXP: { pattern: /^east\/west$/ },
  };
  assert.strictEqual(validateEnv(schema, { ANY: 'value' }).ANY, 'value');
  assert.deepStrictEqual(toJsonSchema(schema).properties, {
    PATH: { type: 'string', pattern: '^east/west$' },
    ANY: { type: 'string', pattern: '' },
    HEX: { type: 'string', pattern: '^fe', allOf: [{ pattern: '^[0-9a-fA-F]+$' }] },
    REGEXP: { type: 'string', pattern: '^east\\/west$' },
  });
}

// Issue #33: scanCode finds process.env[`KEY`] template-literal access,
// but not interpolated names — those cannot be known statically.
assert.deepStrictEqual(
  scanCode('const v = process.env[`DYNAMIC_NAME`]; const w = process.env[`PREFIX_${SUFFIX}`];'),
  ['DYNAMIC_NAME']);
assert.deepStrictEqual(
  scanCode('process.env.API_URL; process.env[\'BRACKET\']; process.env[`TICK`];'),
  ['API_URL', 'BRACKET', 'TICK']);


// Issues #45 + #47: 'int' type (whole numbers only) and min/max for numbers.
{
  const ints = validateEnv({ N: { type: 'int', required: true } }, { N: '42' });
  assert.strictEqual(ints.N, 42);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '-3' }).N, -3);
  // Issue #277: decimal/scientific spellings are rejected even when whole.
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '1e3' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '1.5e2' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '1.0' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '3.5' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: 'abc' }), /expected an integer/);
  // min/max: both, min alone, max alone; the error names the allowed range.
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '5' }).N, 5);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1 } }, { N: '0' }), /at least 1/);
  assert.throws(() => validateEnv({ N: { type: 'number', max: 10 } }, { N: '11' }), /at most 10/);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '99' }), /1\u201310/);
  // min/max also apply to int and port.
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 0 } }, { N: '7' }).N, 7);
  assert.throws(() => validateEnv({ N: { type: 'int', min: 0 } }, { N: '-1' }), /at least 0/);
  assert.throws(() => validateEnv({ P: { type: 'port', max: 1024 } }, { P: '8080' }), /at most 1024/);
  // min/max leave non-numeric values alone.
  assert.strictEqual(validateEnv({ S: { type: 'string', min: 1 } }, { S: 'x' }).S, 'x');
}

// Issue #219: numeric env strings are decimal, not JavaScript radix literals.
{
  const expected = { number: 'expected a number', int: 'expected an integer', port: 'expected a port' };
  for (const type of ['number', 'int', 'port']) {
    for (const raw of ['0x10', '0X10', '0b101', '0B101', '0o17', '0O17']) {
      for (const trim of [true, false]) {
        for (const value of [raw, ` \t${raw}\n`]) {
          assert.throws(
            () => validateEnv({ N: { type, trim } }, { N: value }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N: ${expected[type]}`),
          );
          assert.throws(
            () => validateEnv({ N: { type: 'array', of: type, trim } }, { N: `1,${value}` }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N[1]: ${expected[type]}`),
          );
        }
      }
      assert.throws(() => validateEnv({ N: { type, default: raw } }, {}), EnvSaafError);
    }
    for (const [raw, value] of [['42', 42], ['+42', 42], ['042', 42], ['0', 0]]) {
      for (const trim of [true, false]) {
        assert.strictEqual(validateEnv({ N: { type, trim } }, { N: ` ${raw} ` }).N, value);
        assert.deepStrictEqual(
          validateEnv({ N: { type: 'array', of: type, trim } }, { N: ` ${raw} ,1` }).N,
          [value, 1],
        );
      }
    }
    // Issue #277: decimal/scientific spellings are not plain integer
    // literals. 'number' still accepts them; 'int' and 'port' reject them
    // (as env values, as array items, and as defaults), in both trims.
    if (type === 'number') {
      for (const [raw, value] of [['1e3', 1000], ['1.5e2', 150], ['1.0', 1]]) {
        assert.strictEqual(validateEnv({ N: { type } }, { N: raw }).N, value);
      }
    } else {
      for (const raw of ['1e3', '1.5e2', '1.0', '8080.0']) {
        for (const trim of [true, false]) {
          assert.throws(
            () => validateEnv({ N: { type, trim } }, { N: ` ${raw} ` }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N: ${expected[type]}`),
          );
          assert.throws(
            () => validateEnv({ N: { type: 'array', of: type, trim } }, { N: `1,${raw}` }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N[1]: ${expected[type]}`),
          );
        }
      }
      assert.throws(() => validateEnv({ N: { type, default: '1e3' } }, {}), EnvSaafError);
      assert.throws(() => validateEnv({ N: { type, default: '1.0' } }, {}), EnvSaafError);
    }
    for (const value of [0x10, 0b101, 0o17]) {
      assert.strictEqual(validateEnv({ N: { type, default: value } }, {}).N, value);
      assert.strictEqual(validateEnv({ N: { type } }, { N: value }).N, value);
    }
    assert.deepStrictEqual(
      validateEnv({ N: { type: 'array', of: type, default: [16, 5, 15] } }, {}).N,
      [16, 5, 15],
    );
    const result = validateEnv({ N: { type, sensitive: true } }, { N: '0x1F90' }, { throwOnError: false });
    assert.deepStrictEqual(result.env, {});
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes(expected[type]));
    assert.ok(!result.errors[0].includes('0x1F90'));
  }
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '.5' }).N, 0.5);
  for (const type of ['number', 'int']) {
    assert.strictEqual(validateEnv({ N: { type } }, { N: '-3' }).N, -3);
  }
  assert.strictEqual(validateEnv({ N: { type: 'string' } }, { N: '0x10' }).N, '0x10');
}

// Issue #277: 'int' (and 'port', which builds on it) only accepts plain
// integer literals — optional sign + digits. Decimal/scientific spellings
// that happen to be whole numbers are rejected, while 'number' is unchanged.
{
  // Accepted: plain literals, both signs, leading zeros, zero itself.
  for (const [raw, value] of [['42', 42], ['-42', -42], ['+42', 42], ['007', 7], ['0', 0]]) {
    assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: raw }).N, value);
  }
  // Rejected: decimal and scientific spellings, even when whole.
  for (const raw of ['1.0', '1e3', '1.5e2', '42.0', '1E3', '+1.0']) {
    assert.throws(
      () => validateEnv({ N: { type: 'int' } }, { N: raw }),
      err => err instanceof EnvSaafError && err.errors[0] === `N: expected an integer (e.g. 42), got "${raw}"`,
    );
    assert.throws(
      () => validateEnv({ P: { type: 'port' } }, { P: raw }),
      err => err instanceof EnvSaafError && err.errors[0].startsWith('P: expected a port'),
    );
  }
  // 'port' keeps its range: plain literals in range pass, out of range fail.
  assert.strictEqual(validateEnv({ P: { type: 'port' } }, { P: '8080' }).P, 8080);
  assert.strictEqual(validateEnv({ P: { type: 'port' } }, { P: '0' }).P, 0);
  assert.throws(() => validateEnv({ P: { type: 'port' } }, { P: '8080.0' }), /expected a port/);
  // 'number' behaviour is unchanged: the same spellings still pass there.
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '1.0' }).N, 1);
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '1e3' }).N, 1000);
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '1.5e2' }).N, 150);
  // Non-throwing mode collects the error and omits the key.
  const collected = validateEnv({ N: { type: 'int' } }, { N: '1e3' }, { throwOnError: false });
  assert.deepStrictEqual(collected.env, {});
  assert.deepStrictEqual(collected.errors, ['N: expected an integer (e.g. 42), got "1e3"']);
}

// Issues #32 + #48: 'json' type (parse JSON values) and minLength/maxLength for strings.
{
  // json: objects, arrays and primitives are parsed and returned as-is.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', required: true } }, { F: '{"beta":true,"maxItems":3}' }).F,
    { beta: true, maxItems: 3 });
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: '[1, "two", null]' }).F, [1, 'two', null]);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '42' }).F, 42);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '"hello"' }).F, 'hello');
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'true' }).F, true);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'null' }).F, null);
  // Invalid JSON is a normal collected error naming the key.
  assert.throws(() => validateEnv({ F: { type: 'json' } }, { F: '{not json' }), /expected valid JSON/);
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, { F: '' }), /missing required variable/);
  // A default may be given as an already-parsed object.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', default: { beta: false } } }, {}).F, { beta: false });
  // An already-parsed value passed directly in the env object passes through.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: { beta: true } }).F, { beta: true });
  // json works with required/default like every other type.
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, {}), EnvSaafError);

  // minLength/maxLength: both, min alone, max alone; the error names the allowed length.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 2, maxLength: 5 } }, { S: 'abc' }).S, 'abc');
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 3 } }, { S: 'ab' }), /at least 3 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2 } }, { S: 'abc' }), /at most 2 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, maxLength: 4 } }, { S: 'abcdef' }), /2\u20134 characters/);
  // Length is checked after coercion, so surrounding whitespace is trimmed first.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 3, maxLength: 3 } }, { S: '  abc  ' }).S, 'abc');
  // Combines with pattern: length is checked first, then the pattern.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 5, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /at least 5 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /expected to match/);
  // Applies to email and url values too; non-string types are rejected up front.
  assert.throws(() => validateEnv({ E: { type: 'email', maxLength: 5 } }, { E: 'a@b.co' }), /at most 5 characters/);
  assert.throws(() => validateEnv({ N: { type: 'number', minLength: 5 } }, { N: '42' }), /N: "minLength" only applies to string types/);
  // Bad option values are a clear rule error, not a crash.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: -1 } }, { S: 'abc' }), /non-negative integers/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2.5 } }, { S: 'abc' }), /non-negative integers/);
}

// Issues #37 + #42: 'uuid' type (canonical UUIDs) and 'hex' type
// (hex strings, with an optional exact `length` for fixed-size values).
{
  // uuid: lowercase, uppercase and mixed-case hex all pass, returned unchanged.
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550e8400-e29b-41d4-a716-446655440000' }).ID,
    '550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550E8400-E29B-41D4-A716-446655440000' }).ID,
    '550E8400-E29B-41D4-A716-446655440000');
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550e8400-E29B-41d4-A716-446655440000' }).ID,
    '550e8400-E29B-41d4-A716-446655440000');
  // Malformed UUIDs are rejected with an error naming the key.
  for (const bad of [
    '550e8400e29b41d4a716446655440000', // no dashes
    '550e8400-e29b-41d4-a716', // too short
    '550e8400-e29b-41d4-a716-44665544000g', // non-hex character
    '550e8400-e29b-41d4-a716-446655440000-extra', // too long
    'not-a-uuid',
  ]) {
    assert.throws(() => validateEnv({ ID: { type: 'uuid' } }, { ID: bad }), /expected a valid UUID/);
  }
  assert.throws(() => validateEnv({ ID: { type: 'uuid', required: true } }, {}), EnvSaafError);

  // hex: mixed-case hex passes, returned unchanged.
  assert.strictEqual(validateEnv({ H: { type: 'hex' } }, { H: 'deadBEEF42' }).H, 'deadBEEF42');
  assert.strictEqual(validateEnv({ H: { type: 'hex' } }, { H: '00ff' }).H, '00ff');
  for (const bad of ['deadbeefzz', '0x1234', '12 34', 'café']) {
    assert.throws(() => validateEnv({ H: { type: 'hex' } }, { H: bad }), /expected a hexadecimal string/);
  }
  // length: an exact-length value passes, anything else fails naming the length.
  assert.strictEqual(validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2c3' }).H, 'a1b2c3');
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2' }), /6 characters long/);
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2c3d4' }), /6 characters long/);
  // A bad length option is a clear rule error, not a crash.
  assert.throws(() => validateEnv({ H: { type: 'hex', length: -1 } }, { H: 'a1' }), /"length" must be a non-negative integer/);
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 2.5 } }, { H: 'a1' }), /"length" must be a non-negative integer/);
  // minLength/maxLength also work on hex values — they are strings.
  assert.throws(() => validateEnv({ H: { type: 'hex', maxLength: 2 } }, { H: 'a1b2' }), /at most 2 characters/);
}

// Issues #38 + #39 + #43: 'ipv4', 'semver' and 'base64' types. All three
// return the value unchanged; a bad value is rejected naming the key.
{
  // ipv4: four octets, each 0-255; a leading zero is rejected (except '0' itself).
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '192.168.0.1' }).IP, '192.168.0.1');
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '0.0.0.0' }).IP, '0.0.0.0');
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '255.255.255.255' }).IP, '255.255.255.255');
  for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'example.com', '01.2.3.4', '192.168.0', '192.168.0.1/24']) {
    assert.throws(() => validateEnv({ IP: { type: 'ipv4' } }, { IP: bad }), /expected a valid IPv4 address/);
  }
  assert.throws(() => validateEnv({ IP: { type: 'ipv4', required: true } }, {}), EnvSaafError);

  // semver: MAJOR.MINOR.PATCH, one optional lowercase 'v' prefix; pre-release and build suffixes pass.
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '1.2.3' }).V, '1.2.3');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '1.2.3-beta.1' }).V, '1.2.3-beta.1');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '0.0.1+build.5' }).V, '0.0.1+build.5');
  // Issue #227: a 'v' prefix is accepted and returned unchanged, prefix included.
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3' }).V, 'v1.2.3');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3-rc.1' }).V, 'v1.2.3-rc.1');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3+build' }).V, 'v1.2.3+build');
  for (const bad of ['1.2', 'v1.2', 'vv1.2.3', 'v', 'V1.2.3', '1.02.3', '1.2.3.4', 'latest', '1.2.x']) {
    assert.throws(() => validateEnv({ V: { type: 'semver' } }, { V: bad }), /expected a valid semantic version/);
  }

  // Base64 accepts either alphabet with optional complete padding.
  const base64Schema = { B: { type: 'base64', trim: false } };
  for (const value of [
    'aGVsbG8=', 'aGVsbG8gd29ybGQ=', 'AA==', 'aGVsbG8', 'AA', 'AAAA',
    '+/8=', '+/8', '-_8=', '-_8', '/w==', '/w', '_w==', '_w', '+/AA', '-_AA',
  ]) {
    assert.strictEqual(validateEnv(base64Schema, { B: value }).B, value);
  }
  for (const bad of [
    'not!!base64', 'a', 'AAAAA', 'aGVsbG8===', '====', 'AA=', 'AAA==',
    'AAAA=', 'A===', 'AA=A', 'AA==AAAA', 'AA A', 'AA==\n', '+_8=', '-/8',
  ]) {
    assert.throws(() => validateEnv(base64Schema, { B: bad }), /expected a valid base64 string/);
  }
  // minLength/maxLength work on the new string types too.
  assert.throws(() => validateEnv({ IP: { type: 'ipv4', minLength: 20 } }, { IP: '1.2.3.4' }), /at least 20 characters/);
}

// Issue #40: 'date' type — ISO 8601 dates and datetimes become Date objects.
// Impossible dates are rejected instead of rolling over to the next month.
{
  // date-only: parsed as a Date at UTC midnight.
  const d = validateEnv({ D: { type: 'date' } }, { D: '2026-01-31' }).D;
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-01-31T00:00:00.000Z');
  // leap day is real in a leap year, impossible otherwise.
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2024-02-29' }).D.toISOString().slice(0, 10), '2024-02-29');
  assert.throws(() => validateEnv({ D: { type: 'date' } }, { D: '2026-02-29' }), /expected a valid ISO 8601 date/);
  // full datetimes: UTC, an offset, and fractional seconds all parse.
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00Z' }).D.toISOString(), '2026-01-31T10:00:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00+05:30' }).D.toISOString(), '2026-01-31T04:30:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00.123Z' }).D.toISOString(), '2026-01-31T10:00:00.123Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00' }).D instanceof Date, true);
  // impossible and malformed values are rejected, naming the key.
  for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-01-32', '2026-01-31T25:00:00Z',
    '2026-01-31T10:60:00Z', '31-01-2026', '2026/01/31', 'not-a-date', '2026-1-31']) {
    assert.throws(() => validateEnv({ D: { type: 'date' } }, { D: bad }), /expected a valid ISO 8601 date/);
  }
  assert.throws(() => validateEnv({ D: { type: 'date', required: true } }, {}), EnvSaafError);
  // A Date given as a default passes through; an invalid one fails like a bad value.
  const def = new Date('2026-06-01T00:00:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date', default: def } }, {}).D, def);
  assert.throws(() => validateEnv({ D: { type: 'date', default: new Date('not a date') } }, {}), /expected a valid ISO 8601 date/);
  // generateExample suggests a real date, not a placeholder.
  assert.ok(generateExample({ LAUNCH: { type: 'date', required: true } }).includes('LAUNCH=2026-01-31'));
}

// Issue #292: `date` type supports `min` / `max` bounds as ISO dates,
// compared chronologically against the parsed value. Bounds are inclusive.
{
  const schema = { D: { type: 'date', min: '2026-01-01', max: '2026-12-31' } };
  // Inside the range, and exactly on each bound, passes.
  assert.strictEqual(validateEnv(schema, { D: '2026-06-15' }).D.toISOString().slice(0, 10), '2026-06-15');
  assert.strictEqual(validateEnv(schema, { D: '2026-01-01' }).D.toISOString().slice(0, 10), '2026-01-01');
  assert.strictEqual(validateEnv(schema, { D: '2026-12-31' }).D.toISOString().slice(0, 10), '2026-12-31');
  // Outside either bound fails with an error naming the allowed range.
  assert.throws(() => validateEnv(schema, { D: '2025-12-31' }), /D: expected a date between 2026-01-01 and 2026-12-31, got "2025-12-31"/);
  assert.throws(() => validateEnv(schema, { D: '2027-01-01' }), /D: expected a date between 2026-01-01 and 2026-12-31, got "2027-01-01"/);
  // Either bound works alone.
  assert.throws(() => validateEnv({ D: { type: 'date', min: '2026-01-01' } }, { D: '2025-12-31' }), /on or after 2026-01-01/);
  assert.strictEqual(validateEnv({ D: { type: 'date', min: '2026-01-01' } }, { D: '2030-01-01' }).D.toISOString().slice(0, 10), '2030-01-01');
  assert.throws(() => validateEnv({ D: { type: 'date', max: '2026-12-31' } }, { D: '2027-01-01' }), /on or before 2026-12-31/);
  // Date-time values compare against date-only bounds by their instant.
  assert.strictEqual(validateEnv(schema, { D: '2026-01-01T00:00:00Z' }).D.toISOString(), '2026-01-01T00:00:00.000Z');
  // '2025-12-31T23:00:00-01:00' is exactly the min instant, so it passes;
  // one second earlier (in UTC) fails.
  assert.strictEqual(validateEnv(schema, { D: '2025-12-31T23:00:00-01:00' }).D.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.throws(() => validateEnv(schema, { D: '2025-12-31T22:59:59-01:00' }), /D: expected a date between 2026-01-01 and 2026-12-31/);
  // Datetime bounds work too.
  assert.throws(() => validateEnv({ D: { type: 'date', min: '2026-01-01T12:00:00Z' } }, { D: '2026-01-01T10:00:00Z' }),
    /on or after 2026-01-01T12:00:00Z/);
  // A Date object as a bound works; a default outside the bounds fails like a value.
  assert.strictEqual(validateEnv({ D: { type: 'date', min: new Date('2026-01-01T00:00:00Z') } }, { D: '2026-06-01' }).D.toISOString().slice(0, 10), '2026-06-01');
  assert.throws(() => validateEnv({ D: { type: 'date', min: '2026-01-01', default: '2025-01-01' } }, {}), /on or after 2026-01-01/);
  // Schema errors: a numeric bound, a nonsense bound, and min above max.
  assert.throws(() => validateSchema({ D: { type: 'date', min: 20260101 } }), /D: "min" must be an ISO date string for type 'date'/);
  assert.throws(() => validateSchema({ D: { type: 'date', min: 'next week' } }), /D: "min" must be a valid ISO 8601 date for type 'date'/);
  assert.throws(() => validateSchema({ D: { type: 'date', min: '2027-01-01', max: '2026-01-01' } }), /D: "min" must not exceed "max"/);
  assert.throws(() => validateSchema({ D: { type: 'date', max: 0 } }), /D: "max" must be an ISO date string for type 'date'/);
  // throwOnError:false collects the bound failure with the others.
  const collected = validateEnv(schema, { D: '2025-01-01' }, { throwOnError: false });
  assert.strictEqual(collected.errors.length, 1);
  assert.match(collected.errors[0], /D: expected a date between 2026-01-01 and 2026-12-31/);
  // generateExample uses the bound when the default example is out of range.
  assert.ok(generateExample({ D: { type: 'date', min: '2027-01-01' } }).includes('D=2027-01-01'));
  assert.ok(generateExample({ D: { type: 'date', max: '2026-01-15' } }).includes('D=2026-01-15'));
  assert.ok(generateExample({ D: { type: 'date', min: '2026-01-01', max: '2026-12-31' } }).includes('D=2026-01-31'));
  console.log('date min/max tests passed');
}

// Issue #41: 'duration' type — human durations ('15m', '2h', '1d') become milliseconds.
{
  const schema = { TIMEOUT: { type: 'duration' } };
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms' }).TIMEOUT, 500);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '30s' }).TIMEOUT, 30000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '15m' }).TIMEOUT, 900000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2h' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1d' }).TIMEOUT, 86400000);
  // A bare number is already milliseconds; decimals and case do not matter.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '250' }).TIMEOUT, 250);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5h' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '15M' }).TIMEOUT, 900000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: ' 30s ' }).TIMEOUT, 30000);
  // A number passed directly (e.g. as a default) is taken as milliseconds.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', default: 5000 } }, {}).TIMEOUT, 5000);
  // min/max work on the millisecond result like on any other number.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', min: 1000 } }, { TIMEOUT: '30s' }).TIMEOUT, 30000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', min: 1000 } }, { TIMEOUT: '500ms' }), /expected a duration at least 1000ms/);
  // Unknown units, negatives and malformed values are rejected, naming the key.
  for (const bad of ['15x', '15min', '15sec', '-5m', '-1', 'm', '1.2.3h', '1e3s']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', required: true } }, {}), EnvSaafError);
  // generateExample suggests a real duration, not a placeholder.
  assert.ok(generateExample({ TIMEOUT: { type: 'duration', required: true } }).includes('TIMEOUT=15m'));
  // Issue #176: 'w' is a week of 7 days, case-insensitive, fractional values allowed.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1w' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2w' }).TIMEOUT, 1209600000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1W' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5w' }).TIMEOUT, 907200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: ' 1 w ' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', max: 604800000 } }, { TIMEOUT: '1w' }).TIMEOUT, 604800000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', max: 604800000 } }, { TIMEOUT: '2w' }), /expected a duration at most 604800000ms/);
  // Existing units keep their values, and wrong week spellings are still rejected.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '7d' }).TIMEOUT, validateEnv(schema, { TIMEOUT: '1w' }).TIMEOUT);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1d' }).TIMEOUT, 86400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2H' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms' }).TIMEOUT, 500);
  for (const bad of ['1wk', '1week', '1ww', 'w', '-1w', '1.w', '1e2w']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  // Issue #224: compound durations sum their parts.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1h30m' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1h 30m' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2d12h' }).TIMEOUT, 216000000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms0.25s' }).TIMEOUT, 750);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5h30m' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1H30M' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1w1d' }).TIMEOUT, 691200000);
  // min/max apply to the summed total.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', max: 5400000 } }, { TIMEOUT: '1h30m' }).TIMEOUT, 5400000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', max: 5399999 } }, { TIMEOUT: '1h30m' }), /expected a duration at most 5399999ms/);
  // A trailing bare number, a leading unit and mixed junk are rejected.
  for (const bad of ['1h30', 'h30m', '1h30x', '1h 30', '1h30min']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  // Issue #280: each unit may appear only once, regardless of case or spacing.
  const repeated = ['1h1h', '30m30m', '1s500ms250ms', '1h30m1h'];
  for (const unit of ['ms', 's', 'm', 'h', 'd', 'w']) {
    repeated.push(`1${unit} 0${unit.toUpperCase()}`);
  }
  for (const bad of repeated) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /TIMEOUT: expected a duration/);
    const collected = validateEnv(schema, { TIMEOUT: bad }, { throwOnError: false });
    assert.strictEqual(collected.env.TIMEOUT, undefined);
    assert.ok(collected.errors.some(error => error.startsWith('TIMEOUT: expected a duration')));
  }
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1w2d' }).TIMEOUT, 777600000);
  assert.throws(
    () => validateEnv({ TIMEOUT: { type: 'duration', default: '1h1h' } }, {}),
    /TIMEOUT: expected a duration/,
  );
  assert.throws(
    () => validateEnv({ TIMEOUTS: { type: 'array', of: 'duration' } }, { TIMEOUTS: '1h30m,1s1s' }),
    /TIMEOUTS.*expected a duration/,
  );
  // Array items share the coercion path.
  assert.deepStrictEqual(
    validateEnv({ TIMEOUTS: { type: 'array', of: 'duration' } }, { TIMEOUTS: '1h30m,45s' }).TIMEOUTS,
    [5400000, 45000]);
}

// Issue #44: 'host' type — a hostname or IP address, with no scheme, path or port.
{
  const schema = { HOST: { type: 'host' } };
  assert.strictEqual(validateEnv(schema, { HOST: 'db.internal' }).HOST, 'db.internal');
  assert.strictEqual(validateEnv(schema, { HOST: 'localhost' }).HOST, 'localhost');
  assert.strictEqual(validateEnv(schema, { HOST: '10.0.0.5' }).HOST, '10.0.0.5');
  assert.strictEqual(validateEnv(schema, { HOST: '::1' }).HOST, '::1');
  assert.strictEqual(validateEnv(schema, { HOST: '2001:db8::1' }).HOST, '2001:db8::1');
  assert.strictEqual(validateEnv(schema, { HOST: 'DB.EXAMPLE.COM' }).HOST, 'DB.EXAMPLE.COM');
  // Issue #413: one DNS root dot is accepted and preserved.
  const longestHost = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  for (const host of ['example.com.', 'localhost.', 'DB.EXAMPLE.COM.', longestHost + '.']) {
    assert.strictEqual(validateEnv(schema, { HOST: host }).HOST, host);
  }
  assert.strictEqual(validateEnv({ HOST: { type: 'host', default: 'example.com.' } }, {}).HOST, 'example.com.');
  assert.deepStrictEqual(validateEnv({ HOSTS: { type: 'array', of: 'host' } }, { HOSTS: 'example.com.,db.internal.' }).HOSTS,
    ['example.com.', 'db.internal.']);
  assert.throws(() => validateEnv({ HOST: { type: 'host', maxLength: 11 } }, { HOST: 'example.com.' }), /at most 11 characters/);
  assert.strictEqual(validateEnv({ HOST: { type: 'host', pattern: '\\.$' } }, { HOST: 'example.com.' }).HOST, 'example.com.');
  // A scheme, a path or a port is rejected, naming the key.
  for (const bad of ['https://db.internal', 'http://localhost:3000', 'db.internal:8080', 'localhost:3000',
    'db/x', 'db.internal/', 'http://[::1]:8080', '-bad-.example.com', 'bad..host', '.example.com', 'example..com', 'example.com..', '.', '.example.com.', longestHost + 'x.', longestHost + 'x']) {
    assert.throws(() => validateEnv(schema, { HOST: bad }), /expected a hostname or IP address/);
  }
  assert.throws(() => validateEnv({ HOST: { type: 'host', required: true } }, {}), EnvSaafError);
  // String options work on it like on any other string type.
  assert.throws(() => validateEnv({ HOST: { type: 'host', maxLength: 5 } }, { HOST: 'db.internal' }), /at most 5 characters/);
  // generateExample suggests a real host, not a placeholder.
  assert.ok(generateExample({ HOST: { type: 'host', required: true } }).includes('HOST=localhost'));
}

// Issue #82: parseEnvFile takes .env TEXT, not a file path. Passing a path
// silently returned {}; now it throws a clear error pointing at loadEnv.
{
  const helpful = /parseEnvFile expects \.env text, not a file path.*did you mean loadEnv\(schema, \{ path:/;
  assert.throws(() => parseEnvFile('.env'), helpful);
  assert.throws(() => parseEnvFile('config/.env.local'), helpful);
  assert.throws(() => parseEnvFile('/etc/app.env'), helpful);
  // Normal .env text still parses as before — including a single line with
  // no trailing newline and an empty file.
  assert.deepStrictEqual(parseEnvFile('A=1'), { A: '1' });
  assert.deepStrictEqual(parseEnvFile('FOO=bar'), { FOO: 'bar' });
  assert.deepStrictEqual(parseEnvFile(''), {});
  // A lone comment line is not a path, even when it mentions one.
  assert.deepStrictEqual(parseEnvFile('# see config/notes'), {});
}

// Issue #145: bare lines report their position, even after multiline values.
{
  assert.throws(() => parseEnvFile('FOO\n'), /line 1: expected KEY=VALUE/);
  assert.throws(
    () => parseEnvFile('PORT=3000\r\nCERT="one\r\ntwo"\r\nFOO # example=123\r\nBAR=\r\n'),
    /line 4: expected KEY=VALUE/
  );
  assert.deepStrictEqual(parseEnvFile('\r\n# comment\r\n \t\r\n'), {});
  assert.deepStrictEqual(parseEnvFile('BAR=\n'), { BAR: '' });
}

// CLI callers retain readable errors and the machine-readable JSON contract.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-bare-line-'));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...args], {
    encoding: 'utf8',
  });
  try {
    fs.writeFileSync(path.join(dir, '.env.example'), '# config\nFOO\n');
    const scan = run('scan', dir, '--json');
    assert.strictEqual(scan.status, 2);
    assert.strictEqual(scan.stderr, '');
    const error = JSON.parse(scan.stdout);
    assert.strictEqual(error.ok, false);
    assert.match(error.error, /\.env\.example: line 2: expected KEY=VALUE/);

    fs.writeFileSync(path.join(dir, '.env.example'), 'FOO=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'fake secret value accidentally written on its own line\n');
    const check = run('check', dir);
    assert.strictEqual(check.status, 2);
    assert.strictEqual(check.stdout, '');
    assert.match(check.stderr, /\.env: line 1: expected KEY=VALUE/);
    assert.doesNotMatch(check.stderr, /fake secret value/);

    // Issue #221: invalid assignment keys use the same CLI error contract.
    fs.writeFileSync(path.join(dir, '.env.example'), '# config\nAPP NAME=private-value\n');
    const invalidKey = run('scan', dir, '--json');
    assert.strictEqual(invalidKey.status, 2);
    assert.strictEqual(invalidKey.stderr, '');
    const invalidKeyError = JSON.parse(invalidKey.stdout);
    assert.strictEqual(invalidKeyError.ok, false);
    assert.match(invalidKeyError.error, /\.env\.example: line 2: expected KEY=VALUE/);
    assert.doesNotMatch(invalidKey.stdout, /private-value/);

    fs.writeFileSync(path.join(dir, '.env.example'), 'FOO=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=ok\r\nMY KEY=private-value\r\n');
    const invalidEnv = run('check', dir);
    assert.strictEqual(invalidEnv.status, 2);
    assert.strictEqual(invalidEnv.stdout, '');
    assert.match(invalidEnv.stderr, /\.env: line 2: expected KEY=VALUE/);
    assert.doesNotMatch(invalidEnv.stderr, /private-value/);
    const target = {};
    assert.throws(
      () => require('./index').loadEnv({ FOO: { type: 'string' } }, {
        path: path.join(dir, '.env'), env: target, assign: true,
      }),
      err => err instanceof SyntaxError && err.message === 'line 2: expected KEY=VALUE',
    );
    assert.deepStrictEqual(target, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #88: loadEnv with assign: true must JSON-stringify object/array values.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-assign-json-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'CFG={"a":1}\nLIST=[1,2,3]\nN=42\nFLAG=true\nNAME=hi\nNOTHING=null\n');
  const schema = {
    CFG: { type: 'json', required: true },
    LIST: { type: 'json', required: true },
    N: { type: 'number', required: true },
    FLAG: { type: 'boolean', required: true },
    NAME: { type: 'string', required: true },
    NOTHING: { type: 'json', required: true },
  };
  const target = {};
  const validated = loadEnv(schema, { path: file, env: target, assign: true });
  // The validated result is unchanged (parsed objects), only the assigned-back copy is text.
  assert.deepStrictEqual(validated.CFG, { a: 1 });
  assert.deepStrictEqual(validated.LIST, [1, 2, 3]);
  // Objects/arrays from the json type round-trip through JSON.parse.
  assert.strictEqual(target.CFG, '{"a":1}');
  assert.deepStrictEqual(JSON.parse(target.CFG), { a: 1 });
  assert.strictEqual(target.LIST, '[1,2,3]');
  assert.deepStrictEqual(JSON.parse(target.LIST), [1, 2, 3]);
  // Primitives keep their existing String(value) behaviour.
  assert.strictEqual(target.N, '42');
  assert.strictEqual(target.FLAG, 'true');
  assert.strictEqual(target.NAME, 'hi');
  // null stays "null".
  assert.strictEqual(target.NOTHING, 'null');

  // A transform returning an object is also JSON-stringified on assign.
  const t2 = {};
  loadEnv(
    { OBJ: { type: 'json', required: true, transform: (v) => ({ raw: v }) } },
    { path: (() => { const f = path.join(dir, '.env2'); fs.writeFileSync(f, 'OBJ=\'"x"\'\n'); return f; })(), env: t2, assign: true }
  );
  assert.strictEqual(t2.OBJ, '{"raw":"x"}');
  assert.deepStrictEqual(JSON.parse(t2.OBJ), { raw: 'x' });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #117: parseEnvFile — a backslash-escaped quote inside a quoted value
// is part of the value, not the end of it. Single and double quotes behave the
// same way; a plain backslash (C:\path) is not an escape and stays literal.
{
  assert.deepStrictEqual(parseEnvFile(String.raw`B='it\'s'`), { B: "it's" });
  assert.deepStrictEqual(parseEnvFile(String.raw`D="it\"s"`), { D: 'it"s' });
  assert.deepStrictEqual(
    parseEnvFile(String.raw`E='C:\path\to'`),
    { E: String.raw`C:\path\to` }
  );
  // The escaped quote on the first line must not close a multiline value.
  assert.deepStrictEqual(
    parseEnvFile("G='line1\\'s\nline2'\n"),
    { G: "line1's\nline2" }
  );
}

// Issue #114: a default goes through the same coercion and validation as a
// provided value; a bad default fails with the key named, a supplied value wins.
{
  const bad = (schema, key) => assert.throws(
    () => validateEnv(schema, {}),
    (e) => e instanceof EnvSaafError && e.errors.some((m) => m.startsWith(key + ':'))
  );
  bad({ P: { type: 'port', default: 99999 } }, 'P');
  bad({ M: { choices: ['a', 'b'], default: 'c' } }, 'M');
  bad({ N: { type: 'number', default: 'notanumber' } }, 'N');
  bad({ R: { type: 'int', min: 1, max: 5, default: 9 } }, 'R');
  // An empty value counts as missing, so the default is checked then too.
  assert.throws(() => validateEnv({ P: { type: 'port', default: 99999 } }, { P: '' }), /P:/);
  // Valid defaults still work, and are coerced like real values.
    assert.deepStrictEqual({ ...validateEnv({
    P: { type: 'port', default: 3000 },
    L: { choices: ['info', 'warn'], default: 'info' },
    B: { type: 'boolean', default: 'yes' },
    J: { type: 'json', default: { a: 1 } },
  }, {}) }, { P: 3000, L: 'info', B: true, J: { a: 1 } });
  // A supplied value overrides the default (and a bad default is never checked then).
  assert.strictEqual(validateEnv({ P: { type: 'port', default: 99999 } }, { P: '8080' }).P, 8080);
  // transform still runs only on provided values.
  assert.strictEqual(validateEnv({ T: { default: 'a', transform: (v) => v + '!' } }, {}).T, 'a');
}

// Issue #115: scanCode reads code, not the text inside comments or literals.
{
  // A mention in a comment or a literal is not a read.
  assert.deepStrictEqual(scanCode('// set process.env.FOO first'), []);
  assert.deepStrictEqual(scanCode('/* use process.env.BAR */'), []);
  assert.deepStrictEqual(scanCode('const s = "see process.env.BAZ in docs"'), []);
  assert.deepStrictEqual(scanCode("const t = 'process.env.QUX'"), []);
  assert.deepStrictEqual(scanCode('const u = `see process.env.QUUX in docs`'), []);
  assert.deepStrictEqual(scanCode('const r = /process.env.REGEX/;'), []);   // a regex literal, not a read
  // A block comment spanning lines is masked across lines.
  assert.deepStrictEqual(scanCode('const a = 1; /* process.env.L\nprocess.env.M */ const b = 2;'), []);
  // A read inside a template's ${...} is a read; the literal text around it is not.
  assert.deepStrictEqual(scanCode('const v = `k=${process.env.REAL} and process.env.FAKE`'), ['REAL']);
  // The reads that must keep working: dot, bracket with a string or template, destructuring.
  assert.deepStrictEqual(scanCode("process.env.A; process.env['B']; process.env[`C`]"), ['A', 'B', 'C']);
  assert.deepStrictEqual(scanCode('const { D, E: alias = 1, F = "x" } = process.env;'), ['D', 'E', 'F']);
  // A real read and a decoy on the same line: only the read counts.
  assert.deepStrictEqual(scanCode('const g = process.env.G; // process.env.H is not read'), ['G']);
  // Destructuring that only appears in a comment is not a read.
  assert.deepStrictEqual(scanCode('// const { I } = process.env'), []);
  // An escaped quote doesn't end the literal early and expose what follows it.
  assert.deepStrictEqual(scanCode("const j = 'it\\'s process.env.J'; process.env.K"), ['K']);
  // The library's own doc comment mentions process.env.KEY: scanning index.js is not a read of KEY.
  const own = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.ok(!scanCode(own).includes('KEY'));
}

// Issue #90: CLI check --schema validates values against a schema, not just presence.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-schema-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const p = process.env.PORT;\nconst d = process.env.DEBUG;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nDEBUG=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    fs.writeFileSync(path.join(dir, 'env.schema.js'),
      "'use strict';\nmodule.exports = { PORT: { type: 'port', required: true }, DEBUG: { type: 'boolean' } };\n");

    // A wrong-typed value in the real .env fails the check, naming the key, exit 1.
    const bad = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.ok(bad.stdout.includes('INVALID: PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'), bad.stdout);
    assert.ok(!bad.stdout.includes('DEBUG'), bad.stdout);

    // --json reports the failure in the existing `invalid` field.
    const json = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 1);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: false,
      missing: [],
      extra: [],
      unused: [],
      invalid: ['PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'],
      envExtra: [],
      envMissing: [],
      // Issue #358: --schema also diffs the schema against the example file.
      schemaNotDocumented: [],
      documentedNotInSchema: [],
    });

    // Valid values pass, and presence-only (no --schema) never flags values.
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\nDEBUG=yes\n');
    const good = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(good.status, 0);
    assert.ok(good.stdout.includes('all clean'));
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    const presenceOnly = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(presenceOnly.status, 0);
    assert.ok(presenceOnly.stdout.includes('all clean'));
    assert.ok(!presenceOnly.stdout.includes('INVALID'));

    // The template's placeholders are not real values: with no .env the schema
    // step is skipped instead of flagging .env.example.
    fs.rmSync(path.join(dir, '.env'));
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=not-a-port\nDEBUG=\n');
    const skipped = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(skipped.status, 0);
    assert.ok(!skipped.stdout.includes('INVALID'));
    assert.ok(skipped.stdout.includes('no .env file found — values were not validated'), skipped.stdout);
    const skippedJson = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(skippedJson.status, 0);
    assert.strictEqual(JSON.parse(skippedJson.stdout).envFileFound, false);

    // An explicit --file names the file to validate.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nDEBUG=\n');
    fs.writeFileSync(path.join(dir, 'custom.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    const custom = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js', '--file', 'custom.env'], { encoding: 'utf8' });
    assert.strictEqual(custom.status, 1);
    assert.ok(!custom.stdout.includes('values were not validated'), custom.stdout);
    assert.ok(custom.stdout.includes('INVALID: PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'), custom.stdout);

    // A schema file that cannot be loaded is a usage error (exit 2), not a finding.
    const missing = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'nope.js'], { encoding: 'utf8' });
    assert.strictEqual(missing.status, 2);
    assert.ok(missing.stderr.includes('cannot load schema nope.js'), missing.stderr);
    fs.writeFileSync(path.join(dir, 'bad.schema.js'), "'use strict';\nmodule.exports = 'nope';\n");
    const notObject = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'bad.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(notObject.status, 2);
    assert.ok(notObject.stderr.includes('must export a schema object'), notObject.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #89: a missing template file must point at the command that drafts one,
// and --json must carry that hint instead of plain text on stderr.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-hint-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const known = process.env.KNOWN;');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const plain = run(['check', dir]);
  assert.strictEqual(plain.status, 2);
  assert.match(plain.stderr, /not found in/);
  assert.match(plain.stderr, /env-saaf example/);
  assert.strictEqual(plain.stdout, '');

  const json = run(['check', dir, '--json']);
  assert.strictEqual(json.status, 2);
  const payload = JSON.parse(json.stdout.trim());
  assert.strictEqual(payload.ok, false);
  assert.match(payload.error, /not found in/);
  assert.match(payload.hint, /env-saaf example/);
  assert.strictEqual(json.stderr, '');

  fs.rmSync(dir, { recursive: true, force: true });
}
// Issue #63: CLI scan also lists keys declared in the template that no code reads, as a
// warning only: stdout stays the plain list, the exit code stays 0.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-unused-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const a = process.env.USED_KEY;\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\nOLD_KEY=2\n');
    fs.writeFileSync(path.join(dir, '.env.sample'), 'USED_KEY=1\nSAMPLE_ONLY=3\n');

    // Text mode: used vars on stdout (unchanged), the unused key as a warning on stderr
    const plain = run(['scan', dir]);
    assert.strictEqual(plain.status, 0);
    assert.strictEqual(plain.stdout.trim(), 'USED_KEY');
    assert.match(plain.stderr, /UNUSED: OLD_KEY \(in \.env\.example, never used in code\)/);
    assert.ok(!plain.stderr.includes('USED_KEY (in'));

    // --json: an `unused` field next to `vars`, still ok: true and exit 0
    const json = run(['scan', dir, '--json']);
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: true,
      vars: ['USED_KEY'],
      unused: ['OLD_KEY'],
      locations: { USED_KEY: [{ file: 'app.js', line: 1 }] },
    });
    assert.strictEqual(json.stderr, '');

    // --file picks another template
    const sample = run(['scan', dir, '--file', '.env.sample', '--json']);
    assert.deepStrictEqual(JSON.parse(sample.stdout).unused, ['SAMPLE_ONLY']);

    // A template where every key is read produces no warning at all
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\n');
    const clean = run(['scan', dir]);
    assert.strictEqual(clean.status, 0);
    assert.strictEqual(clean.stderr, '');
    assert.deepStrictEqual(JSON.parse(run(['scan', dir, '--json']).stdout), {
      ok: true,
      vars: ['USED_KEY'],
      unused: [],
      locations: { USED_KEY: [{ file: 'app.js', line: 1 }] },
    });

    // No template file: nothing to compare, output exactly as before
    fs.rmSync(path.join(dir, '.env.example'));
    const none = run(['scan', dir, '--json']);
    assert.deepStrictEqual(JSON.parse(none.stdout), {
      ok: true,
      vars: ['USED_KEY'],
      locations: { USED_KEY: [{ file: 'app.js', line: 1 }] },
    });
    assert.strictEqual(none.stderr, '');
    assert.strictEqual(run(['scan', dir]).stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #134: invalid schema rules must be rejected up front, even when no
// value is present to coerce (an absent optional key must not hide a typo).
{
  const unknown = validateEnv.bind(null, { TYPO: { type: 'emial' } }, {});
  assert.throws(unknown, EnvSaafError);
  assert.throws(unknown, /TYPO/);
  assert.throws(unknown, /emial/);

  // The invalid option is reported before any environment value is read.
  assert.throws(() => validateEnv({ K: { type: 'string', pattern: null } }, {}), /"pattern" must be a RegExp or string/);
  assert.throws(() => validateEnv({ K: { type: 'string', transform: 'nope' } }, {}), /"transform" must be a function/);
  assert.throws(() => validateEnv({ K: { type: 'number', min: 'x' } }, {}), /"min"/);
  assert.throws(() => validateEnv({ K: { type: 'number', max: 'x' } }, {}), /"max"/);
  assert.throws(() => validateEnv({ K: { type: 'hex', length: 'x' } }, {}), /"length"/);

  // Valid rules still validate and coerce exactly as before.
  assert.strictEqual(validateEnv({ OK: { type: 'int', required: true } }, { OK: '42' }).OK, 42);
}

// Issue #133: a directory argument that is a file or does not exist must be
// reported clearly with exit 2, never a raw Node stack trace.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-baddir-'));
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, 'process.env.X;');

  try {
    for (const command of ['scan', 'check', 'example']) {
      // missing directory
      const missing = spawnSync(process.execPath, [cli, command, path.join(dir, 'nope')], { encoding: 'utf8' });
      assert.strictEqual(missing.status, 2, `${command} missing`);
      assert.ok(missing.stderr.includes('does not exist'), `${command} missing: ${missing.stderr}`);
      assert.ok(!/at .*readdirSync|ENOENT: no such file or directory, scandir/.test(missing.stderr), 'no stack trace');

      // a file where a directory is expected
      const asFile = spawnSync(process.execPath, [cli, command, file], { encoding: 'utf8' });
      assert.strictEqual(asFile.status, 2, `${command} file`);
      assert.ok(asFile.stderr.includes('is not a directory'), `${command} file: ${asFile.stderr}`);
      assert.ok(!/at .*readdirSync|ENOTDIR/.test(asFile.stderr), 'no stack trace');
    }

    // --json keeps stdout parseable with an error field and the same exit code.
    const json = spawnSync(process.execPath, [cli, 'scan', file, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 2);
    assert.strictEqual(JSON.parse(json.stdout).ok, false);
    assert.ok(JSON.parse(json.stdout).error.includes('is not a directory'));

    // A real directory is still scanned normally.
    const ok = spawnSync(process.execPath, [cli, 'scan', dir], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0);
    assert.strictEqual(ok.stdout.trim(), 'X');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #144: duplicates fail through the public entry points without values.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const duplicate = '# comment\r\nPORT=synthetic_first\r\nexport PORT=synthetic_second\r\n';
  const check = (error) => {
    assert.strictEqual(error.message, 'env-saaf: duplicate key PORT at line 3 (first defined at line 2)');
    return true;
  };
  assert.throws(() => parseEnvFile(duplicate), check);
  assert.throws(() => parseEnvFile('A="first\nsecond"\nA=third'), /duplicate key A at line 3 .*line 1/);
  assert.deepStrictEqual(parseEnvFile('A="first\nA=inside"\nB=ok'), { A: 'first\nA=inside', B: 'ok' });
  for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.strictEqual(parseEnvFile(key + '=ok')[key], 'ok');
    assert.throws(() => parseEnvFile(key + '=one\n' + key + '=two'), /duplicate key/);
  }
  const dir = fs.mkdtempSync(path.join(__dirname, 'duplicate-test-'));
  const file = path.join(dir, '.env');
  try {
    fs.writeFileSync(file, duplicate);
    assert.throws(() => loadEnv({}, { path: file, env: {} }), check);
    fs.writeFileSync(file, 'PORT=3000\nNAME=example\n');
    assert.strictEqual(loadEnv({ PORT: { type: 'port' } }, { path: file, env: {} }).PORT, 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #146: empty scans explain success on stderr without polluting stdout.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(__dirname, 'scan-empty-test-'));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'scan', dir, ...args], { encoding: 'utf8' });
  try {
    for (const source of [null, 'console.log("hello");\n']) {
      if (source) fs.writeFileSync(path.join(dir, 'app.js'), source);
      const plain = run();
      assert.strictEqual(plain.status, 0);
      assert.strictEqual(plain.stdout, '');
      assert.strictEqual(plain.stderr, 'No process.env usage found.\n');
      const json = run('--json');
      assert.strictEqual(json.status, 0);
      assert.strictEqual(json.stderr, '');
      assert.strictEqual(json.stdout, '{"ok":true,"vars":[],"locations":{}}\n');
    }
    fs.writeFileSync(path.join(dir, 'app.js'), 'process.env.SYNTHETIC_KEY;\n');
    const plain = run();
    assert.strictEqual(plain.status, 0);
    assert.strictEqual(plain.stdout, 'SYNTHETIC_KEY\n');
    assert.strictEqual(plain.stderr, '');
    const json = run('--json');
    assert.strictEqual(json.status, 0);
    assert.strictEqual(json.stderr, '');
    assert.strictEqual(
      json.stdout,
      '{"ok":true,"vars":["SYNTHETIC_KEY"],"locations":{"SYNTHETIC_KEY":[{"file":"app.js","line":1}]}}\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #55: non-throwing mode — return { env, errors } instead of throwing,
// so a health check or a CLI can log every config problem and keep booting.
{
  const schema = {
    PORT: { type: 'port', required: true },
    NAME: { type: 'string' },
    DEBUG: { type: 'boolean', default: false },
  };

  // Default behaviour is unchanged: invalid values still throw.
  assert.throws(() => validateEnv(schema, { PORT: 'not-a-port' }), EnvSaafError);
  assert.throws(() => validateEnv(schema, { PORT: 'not-a-port' }, { throwOnError: true }), EnvSaafError);

  // Invalid values are collected; the values that did validate are returned.
  const partial = validateEnv(schema, { PORT: 'abc', NAME: 'ok', DEBUG: 'yes' }, { throwOnError: false });
  assert.deepStrictEqual(partial.env, { NAME: 'ok', DEBUG: true });
  assert.deepStrictEqual(partial.errors, ['PORT: expected a port (0-65535, e.g. 3000), got "abc"']);

  // A clean environment returns the env the throwing API would and no errors.
  const clean = validateEnv(schema, { PORT: '3000', DEBUG: 'false' }, { throwOnError: false });
  assert.deepStrictEqual(clean.env, { PORT: 3000, DEBUG: false });
  assert.deepStrictEqual(clean.errors, []);

  // The returned list is the EnvSaafError contents, one-to-one.
  const bad = { PORT: 'x', DEBUG: 'maybe' };
  let thrown;
  try { validateEnv(schema, bad); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof EnvSaafError);
  const collected = validateEnv(schema, bad, { throwOnError: false });
  assert.deepStrictEqual(collected.errors, thrown.errors);
  assert.strictEqual(collected.errors.length, 2);

  // strict-mode findings are collected the same way.
  const strict = validateEnv(schema, { PORT: '3000', TYPO: 'x' }, { strict: true, throwOnError: false });
  assert.deepStrictEqual(strict.env, { PORT: 3000, DEBUG: false });
  assert.deepStrictEqual(strict.errors, ['TYPO: set but not in schema (strict mode)']);

  // The returned env is frozen exactly like the throwing API's result.
  assert.ok(Object.isFrozen(strict.env));
  assert.deepStrictEqual(validateEnv({}, {}, { throwOnError: false }), { env: {}, errors: [], details: [] });

  // A malformed schema is a bug in the code, not a config problem: it throws
  // even in non-throwing mode, where no result could be trusted.
  assert.throws(() => validateEnv({ TYPO: { type: 'emial' } }, {}, { throwOnError: false }), /emial/);

  // loadEnv keeps throwing: with assign: true it writes into the real env, so
  // a partial result must not be accepted there.
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(__dirname, 'non-throwing-test-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'PORT=not-a-port\n');
    assert.throws(() => loadEnv({ PORT: { type: 'port' } }, { path: file, env: {}, throwOnError: false }), EnvSaafError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #169: exercise the CLI's Windows path handling with an in-memory filesystem.
{
  const fs = require('node:fs');
  const path = require('node:path').win32;
  const { runInNewContext } = require('node:vm');
  const cli = fs.readFileSync(require.resolve('./cli'), 'utf8');
  const dir = 'C:\\project';
  for (const [name, schemaPath, example] of [
    ['D:custom.js', 'D:\\schemas\\custom.js', 'npx env-saaf check . --schema D:/schemas/custom.js'],
    ["schema files/it's custom.js", "C:\\project\\schema files\\it's custom.js",
      `npx env-saaf check . --schema "./schema files/it's custom.js"`],
    ['budget! draft.js', 'C:\\project\\budget! draft.js'],
  ]) {
    const writes = new Map();
    const requireFromCli = id => {
      if (id === 'node:fs') return {
        existsSync: file => file === dir,
        statSync: () => ({ isDirectory: () => true }),
        // Issue #171: init now scans the directory before writing; this stub
        // project has no files, so the scan finds nothing.
        readdirSync: () => [],
        writeFileSync: (file, contents) => writes.set(file, contents),
      };
      if (id === 'node:path') return {
        ...path,
        // Supply D:'s current directory without relying on the host environment.
        resolve: (root, file) => path.resolve(file === 'D:custom.js' ? 'D:\\schemas' : root, file),
      };
      if (id === schemaPath) return {};
      // Issue #171: init scans the directory before writing; this stub
      // project ('C:\\project') does not exist on disk, so hand the CLI a
      // scan that finds nothing instead of the real scanDir.
      if (id === './index') return { ...require('./index'), scanDir: () => [] };
      return require(id);
    };
    requireFromCli.resolve = id => id;
    requireFromCli.cache = {};
    runInNewContext(cli, {
      require: requireFromCli,
      process: { argv: ['node', 'cli.js', 'init', dir, '--schema', name], platform: 'win32' },
    });
    const generated = writes.get(schemaPath);
    assert.ok(generated, schemaPath);
    if (!example) {
      assert.match(generated, /--schema set to this path \(JSON\): "\.\/budget! draft\.js"\n/);
      assert.doesNotMatch(generated, /npx env-saaf check/);
      continue;
    }
    const label = example.includes('"') ? ' (cmd.exe)' : '';
    assert.ok(generated.includes(`// Validate the real .env against it${label}: ${example}\n`), generated);
    const argument = example.split(' --schema ')[1].replace(/^"|"$/g, '');
    assert.strictEqual(path.resolve(dir, argument), schemaPath);
  }
}

// Issue #60: CLI 'init' — scaffold a starter schema + .env.example.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(__dirname, 'init-test-'));
  try {
    // Both files land in an empty directory, with a confirmation on stdout.
    const first = run(['init', dir]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes('env.schema.js') && first.stdout.includes('.env.example'));
    const schemaFile = path.join(dir, 'env.schema.js');
    const exampleFile = path.join(dir, '.env.example');
    assert.ok(fs.existsSync(schemaFile));
    assert.ok(fs.existsSync(exampleFile));
    // The scaffold is a valid schema object, and the .env.example on disk is
    // exactly what generateExample produces from it — the two cannot drift.
    const starter = require(schemaFile);
    const types = Object.values(starter).map(rule => rule.type);
    for (const t of ['string', 'int', 'boolean', 'port', 'url', 'email']) {
      assert.ok(types.includes(t), `starter schema should demonstrate ${t}`);
    }
    assert.strictEqual(fs.readFileSync(exampleFile, 'utf8'), generateExample(starter));
    assert.deepStrictEqual(
      Object.keys(starter),
      fs.readFileSync(exampleFile, 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split('=')[0]),
    );

    // Refuses to overwrite either file without --force, naming what exists,
    // and the files keep their content.
    const before = fs.readFileSync(schemaFile, 'utf8');
    assert.match(before, /npx env-saaf check \. --schema \.\/env\.schema\.js$/m);
    const again = run(['init', dir]);
    assert.strictEqual(again.status, 1);
    assert.match(again.stderr, /already exist/);
    assert.match(again.stderr, /--force/);
    assert.strictEqual(fs.readFileSync(schemaFile, 'utf8'), before);

    // --force overwrites both files: a hand-edited schema is replaced by the
    // scaffold again.
    fs.writeFileSync(schemaFile, 'module.exports = { HAND_EDITED: true };\n');
    const forced = run(['init', dir, '--force']);
    assert.strictEqual(forced.status, 0, forced.stderr);
    assert.strictEqual(fs.readFileSync(schemaFile, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(exampleFile, 'utf8'), generateExample(starter));

    // --schema names the schema file; the .env.example is still generated.
    const dir2 = fs.mkdtempSync(path.join(dir, 'named-'));
    try {
      const assertSchemaExample = (schema, argument) => {
        const named = run(['init', dir2, '--force', '--schema', schema]);
        assert.strictEqual(named.status, 0, named.stderr);
        const generated = fs.readFileSync(path.resolve(dir2, schema), 'utf8');
        assert.ok(generated.includes(`npx env-saaf check . --schema ${argument}\n`), generated);
      };
      assertSchemaExample('custom.js', './custom.js');
      assert.ok(fs.existsSync(path.join(dir2, '.env.example')));

      assertSchemaExample('../parent.js', './../parent.js');
      fs.mkdirSync(path.join(dir2, 'schema files'));
      const absolute = path.join(dir2, 'schema files', 'absolute.js');
      const absoluteArg = absolute.split(path.sep).join('/');
      if (process.platform === 'win32') {
        assertSchemaExample('schema files/custom.js', '"./schema files/custom.js"');
        if (/^[\w./: '()-]+$/.test(absoluteArg)) {
          assertSchemaExample(absolute, `"${absoluteArg}"`);
        }
      } else {
        assertSchemaExample('schema files/custom.js', "'./schema files/custom.js'");
        assertSchemaExample(absolute, `'${absoluteArg.replace(/'/g, `'"'"'`)}'`);
      }

      if (process.platform !== 'win32') {
        assertSchemaExample("it's $config.js", "'./it'\"'\"'s $config.js'");
        assertSchemaExample('line\nbreak.js', "$'./line\\nbreak.js'");
        assertSchemaExample('line\u2028separator.js', "$'./line\\342\\200\\250separator.js'");
      }
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #175: 'number' and 'int' reject non-finite values (Infinity, -Infinity, exponent overflow).
{
  const nonFinite = ['Infinity', '-Infinity', '+Infinity', '1e999', '-1e999', ' Infinity ', ' 1e999 '];
  for (const raw of nonFinite) {
    assert.throws(
      () => validateEnv({ N: { type: 'number' } }, { N: raw }),
      err => err instanceof EnvSaafError && err.errors.length === 1
        && err.errors[0] === `N: expected a number (e.g. 3.14), got "${raw}"`,
    );
    assert.throws(
      () => validateEnv({ N: { type: 'int' } }, { N: raw }),
      err => err instanceof EnvSaafError && err.errors.length === 1
        && err.errors[0] === `N: expected an integer (e.g. 42), got "${raw}"`,
    );
  }
  // Non-finite values cannot slip past a lower bound like min: 0 either.
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 0 } }, { N: 'Infinity' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'N: expected a number (e.g. 3.14), got "Infinity"',
  );
  // Non-finite defaults are rejected just like env inputs.
  for (const def of [Infinity, -Infinity, '1e999']) {
    assert.throws(
      () => validateEnv({ N: { type: 'number', default: def } }, {}),
      err => err instanceof EnvSaafError && err.errors[0] === `N: expected a number (e.g. 3.14), got "${def}"`,
    );
    assert.throws(
      () => validateEnv({ N: { type: 'int', default: def } }, {}),
      err => err instanceof EnvSaafError && err.errors[0] === `N: expected an integer (e.g. 42), got "${def}"`,
    );
  }
  // Non-throwing mode collects the error and omits the key.
  const collected = validateEnv({ N: { type: 'number' } }, { N: '1e999' }, { throwOnError: false });
  assert.deepStrictEqual(collected.env, {});
  assert.deepStrictEqual(collected.errors, ['N: expected a number (e.g. 3.14), got "1e999"']);
  // Ordinary finite inputs still pass for both 'number' and 'int'.
  for (const [raw, expected] of [['0', 0], ['42', 42], ['-7', -7], ['3.14', 3.14], ['-0.5', -0.5], ['1e3', 1000], ['1.5e-2', 0.015]]) {
    assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: raw }).N, expected);
  }
  for (const [raw, expected] of [['0', 0], ['42', 42], ['-7', -7]]) {
    assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: raw }).N, expected);
  }
  // Issue #277: whole-valued decimal/scientific spellings are not integers.
  for (const raw of ['1e3', '1.5e2', '1.0']) {
    assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: raw }), /expected an integer/);
  }
}

// Issue #412: a single '_' between digits (as in JavaScript numeric literals)
// is accepted for 'int' and 'number'; misplaced separators are still rejected
// with the usual messages.
{
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '1_000' }).N, 1000);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '-1_000_000' }).N, -1000000);
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '1_000.5' }).N, 1000.5);
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '0.000_1' }).N, 0.0001);
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 1, max: 5000 } }, { N: '2_500' }).N, 2500);
  assert.deepStrictEqual(validateEnv({ N: { type: 'array', of: 'int' } }, { N: '1_000,2_000' }).N, [1000, 2000]);
  for (const raw of ['_100', '100_', '1__000', '1_.5']) {
    assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: raw }),
      (err) => err.errors[0] === `N: expected an integer (e.g. 42), got "${raw}"`);
    assert.throws(() => validateEnv({ N: { type: 'number' } }, { N: raw }),
      (err) => err.errors[0] === `N: expected a number (e.g. 3.14), got "${raw}"`);
  }
  // Separators do not turn a decimal into an integer or bypass the radix rule.
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '1_000.5' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'number' } }, { N: '0x1_0' }), /expected a number/);
}

// Issue #58: every built-in type's validation error includes a format example,
// and aggregated errors remain one concise bullet per key.
{
  const cases = [
    ['email', 'not-an-email', 'e.g. user@example.com'],
    ['number', 'not-a-number', 'e.g. 3.14'],
    ['int', '3.5', 'e.g. 42'],
    ['json', '{bad', 'e.g. {"key":"value"}'],
    ['boolean', 'maybe', 'e.g. true/false, yes/no, on/off, 1/0, y/n'],
    ['url', 'not-a-url', 'e.g. https://example.com'],
    ['uuid', 'not-a-uuid', 'e.g. 550e8400-e29b-41d4-a716-446655440000'],
    ['hex', 'not-hex!', 'e.g. deadbeef'],
    ['ipv4', '999.1.1.1', 'e.g. 192.168.0.1'],
    ['semver', '1.2', 'e.g. 1.2.3'],
    ['base64', 'not base64!', 'e.g. aGVsbG8='],
    ['port', 'abc', '0-65535, e.g. 3000'],
    ['date', '2026-02-31', 'e.g. 2026-01-31'],
    ['file', './definitely-missing-env-saaf-file.json', 'e.g. ./config.json'],
    ['duration', '15min', 'e.g. 500ms, 30s, 15m, 2h, 1d, 1w, 1h30m'],
    ['host', 'https://db.internal', 'e.g. db.internal, localhost, 10.0.0.5'],
  ];
  for (const [type, bad, expectedHint] of cases) {
    assert.throws(
      () => validateEnv({ VAL: { type } }, { VAL: bad }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0].includes(`(${expectedHint})`)
        && err.errors[0].includes(`got "${bad}"`),
      `${type} error should include (${expectedHint})`,
    );
  }

  // Aggregated EnvSaafError stays readable: one single-line bullet per failing key.
  const schema = {};
  const badEnv = {};
  for (const [type, bad] of cases) {
    const key = `BAD_${type.toUpperCase()}`;
    schema[key] = { type, required: true };
    badEnv[key] = bad;
  }
  let aggregated;
  try { validateEnv(schema, badEnv); } catch (e) { aggregated = e; }
  assert.ok(aggregated instanceof EnvSaafError);
  assert.strictEqual(aggregated.errors.length, cases.length);
  const lines = aggregated.message.split('\n');
  assert.strictEqual(lines[0], 'Invalid environment variables:');
  assert.strictEqual(lines.length, cases.length + 1);
  for (let i = 0; i < cases.length; i++) {
    const [type, , expectedHint] = cases[i];
    const key = `BAD_${type.toUpperCase()}`;
    assert.ok(lines[i + 1].startsWith(`  - ${key}: `), lines[i + 1]);
    assert.ok(lines[i + 1].includes(`(${expectedHint})`), lines[i + 1]);
  }
}

// Issue #170 + #178: CLI round-trip — a fresh `init` followed by `check`
// passes with a single note instead of one UNUSED line per scaffolded key,
// and UNUSED fails the check again as soon as code reads a variable.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-roundtrip-'));
  try {
    // init in an empty directory, then check: exit 0, one plain note, no
    // UNUSED lines — the scaffold is ahead of the code, not drift.
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    const checked = run(['check', dir]);
    assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.includes('no process.env usage found in code yet'), checked.stdout);
    assert.ok(checked.stdout.includes('8 keys in .env.example are not used by any code yet'), checked.stdout);
    assert.ok(!checked.stdout.includes('UNUSED:'), checked.stdout);
    const checkedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.strictEqual(checkedJson.ok, true);
    assert.deepStrictEqual(checkedJson.extra, []);
    assert.ok(checkedJson.note.includes('no process.env usage found in code yet'), checkedJson.note);
    // --schema with no real .env: the schema step is skipped, the note still rules.
    assert.strictEqual(run(['check', dir, '--schema', './env.schema.js']).status, 0);

    // A real finding still fails even with no code usage: an EXTRA key in .env
    // is not hidden behind the scaffold note.
    fs.writeFileSync(path.join(dir, '.env'), 'TYPO_KEY=1\n');
    const extra = run(['check', dir]);
    assert.strictEqual(extra.status, 1);
    assert.ok(extra.stdout.includes('EXTRA in .env: TYPO_KEY'), extra.stdout);
    fs.rmSync(path.join(dir, '.env'));

    // Once code reads one variable, UNUSED is a finding again (#113): the
    // other seven scaffolded keys fail the check, in text and --json.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const port = process.env.PORT;\n');
    const drifted = run(['check', dir]);
    assert.strictEqual(drifted.status, 1);
    assert.ok(drifted.stdout.includes('UNUSED: APP_NAME'), drifted.stdout);
    assert.ok(!drifted.stdout.includes('no process.env usage found'), drifted.stdout);
    const driftedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.strictEqual(driftedJson.ok, false);
    assert.strictEqual(driftedJson.extra.length, 7);
    assert.strictEqual(driftedJson.note, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #184: CLI 'init' in an ES module project writes env.schema.cjs
// instead of crashing on require() of a .js starter Node treats as ESM.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-esm-'));
  try {
    // A "type": "module" project: init exits 0, writes env.schema.cjs (not
    // env.schema.js) + .env.example, and the whole round-trip works —
    // check passes with the scaffold note, and check --schema validates a
    // real .env against the .cjs schema.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"esmproj","type":"module"}\n');
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    assert.ok(inited.stdout.includes('env.schema.cjs'), inited.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.cjs')));
    assert.ok(!fs.existsSync(path.join(dir, 'env.schema.js')));
    assert.ok(fs.existsSync(path.join(dir, '.env.example')));
    const starter = require(path.join(dir, 'env.schema.cjs'));
    assert.strictEqual(starter.PORT.type, 'port');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), generateExample(starter));
    assert.strictEqual(run(['check', dir]).status, 0);
    fs.writeFileSync(path.join(dir, '.env'),
      'APP_NAME=myapp\nRETRIES=3\nDEBUG=false\nPORT=3000\nAPI_URL=https://example.com\nSUPPORT_EMAIL=a@b.com\nSHUTDOWN_TIMEOUT=15m\nDB_HOST=localhost\n');
    assert.strictEqual(run(['check', dir, '--schema', './env.schema.cjs']).status, 0);
    fs.rmSync(path.join(dir, '.env'));

    // An explicit --schema .js name in the same project is refused cleanly
    // (exit 2, no stack trace) and writes neither file.
    const refused = run(['init', dir, '--force', '--schema', 'custom.js']);
    assert.strictEqual(refused.status, 2, refused.stdout + refused.stderr);
    assert.ok(refused.stderr.includes('.cjs'), refused.stderr);
    assert.ok(!refused.stderr.includes('ReferenceError'), refused.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'custom.js')));

    // check --schema on a .js schema in an ES module project names the fix.
    fs.writeFileSync(path.join(dir, 'bad.js'), "module.exports = { PORT: { type: 'port' } };\n");
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    const badCheck = run(['check', dir, '--schema', './bad.js']);
    assert.strictEqual(badCheck.status, 2);
    assert.ok(badCheck.stderr.includes('.cjs'), badCheck.stderr);
    assert.ok(!badCheck.stderr.includes('ReferenceError'), badCheck.stderr);
    fs.rmSync(path.join(dir, '.env'));
    fs.rmSync(path.join(dir, 'bad.js'));

    // A CommonJS project is unchanged: the starter is still env.schema.js.
    const cjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cjs-'));
    try {
      fs.writeFileSync(path.join(cjsDir, 'package.json'), '{"name":"cjsproj","type":"commonjs"}\n');
      const cjsInit = run(['init', cjsDir]);
      assert.strictEqual(cjsInit.status, 0, cjsInit.stderr);
      assert.ok(fs.existsSync(path.join(cjsDir, 'env.schema.js')));
      assert.ok(!fs.existsSync(path.join(cjsDir, 'env.schema.cjs')));
    } finally {
      fs.rmSync(cjsDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #171: `init` scans the directory first (the same scan `check` and
// `example` use) and folds keys the code already reads into the starter schema
// as `{ type: 'string' }` entries, so the generated .env.example covers them
// and the first `check` reports no MISSING lines to merge by hand. A directory
// with no code yet scaffolds exactly as before, and keys the scaffold already
// declares are not duplicated.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-init-scan-'));
  try {
    // Code already reads FOO and PORT: FOO must be folded into the scaffold,
    // while PORT (already scaffolded) must not be duplicated.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const port = process.env.PORT;\nconst tag = process.env.FOO;\n');
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    // The discovered keys are listed in init's output.
    assert.ok(inited.stdout.includes('folded in 1 key found by scanning the code: FOO'), inited.stdout);
    const schemaFile = path.join(dir, 'env.schema.js');
    const schemaText = fs.readFileSync(schemaFile, 'utf8');
    assert.match(schemaText, /FOO: \{ type: 'string' \},/);
    assert.match(schemaText, /Found by scanning this project's code/);
    assert.strictEqual(schemaText.match(/^  PORT:/gm).length, 1, schemaText);
    const starter = require(schemaFile);
    assert.deepStrictEqual(starter.FOO, { type: 'string' });
    const exampleText = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(exampleText, /^FOO=your_value_here$/m);
    assert.strictEqual(exampleText.match(/^PORT=/gm).length, 1, exampleText);
    assert.strictEqual(exampleText, generateExample(starter));

    // The original complaint is gone: the first `check` after init no longer
    // reports the scanned key as MISSING in .env.example (text or --json).
    const checked = run(['check', dir]);
    assert.ok(!checked.stdout.includes('MISSING in .env.example: FOO'), checked.stdout);
    const checkedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.deepStrictEqual(checkedJson.missing, []);

    // Once the code reads every documented key (the folded one included), the
    // whole round trip is clean: check --schema validates a real .env against
    // the folded scaffold with no hand merging.
    fs.writeFileSync(path.join(dir, 'app.js'),
      'const a = process.env.APP_NAME, r = process.env.RETRIES, d = process.env.DEBUG;\n'
      + 'const p = process.env.PORT, u = process.env.API_URL, e = process.env.SUPPORT_EMAIL;\n'
      + 'const t = process.env.SHUTDOWN_TIMEOUT, h = process.env.DB_HOST, f = process.env.FOO;\n');
    fs.writeFileSync(path.join(dir, '.env'),
      'APP_NAME=myapp\nRETRIES=3\nDEBUG=false\nPORT=3000\nAPI_URL=https://example.com\nSUPPORT_EMAIL=a@b.com\nSHUTDOWN_TIMEOUT=15m\nDB_HOST=localhost\nFOO=bar\n');
    const roundTrip = run(['check', dir, '--schema', './env.schema.js']);
    assert.strictEqual(roundTrip.status, 0, roundTrip.stdout + roundTrip.stderr);
    assert.ok(roundTrip.stdout.includes('all clean'), roundTrip.stdout);
    fs.rmSync(path.join(dir, '.env'));

    // A fresh directory (no code yet) behaves exactly as before: the same 8
    // starter keys, no scan comment, and no "folded in" line on stdout.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-init-fresh-'));
    try {
      const freshInit = run(['init', fresh]);
      assert.strictEqual(freshInit.status, 0, freshInit.stderr);
      assert.ok(freshInit.stdout.includes('(8 variables)'), freshInit.stdout);
      assert.ok(!freshInit.stdout.includes('folded in'), freshInit.stdout);
      const freshSchema = fs.readFileSync(path.join(fresh, 'env.schema.js'), 'utf8');
      assert.doesNotMatch(freshSchema, /Found by scanning/);
      const freshStarter = require(path.join(fresh, 'env.schema.js'));
      assert.deepStrictEqual(
        Object.keys(freshStarter),
        ['APP_NAME', 'RETRIES', 'DEBUG', 'PORT', 'API_URL', 'SUPPORT_EMAIL', 'SHUTDOWN_TIMEOUT', 'DB_HOST'],
      );
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #54: `sensitive: true` masks a key's value in all validation errors
// and CLI output, even when its name does not look like a secret.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');

  // 1. Invalid non-boolean `sensitive` option is rejected up front even when absent.
  for (const bad of ['true', 1, 0, null, {}]) {
    assert.throws(
      () => validateEnv({ SESSION_ID: { type: 'string', sensitive: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('SESSION_ID: "sensitive" must be a boolean'),
    );
  }

  // 2. Coercion errors across types never leak the raw value when sensitive: true.
  const coercionCases = [
    ['email', 'not-an-email-secret99'],
    ['number', 'not-a-number-secret99'],
    ['int', 'not-an-int-secret99'],
    ['json', '{bad-json-secret99'],
    ['boolean', 'not-a-bool-secret99'],
    ['url', 'not-a-url-secret99'],
    ['file', path.join(os.tmpdir(), 'env-saaf-missing-secret-file-99999')],
    ['uuid', 'not-a-uuid-secret99'],
    ['hex', 'not-hex-secret99'],
    ['ipv4', '999.999.999.999'],
    ['semver', 'v-secret-1.2.3'],
    ['base64', 'not*base64*secret99'],
    ['date', 'not-a-date-secret99'],
    ['duration', 'not-a-duration-secret99'],
    ['host', 'https://secret-host.internal/path'],
    ['port', '99999'],
  ];
  for (const [type, raw] of coercionCases) {
    assert.throws(
      () => validateEnv({ SESSION_ID: { type, sensitive: true } }, { SESSION_ID: raw }),
      err => err instanceof EnvSaafError
        && !err.message.includes(raw)
        && err.errors[0].includes(`got "${maskValue(raw)}"`),
      `expected masked error for type "${type}"`,
    );
  }
  // URL protocols mismatch also masks sensitive values.
  const badProtoUrl = 'http://secret-token-host.internal/callback';
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'url', protocols: ['https'], sensitive: true } }, { SESSION_ID: badProtoUrl }),
    err => err instanceof EnvSaafError
      && !err.message.includes(badProtoUrl)
      && err.errors[0].includes(`got "${maskValue(badProtoUrl)}"`),
  );

  // 3. Post-coercion rule checks (min/max, minLength/maxLength, length, choices, pattern, transform).
  assert.throws(
    () => validateEnv({ LICENSE_KEY: { type: 'int', min: 100000, sensitive: true } }, { LICENSE_KEY: '12345' }),
    err => err instanceof EnvSaafError && !err.message.includes('12345') && err.errors[0].includes('got "12***45"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', minLength: 30, sensitive: true } }, { SESSION_ID: 'sess_secret_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('sess_secret_99') && err.errors[0].includes('got "se***99"'),
  );
  assert.throws(
    () => validateEnv({ LICENSE_KEY: { type: 'hex', length: 32, sensitive: true } }, { LICENSE_KEY: 'deadbeef1234' }),
    err => err instanceof EnvSaafError && !err.message.includes('deadbeef1234') && err.errors[0].includes('got "de***34"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', choices: ['alpha', 'beta'], sensitive: true } }, { SESSION_ID: 'secret_gamma_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('secret_gamma_99') && err.errors[0].includes('got "se***99"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', pattern: /^sid_/, sensitive: true } }, { SESSION_ID: 'raw_secret_token_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('raw_secret_token_99') && err.errors[0].includes('got "ra***99"'),
  );
  // Throwing transform that echoes the value still does not leak the raw value.
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, transform: v => { throw new Error(`bad token ${v}`); } } },
      { SESSION_ID: 'raw_secret_token_99' },
    ),
    err => err instanceof EnvSaafError && !err.message.includes('raw_secret_token_99') && err.errors[0].includes('ra***99'),
  );

  // 4. Short sensitive values mask to '****' without leaking.
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int', sensitive: true } }, { SESSION_ID: 'bad!' }),
    err => err instanceof EnvSaafError && !err.message.includes('bad!') && err.errors[0].includes('got "****"'),
  );

  // 5. Valid sensitive values return the real unmasked value.
  const okRes = validateEnv(
    { SESSION_ID: { type: 'string', pattern: /^sid_/, sensitive: true } },
    { SESSION_ID: 'sid_real_value_123' },
  );
  assert.strictEqual(okRes.SESSION_ID, 'sid_real_value_123');

  // 6. Non-throwing mode masks sensitive values in errors too.
  const nonThrow = validateEnv(
    { SESSION_ID: { type: 'uuid', sensitive: true } },
    { SESSION_ID: 'sess_raw_secret_42' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrow.env, {});
  assert.strictEqual(nonThrow.errors.length, 1);
  assert.ok(!nonThrow.errors[0].includes('sess_raw_secret_42'));
  assert.ok(nonThrow.errors[0].includes('got "se***42"'));

  // 7. Non-sensitive control: sensitive omitted or false behaves identically to before.
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int' } }, { SESSION_ID: 'not-an-int-plain99' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SESSION_ID: expected an integer (e.g. 42), got "not-an-int-plain99"',
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int', sensitive: false } }, { SESSION_ID: 'not-an-int-plain99' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SESSION_ID: expected an integer (e.g. 42), got "not-an-int-plain99"',
  );

  // 8. maskSecrets masks innocuously-named keys as well.
  assert.deepStrictEqual(
    maskSecrets({ SESSION_ID: 'sess_raw_secret_42', LICENSE_KEY: 'lic_99887766' }),
    { SESSION_ID: 'se***42', LICENSE_KEY: 'li***66' },
  );

  // 9. generateExample leaves sensitive keys empty (unless default is set),
  // while non-sensitive innocuously-named keys keep their placeholder.
  const exSens = generateExample({
    SESSION_ID: { type: 'string', required: true, sensitive: true },
    PLAIN_ID: { type: 'string', required: true },
    SENS_DEFAULT: { type: 'string', sensitive: true, default: 'dev-placeholder' },
  });
  assert.match(exSens, /^SESSION_ID=$/m);
  assert.match(exSens, /^PLAIN_ID=your_value_here$/m);
  assert.match(exSens, /^SENS_DEFAULT=dev-placeholder$/m);

  // 10. loadEnv and CLI `check --schema` (text and --json) mask sensitive values.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-sensitive-'));
  try {
    const envFile = path.join(dir, '.env');
    const exampleFile = path.join(dir, '.env.example');
    const schemaFile = path.join(dir, 'env.schema.js');
    const secretVal = 'lic_super_secret_987654';
    fs.writeFileSync(envFile, `SESSION_ID=${secretVal}\n`);
    fs.writeFileSync(exampleFile, 'SESSION_ID=\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'const s = process.env.SESSION_ID;\n');
    fs.writeFileSync(schemaFile, "module.exports = { SESSION_ID: { type: 'uuid', required: true, sensitive: true } };\n");

    assert.throws(
      () => loadEnv({ SESSION_ID: { type: 'uuid', required: true, sensitive: true } }, { path: envFile, env: {} }),
      err => err instanceof EnvSaafError && !err.message.includes(secretVal) && err.errors[0].includes('got "li***54"'),
    );

    const cli = path.join(__dirname, 'cli.js');
    const textRun = spawnSync('node', [cli, 'check', dir, '--schema', './env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(textRun.status, 1);
    assert.ok(!textRun.stdout.includes(secretVal) && !textRun.stderr.includes(secretVal), textRun.stdout + textRun.stderr);
    assert.ok(textRun.stdout.includes('INVALID: SESSION_ID:') && textRun.stdout.includes('got "li***54"'), textRun.stdout);

    const jsonRun = spawnSync('node', [cli, 'check', dir, '--schema', './env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(jsonRun.status, 1);
    assert.ok(!jsonRun.stdout.includes(secretVal) && !jsonRun.stderr.includes(secretVal), jsonRun.stdout + jsonRun.stderr);
    const parsed = JSON.parse(jsonRun.stdout.trim());
    assert.strictEqual(parsed.ok, false);
    assert.ok(parsed.invalid[0].includes('got "li***54"'), parsed.invalid[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- requiredIf: conditionally required variables (issue #51) ---
{
  // 1. Up-front schema validation rejects malformed requiredIf specs,
  // even when the key is absent and even in non-throwing mode.
  for (const bad of [
    null,
    'MODE',
    123,
    true,
    [],
    {},
    { key: '' },
    { key: '   ' },
    { key: 42, equals: 'production' },
    { key: 'MODE' },
    { key: 'MODE', equals: undefined },
    { key: 'MODE', equals: 'production', in: ['production'] },
    { key: 'MODE', in: 'production' },
    { key: 'MODE', in: [] },
  ]) {
    assert.throws(
      () => validateEnv({ SENTRY_DSN: { type: 'url', requiredIf: bad } }, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError && err.errors.some(e => e.startsWith('SENTRY_DSN: "requiredIf')),
      `expected schema error for requiredIf=${JSON.stringify(bad)}`,
    );
  }

  // 2. Basic `equals`: missing + condition true throws the usual required error.
  const basicSchema = {
    MODE: { type: 'string', choices: ['development', 'staging', 'production'] },
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
  };
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Empty string is treated as unset, so it also triggers the required error.
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: '' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Provided valid value satisfies the condition.
  const prodOk = validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: 'https://sentry.example.com/1' });
  assert.strictEqual(prodOk.MODE, 'production');
  assert.strictEqual(prodOk.SENTRY_DSN, 'https://sentry.example.com/1');
  // Provided invalid value reports only the type error (no duplicate missing error).
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: 'not-a-url' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0].includes('SENTRY_DSN: expected a valid URL'),
  );
  // Condition false leaves the key optional and omitted.
  const devOk = validateEnv(basicSchema, { MODE: 'development' });
  assert.strictEqual(devOk.MODE, 'development');
  assert.strictEqual('SENTRY_DSN' in devOk, false);
  // Referenced key absent (or empty) leaves the key optional and omitted.
  const absentOk = validateEnv(basicSchema, {});
  assert.strictEqual('SENTRY_DSN' in absentOk, false);
  const emptyRefOk = validateEnv(basicSchema, { MODE: '' });
  assert.strictEqual('SENTRY_DSN' in emptyRefOk, false);
  // Optional key provided while condition is false is still validated.
  const devWithDsn = validateEnv(basicSchema, { MODE: 'development', SENTRY_DSN: 'https://sentry.example.com/dev' });
  assert.strictEqual(devWithDsn.SENTRY_DSN, 'https://sentry.example.com/dev');
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'development', SENTRY_DSN: 'bad-url' }),
    err => err instanceof EnvSaafError && err.errors[0].includes('SENTRY_DSN: expected a valid URL'),
  );

  // 3. `in: [...]` matches any listed value and stays optional otherwise.
  const inSchema = {
    MODE: { type: 'string' },
    ALERT_WEBHOOK: { type: 'url', requiredIf: { key: 'MODE', in: ['staging', 'production'] } },
  };
  for (const mode of ['staging', 'production']) {
    assert.throws(
      () => validateEnv(inSchema, { MODE: mode }),
      err => err instanceof EnvSaafError && err.errors[0] === 'ALERT_WEBHOOK: missing required variable',
    );
  }
  assert.strictEqual('ALERT_WEBHOOK' in validateEnv(inSchema, { MODE: 'development' }), false);
  assert.strictEqual('ALERT_WEBHOOK' in validateEnv(inSchema, {}), false);

  // 4. Two-pass evaluation: key declaration order does not matter, and
  // conditions see coerced values, defaults, and transforms from Pass 1.
  const reversedSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    MODE: { type: 'string', default: 'production' },
  };
  assert.throws(
    () => validateEnv(reversedSchema, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Boolean coercion (and falsy `equals: false`).
  const tlsSchema = {
    TLS_CERT: { type: 'string', requiredIf: { key: 'USE_TLS', equals: true } },
    DEV_NOTICE: { type: 'string', requiredIf: { key: 'USE_TLS', equals: false } },
    USE_TLS: { type: 'boolean', default: false },
  };
  assert.throws(
    () => validateEnv(tlsSchema, { USE_TLS: 'yes' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'TLS_CERT: missing required variable',
  );
  assert.throws(
    () => validateEnv(tlsSchema, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'DEV_NOTICE: missing required variable',
  );
  // Numeric coercion with `in`.
  const retrySchema = {
    RETRY_BACKOFF: { type: 'duration', requiredIf: { key: 'RETRIES', in: [1, 2, 3] } },
    RETRIES: { type: 'int' },
  };
  assert.throws(
    () => validateEnv(retrySchema, { RETRIES: '2' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'RETRY_BACKOFF: missing required variable',
  );
  assert.strictEqual('RETRY_BACKOFF' in validateEnv(retrySchema, { RETRIES: '0' }), false);
  // Transform on referenced key is visible in Pass 2.
  const transformSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    MODE: { type: 'string', transform: v => v.toLowerCase() },
  };
  assert.throws(
    () => validateEnv(transformSchema, { MODE: 'PRODUCTION' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // If the referenced key failed Pass 1 validation, Pass 2 does not emit a spurious error.
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'invalid' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0].includes('MODE: expected one of'),
  );
  // Referenced key outside the schema falls back to raw `env`.
  const externalRefSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'NODE_ENV', equals: 'production' } },
  };
  assert.throws(
    () => validateEnv(externalRefSchema, { NODE_ENV: 'production' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  assert.strictEqual('SENTRY_DSN' in validateEnv(externalRefSchema, { NODE_ENV: 'test' }), false);
  assert.strictEqual('SENTRY_DSN' in validateEnv(externalRefSchema, {}), false);

  // 5. Interaction with `default`, `required: true`, `throwOnError: false`, and `loadEnv`.
  const withDefault = validateEnv(
    {
      MODE: { type: 'string', default: 'production' },
      SENTRY_DSN: { type: 'url', default: 'https://sentry.example.com/default', requiredIf: { key: 'MODE', equals: 'production' } },
    },
    {},
  );
  assert.strictEqual(withDefault.SENTRY_DSN, 'https://sentry.example.com/default');

  // Issue #204: combining `required: true` and `requiredIf` is rejected up front
  // as a schema error instead of silently letting `required` win.
  assert.throws(
    () => validateEnv(
      {
        MODE: { type: 'string', default: 'production' },
        SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } },
      },
      {},
    ),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: "required" and "requiredIf" cannot be used together (use one or the other)',
  );

  // Non-throwing mode collects the conditional required error alongside validated values.
  const collected = validateEnv(
    {
      MODE: { type: 'string', default: 'production' },
      PORT: { type: 'port', default: 3000 },
      SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    },
    {},
    { throwOnError: false },
  );
  assert.deepStrictEqual(collected.env, { MODE: 'production', PORT: 3000 });
  assert.deepStrictEqual(collected.errors, ['SENTRY_DSN: missing required variable']);

  // loadEnv enforces requiredIf from loaded .env files.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-required-if-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'MODE=production\n');
    assert.throws(
      () => loadEnv(basicSchema, { path: envFile, env: {} }),
      err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
    );
    fs.writeFileSync(envFile, 'MODE=production\nSENTRY_DSN=https://sentry.example.com/live\n');
    const loaded = loadEnv(basicSchema, { path: envFile, env: {} });
    assert.strictEqual(loaded.SENTRY_DSN, 'https://sentry.example.com/live');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// Issue #204: `required` + `requiredIf` contradict each other, and a self-referencing `requiredIf` never fires.
{
  // `required: true` together with `requiredIf` is rejected up front —
  // `required` would otherwise silently win and the condition would be dead config.
  assert.throws(
    () => validateEnv(
      {
        MODE: { type: 'string', default: 'dev' },
        SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } },
      },
      { MODE: 'dev' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.includes('SENTRY_DSN: "required" and "requiredIf" cannot be used together (use one or the other)'),
  );
  // Schema errors still throw with `{ throwOnError: false }`.
  assert.throws(
    () => validateEnv(
      { SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } } },
      {},
      { throwOnError: false },
    ),
    err => err instanceof EnvSaafError,
  );
  // A `requiredIf` naming its own key is rejected up front.
  assert.throws(
    () => validateEnv(
      { MODE: { type: 'string', requiredIf: { key: 'MODE', equals: 'production' } } },
      {},
    ),
    err => err instanceof EnvSaafError
      && err.errors.includes('MODE: "requiredIf" must name a different key, not itself'),
  );
  // A well-formed `requiredIf` still works (regression guard).
  assert.deepStrictEqual(
    validateEnv(
      {
        MODE: { type: 'string', default: 'development' },
        SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
      },
      { MODE: 'development' },
    ),
    { MODE: 'development' },
  );
}

// Issue #340: `required: true` with a `default` is dead config — the default
// means the key is never missing — so the schema is rejected up front.
{
  const message = 'PORT: "required" and "default" cannot be used together (remove one of them)';
  assert.throws(
    () => validateSchema({ PORT: { type: 'port', required: true, default: 3000 } }),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0] === message,
  );
  // Falsy defaults count too, and it is a schema error even with throwOnError: false.
  assert.throws(
    () => validateEnv({ DEBUG: { type: 'boolean', required: true, default: false } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError
      && err.errors[0] === 'DEBUG: "required" and "default" cannot be used together (remove one of them)',
  );
  // Inside a group the error names the full env var.
  assert.throws(
    () => validateEnv({ DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true, default: 'localhost' } } } }, {}),
    err => err instanceof EnvSaafError
      && err.errors.includes('DB_HOST: "required" and "default" cannot be used together (remove one of them)'),
  );
  // Only one of the two, `required: false`, or `requiredIf` + `default` are still fine.
  assert.doesNotThrow(() => validateSchema({
    A: { type: 'port', required: true },
    B: { type: 'port', default: 3000 },
    C: { type: 'port', required: false, default: 3000 },
    MODE: { type: 'string', default: 'dev' },
    D: { type: 'url', default: 'https://example.com', requiredIf: { key: 'MODE', equals: 'production' } },
  }));
}

// Issue #46: `array` type — split a delimited string into a typed array.
{
  // 1. Default `of: 'string'` and explicit `of: 'string'`, trimming items by default.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', of: 'string', required: true } }, { TAGS: 'a,b,c' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', required: true } }, { TAGS: ' a , b , c ' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array' } }, { TAGS: 'solo' }).TAGS,
    ['solo'],
  );
  // trim: false preserves surrounding whitespace on each item.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', of: 'string', trim: false } }, { TAGS: ' a , b ' }).TAGS,
    [' a ', ' b '],
  );

  // 2. Custom separators (single-character and multi-character).
  assert.deepStrictEqual(
    validateEnv({ PORTS: { type: 'array', of: 'port', separator: ';' } }, { PORTS: '80;443;8080' }).PORTS,
    [80, 443, 8080],
  );
  assert.deepStrictEqual(
    validateEnv({ PATHS: { type: 'array', separator: '::' } }, { PATHS: 'alpha::beta::gamma' }).PATHS,
    ['alpha', 'beta', 'gamma'],
  );

  // 3. Coercion across scalar `of` types (number, int, boolean, url + protocols, email, duration, date).
  const typed = validateEnv({
    NUMS: { type: 'array', of: 'number', required: true },
    INTS: { type: 'array', of: 'int', required: true },
    FLAGS: { type: 'array', of: 'boolean', required: true },
    ORIGINS: { type: 'array', of: 'url', protocols: ['https'], required: true },
    EMAILS: { type: 'array', of: 'email', required: true },
    TIMEOUTS: { type: 'array', of: 'duration', required: true },
    DATES: { type: 'array', of: 'date', required: true },
  }, {
    NUMS: '1.5, 2, -3.25',
    INTS: '10, 20, 30',
    FLAGS: 'true, no, 1, off',
    ORIGINS: 'https://a.example.com, https://b.example.com',
    EMAILS: 'admin@example.com, ops@example.com',
    TIMEOUTS: '500ms, 2s, 1m',
    DATES: '2026-01-31, 2026-02-01',
  });
  assert.deepStrictEqual(typed.NUMS, [1.5, 2, -3.25]);
  assert.deepStrictEqual(typed.INTS, [10, 20, 30]);
  assert.deepStrictEqual(typed.FLAGS, [true, false, true, false]);
  assert.deepStrictEqual(typed.ORIGINS, ['https://a.example.com', 'https://b.example.com']);
  assert.deepStrictEqual(typed.EMAILS, ['admin@example.com', 'ops@example.com']);
  assert.deepStrictEqual(typed.TIMEOUTS, [500, 2000, 60000]);
  assert.strictEqual(typed.DATES.length, 2);
  assert.ok(typed.DATES.every(d => d instanceof Date));

  // 4. Invalid items report their 0-based index and offending value.
  assert.throws(
    () => validateEnv({ PORTS: { type: 'array', of: 'port' } }, { PORTS: '80,abc,443' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('PORTS[1]')
      && err.errors[0].includes('expected a port')
      && err.errors[0].includes('got "abc"'),
  );
  assert.throws(
    () => validateEnv({ ORIGINS: { type: 'array', of: 'url', protocols: ['https'] } }, { ORIGINS: 'https://a.com,http://b.com' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('ORIGINS[1]')
      && err.errors[0].includes('protocols (https)')
      && err.errors[0].includes('got "http://b.com"'),
  );

  // 5. Empty items are rejected (not silently dropped) with their index and value.
  for (const [raw, expectedIndex] of [['a,,c', 1], ['a,   ,c', 1], [',a,b', 0], ['a,b,', 2]]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', of: 'string' } }, { TAGS: raw }),
      err => err instanceof EnvSaafError
        && err.errors[0].includes(`TAGS[${expectedIndex}]`)
        && err.errors[0].includes('expected a non-empty value'),
    );
  }
  assert.throws(
    () => validateEnv({ INTS: { type: 'array', of: 'int' } }, { INTS: '1,,3' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('INTS[1]')
      && err.errors[0].includes('expected an integer')
      && err.errors[0].includes('got ""'),
  );

  // 6. Defaults: delimited string, already-parsed array (including empty []), and invalid defaults.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', default: 'x,y' } }, {}).TAGS,
    ['x', 'y'],
  );
  assert.deepStrictEqual(
    validateEnv({ PORTS: { type: 'array', of: 'port', default: [80, 443] } }, {}).PORTS,
    [80, 443],
  );
  assert.deepStrictEqual(
    validateEnv({ FLAGS: { type: 'array', of: 'string', default: [] } }, {}).FLAGS,
    [],
  );
  assert.throws(
    () => validateEnv({ PORTS: { type: 'array', of: 'port', default: [80, 'bad'] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('PORTS[1]') && err.errors[0].includes('got "bad"'),
  );
  assert.throws(
    () => validateEnv({ NUMS: { type: 'array', of: 'number', default: [1, null] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('NUMS[1]') && err.errors[0].includes('expected a number'),
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', default: 123 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('expected a delimited list'),
  );

  // 7. Missing optional array is omitted; missing required array fails.
  assert.deepStrictEqual(validateEnv({ TAGS: { type: 'array' } }, {}), {});
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', required: true } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: missing required variable',
  );

  // 8. `sensitive: true` masks offending item values without leaking secrets.
  const secretItem = 'secret_bad_token_99';
  assert.throws(
    () => validateEnv(
      { TOKENS: { type: 'array', of: 'uuid', sensitive: true } },
      { TOKENS: `550e8400-e29b-41d4-a716-446655440000,${secretItem}` },
    ),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('TOKENS[1]')
      && !err.message.includes(secretItem)
      && err.errors[0].includes(`got "${maskValue(secretItem)}"`),
  );

  // 9. Up-front schema validation rejects invalid `of` and `separator` even when key is absent.
  for (const badOf of ['unknown', 'array', 123, null, {}]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', of: badOf } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].includes('TAGS: "of" must be a valid item type'),
    );
  }
  for (const badSep of ['', 123, null, []]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', separator: badSep } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].includes('TAGS: "separator" must be a non-empty string'),
    );
  }

  // 10. Transform and non-throwing mode work with `array`.
  const transformed = validateEnv(
    { TAGS: { type: 'array', of: 'string', transform: xs => xs.map(s => s.toUpperCase()) } },
    { TAGS: 'a,b' },
  );
  assert.deepStrictEqual(transformed.TAGS, ['A', 'B']);
  const nonThrowArr = validateEnv(
    { PORTS: { type: 'array', of: 'port' }, TAGS: { type: 'array' } },
    { PORTS: '80,nope', TAGS: 'x,y' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrowArr.env, { TAGS: ['x', 'y'] });
  assert.strictEqual(nonThrowArr.errors.length, 1);
  assert.ok(nonThrowArr.errors[0].includes('PORTS[1]'));

  // 11. `minItems` / `maxItems` bound the item count (issue #207).
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 2 } }, { TAGS: 'a,b' }).TAGS,
    ['a', 'b'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', maxItems: 2 } }, { TAGS: 'a,b' }).TAGS,
    ['a', 'b'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 2, maxItems: 3 } }, { TAGS: 'a,b,c' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 1, maxItems: 1 } }, { TAGS: 'solo' }).TAGS,
    ['solo'],
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2 } }, { TAGS: 'only-one' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 2 items, got 1',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', maxItems: 2 } }, { TAGS: 'a,b,c' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at most 2 items, got 3',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2, maxItems: 3 } }, { TAGS: 'a,b,c,d' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected 2–3 items, got 4',
  );
  // Bounds apply to defaults too, and to an empty array default.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 1, maxItems: 2, default: ['x'] } }, {}).TAGS,
    ['x'],
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2, default: ['x'] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 2 items, got 1',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 1, default: [] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 1 items, got 0',
  );
  // Malformed options are rejected up front, even when the key is absent.
  for (const bad of [{ minItems: -1 }, { maxItems: -2 }, { minItems: 1.5 }, { maxItems: '3' }, { minItems: 3, maxItems: 2 }]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', ...bad } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].startsWith('TAGS:'),
    );
  }
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 3, maxItems: 2 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" must not exceed "maxItems"'),
  );
  assert.throws(
    () => validateEnv({ NAME: { type: 'string', minItems: 1 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" and "maxItems" only apply to type \'array\''),
  );
  assert.throws(
    () => validateEnv({ N: { type: 'int', maxItems: 2 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" and "maxItems" only apply to type \'array\''),
  );

  // 11b. `unique: true` rejects repeated items (issue #291).
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', unique: true } }, { TAGS: 'a,b,c' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ IDS: { type: 'array', of: 'int', unique: true } }, { IDS: '1,2,3' }).IDS,
    [1, 2, 3],
  );
  // Off by default: the same values pass without the option.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array' } }, { TAGS: 'a,a,b' }).TAGS,
    ['a', 'a', 'b'],
  );
  // Duplicates are compared after item coercion: '1,01' is a duplicate for of: 'int'.
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', unique: true } }, { TAGS: 'a,a,b' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: duplicate value "a" (unique: true)',
  );
  assert.throws(
    () => validateEnv({ IDS: { type: 'array', of: 'int', unique: true } }, { IDS: '1,01,2' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'IDS: duplicate value "1" (unique: true)',
  );
  // The duplicated value is masked when the rule is sensitive.
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', unique: true, sensitive: true } }, { TAGS: 'secret,secret' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: duplicate value "se***et" (unique: true)',
  );
  // Applies to defaults too, and non-throwing mode collects the error.
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', unique: true, default: ['x', 'x'] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: duplicate value "x" (unique: true)',
  );
  const collectedUnique = validateEnv({ TAGS: { type: 'array', unique: true } }, { TAGS: 'a,a' }, { throwOnError: false });
  assert.deepStrictEqual(collectedUnique.env, {});
  assert.deepStrictEqual(collectedUnique.errors, ['TAGS: duplicate value "a" (unique: true)']);
  // Malformed option and use on a non-array rule are rejected up front.
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', unique: 'yes' } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"unique" must be a boolean'),
  );
  assert.throws(
    () => validateEnv({ NAME: { type: 'string', unique: true } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"unique" only applies to type \'array\''),
  );
  // toJsonSchema renders the option as uniqueItems.
  assert.deepStrictEqual(
    toJsonSchema({ TAGS: { type: 'array', unique: true } }).properties.TAGS,
    { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
  );
  assert.deepStrictEqual(
    toJsonSchema({ TAGS: { type: 'array' } }).properties.TAGS,
    { type: 'array', items: { type: 'string', minLength: 1 } },
  );

  // 12. generateExample produces a delimited placeholder (respecting separator, array default, and sensitive).
  const exArr = generateExample({
    TAGS: { type: 'array', required: true },
    PORTS: { type: 'array', of: 'port', separator: ';' },
    DEFAULTS: { type: 'array', of: 'port', separator: ';', default: [80, 443] },
    SECRET_LIST: { type: 'array', sensitive: true },
  });
  assert.match(exArr, /^TAGS=a,b,c$/m);
  // Issue #223: port items get port examples (previously the invalid 'a;b;c').
  assert.match(exArr, /^PORTS=3000;8080;5432$/m);
  assert.match(exArr, /^DEFAULTS=80;443$/m);
  assert.match(exArr, /^SECRET_LIST=$/m);
}
// Issue #205: aliases must not populate multiple declared keys.
{
  const cases = [
    [{ A: { aliases: ['B'] }, B: { type: 'string' } }, 'A', 'B'],
    [{ B: { type: 'string' }, A: { aliases: ['B'] } }, 'A', 'B'],
    [{ A: { aliases: ['SHARED'] }, B: { aliases: ['SHARED'] } }, 'B', 'SHARED'],
    [{ A: { aliases: ['A'] } }, 'A', 'A'],
    [{ A: { aliases: ['__proto__'] }, ['__proto__']: { type: 'string' } }, 'A', '__proto__'],
    [{ A: { aliases: ['toString'] }, B: { aliases: ['toString'] } }, 'B', 'toString'],
  ];
  for (const [schema, key, alias] of cases) {
    for (const throwOnError of [true, false]) {
      assert.throws(
        () => validateEnv(schema, {}, { throwOnError }),
        err => err instanceof EnvSaafError
          && err.errors.some(message => message.startsWith(`${key}:`) && message.includes(`"${alias}"`)),
        `expected alias collision for ${key}/${alias} with throwOnError=${throwOnError}`,
      );
    }
  }
}

// Issue #53: `aliases` accepts renamed/deprecated variables as fallbacks and warns.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');

  // 1. Schema validation rejects malformed `aliases` up front even when absent.
  for (const bad of ['OLD_NAME', 123, null, {}, [''], ['   '], [123], [null], ['OK', '']]) {
    assert.throws(
      () => validateEnv({ DATABASE_URL: { type: 'url', aliases: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('DATABASE_URL: "aliases" must be an array of non-empty strings'),
      `expected schema error for aliases=${JSON.stringify(bad)}`,
    );
  }
  // Empty array is a valid no-op.
  assert.deepStrictEqual(validateEnv({ A: { type: 'string', aliases: [] } }, {}), {});

  // 2. Non-function `onWarn` throws TypeError.
  assert.throws(
    () => validateEnv({ A: { type: 'string', aliases: ['OLD_A'] } }, {}, { onWarn: 'nope' }),
    TypeError,
  );

  // 3. Alias-only config validates, coerces, transforms, and yields under canonical key.
  {
    const warnings = [];
    const res = validateEnv(
      {
        PORT: { type: 'port', required: true, aliases: ['APP_PORT'] },
        ORIGINS: {
          type: 'array',
          aliases: ['CORS_ORIGINS'],
          transform: xs => xs.map(s => s.toLowerCase()),
        },
      },
      { APP_PORT: '8080', CORS_ORIGINS: 'A.COM, B.COM' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 8080);
    assert.deepStrictEqual(res.ORIGINS, ['a.com', 'b.com']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'APP_PORT'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'CORS_ORIGINS'), false);
    assert.deepStrictEqual(warnings, [
      'env-saaf: APP_PORT is deprecated; use PORT instead',
      'env-saaf: CORS_ORIGINS is deprecated; use ORIGINS instead',
    ]);
  }

  // 4. Default warning sink uses console.warn once per warning.
  {
    const origWarn = console.warn;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));
    try {
      const res = validateEnv(
        { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
        { DB_URL: 'https://db.example.com' },
      );
      assert.strictEqual(res.DATABASE_URL, 'https://db.example.com');
      assert.deepStrictEqual(logged, ['env-saaf: DB_URL is deprecated; use DATABASE_URL instead']);
    } finally {
      console.warn = origWarn;
    }
  }

  // 5. Both canonical key and alias set: canonical key wins and warning notes alias is ignored.
  {
    const warnings = [];
    const res = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL', 'LEGACY_DB_URL'] } },
      { DATABASE_URL: 'https://new.example.com', DB_URL: 'https://old.example.com' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.DATABASE_URL, 'https://new.example.com');
    assert.deepStrictEqual(warnings, ['env-saaf: DB_URL is ignored because DATABASE_URL is set']);
  }

  // 6. Only canonical key set: no warnings.
  {
    const warnings = [];
    const res = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
      { DATABASE_URL: 'https://new.example.com' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.DATABASE_URL, 'https://new.example.com');
    assert.deepStrictEqual(warnings, []);
  }

  // 7. Multiple aliases: first populated alias wins, subsequent populated aliases warn as ignored.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', aliases: ['OLD_PORT_1', 'OLD_PORT_2', 'OLD_PORT_3'] } },
      { OLD_PORT_1: '', OLD_PORT_2: '4000', OLD_PORT_3: '5000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 4000);
    assert.deepStrictEqual(warnings, [
      'env-saaf: OLD_PORT_2 is deprecated; use PORT instead',
      'env-saaf: OLD_PORT_3 is ignored because OLD_PORT_2 is set; use PORT instead',
    ]);
  }

  // 8. Empty canonical key ('') falls back to alias; empty alias ('') is treated as unset.
  {
    const warnings = [];
    const res = validateEnv(
      {
        HOST: { type: 'host', aliases: ['APP_HOST'] },
        MODE: { type: 'string', default: 'dev', aliases: ['APP_MODE'] },
      },
      { HOST: '', APP_HOST: 'localhost', APP_MODE: '' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.HOST, 'localhost');
    assert.strictEqual(res.MODE, 'dev');
    assert.deepStrictEqual(warnings, ['env-saaf: APP_HOST is deprecated; use HOST instead']);
  }

  // 9. Alias wins over default; missing canonical + alias still fails required without warning.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', default: 3000, aliases: ['APP_PORT'] } },
      { APP_PORT: '9000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 9000);
    assert.strictEqual(warnings.length, 1);

    const reqWarnings = [];
    assert.throws(
      () => validateEnv(
        { PORT: { type: 'port', required: true, aliases: ['APP_PORT'] } },
        {},
        { onWarn: msg => reqWarnings.push(msg) },
      ),
      err => err instanceof EnvSaafError && err.errors.includes('PORT: missing required variable'),
    );
    assert.deepStrictEqual(reqWarnings, []);
  }

  // 10. Invalid alias value reports error under canonical key and respects `sensitive: true`.
  {
    const warnings = [];
    assert.throws(
      () => validateEnv(
        { SESSION_ID: { type: 'uuid', sensitive: true, aliases: ['OLD_SESSION_ID'] } },
        { OLD_SESSION_ID: 'not-a-uuid-secret99' },
        { onWarn: msg => warnings.push(msg) },
      ),
      err => err instanceof EnvSaafError
        && !err.message.includes('not-a-uuid-secret99')
        && err.errors[0].startsWith('SESSION_ID:')
        && err.errors[0].includes('got "no***99"'),
    );
    assert.deepStrictEqual(warnings, ['env-saaf: OLD_SESSION_ID is deprecated; use SESSION_ID instead']);
  }

  // 11. Strict mode recognises declared aliases and still flags unknown variables.
  {
    const warnings = [];
    const okStrict = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
      { DB_URL: 'https://db.example.com' },
      { strict: true, onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(okStrict.DATABASE_URL, 'https://db.example.com');
    assert.strictEqual(warnings.length, 1);

    assert.throws(
      () => validateEnv(
        { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
        { DB_URL: 'https://db.example.com', TYPO_KEY: '1' },
        { strict: true, onWarn: () => {} },
      ),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'TYPO_KEY: set but not in schema (strict mode)',
    );
  }

  // 12. Repeating an alias on the same rule does not emit duplicate warnings.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', aliases: ['APP_PORT', 'APP_PORT'] } },
      { PORT: '3000', APP_PORT: '4000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 3000);
    assert.deepStrictEqual(warnings, ['env-saaf: APP_PORT is ignored because PORT is set']);
  }

  // 13. Non-throwing mode preserves `{ env, errors }` shape and emits warnings via `onWarn`.
  {
    const warnings = [];
    const collected = validateEnv(
      { PORT: { type: 'port', required: true, aliases: ['APP_PORT'] } },
      { APP_PORT: '3000' },
      { throwOnError: false, onWarn: msg => warnings.push(msg) },
    );
    assert.deepStrictEqual(collected, { env: { PORT: 3000 }, errors: [], details: [] });
    assert.deepStrictEqual(warnings, ['env-saaf: APP_PORT is deprecated; use PORT instead']);
  }

  // 14. loadEnv passes `onWarn` through and resolves aliases from a `.env` file.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-aliases-'));
    try {
      const envFile = path.join(dir, '.env');
      fs.writeFileSync(envFile, 'OLD_PORT=7070\n');
      const warnings = [];
      const res = loadEnv(
        { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
        { path: envFile, env: {}, onWarn: msg => warnings.push(msg) },
      );
      assert.strictEqual(res.PORT, 7070);
      assert.deepStrictEqual(warnings, ['env-saaf: OLD_PORT is deprecated; use PORT instead']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
// Issue #186: validateEnv treats an empty string ('') as unset across
// optional, required, and default rules, while whitespace-only input is provided.
{
  const optional = validateEnv({ NICK: { type: 'string' } }, { NICK: '' });
  assert.deepStrictEqual(optional, {});
  assert.strictEqual(Object.prototype.hasOwnProperty.call(optional, 'NICK'), false);

  assert.throws(
    () => validateEnv({ PORT: { type: 'port', required: true } }, { PORT: '' }),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0] === 'PORT: missing required variable',
  );

  const defaulted = validateEnv(
    {
      HOST: { type: 'string', default: 'localhost' },
      PORT: { type: 'port', default: 3000 },
    },
    { HOST: '', PORT: '' },
  );
  assert.deepStrictEqual(defaulted, { HOST: 'localhost', PORT: 3000 });

  // Whitespace-only is provided, not unset: trimmed to '' by default, preserved with trim: false.
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string' } }, { NICK: '   ' }), { NICK: '' });
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string', trim: false } }, { NICK: '   ' }), { NICK: '   ' });

  // parseEnvFile preserves KEY= as '', which validateEnv then treats as unset.
  const parsed = parseEnvFile('NICK=\n');
  assert.deepStrictEqual(parsed, { NICK: '' });
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string' } }, parsed), {});
}

// Issue #52: per-key `validate(value, env)` function for custom rules.
{
  // 1. Non-function `validate` is rejected up front in validateSchema,
  // even when the key is absent/optional and even with throwOnError: false.
  for (const bad of ['fn', 123, true, null, {}]) {
    assert.throws(
      () => validateEnv({ CUSTOM: { type: 'string', validate: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('CUSTOM: "validate" must be a function'),
    );
    assert.throws(
      () => validateEnv({ CUSTOM: { type: 'string', validate: bad } }, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError
        && err.errors.includes('CUSTOM: "validate" must be a function'),
    );
  }

  // 2. Passing return values: true, undefined, null, and empty string.
  const passRes = validateEnv(
    {
      A: { type: 'string', validate: () => true },
      B: { type: 'string', validate: () => undefined },
      C: { type: 'string', validate: () => null },
      D: { type: 'string', validate: () => '' },
    },
    { A: 'a', B: 'b', C: 'c', D: 'd' },
  );
  assert.deepStrictEqual(passRes, { A: 'a', B: 'b', C: 'c', D: 'd' });

  // 3. Failing return values: string message and boolean false.
  assert.throws(
    () => validateEnv(
      { APP_PORT: { type: 'port', validate: v => v >= 1024 || 'must be an unprivileged port (>= 1024)' } },
      { APP_PORT: '80' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'APP_PORT: must be an unprivileged port (>= 1024)',
  );
  assert.throws(
    () => validateEnv(
      { APP_PORT: { type: 'port', validate: v => v >= 1024 } },
      { APP_PORT: '80' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'APP_PORT: failed custom validation, got "80"',
  );

  // 4. Receives coerced value and full env object (cross-key checks).
  let seenVal, seenEnv;
  const inputEnv = { PRIMARY_HOST: 'db1.internal', REPLICA_HOST: 'db2.internal', CONFIG: '{"retries":3}' };
  const crossOk = validateEnv(
    {
      PRIMARY_HOST: { type: 'host', required: true },
      REPLICA_HOST: {
        type: 'host',
        required: true,
        validate: (v, e) => v !== e.PRIMARY_HOST || 'must differ from PRIMARY_HOST',
      },
      CONFIG: {
        type: 'json',
        validate: (v, e) => { seenVal = v; seenEnv = e; return v.retries > 0 || 'retries must be positive'; },
      },
    },
    inputEnv,
  );
  assert.strictEqual(crossOk.REPLICA_HOST, 'db2.internal');
  assert.deepStrictEqual(seenVal, { retries: 3 });
  assert.strictEqual(seenEnv, inputEnv);

  assert.throws(
    () => validateEnv(
      {
        PRIMARY_HOST: { type: 'host', required: true },
        REPLICA_HOST: {
          type: 'host',
          required: true,
          validate: (v, e) => v !== e.PRIMARY_HOST || 'must differ from PRIMARY_HOST',
        },
      },
      { PRIMARY_HOST: 'db1.internal', REPLICA_HOST: 'db1.internal' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'REPLICA_HOST: must differ from PRIMARY_HOST',
  );

  // 5. Throwing validator is reported as a validation failure, not a crash.
  assert.throws(
    () => validateEnv(
      {
        DIR: { type: 'string', validate: () => { throw new Error('directory does not exist'); } },
        NON_ERR: { type: 'string', validate: () => { throw 'raw string throw'; } },
      },
      { DIR: '/nope', NON_ERR: 'x' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 2
      && err.errors[0] === 'DIR: validation failed: directory does not exist'
      && err.errors[1] === 'NON_ERR: validation failed: raw string throw',
  );

  // 6. Aggregated errors: built-in failures and custom validate failures collect together.
  assert.throws(
    () => validateEnv(
      {
        REQ: { type: 'string', required: true },
        BAD_PORT: { type: 'port' },
        CUSTOM_STR: { type: 'string', validate: () => 'custom reason' },
        CUSTOM_FALSE: { type: 'int', validate: () => false },
        CUSTOM_THROW: { type: 'string', validate: () => { throw new Error('boom'); } },
      },
      { BAD_PORT: 'nope', CUSTOM_STR: 'a', CUSTOM_FALSE: '7', CUSTOM_THROW: 'b' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 5
      && err.errors[0] === 'REQ: missing required variable'
      && err.errors[1].startsWith('BAD_PORT: expected a port')
      && err.errors[2] === 'CUSTOM_STR: custom reason'
      && err.errors[3] === 'CUSTOM_FALSE: failed custom validation, got "7"'
      && err.errors[4] === 'CUSTOM_THROW: validation failed: boom',
  );

  // 7. Execution order:
  // - skipped for missing optional keys and when coercion/built-in checks fail
  // - runs before transform; transform is skipped when validate fails
  // - runs on defaults (while transform is still skipped on defaults)
  let calledOnMissing = false;
  let calledAfterBadCoercion = false;
  let calledAfterBadBuiltin = false;
  validateEnv(
    { OPT: { type: 'string', validate: () => { calledOnMissing = true; return true; } } },
    {},
  );
  assert.strictEqual(calledOnMissing, false);

  assert.throws(
    () => validateEnv(
      {
        N: { type: 'int', validate: () => { calledAfterBadCoercion = true; return true; } },
        M: { type: 'int', min: 10, validate: () => { calledAfterBadBuiltin = true; return true; } },
      },
      { N: 'abc', M: '5' },
    ),
    err => err instanceof EnvSaafError && err.errors.length === 2,
  );
  assert.strictEqual(calledAfterBadCoercion, false);
  assert.strictEqual(calledAfterBadBuiltin, false);

  const order = [];
  const transformedRes = validateEnv(
    {
      LIST: {
        type: 'array',
        validate: xs => { order.push(['validate', xs]); return xs.length >= 2 || 'needs two'; },
        transform: xs => { order.push(['transform', xs]); return xs.map(s => s.toUpperCase()); },
      },
    },
    { LIST: 'a,b' },
  );
  assert.deepStrictEqual(transformedRes.LIST, ['A', 'B']);
  assert.deepStrictEqual(order, [['validate', ['a', 'b']], ['transform', ['a', 'b']]]);

  let transformCalledAfterFail = false;
  assert.throws(
    () => validateEnv(
      {
        LIST: {
          type: 'string',
          validate: () => 'bad list',
          transform: v => { transformCalledAfterFail = true; return v.toUpperCase(); },
        },
      },
      { LIST: 'a' },
    ),
    err => err instanceof EnvSaafError && err.errors[0] === 'LIST: bad list',
  );
  assert.strictEqual(transformCalledAfterFail, false);

  let defaultTransformCalled = false;
  const defaultOk = validateEnv(
    {
      PORT: {
        type: 'port',
        default: 8080,
        validate: v => v >= 1024 || 'too low',
        transform: v => { defaultTransformCalled = true; return v; },
      },
    },
    {},
  );
  assert.strictEqual(defaultOk.PORT, 8080);
  assert.strictEqual(defaultTransformCalled, false);

  assert.throws(
    () => validateEnv(
      { PORT: { type: 'port', default: 80, validate: v => v >= 1024 || 'default too low' } },
      {},
    ),
    err => err instanceof EnvSaafError && err.errors[0] === 'PORT: default too low',
  );

  // 8. `sensitive: true` masks values across false, string, and thrown validate errors.
  const secret = 'sess_secret_token_99';
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: () => false } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: failed custom validation, got "${maskValue(secret)}"`,
  );
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: v => `rejected ${v}` } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: rejected ${maskValue(secret)}`,
  );
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: v => { throw new Error(`bad ${v}`); } } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: validation failed: bad ${maskValue(secret)}`,
  );

  // 9. Non-throwing mode collects validate errors and omits failing keys from env.
  const collected = validateEnv(
    {
      GOOD: { type: 'int', validate: v => v > 0 },
      BAD: { type: 'int', validate: v => v > 10 || 'must exceed 10' },
    },
    { GOOD: '5', BAD: '3' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(collected.env, { GOOD: 5 });
  assert.deepStrictEqual(collected.errors, ['BAD: must exceed 10']);
}

// Issue #210: post-transform return value is verified against the declared type.
{
  const { validateEnv, EnvSaafError, maskValue } = require('./index');

  // 1. Acceptance criteria: int transform returning string, string/omitted-type returning number.
  assert.throws(
    () => validateEnv({ N: { type: 'int', transform: () => 'oops' } }, { N: '5' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('N:')
      && err.errors[0].includes('integer'),
  );
  assert.throws(
    () => validateEnv({ A: { type: 'string', transform: () => 42 } }, { A: 'x' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('A:')
      && err.errors[0].includes('string'),
  );
  assert.throws(
    () => validateEnv({ A: { transform: () => 42 } }, { A: 'x' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('A:')
      && err.errors[0].includes('string'),
  );

  // 2. Transforms returning valid values of the declared type pass unchanged
  // (and post-transform values do not re-run choices/min/max/pattern).
  const fixedDate = new Date('2026-06-01T00:00:00Z');
  const valid = validateEnv(
    {
      S: { type: 'string', choices: ['a', 'b'], transform: v => v.toUpperCase() },
      N: { type: 'number', min: 1, max: 10, transform: n => n * 10.5 },
      I: { type: 'int', transform: n => n + 1 },
      P: { type: 'port', transform: n => n + 1 },
      D: { type: 'duration', transform: ms => ms * 2 },
      B: { type: 'boolean', transform: b => !b },
      DT: { type: 'date', transform: () => fixedDate },
      J: { type: 'json', transform: v => ({ wrapped: v }) },
      J_NULL: { type: 'json', transform: () => null },
      ARR: { type: 'array', of: 'int', transform: xs => xs.map(x => x * 2) },
      EMAIL: { type: 'email', transform: v => v.toLowerCase() },
      URL: { type: 'url', protocols: ['https'], transform: v => v.replace(/\/$/, '') },
    },
    {
      S: 'a',
      N: '2',
      I: '4',
      P: '3000',
      D: '1s',
      B: 'true',
      DT: '2026-01-31',
      J: '{"k":1}',
      J_NULL: '123',
      ARR: '1,2,3',
      EMAIL: 'USER@EXAMPLE.COM',
      URL: 'https://example.com/',
    },
  );
  assert.strictEqual(valid.S, 'A');
  assert.strictEqual(valid.N, 21);
  assert.strictEqual(valid.I, 5);
  assert.strictEqual(valid.P, 3001);
  assert.strictEqual(valid.D, 2000);
  assert.strictEqual(valid.B, false);
  assert.strictEqual(valid.DT, fixedDate);
  assert.deepStrictEqual(valid.J, { wrapped: { k: 1 } });
  assert.strictEqual(valid.J_NULL, null);
  assert.deepStrictEqual(valid.ARR, [2, 4, 6]);
  assert.strictEqual(valid.EMAIL, 'user@example.com');
  assert.strictEqual(valid.URL, 'https://example.com');

  // 3. Invalid post-transform values are rejected across all type categories.
  const badCases = [
    [{ N: { type: 'number', transform: () => NaN } }, { N: '1' }, /N: expected a number/],
    [{ N: { type: 'number', transform: () => Infinity } }, { N: '1' }, /N: expected a number/],
    [{ N: { type: 'number', transform: () => '5' } }, { N: '1' }, /N: expected a number/],
    [{ I: { type: 'int', transform: () => 3.5 } }, { I: '1' }, /I: expected an integer/],
    [{ I: { type: 'int', transform: () => '5' } }, { I: '1' }, /I: expected an integer/],
    [{ P: { type: 'port', transform: () => 70000 } }, { P: '3000' }, /P: expected a port/],
    [{ P: { type: 'port', transform: () => '3000' } }, { P: '3000' }, /P: expected a port/],
    [{ D: { type: 'duration', transform: () => -5 } }, { D: '1s' }, /D: expected a duration/],
    [{ D: { type: 'duration', transform: () => '1s' } }, { D: '1s' }, /D: expected a duration/],
    [{ B: { type: 'boolean', transform: () => 'true' } }, { B: 'true' }, /B: expected a boolean/],
    [{ B: { type: 'boolean', transform: () => 1 } }, { B: 'true' }, /B: expected a boolean/],
    [{ DT: { type: 'date', transform: () => '2026-01-31' } }, { DT: '2026-01-31' }, /DT: expected a valid ISO 8601 date/],
    [{ DT: { type: 'date', transform: () => new Date('invalid') } }, { DT: '2026-01-31' }, /DT: expected a valid ISO 8601 date/],
    [{ J: { type: 'json', transform: () => undefined } }, { J: '{}' }, /J: expected valid JSON/],
    [{ J: { type: 'json', transform: () => NaN } }, { J: '{}' }, /J: expected valid JSON/],
    [{ L: { type: 'array', transform: () => 'a,b' } }, { L: 'a,b' }, /L: expected an array/],
    [{ L: { type: 'array', of: 'int', transform: xs => [...xs, 'oops'] } }, { L: '1,2' }, /L\[2\]: expected an integer/],
    [{ L: { type: 'array', of: 'url', protocols: ['https'], transform: () => ['http://example.com'] } }, { L: 'https://example.com' }, /L\[0\]: expected a URL with one of these protocols/],
    [{ E: { type: 'email', transform: () => 42 } }, { E: 'a@b.co' }, /E: expected a email string/],
    [{ E: { type: 'email', transform: () => 'not-an-email' } }, { E: 'a@b.co' }, /E: expected a valid email address/],
    [{ H: { type: 'hex', transform: () => 1234 } }, { H: 'deadbeef' }, /H: expected a hex string/],
    [{ U: { type: 'url', protocols: ['https'], transform: () => 'http://example.com' } }, { U: 'https://example.com' }, /U: expected a URL with one of these protocols/],
    [{ NUL: { type: 'string', transform: () => Object.create(null) } }, { NUL: 'x' }, /NUL: expected a string/],
  ];
  for (const [schema, envInput, pattern] of badCases) {
    assert.throws(() => validateEnv(schema, envInput), pattern);
  }

  // 4. `default` + `transform`: bad defaults fail type validation even with transform;
  // valid defaults do not invoke transform and pass unchanged.
  assert.throws(
    () => validateEnv({ N: { type: 'int', default: 'oops', transform: x => x + 1 } }, {}),
    /N: expected an integer/,
  );
  assert.throws(
    () => validateEnv({ N: { type: 'int', default: 'oops', transform: x => x + 1 } }, { N: '' }),
    /N: expected an integer/,
  );
  let defaultRanTransform = false;
  assert.strictEqual(
    validateEnv({ N: { type: 'int', default: 5, transform: () => { defaultRanTransform = true; return 'oops'; } } }, {}).N,
    5,
  );
  assert.strictEqual(defaultRanTransform, false);

  // 5. Execution order, non-throwing mode, Pass 2 requiredIf, aliases, and sensitive masking.
  let seenByValidate;
  assert.throws(
    () => validateEnv(
      {
        N: {
          type: 'int',
          validate: v => { seenByValidate = v; return true; },
          transform: () => 'oops',
        },
      },
      { N: '5' },
    ),
    /N: expected an integer/,
  );
  assert.strictEqual(seenByValidate, 5);

  const nonThrowing = validateEnv(
    {
      GOOD: { type: 'int', transform: n => n + 1 },
      BAD: { type: 'int', transform: () => 'oops' },
      DEP: { type: 'string', requiredIf: { key: 'BAD', equals: 'oops' } },
    },
    { GOOD: '1', BAD: '5' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrowing.env, { GOOD: 2 });
  assert.strictEqual(nonThrowing.errors.length, 1);
  assert.ok(nonThrowing.errors[0].includes('BAD: expected an integer'));

  const aliasWarnings = [];
  assert.throws(
    () => validateEnv(
      { N: { type: 'int', aliases: ['OLD_N'], transform: () => 'oops' } },
      { OLD_N: '5' },
      { onWarn: m => aliasWarnings.push(m) },
    ),
    /N: expected an integer/,
  );
  assert.strictEqual(aliasWarnings.length, 1);

  const rawSecret = 'super_secret_token_99';
  assert.throws(
    () => validateEnv(
      { TOK: { type: 'int', sensitive: true, transform: () => rawSecret } },
      { TOK: '7' },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(rawSecret)
      && err.errors[0].includes(maskValue(rawSecret)),
  );
}

// Issue #211: string-only options (`pattern`, `minLength`, `maxLength`) must be
// rejected up front on non-string types instead of silently doing nothing.
{
  const fs = require('node:fs');
  const path = require('node:path');

  // Exact reproduction from issue #211 (present and absent, throwing and non-throwing).
  for (const env of [{ N: '42' }, {}]) {
    assert.throws(
      () => validateEnv({ N: { type: 'int', pattern: /^4/ } }, env),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0].includes('N:')
        && err.errors[0].includes('"pattern"'),
    );
  }
  assert.throws(
    () => validateEnv({ N: { type: 'int', pattern: /^4/ } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError && err.errors[0].includes('N:') && err.errors[0].includes('"pattern"'),
  );

  // Every non-string type rejects pattern, minLength, and maxLength up front.
  const nonStringCases = [
    ['int', { N: '42' }],
    ['number', { N: '3.14' }],
    ['port', { N: '3000' }],
    ['duration', { N: '15m' }],
    ['boolean', { N: 'true' }],
    ['date', { N: '2026-01-31' }],
    ['array', { N: 'a,b' }],
    ['json', { N: '{"a":1}' }],
  ];
  for (const [type, env] of nonStringCases) {
    for (const [opt, val] of [['pattern', /^a/], ['minLength', 1], ['maxLength', 5]]) {
      for (const inputEnv of [env, {}]) {
        assert.throws(
          () => validateEnv({ K: { type, [opt]: val } }, inputEnv),
          err => err instanceof EnvSaafError
            && err.errors.some(e => e.includes('K:') && e.includes(`"${opt}"`) && e.includes(`'${type}'`)),
          `expected ${type} to reject ${opt}`,
        );
      }
    }
  }

  // Omitted type defaults to 'string' and all string-valued types keep working.
  assert.strictEqual(
    validateEnv({ S: { pattern: /^[a-z]+$/, minLength: 2, maxLength: 5 } }, { S: 'abc' }).S,
    'abc',
  );
  const tmpDir = fs.mkdtempSync(path.join(__dirname, 'issue-211-test-'));
  const tmpFile = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(tmpFile, 'ok');
  try {
    const stringCases = [
      ['string', 'hello', /^h/, 2, 10],
      ['email', 'user@example.com', /@example\.com$/, 5, 30],
      ['url', 'https://example.com', /^https:\/\//, 10, 40],
      ['file', tmpFile, /sample\.txt$/, 5, 300],
      ['uuid', '550e8400-e29b-41d4-a716-446655440000', /^550e8400-/, 36, 36],
      ['hex', 'deadbeef', /^dead/, 4, 16],
      ['ipv4', '192.168.0.1', /^192\.168\./, 7, 15],
      ['semver', '1.2.3-beta.1', /^1\.2\.3/, 5, 20],
      ['base64', 'aGVsbG8=', /^aGVs/, 4, 16],
      ['host', 'db.internal', /\.internal$/, 3, 30],
    ];
    for (const [type, raw, pattern, minLength, maxLength] of stringCases) {
      assert.strictEqual(
        validateEnv({ S: { type, pattern, minLength, maxLength } }, { S: raw }).S,
        raw,
        `expected ${type} to allow pattern/minLength/maxLength`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Numeric min/max bounds continue working on numeric types.
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 1, max: 50 } }, { N: '42' }).N, 42);

  // Unknown type with string-only option reports only the unknown type error.
  assert.throws(
    () => validateEnv({ K: { type: 'emial', pattern: /@/ } }, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0].includes('unknown type "emial"'),
  );
  // Unknown option on a present environment variable.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', requried: true } }, { PORT: '3000' }),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "requried"'),
  );

  // Unknown option on an absent environment variable.
  // Schema errors must throw even when throwOnError is false.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', requried: true } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "requried"'),
  );

  // Misspelled default must also be rejected.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', defualt: '3000' } }, {}),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "defualt"'),
  );

  // Issue #250: a typo'd option on the options object itself is rejected up
  // front — same class of bug as #218, one layer up.
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, { A: 'x', TYPO_KEY: '1' }, { stric: true }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "stric"')),
  );
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, { A: 'x' }, { throwOnEror: true }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "throwOnEror"')),
  );
  // The check runs even when the variable is absent and even with
  // { throwOnError: false } — like schema errors, it always throws.
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, {}, { stric: true, throwOnError: false }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "stric"')),
  );
  // loadEnv rejects its own typos too, naming the loadEnv option set.
  const tmp250 = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'env-saaf-250-'));
  try {
    assert.throws(
      () => loadEnv({ A: { type: 'string' } }, { path: require('node:path').join(tmp250, 'x.env'), env: { A: 'x' }, overide: true }),
      err => err instanceof EnvSaafError
        && err.errors.some((e) => e.includes('unknown option "overide"')),
    );
    // A typo'd validateEnv option forwarded through loadEnv is rejected too.
    assert.throws(
      () => loadEnv({ A: { type: 'string' } }, { path: require('node:path').join(tmp250, 'x.env'), env: { A: 'x' }, stric: true }),
      err => err instanceof EnvSaafError
        && err.errors.some((e) => e.includes('unknown option "stric"')),
    );
  } finally {
    require('node:fs').rmSync(tmp250, { recursive: true, force: true });
  }
  // Every currently valid option keeps working exactly as before.
  assert.deepStrictEqual(
    validateEnv({ A: { type: 'string' } }, { A: 'x', B: '1' }, { strict: true, throwOnError: false }).errors,
    ['B: set but not in schema (strict mode)'],
  );
  assert.strictEqual(validateEnv({ A: { type: 'string' } }, { A: 'x' }, { throwOnError: false }).env.A, 'x');
  assert.throws(
    () => validateEnv({ A: { type: 'string', required: true } }, {}, { formatError: () => 'custom' }),
    (e) => e.message === 'custom',
  );

  // Issue #220: contradictory bounds are schema errors, even for absent keys.
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 10, max: 5 } }, { N: '7' }),
    err => err instanceof EnvSaafError && err.errors.includes('N: "min" must not exceed "max"'),
  );
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 10, max: 5 } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('N: "min" must not exceed "max"'),
  );
  assert.throws(
    () => validateEnv({ S: { type: 'string', minLength: 10, maxLength: 5 } }, { S: 'hello' }),
    err => err instanceof EnvSaafError && err.errors.includes('S: "minLength" must not exceed "maxLength"'),
  );
  assert.throws(
    () => validateEnv({ S: { type: 'string', minLength: 10, maxLength: 5 } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('S: "minLength" must not exceed "maxLength"'),
  );
  assert.throws(
    () => validateEnv({ M: { type: 'string', choices: [] } }, { M: 'a' }),
    err => err instanceof EnvSaafError && err.errors.includes('M: "choices" must be a non-empty array'),
  );
  assert.throws(
    () => validateEnv({ M: { type: 'string', choices: [] } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('M: "choices" must be a non-empty array'),
  );
  // Valid combinations keep working exactly as before.
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 5, max: 10 } }, { N: '7' }).N, 7);
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 5, max: 5 } }, { N: '5' }).N, 5);
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 2, maxLength: 5 } }, { S: 'hey' }).S, 'hey');
  assert.strictEqual(validateEnv({ M: { type: 'string', choices: ['a', 'b'] } }, { M: 'a' }).M, 'a');

  // Several valid options together must continue working.
  assert.strictEqual(
    validateEnv(
      { PORT: { type: 'int', required: true, min: 1, max: 65535, trim: true } },
      { PORT: '3000' },
    ).PORT,
    3000,
  );
}

// Issue #305: a `choices` entry that can never match the declared type is a
// schema bug, rejected up front instead of failing for every real value.
{
  const { validateEnv, validateSchema, EnvSaafError } = require('./index');
  const never = (key, entry, type) =>
    `${key}: "choices" entry ${entry} can never match type '${type}' (a choice must be a value this type can produce)`;

  // The three shapes from the issue: int, boolean and date.
  assert.throws(
    () => validateEnv({ N: { type: 'int', choices: ['1', '2'] } }, { N: '1' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 2
      && err.errors.includes(never('N', '"1"', 'int'))
      && err.errors.includes(never('N', '"2"', 'int')),
  );
  assert.throws(
    () => validateEnv({ B: { type: 'boolean', choices: ['true'] } }, { B: 'true' }),
    err => err instanceof EnvSaafError && err.errors.includes(never('B', '"true"', 'boolean')),
  );
  assert.throws(
    () => validateEnv({ D: { type: 'date', choices: [new Date('2026-01-31T00:00:00.000Z')] } }, { D: '2026-01-31' }),
    err => err instanceof EnvSaafError
      && err.errors.includes(`D: "choices" cannot be used with type 'date' (a parsed date is a new Date object, so no choice can ever match)`),
  );
  // Other numeric-like types are covered too.
  assert.throws(
    () => validateSchema({ P: { type: 'port', choices: ['3000'] } }),
    err => err instanceof EnvSaafError && err.errors.includes(never('P', '"3000"', 'port')),
  );
  assert.throws(
    () => validateSchema({ T: { type: 'duration', choices: ['5s'] } }),
    err => err instanceof EnvSaafError && err.errors.includes(never('T', '"5s"', 'duration')),
  );
  // Schema errors throw even when the key is absent and even with { throwOnError: false }.
  assert.throws(
    () => validateEnv({ N: { type: 'int', choices: ['1'] } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError && err.errors.includes(never('N', '"1"', 'int')),
  );

  // Matching choices still pass, and the runtime check is unchanged.
  assert.strictEqual(validateEnv({ N: { type: 'int', choices: [1, 2] } }, { N: '2' }).N, 2);
  assert.throws(() => validateEnv({ N: { type: 'int', choices: [1, 2] } }, { N: '3' }), /N: expected one of \[1, 2\], got "3"/);
  assert.strictEqual(validateEnv({ B: { type: 'boolean', choices: [true] } }, { B: 'yes' }).B, true);
  assert.strictEqual(validateEnv({ S: { type: 'string', choices: ['a', 'b'] } }, { S: 'b' }).S, 'b');
  assert.strictEqual(validateEnv({ S: { choices: ['x', 'y'] } }, { S: 'x' }).S, 'x');
  assert.doesNotThrow(() => validateSchema({
    A: { type: 'number', choices: [1.5, 2] },
    B: { type: 'port', choices: [8080, 3000] },
    C: { type: 'duration', choices: [5000] },
  }));
  // Non-finite numbers stay valid: toJsonSchema() drops them from the generated `enum`.
  assert.doesNotThrow(() => validateSchema({ COUNT: { type: 'int', choices: [2, Infinity, 0, NaN] } }));
}

// Issue #287: groups compose prefixes and nest results at every level.
{
  const schema = {
    MODE: { type: 'string' },
    APP: { prefix: 'APP_', schema: {
      DB: { prefix: 'DB_', schema: {
        HOST: { type: 'host', required: true },
        PORT: { type: 'port', default: 5432 },
      } },
      CACHE: { prefix: 'CACHE_', schema: { TTL: { type: 'int' } } },
    } },
  };
  assert.doesNotThrow(() => validateSchema(schema));
  const result = validateEnv(schema, { MODE: 'dev', APP_DB_HOST: 'db.internal' }, { strict: true });
  assert.deepStrictEqual(result, { MODE: 'dev', APP: { DB: { HOST: 'db.internal', PORT: 5432 } } });
  for (const container of [result, result.APP, result.APP.DB]) assert.ok(Object.isFrozen(container));
  assert.throws(() => { result.APP.DB.HOST = 'changed'; }, TypeError);
  assert.ok(!('CACHE' in result.APP));
  assert.deepStrictEqual(validateEnv({ APP: { prefix: 'APP_', schema: {
    CACHE: { prefix: 'CACHE_', schema: { TTL: { type: 'int' } } },
  } } }, {}), {});

  const partial = validateEnv(schema, {}, { throwOnError: false });
  assert.deepStrictEqual(partial, {
    env: { APP: { DB: { PORT: 5432 } } }, errors: ['APP_DB_HOST: missing required variable'],
    details: [{ key: 'APP_DB_HOST', message: 'missing required variable' }],
  });
  assert.ok(Object.isFrozen(partial.env.APP.DB));
  assert.throws(() => validateEnv(schema, { APP_DB_HOST: 'db.internal', APP_DB_EXTRA: 'x' }, { strict: true }),
    err => err instanceof EnvSaafError && err.errors.includes('APP_DB_EXTRA: set but not in schema (strict mode)'));
  assert.throws(() => validateSchema({ APP: { prefix: 'APP_', schema: {
    DB: { prefix: 'DB_', schema: { PORT: { type: 'unknown' } } },
  } } }), err => err instanceof EnvSaafError && err.errors.includes('APP_DB_PORT: unknown type "unknown"'));

  const warnings = [];
  const references = { APP: { prefix: 'APP_', schema: {
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', aliases: ['OLD_DB_HOST'] } } },
    MAIL: { prefix: 'MAIL_', schema: { HOST: { type: 'host', requiredIf: { key: 'APP_DB_HOST', equals: 'db.internal' } } } },
  } } };
  const referenced = validateEnv(references, { OLD_DB_HOST: 'db.internal', APP_MAIL_HOST: 'mail.internal' },
    { strict: true, onWarn: warning => warnings.push(warning) });
  assert.deepStrictEqual(referenced, { APP: { DB: { HOST: 'db.internal' }, MAIL: { HOST: 'mail.internal' } } });
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('OLD_DB_HOST is deprecated'));
  const required = validateEnv(references, { APP_DB_HOST: 'db.internal' }, { throwOnError: false, onWarn: () => {} });
  assert.deepStrictEqual(required.errors, ['APP_MAIL_HOST: missing required variable']);

  const example = generateExample(schema);
  assert.ok(example.includes("# group APP — the keys below are read from env vars prefixed with 'APP_'"));
  assert.ok(example.includes("# group APP.DB — the keys below are read from env vars prefixed with 'APP_DB_'"));
  assert.ok(example.includes("# group APP.CACHE — the keys below are read from env vars prefixed with 'APP_CACHE_'"));
  assert.match(example, /^APP_DB_HOST=localhost$/m);
  assert.match(example, /^APP_DB_PORT=5432$/m);
  assert.match(example, /^APP_CACHE_TTL=42$/m);
  assert.ok(example.indexOf('# group APP.DB') < example.indexOf('APP_DB_HOST='));
  assert.strictEqual(validateEnv(schema, parseEnvFile(example), { strict: true }).APP.DB.PORT, 5432);
  assert.deepStrictEqual(toJsonSchema(schema), {
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
      MODE: { type: 'string' },
      APP: { type: 'object', properties: {
        DB: { type: 'object', properties: {
          HOST: { type: 'string', anyOf: [{ format: 'hostname' }, { format: 'ipv4' }, { format: 'ipv6' }] },
          PORT: { type: 'integer', minimum: 0, maximum: 65535, default: 5432 },
        }, required: ['HOST'] },
        CACHE: { type: 'object', properties: { TTL: { type: 'integer' } } },
      } },
    },
  });

  const defaultValue = { count: 1 };
  const transformedValue = { count: 2 };
  const deep = { APP: { prefix: 'APP_', schema: {
    DB: { prefix: 'DB_', schema: {
      AUTH: { prefix: 'AUTH_', schema: {
        USER: { type: 'string', required: true },
        DATA: { type: 'json', default: defaultValue },
        EXTRA: { type: 'json', transform: () => transformedValue },
      } },
    } },
  } } };
  const deepResult = validateEnv(deep, { APP_DB_AUTH_USER: 'alice', APP_DB_AUTH_EXTRA: '{}' });
  assert.strictEqual(deepResult.APP.DB.AUTH.USER, 'alice');
  for (const group of [deepResult.APP, deepResult.APP.DB, deepResult.APP.DB.AUTH]) assert.ok(Object.isFrozen(group));
  assert.strictEqual(deepResult.APP.DB.AUTH.DATA, defaultValue);
  assert.strictEqual(deepResult.APP.DB.AUTH.EXTRA, transformedValue);
  deepResult.APP.DB.AUTH.DATA.count++;
  deepResult.APP.DB.AUTH.EXTRA.count++;
  assert.strictEqual(defaultValue.count, 2);
  assert.strictEqual(transformedValue.count, 3);
  assert.ok(generateExample(deep).includes('# group APP.DB.AUTH'));
  assert.deepStrictEqual(toJsonSchema(deep).properties.APP.properties.DB.properties.AUTH.required, ['USER']);

  const collides = candidate => assert.throws(() => validateSchema(candidate),
    err => err instanceof EnvSaafError && err.errors.some(error => error.includes('collide')));
  collides({ ...schema, APP_DB_HOST: { type: 'string' } });
  collides({ ...schema, OTHER: { prefix: 'APP_DB_', schema: { HOST: {} } } });
  collides({ APP: { prefix: 'APP_', schema: {
    DB: { prefix: 'DB_', schema: { HOST: {} } }, DB_HOST: {},
  } } });
  // Group names remain reserved against prefixed keys, as for one-level groups.
  collides({ ROOT: { prefix: 'APP_', schema: { DB: { prefix: 'DB_', schema: { HOST: {} } } } },
    APP_DB_HOST: { prefix: 'OTHER_', schema: { KEY: {} } } });
  assert.throws(() => validateSchema({ ...schema, OTHER: { aliases: ['APP_DB_HOST'] } }),
    err => err instanceof EnvSaafError && err.errors.includes('OTHER: alias "APP_DB_HOST" conflicts with a declared schema key'));
  const duplicateAlias = { APP: { prefix: 'APP_', schema: {
    A: { prefix: 'A_', schema: { VALUE: { aliases: ['OLD_VALUE'] } } },
    B: { prefix: 'B_', schema: { VALUE: { aliases: ['OLD_VALUE'] } } },
  } } };
  assert.throws(() => validateSchema(duplicateAlias),
    err => err instanceof EnvSaafError && err.errors.some(error => error.includes('alias "OLD_VALUE" is already used')));

  // Sharing a sub-schema is valid; only a reference back to an ancestor is circular.
  const shared = Object.freeze({ PORT: Object.freeze({ type: 'port', default: 8080 }) });
  const reused = Object.freeze({
    APP: Object.freeze({ prefix: 'APP_', schema: Object.freeze({
      A: Object.freeze({ prefix: 'A_', schema: shared }),
      B: Object.freeze({ prefix: 'B_', schema: shared }),
    }) }),
  });
  const reusedResult = validateEnv(reused, {});
  assert.deepStrictEqual(reusedResult, { APP: { A: { PORT: 8080 }, B: { PORT: 8080 } } });
  assert.notStrictEqual(reusedResult.APP.A, reusedResult.APP.B);
  const circular = {};
  circular.APP = { prefix: 'APP_', schema: circular };
  for (const check of [validateSchema, generateExample, toJsonSchema, candidate => loadEnv(candidate, { paths: [], env: {} })]) {
    assert.throws(() => check(circular), err => err instanceof EnvSaafError && /circular/.test(err.message));
  }
  // Group names are own properties even when Object.prototype has that name.
  const named = validateEnv({ APP: { prefix: 'APP_', schema: Object.fromEntries(
    ['__proto__', 'constructor', 'toString'].map((name, index) => [name, {
      prefix: `N${index}_`, schema: { VALUE: { type: 'string', default: name } },
    }]),
  ) } }, {});
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.ok(Object.prototype.hasOwnProperty.call(named.APP, name));
    assert.strictEqual(named.APP[name].VALUE, name);
    assert.ok(Object.isFrozen(named.APP[name]));
  }
  assert.strictEqual(Object.getPrototypeOf(named.APP), Object.prototype);
  assert.ok(!Object.isFrozen(Object.prototype));

  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-nested-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'APP_DB_HOST=db.internal\nAPP_DB_PORT=6543\n');
    const assigned = {};
    const loaded = loadEnv(schema, { path: file, env: assigned, assign: true });
    assert.deepStrictEqual(loaded, { APP: { DB: { HOST: 'db.internal', PORT: 6543 } } });
    assert.deepStrictEqual(assigned, { APP_DB_HOST: 'db.internal', APP_DB_PORT: '6543' });
    assert.ok(Object.isFrozen(loaded.APP.DB));
    assert.throws(() => loadEnv(schema, { paths: [path.join(dir, 'missing.env')], env: {} }),
      /required variables missing: APP_DB_HOST/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #320: `choices` on an `array` rule constrains each coerced item.
{
  const never = (key, entry, type) =>
    `${key}: "choices" entry ${entry} can never match type '${type}' (a choice must be a value this type can produce)`;

  // A value whose items are all allowed passes; a single bad item names the
  // key, the offending item and its index.
  assert.deepStrictEqual(
    validateEnv({ A: { type: 'array', of: 'string', choices: ['a', 'b'] } }, { A: 'a,b,a' }),
    { A: ['a', 'b', 'a'] },
  );
  assert.throws(
    () => validateEnv({ A: { type: 'array', of: 'string', choices: ['a', 'b'] } }, { A: 'a,c' }),
    err => err instanceof EnvSaafError
      && err.errors.includes('A: expected one of [a, b], got "c" (item 1)'),
  );

  // Items are coerced before the choices check, just like scalar rules.
  assert.deepStrictEqual(
    validateEnv({ N: { type: 'array', of: 'int', choices: [1, 2] } }, { N: '01,2' }),
    { N: [1, 2] },
  );
  assert.deepStrictEqual(
    validateEnv({ B: { type: 'array', of: 'boolean', choices: [true] } }, { B: 'yes,true' }),
    { B: [true, true] },
  );
  assert.throws(
    () => validateEnv({ N: { type: 'array', of: 'int', choices: [1, 2] } }, { N: '1,3' }),
    err => err instanceof EnvSaafError && /N: expected one of \[1, 2\], got "3"/.test(err.errors[0]),
  );
  // Defaults go through the same per-item check.
  assert.deepStrictEqual(
    validateEnv({ A: { type: 'array', choices: ['a', 'b'], default: ['b', 'a'] } }, {}),
    { A: ['b', 'a'] },
  );
  assert.throws(
    () => validateEnv({ A: { type: 'array', choices: ['a', 'b'], default: ['b', 'z'] } }, {}),
    err => err instanceof EnvSaafError && err.errors.some(m => m.includes('got "z"')),
  );

  // Schema validation applies #305 to the item type.
  assert.throws(
    () => validateSchema({ N: { type: 'array', of: 'int', choices: ['1', '2'] } }),
    err => err instanceof EnvSaafError
      && err.errors.includes(never('N', '"1"', 'int'))
      && err.errors.includes(never('N', '"2"', 'int')),
  );
  assert.throws(
    () => validateSchema({ B: { type: 'array', of: 'boolean', choices: ['true'] } }),
    err => err instanceof EnvSaafError && err.errors.includes(never('B', '"true"', 'boolean')),
  );
  assert.throws(
    () => validateSchema({ D: { type: 'array', of: 'date', choices: ['2026-01-31'] } }),
    err => err instanceof EnvSaafError
      && err.errors.includes(`D: "choices" cannot be used with type 'date' (a parsed date is a new Date object, so no choice can ever match)`),
  );
  assert.doesNotThrow(() => validateSchema({
    A: { type: 'array', choices: ['a', 'b'] },
    N: { type: 'array', of: 'int', choices: [1, 2] },
    U: { type: 'array', of: 'url', choices: ['https://example.com'] },
  }));

  // toJsonSchema puts the enum on items, not on the array itself.
  assert.deepStrictEqual(
    toJsonSchema({ A: { type: 'array', of: 'string', choices: ['a', 'b'] } }).properties.A,
    { type: 'array', items: { type: 'string', minLength: 1, enum: ['a', 'b'] } },
  );
  assert.deepStrictEqual(
    toJsonSchema({ N: { type: 'array', of: 'int', choices: [1, 2] } }).properties.N,
    { type: 'array', items: { type: 'integer', enum: [1, 2] } },
  );
  // Scalar behaviour is unchanged.
  assert.deepStrictEqual(
    toJsonSchema({ S: { choices: ['a', 'b'] } }).properties.S,
    { type: 'string', enum: ['a', 'b'] },
  );

  // generateExample emits allowed items that validate against the same schema.
  const schema = { A: { type: 'array', of: 'string', choices: ['a', 'b'], required: true } };
  const example = generateExample(schema);
  assert.match(example, /^A=a,b$/m);
  assert.deepStrictEqual(validateEnv(schema, parseEnvFile(example)), { A: ['a', 'b'] });
  const typed = { N: { type: 'array', of: 'int', choices: [2, 4] } };
  const typedExample = generateExample(typed);
  assert.match(typedExample, /^N=2,4$/m);
  assert.deepStrictEqual(validateEnv(typed, parseEnvFile(typedExample)), { N: [2, 4] });
  // minItems/maxItems, separator, unique and explicit defaults are respected.
  assert.match(generateExample({ A: { type: 'array', choices: ['a', 'b', 'c'], minItems: 4, maxItems: 5 } }), /^A=a,b,c,a$/m);
  assert.match(generateExample({ A: { type: 'array', separator: ';', choices: ['x;y', 'ok'] } }), /^A=ok$/m);
  assert.match(generateExample({ A: { type: 'array', unique: true, choices: ['a', 'b'] } }), /^A=a,b$/m);
  assert.match(generateExample({ A: { type: 'array', choices: ['a', 'b'], default: ['b'] } }), /^A=b$/m);
}

// feat: grouped (nested) schemas with a key prefix (fixes #228)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { validateEnv, validateSchema, loadEnv, generateExample, EnvSaafError } = require('./index');

  // The issue's example: validates, coerces and nests; a missing grouped key
  // errors with the FULL env name (DB_HOST, not DB.HOST).
  const schema = {
    DB: { prefix: 'DB_', schema: {
      HOST: { type: 'host', required: true },
      PORT: { type: 'port', default: 5432 },
    } },
  };
  const out = validateEnv(schema, { DB_HOST: 'db.internal' });
  assert.deepStrictEqual(out, { DB: { HOST: 'db.internal', PORT: 5432 } });
  assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(out.DB));
  assert.throws(() => { out.DB.HOST = 'changed.internal'; }, TypeError);
  assert.strictEqual(out.DB.HOST, 'db.internal');
  assert.deepStrictEqual(validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: '6543' }), { DB: { HOST: 'db.internal', PORT: 6543 } });
  assert.throws(
    () => validateEnv(schema, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0] === 'DB_HOST: missing required variable',
  );
  // Coercion errors inside a group also name the full env name.
  assert.throws(
    () => validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: 'not-a-port' }),
    err => err instanceof EnvSaafError && err.errors.some(e => e.startsWith('DB_PORT:')),
  );
  // An optional inner key that is absent simply leaves the group without it;
  // when no inner key is present at all, the group key is absent too.
  const withOpt = { CACHE: { prefix: 'CACHE_', schema: { HOST: { type: 'host', required: true }, TTL: { type: 'int' } } } };
  assert.deepStrictEqual(validateEnv(withOpt, { CACHE_HOST: 'redis.local' }), { CACHE: { HOST: 'redis.local' } });
  // throwOnError: false returns the nested shape plus errors.
  const soft = validateEnv(schema, {}, { throwOnError: false });
  assert.deepStrictEqual(soft.env, { DB: { PORT: 5432 } }); // defaults still apply in soft mode
  assert.deepStrictEqual(soft.errors, ['DB_HOST: missing required variable']);
  assert.ok(Object.isFrozen(soft.env));
  assert.ok(Object.isFrozen(soft.env.DB));
  assert.throws(() => { soft.env.DB.PORT = 1; }, TypeError);
  assert.strictEqual(soft.env.DB.PORT, 5432);

  // strict mode knows the flattened names: DB_HOST is fine, DB_OTHER is not.
  validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: '1' }, { strict: true, onWarn: () => {} });
  assert.throws(
    () => validateEnv(schema, { DB_HOST: 'db.internal', DB_OTHER: 'x' }, { strict: true }),
    err => err instanceof EnvSaafError && err.errors.some(e => e === 'DB_OTHER: set but not in schema (strict mode)'),
  );

  // aliases inside a group use FULL env names (verbatim, not prefixed).
  const withAlias = { DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true, aliases: ['DATABASE_HOST'] } } } };
  const warnings = [];
  const aliased = validateEnv(withAlias, { DATABASE_HOST: 'db.internal' }, { onWarn: m => warnings.push(m) });
  assert.deepStrictEqual(aliased, { DB: { HOST: 'db.internal' } });
  assert.ok(warnings.some(w => w.includes('DATABASE_HOST is deprecated')));

  // requiredIf across groups / to external keys uses full env names too.
  const crossGroup = {
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true } } },
    MAIL: { prefix: 'MAIL_', schema: { SMTP_HOST: { type: 'host', requiredIf: { key: 'DB_HOST', equals: 'db.internal' } } } },
  };
  assert.throws(
    () => validateEnv(crossGroup, { DB_HOST: 'db.internal' }),
    err => err instanceof EnvSaafError && err.errors.includes('MAIL_SMTP_HOST: missing required variable'),
  );
  assert.deepStrictEqual(
    validateEnv(crossGroup, { DB_HOST: 'other.host', MAIL_SMTP_HOST: 'smtp.local' }),
    { DB: { HOST: 'other.host' }, MAIL: { SMTP_HOST: 'smtp.local' } },
  );
  // requiredIf can also point at an undeclared external key (e.g. NODE_ENV).
  const ext = { A: { prefix: 'A_', schema: { KEY: { requiredIf: { key: 'NODE_ENV', equals: 'production' } } } } };
  assert.throws(
    () => validateEnv(ext, { NODE_ENV: 'production' }),
    err => err instanceof EnvSaafError && err.errors.includes('A_KEY: missing required variable'),
  );
  assert.deepStrictEqual(validateEnv(ext, { NODE_ENV: 'development' }), {});

  // transform inside a group lands nested, type-verified as usual.
  const withTransform = { S: { prefix: 'S_', schema: { NAME: { type: 'string', transform: v => v.toUpperCase() } } } };
  assert.deepStrictEqual(validateEnv(withTransform, { S_NAME: 'abc' }), { S: { NAME: 'ABC' } });

  // Issue #284: freeze the result containers, without freezing rule values
  // or taking ownership of objects supplied by defaults and transforms.
  const defaultValue = { nested: { count: 1 } };
  const transformedValue = { nested: { count: 1 } };
  const values = validateEnv({
    PLAIN: { type: 'json' },
    DB: { prefix: 'DB_', schema: {
      JSON: { type: 'json' },
      ITEMS: { type: 'array' },
      DEFAULT: { type: 'json', default: defaultValue },
      TRANSFORMED: { type: 'json', transform: () => transformedValue },
    } },
    CACHE: { prefix: 'CACHE_', schema: { PORT: { type: 'port', default: 6379 } } },
    OPTIONAL: { prefix: 'OPTIONAL_', schema: { VALUE: { type: 'string' } } },
  }, {
    PLAIN: '{"nested":{"count":1}}',
    DB_JSON: '{"nested":{"count":1}}',
    DB_ITEMS: 'one,two',
    DB_TRANSFORMED: '{}',
  });
  assert.ok(Object.isFrozen(values));
  assert.ok(Object.isFrozen(values.DB));
  assert.ok(Object.isFrozen(values.CACHE));
  assert.ok(!('OPTIONAL' in values));
  assert.strictEqual(values.DB.DEFAULT, defaultValue);
  assert.strictEqual(values.DB.TRANSFORMED, transformedValue);
  for (const value of [values.PLAIN, values.DB.JSON, values.DB.DEFAULT, values.DB.TRANSFORMED]) {
    assert.ok(!Object.isFrozen(value));
    assert.ok(!Object.isFrozen(value.nested));
    value.extra = true;
    value.nested.count = 2;
    assert.strictEqual(value.extra, true);
    assert.strictEqual(value.nested.count, 2);
  }
  values.DB.ITEMS.push('three');
  assert.deepStrictEqual(values.DB.ITEMS, ['one', 'two', 'three']);

  // generateExample emits FLAT env names for a group, with a group comment.
  const example = generateExample({
    APP_NAME: { type: 'string', required: true },
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },
  });
  assert.ok(example.includes('# group DB'));
  assert.ok(example.includes('DB_HOST='));
  assert.ok(example.includes('DB_PORT=5432'));
  assert.ok(!example.includes('DB.HOST'), 'example must stay flat');
  assert.ok(example.indexOf('APP_NAME=') < example.indexOf('DB_HOST='));

  // loadEnv with a group: returns the nested shape; assign writes FLAT names.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-group-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'DB_HOST=db.internal\nDB_PORT=6543\n');
    const loaded = loadEnv(schema, { path: file, env: {} });
    assert.deepStrictEqual(loaded, { DB: { HOST: 'db.internal', PORT: 6543 } });
    assert.ok(Object.isFrozen(loaded));
    assert.ok(Object.isFrozen(loaded.DB));
    assert.throws(() => { loaded.DB.PORT = 1; }, TypeError);
    assert.strictEqual(loaded.DB.PORT, 6543);
    const target = {};
    loadEnv(schema, { path: file, env: target, assign: true });
    assert.strictEqual(target.DB_HOST, 'db.internal');
    assert.strictEqual(target.DB_PORT, '6543');
    assert.ok(!('DB' in target), 'assign must not write a nested group object');
    // required inner rule counts when no file is found
    assert.throws(
      () => loadEnv(schema, { paths: [path.join(dir, 'missing.env')], env: {} }),
      /required variables missing: DB_HOST/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // validateSchema rejects malformed groups up front (flat schemas unchanged).
  const bad = (s, msgPart) => assert.throws(
    () => validateSchema(s),
    err => err instanceof EnvSaafError && err.errors.some(e => e.includes(msgPart)),
    JSON.stringify(s),
  );
  bad({ G: { schema: { A: {} } } }, 'needs a non-empty string "prefix"');                 // no prefix
  bad({ G: { prefix: 'G_', schema: 'nope' } }, 'group "schema" must be an object');          // schema not an object
  bad({ G: { prefix: 'G_', schema: {} } }, 'group "schema" must not be empty');                // empty group
  bad({ G: { prefix: 'G_', schema: { A: {} }, type: 'string' } }, 'cannot also set "type"');  // type + schema
  bad({ G: { prefix: 'G_', schema: { A: {} }, required: true } }, 'group rules only support'); // extra option on group
  bad({ G: { prefix: 'G_', schema: { A: { schema: {} } } } }, 'needs a non-empty string "prefix"'); // malformed nested group
  bad({ G: { prefix: 'G_', schema: { A: { type: 'nope' } } } }, 'G_A: unknown type');         // inner rule error uses full name
  bad({ DB_HOST: { type: 'string' }, G: { prefix: 'DB_', schema: { HOST: {} } } }, 'collide'); // prefix collision with a declared key
  bad({ A: { prefix: 'X_', schema: { K: {} } }, B: { prefix: 'X_', schema: { K: {} } } }, 'collide'); // two groups collide
  // Issue #228 review fix: alias collisions are checked across the FLATTENED
  // schema — one env var must not silently feed two rules. All four
  // cross-boundary combinations are rejected:
  bad( // cross-group: a group-inner alias naming another group's key
    { A: { prefix: 'A_', schema: { H: { aliases: ['B_H'] } } }, B: { prefix: 'B_', schema: { H: {} } } },
    'A_H: alias "B_H" conflicts with a declared schema key',
  );
  bad( // two groups' inner rules sharing one alias
    { A: { prefix: 'A_', schema: { H: { aliases: ['SHARED'] } } }, B: { prefix: 'B_', schema: { H: { aliases: ['SHARED'] } } } },
    'alias "SHARED" is already used by',
  );
  bad( // a flat key colliding with a group-inner alias
    { FLAT_KEY: {}, A: { prefix: 'A_', schema: { H: { aliases: ['FLAT_KEY'] } } } },
    'A_H: alias "FLAT_KEY" conflicts with a declared schema key',
  );
  bad( // a flat rule's alias naming a group-produced key
    { A: { prefix: 'A_', schema: { H: {} } }, X: { aliases: ['A_H'] } },
    'X: alias "A_H" conflicts with a declared schema key',
  );
  // and the collision is no longer silent at validateEnv time either: the
  // schema is rejected before any env var can feed two rules.
  assert.throws(
    () => validateEnv(
      { A: { prefix: 'A_', schema: { H: { aliases: ['B_H'] } } }, B: { prefix: 'B_', schema: { H: {} } } },
      { B_H: 'shared.host' },
    ),
    err => err instanceof EnvSaafError && err.errors.some(e => e.includes('alias "B_H"')),
  );
  // non-conflicting cross-group aliases still work
  validateSchema({
    A: { prefix: 'A_', schema: { H: { aliases: ['OLD_A_HOST'] } } },
    B: { prefix: 'B_', schema: { H: { aliases: ['OLD_B_HOST'] } } },
  });

  // a valid group passes validateSchema
  validateSchema(schema);

  // Flat schemas behave exactly as before (regression guard).
  assert.deepStrictEqual(
    validateEnv({ PORT: { type: 'port', default: 3000 }, NAME: { type: 'string' } }, { NAME: 'x' }),
    { PORT: 3000, NAME: 'x' },
  );
}

// Issue #236: the README "Migrating to env-saaf" after-snippets must run against
// the current API — these tests execute exactly those snippets.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-migrating-'));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=8080\nDATABASE_URL=https://db.example.com/x\nAPI_URL=https://api.example.com\nDEBUG=yes\n');
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    // "From dotenv" snippet.
    const { loadEnv } = require('./index');
    const env = loadEnv({
      PORT: { type: 'port', default: 3000 },
      DATABASE_URL: { type: 'url', required: true },
      DEBUG: { type: 'boolean', default: false },
    });
    assert.strictEqual(env.PORT, 8080);
    assert.strictEqual(typeof env.PORT, 'number');
    assert.strictEqual(env.DATABASE_URL, 'https://db.example.com/x');
    assert.strictEqual(env.DEBUG, true);
    // "From envalid" snippet: same shape, plus error aggregation and choices.
    const env2 = loadEnv({
      API_URL: { type: 'url', required: true },
      PORT: { type: 'port', default: 3000 },
      DEBUG: { type: 'boolean', default: false },
    });
    assert.strictEqual(env2.PORT, 8080);
    assert.throws(
      () => validateEnv({ PORT: { type: 'port', required: true }, DATABASE_URL: { type: 'url', required: true } }, { PORT: 'abc' }),
      (err) => err instanceof EnvSaafError && err.errors.length === 2
        && err.errors.some((e) => e.includes('expected a port'))
        && err.errors.some((e) => e.includes('missing required variable'))
    );
    const collected = validateEnv({ PORT: { type: 'port' } }, { PORT: 'abc' }, { throwOnError: false });
    assert.ok(Array.isArray(collected.errors) && collected.errors[0].includes('expected a port'));
    assert.strictEqual(validateEnv({ MODE: { type: 'string', choices: ['dev', 'prod'] } }, { MODE: 'prod' }).MODE, 'prod');
    assert.deepStrictEqual(validateEnv({ CFG: { type: 'json' } }, { CFG: '{"a":1}' }).CFG, { a: 1 });
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #223: generateExample — array placeholder items come from the `of` item type
{
  // The reported case: `of: 'int'` must not suggest 'a,b,c' (which would not validate).
  assert.throws(() => validateEnv({ NS: { type: 'array', of: 'int' } }, { NS: 'a,b,c' }), /NS\[0\]/);
  const exInt = generateExample({ NS: { type: 'array', of: 'int' } });
  assert.ok(exInt.includes('NS=1,2,3'), exInt);
  // port items get port examples; string (the default) stays 'a,b,c'.
  assert.ok(generateExample({ PORTS: { type: 'array', of: 'port' } }).includes('PORTS=3000,8080,5432'));
  assert.ok(generateExample({ TAGS: { type: 'array' } }).includes('TAGS=a,b,c'));
  assert.ok(generateExample({ TAGS: { type: 'array', of: 'string' } }).includes('TAGS=a,b,c'));
  // A custom separator joins the typed items too.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', separator: ';' } }).includes('NS=1;2;3'));
  // An explicit default still wins over the generated placeholder.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', default: [7, 8] } }).includes('NS=7,8'));
  // A secret-looking key still gets an empty placeholder, array or not.
  assert.ok(generateExample({ API_KEY_LIST: { type: 'array', of: 'string' } }).includes('API_KEY_LIST=\n'));
  // The array comment names the item type so the generated file documents it.
  assert.ok(exInt.includes('# type: array, items: int'), exInt);

  // Round-trip: for every scalar `of` type, the generated placeholder is itself
  // valid against the rule — the init -> check loop stays clean. ('file' is
  // excluded: that type checks the path exists on disk, which a placeholder
  // in a fresh repo cannot guarantee.)
  const scalarTypes = ['string', 'email', 'number', 'int', 'boolean', 'url', 'uuid', 'hex', 'ipv4', 'semver', 'base64', 'port', 'date', 'duration', 'host', 'json'];
  for (const of of scalarTypes) {
    const ex = generateExample({ K: { type: 'array', of } });
    const line = ex.split('\n').find((l) => l.startsWith('K='));
    const value = line.slice(2);
    const parsed = validateEnv({ K: { type: 'array', of } }, { K: value });
    assert.ok(Array.isArray(parsed.K) && parsed.K.length === 3, `${of}: generated "${value}" must validate`);
  }
  // JSON items must not contain the separator — a single-key object per item.
  const exJson = generateExample({ DOCS: { type: 'array', of: 'json' } });
  assert.ok(exJson.includes('DOCS={"a":1},{"b":2},{"c":3}'), exJson);

  // minItems/maxItems are respected so the placeholder passes those bounds too.
  const exMin = generateExample({ NS: { type: 'array', of: 'int', minItems: 5 } });
  assert.ok(exMin.includes('NS=1,2,3,1,2'), exMin);
  assert.deepStrictEqual(validateEnv({ NS: { type: 'array', of: 'int', minItems: 5 } }, { NS: '1,2,3,1,2' }).NS, [1, 2, 3, 1, 2]);
  const exMax = generateExample({ NS: { type: 'array', of: 'int', maxItems: 2 } });
  assert.ok(exMax.includes('NS=1,2\n'), exMax);
  assert.deepStrictEqual(validateEnv({ NS: { type: 'array', of: 'int', maxItems: 2 } }, { NS: '1,2' }).NS, [1, 2]);
  // minItems and maxItems together: capped by maxItems.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', minItems: 5, maxItems: 4 } }).includes('NS=1,2,3,1\n'));
}

// Issue #251: generateExample — every scalar type gets a placeholder that
// itself validates, so the generated file passes `check` out of the box.
{
  const schema = {
    E: { type: 'email' }, U: { type: 'uuid' }, N: { type: 'number' },
    I: { type: 'int' }, B: { type: 'boolean' }, J: { type: 'json' },
    B64: { type: 'base64' }, HX: { type: 'hex' },
  };
  const ex = generateExample(schema);
  assert.ok(ex.includes('E=user@example.com'), ex);
  assert.ok(ex.includes('U=550e8400-e29b-41d4-a716-446655440000'), ex);
  assert.ok(ex.includes('N=3.14'), ex);
  assert.ok(ex.includes('I=42'), ex);
  assert.ok(ex.includes('B=true'), ex);
  assert.ok(ex.includes('J={"key":"value"}'), ex);
  assert.ok(ex.includes('B64=aGVsbG8='), ex);
  assert.ok(ex.includes('HX=deadbeef'), ex);
  // Round-trip: the whole generated file validates cleanly.
  const parsed = validateEnv(schema, parseEnvFile(ex));
  assert.strictEqual(parsed.E, 'user@example.com');
  assert.strictEqual(parsed.U, '550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(parsed.N, 3.14);
  assert.strictEqual(parsed.I, 42);
  assert.strictEqual(parsed.B, true);
  assert.deepStrictEqual(parsed.J, { key: 'value' });
  assert.strictEqual(parsed.B64, 'aGVsbG8=');
  assert.strictEqual(parsed.HX, 'deadbeef');
  // Placeholders for the already-correct types are unchanged.
  assert.ok(generateExample({ P: { type: 'port' } }).includes('P=3000'));
  assert.ok(generateExample({ A: { type: 'url' } }).includes('A=https://example.com'));
  assert.ok(generateExample({ D: { type: 'date' } }).includes('D=2026-01-31'));
  assert.ok(generateExample({ DU: { type: 'duration' } }).includes('DU=15m'));
  assert.ok(generateExample({ H: { type: 'host' } }).includes('H=localhost'));
  assert.ok(generateExample({ S: { type: 'semver' } }).includes('S=1.0.0'));
  assert.ok(generateExample({ IP: { type: 'ipv4' } }).includes('IP=192.168.0.1'));
  // `file` stays the documented exception: no placeholder can guarantee the
  // path exists, so its example is a path the user must create.
  assert.ok(generateExample({ F: { type: 'file' } }).includes('F=./config.json'));
}

// Issue #273: choices supply valid examples after defaults and secret handling.
{
  const schema = {
    S: { type: 'string', choices: ['alpha', 'beta'] },
    N: { type: 'number', choices: [1, 2] },
    Z: { type: 'int', choices: [0, 1] },
    B: { type: 'boolean', choices: [false, true] },
    GROUP: { prefix: 'APP_', schema: { MODE: { choices: ['dev', 'prod'] } } },
  };
  const example = generateExample(schema);
  for (const line of ['S=alpha', 'N=1', 'Z=0', 'B=false', 'APP_MODE=dev']) {
    assert.ok(example.includes(line + '\n'), example);
  }
  assert.deepStrictEqual(validateEnv(schema, parseEnvFile(example)), {
    S: 'alpha', N: 1, Z: 0, B: false, GROUP: { MODE: 'dev' },
  });
  const priority = generateExample({
    MODE: { choices: ['alpha', 'beta'], default: 'beta' },
    API_KEY: { choices: ['alpha', 'beta'] },
    SESSION: { sensitive: true, choices: ['alpha', 'beta'] },
    TOKEN: { choices: ['alpha', 'beta'], default: 'beta' },
  });
  for (const line of ['MODE=beta', 'API_KEY=', 'SESSION=', 'TOKEN=beta']) {
    assert.ok(priority.includes(line + '\n'), priority);
  }
}

// Issue #274: generated numeric placeholders satisfy their own schema bounds.
{
  const cases = [
    ['number', {}, 3.14],
    ['number', { min: 100 }, 100],
    ['number', { max: 2 }, 2],
    ['number', { min: 100, max: 200 }, 100],
    ['number', { min: -10, max: -1 }, -1],
    ['number', { min: 0, max: 0 }, 0],
    ['number', { min: 2, max: 4 }, 3.14],
    ['number', { min: -2.5, max: -2 }, -2],
    ['int', {}, 42],
    ['int', { min: 1000 }, 1000],
    ['int', { max: 20 }, 20],
    ['int', { min: 1000, max: 2000 }, 1000],
    ['int', { min: -10, max: -1 }, -1],
    ['int', { min: 0, max: 0 }, 0],
    ['int', { min: 40, max: 50 }, 42],
    ['int', { min: 100.2 }, 101],
    ['int', { max: 20.8 }, 20],
    ['int', { min: -5.8, max: -3.2 }, -4],
    ['int', { min: 1e21, max: 1e21 }, 1e21],
    ['int', { min: -1e22, max: -1e21 }, -1e21],
    ['port', {}, 3000],
    ['port', { min: 4000 }, 4000],
    ['port', { max: 1024 }, 1024],
    ['port', { min: 8000, max: 9000 }, 8000],
    ['port', { min: 0, max: 0 }, 0],
    ['port', { min: 2999, max: 3001 }, 3000],
    ['port', { min: 4000.2 }, 4001],
    ['port', { max: 80.8 }, 80],
    ['port', { min: -10, max: 10 }, 10],
    ['port', { min: 65535, max: 70000 }, 65535],
    ['duration', {}, 900000],
    ['duration', { min: 3600000 }, 3600000],
    ['duration', { max: 500 }, 500],
    ['duration', { min: 10, max: 20 }, 20],
    ['duration', { min: 0, max: 0 }, 0],
    ['duration', { max: -0 }, 0],
    ['duration', { min: 600000, max: 1000000 }, 900000],
    ['duration', { max: 0.5 }, 0.5],
    ['duration', { max: 1e-7 }, 1e-7],
    ['duration', { min: 1e21, max: 1e21 }, 1e21],
    ['duration', { min: -100, max: 100 }, 100],
    ['duration', { min: 1.2345678901234567e-8, max: 1.2345678901234567e-8 }, 1.2345678901234567e-8],
  ];
  for (const [type, bounds, expected] of cases) {
    const schema = Object.freeze({ VALUE: Object.freeze({ type, ...bounds }) });
    const example = generateExample(schema);
    const result = validateEnv(schema, parseEnvFile(example));
    assert.strictEqual(result.VALUE, expected, `${type} ${JSON.stringify(bounds)}: ${example}`);
  }

  const grouped = { WORKER: { prefix: 'WORKER_', schema: {
    COUNT: { type: 'int', min: 2, max: 8 },
    TIMEOUT: { type: 'duration', max: 500 },
  } } };
  assert.deepStrictEqual(validateEnv(grouped, parseEnvFile(generateExample(grouped))), {
    WORKER: { COUNT: 8, TIMEOUT: 500 },
  });

  const priority = parseEnvFile(generateExample({
    DEFAULT: { type: 'number', min: 100, default: 150 },
    CHOICE: { type: 'int', min: 100, choices: [200, 300] },
    API_TOKEN: { type: 'int', min: 100 },
    SESSION: { type: 'duration', min: 100, sensitive: true },
  }));
  assert.deepStrictEqual(priority, { DEFAULT: '150', CHOICE: '200', API_TOKEN: '', SESSION: '' });

  for (const type of ['number', 'int', 'port', 'duration']) {
    for (const bound of ['min', 'max']) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const schema = { VALUE: { type, [bound]: value } };
        const example = generateExample(schema);
        assert.strictEqual(example, generateExample({ VALUE: { type } }));
        assert.throws(() => validateEnv(schema, parseEnvFile(example)), /must be a number/);
      }
    }
  }
  console.log(`numeric example bounds: ${cases.length} round trips passed`);
}

// Issue #275: string placeholders round-trip through their own length bounds.
{
  const cases = [
    ['string', { minLength: 20 }, 20],
    ['string', { maxLength: 3 }, 3],
    ['string', { minLength: 5, maxLength: 5 }, 5],
    ['string', { maxLength: 0 }, 0],
    [undefined, { minLength: 18, maxLength: 20 }, 18],
  ];
  for (const [type, bounds, length] of cases) {
    const schema = { VALUE: { type, required: true, ...bounds } };
    const example = generateExample(schema);
    assert.strictEqual(validateEnv(schema, parseEnvFile(example)).VALUE.length, length, example);
  }
}

// Issue #275: bounded email examples still have a local part and a domain.
{
  const cases = [
    [{ minLength: 30 }, 30],
    [{ maxLength: 13 }, 13],
    [{ maxLength: 5 }, 5],
    [{ minLength: 8, maxLength: 8 }, 8],
    [{ minLength: 16, maxLength: 16 }, 16],
  ];
  for (const [bounds, length] of cases) {
    const schema = { VALUE: { type: 'email', required: true, ...bounds } };
    const example = generateExample(schema);
    assert.strictEqual(validateEnv(schema, parseEnvFile(example)).VALUE.length, length, example);
  }
}

// Issue #275: other bounded string-like values retain their type's format.
{
  const cases = [
    ['url', { minLength: 24 }, 24],
    ['url', { maxLength: 8, protocols: ['HTTPS:'] }, 8],
    ['url', { minLength: 2, maxLength: 2 }, 2],
    ['url', { maxLength: 5, protocols: ['https', 'X:'] }, 5],
    ['url', { minLength: 19, maxLength: 19, protocols: ['HTTP:'] }, 19],
    ['hex', { maxLength: 3 }, 3],
    ['hex', { minLength: 3, maxLength: 12, length: 10 }, 10],
    ['ipv4', { maxLength: 7 }, 7],
    ['ipv4', { minLength: 15, maxLength: 15 }, 15],
    ['semver', { minLength: 6, maxLength: 6 }, 6],
    ['semver', { minLength: 11 }, 11],
    ['base64', { minLength: 9 }, 10],
    ['base64', { maxLength: 5 }, 4],
    ['base64', { maxLength: 2 }, 2],
    ['uuid', { minLength: 36, maxLength: 36 }, 36],
    ['host', { maxLength: 1 }, 1],
    ['host', { minLength: 64 }, 64],
    ['host', { minLength: 254 }, 254],
  ];
  for (const [type, bounds, length] of cases) {
    const schema = { VALUE: { type, required: true, ...bounds } };
    const example = generateExample(schema);
    assert.strictEqual(validateEnv(schema, parseEnvFile(example)).VALUE.length, length, example);
  }

  // File values require a real file. Generation only supplies a path.
  const files = parseEnvFile(generateExample({
    SHORT: { type: 'file', maxLength: 1 }, LONG: { type: 'file', minLength: 20 },
  }));
  assert.match(files.SHORT, /^[a-z]$/);
  assert.match(files.LONG, /^\.\/[^/]+\.json$/);
  assert.strictEqual(files.LONG.length, 20);
}

// Issue #275: unachievable bounds do not mangle the type or throw on generation.
{
  const impossible = [
    ['string', { maxLength: 0, trim: false }],
    ['string', { minLength: Number.MAX_SAFE_INTEGER }],
    ['email', { maxLength: 4 }],
    ['uuid', { maxLength: 35 }],
    ['ipv4', { minLength: 16 }],
    ['semver', { maxLength: 4 }],
    ['base64', { minLength: 9, maxLength: 9 }],
    ['url', { maxLength: 6, protocols: ['https'] }],
    ['hex', { length: 5, minLength: 6 }],
  ];
  for (const [type, bounds] of impossible) {
    const schema = { VALUE: { type, ...bounds } };
    const example = generateExample(schema);
    assert.strictEqual(example, generateExample({ VALUE: { type } }));
    assert.throws(() => validateEnv(schema, parseEnvFile(example)), /expected a string/);
  }
  const reversed = { VALUE: { minLength: 4, maxLength: 3 } };
  assert.throws(() => validateEnv(reversed, {}), /must not exceed/);
  for (const bounds of [{ minLength: 2.5 }, { maxLength: null }, { minLength: 4, maxLength: 3 }, { minLength: -1, maxLength: 3 }]) {
    assert.strictEqual(generateExample({ VALUE: bounds }), generateExample({ VALUE: {} }));
  }
}

// Issue #275: oversized synthesized values keep the ordinary type example.
{
  const cases = [
    ['string', { minLength: 4097 }],
    ['url', { minLength: 4097 }],
    ['base64', { minLength: 4097 }],
    ['hex', { minLength: 0, length: 4097 }],
  ];
  for (const [type, bounds] of cases) {
    const unbounded = parseEnvFile(generateExample({ VALUE: { type } })).VALUE;
    const value = parseEnvFile(generateExample({ VALUE: { type, ...bounds } })).VALUE;
    assert.strictEqual(value === unbounded, true, `${type}: expected the ordinary example, got ${value.length} characters`);
  }
  const exact = { VALUE: { type: 'hex', minLength: 0, length: 4096 } };
  const env = parseEnvFile(generateExample(exact));
  assert.strictEqual(validateEnv(exact, env).VALUE.length, 4096);
}

// Issue #275: growing examples shares a budget across groups and scalar types.
{
  const schema = {
    FIRST: { minLength: 4096 },
    SECOND: { type: 'base64', minLength: 4096 },
    APP: { prefix: 'APP_', schema: {
      SECOND: { type: 'hex', minLength: 0, length: 4096 },
      THIRD: { type: 'email', minLength: 4096 },
    } },
    // The four large examples add 16,337 characters in total. Exactly 47 remain.
    LAST: { minLength: 62 },
    SPILL: { minLength: 16 },
    SHORT: { maxLength: 3 },
  };
  const env = parseEnvFile(generateExample(schema));
  for (const key of ['FIRST', 'SECOND', 'APP_SECOND', 'APP_THIRD']) assert.strictEqual(env[key].length, 4096);
  assert.strictEqual(env.LAST.length, 62);
  assert.strictEqual(env.SPILL, 'your_value_here');
  assert.strictEqual(env.SHORT.length, 3);
  assert.strictEqual(parseEnvFile(generateExample({ SPILL: schema.SPILL })).SPILL.length, 16);
}

// Issue #275: only usable protocol names can shape a generated URL.
{
  for (const protocols of [true, [], [true], ['bad!']]) {
    const schema = { VALUE: { type: 'url', minLength: 25, protocols } };
    assert.strictEqual(parseEnvFile(generateExample(schema)).VALUE, 'https://example.com');
    assert.throws(() => validateEnv(schema, {}), /"protocols" must be a non-empty array of schemes/);
  }
  const mixed = { VALUE: { type: 'url', minLength: 25, protocols: ['bad!', true, 'HTTP:'] } };
  const value = parseEnvFile(generateExample(mixed)).VALUE;
  assert.strictEqual(new URL(value).protocol, 'http:');
  assert.strictEqual(value.length, 25);
  const exact = { VALUE: { type: 'url', minLength: 19, maxLength: 19, protocols: ['http', 'https'] } };
  assert.strictEqual(parseEnvFile(generateExample(exact)).VALUE, 'https://example.com');
  const shortest = { VALUE: { type: 'url', maxLength: 2, protocols: ['X:'] } };
  assert.strictEqual(validateEnv(shortest, parseEnvFile(generateExample(shortest))).VALUE, 'x:');
}

// Issue #275: length adjustment applies only to synthesized placeholders.
{
  const schema = {
    APP: { prefix: 'APP_', schema: { NAME: { maxLength: 3, required: true } } },
    DEFAULTED: { default: 'é🙂', minLength: 3, maxLength: 3 },
    CHOSEN: { choices: ['🙂', 'ok'], minLength: 2, maxLength: 2 },
    API_KEY: { minLength: 20, choices: ['not printed'] },
    SESSION: { minLength: 20, sensitive: true },
    TOKEN: { minLength: 3, default: 'abc' },
  };
  const generated = parseEnvFile(generateExample(schema));
  assert.strictEqual(generated.API_KEY, '');
  assert.strictEqual(generated.SESSION, '');
  const result = validateEnv(schema, generated);
  assert.strictEqual(result.APP.NAME.length, 3);
  assert.strictEqual(result.DEFAULTED, 'é🙂');
  assert.strictEqual(result.CHOSEN, '🙂');
  assert.strictEqual(result.TOKEN, 'abc');

  const tooLong = { FIRST: { maxLength: 1, choices: ['🙂', 'x'] }, DEFAULTED: { maxLength: 1, default: '🙂' } };
  const authored = parseEnvFile(generateExample(tooLong));
  assert.deepStrictEqual(authored, { FIRST: '🙂', DEFAULTED: '🙂' });
  assert.deepStrictEqual(validateEnv(tooLong, authored, { throwOnError: false }).errors.map(e => e.split(':')[0]),
    ['FIRST', 'DEFAULTED']);

  let calls = 0;
  const custom = { VALUE: {
    minLength: 20, pattern: /^Z+$/,
    validate() { calls++; }, transform(value) { calls++; return value; },
  } };
  assert.strictEqual(parseEnvFile(generateExample(custom)).VALUE.length, 20);
  assert.strictEqual(calls, 0);
  assert.strictEqual(parseEnvFile(generateExample({ VALUE: { minLength: 1, maxLength: 20 } })).VALUE, 'your_value_here');

  const supplied = 'a'.repeat(4097);
  const authoredOverBudget = parseEnvFile(generateExample({
    DEFAULTED: { minLength: 4097, default: supplied },
    CHOSEN: { minLength: 4097, choices: [supplied, 'x'] },
    GENERATED: { minLength: 20 },
  }));
  assert.strictEqual(authoredOverBudget.DEFAULTED, supplied);
  assert.strictEqual(authoredOverBudget.CHOSEN, supplied);
  assert.strictEqual(authoredOverBudget.GENERATED.length, 20);
}

// Issue #281: only strings are masked; other values keep their type/identity.
{
  const when = new Date(0);
  const pattern = /secret/;
  class Config { constructor() { this.token = 'abcdef'; } }
  const instance = new Config();
  const fn = () => 'abcdef';
  const symbol = Symbol('secret');
  const plain = { token: 'abcdef' };
  const array = ['abcdef'];
  for (const value of [undefined, null, 42, 0, false, true, 123n, symbol, when, pattern, instance, fn, plain, array]) {
    assert.strictEqual(maskValue(value), value);
  }
  const input = { TEXT: 'abcdef', EMPTY: '', N: 42, B: false, U: undefined, Z: null,
    BIG: 123n, SYMBOL: symbol, AT: when, AGAIN: when, RX: pattern, C: instance, FN: fn,
    NESTED: { VALUES: ['abcdef', 42, false, undefined, null, 123n, when] } };
  const output = maskSecrets(input);
  assert.deepStrictEqual(output, { ...input, TEXT: 'ab***ef',
    NESTED: { VALUES: ['ab***ef', 42, false, undefined, null, 123n, when] } });
  for (const key of ['AT', 'AGAIN', 'RX', 'C', 'FN']) assert.strictEqual(output[key], input[key]);
  assert.notStrictEqual(output, input);
  assert.notStrictEqual(output.NESTED, input.NESTED);
  assert.strictEqual(input.TEXT, 'abcdef');
}

// Issue #234: maskSecrets recurses into plain objects/arrays; cycles get a placeholder
{
  // The issue's example: the masked structure mirrors the input shape and
  // scalar leaves use today's maskValue shapes.
  const out = maskSecrets({ DB: { PASSWORD: 'hunter2' }, TAGS: ['a', 'b'] });
  assert.deepStrictEqual(out, { DB: { PASSWORD: 'hu***r2' }, TAGS: ['****', '****'] });
  // Flat input behaves byte-for-byte as today.
  assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456', EMPTY: '' }), { KEY: 'sk***56', EMPTY: '' });
  assert.deepStrictEqual(
    maskSecrets({ N: 12345, B: true, Z: null }),
    { N: maskValue(12345), B: maskValue(true), Z: maskValue(null) }
  );
  // Deep nesting and arrays of objects keep their shape.
  assert.deepStrictEqual(
    maskSecrets({ a: { b: { c: { d: 'secret-value' } } }, list: [{ X: 'abcdef' }, 'xy', 42] }),
    { a: { b: { c: { d: 'se***ue' } } }, list: [{ X: 'ab***ef' }, '****', 42] }
  );
  // Non-plain values (Date, class instances) stay unchanged.
  const when = new Date('2026-01-01T00:00:00.000Z');
  assert.deepStrictEqual(maskSecrets({ AT: when }), { AT: maskValue(when) });
  class Cfg { constructor() { this.token = 'abcdef'; } }
  const cfg = new Cfg();
  assert.deepStrictEqual(maskSecrets({ C: cfg }), { C: maskValue(cfg) });
  // A self-referencing object returns without hanging: the repeated reference
  // becomes a fixed placeholder.
  const cyc = { NAME: 'abcdef' };
  cyc.self = cyc;
  assert.deepStrictEqual(maskSecrets(cyc), { NAME: 'ab***ef', self: '[Circular]' });
  // Same for a cycle through an array.
  const arr = ['abcdef'];
  arr.push(arr);
  assert.deepStrictEqual(maskSecrets({ LIST: arr }), { LIST: ['ab***ef', '[Circular]'] });
  // A repeated (non-cyclic) reference is also replaced with the placeholder.
  const shared = { TOKEN: 'abcdef' };
  assert.deepStrictEqual(maskSecrets({ A: shared, B: shared }), { A: { TOKEN: 'ab***ef' }, B: '[Circular]' });
  // The input is not mutated, and empty containers pass through.
  const input = { DB: { PASSWORD: 'hunter2' } };
  maskSecrets(input);
  assert.deepStrictEqual(input, { DB: { PASSWORD: 'hunter2' } });
  assert.deepStrictEqual(maskSecrets({}), {});
  assert.deepStrictEqual(maskSecrets({ LIST: [] }), { LIST: [] });
}

// Issue #222: scanCode — optional chaining `process.env?.KEY` / `import.meta.env?.KEY`
{
  // The reported case: an optional-chained read is a read.
  assert.deepStrictEqual(scanCode('const x = process.env?.MAYBE_KEY;'), ['MAYBE_KEY']);
  // Plain dot access keeps working unchanged.
  assert.deepStrictEqual(scanCode('const x = process.env.MAYBE_KEY;'), ['MAYBE_KEY']);
  // Optional and plain reads mix freely in one source: one sorted, unique list.
  assert.deepStrictEqual(scanCode('process.env.A; process.env?.B; process.env?.A; process.env.A;'), ['A', 'B']);
  // Bracket and backtick forms behind `?.` work too.
  assert.deepStrictEqual(scanCode("process.env?.['BRACKET']; process.env?.[`TICK`];"), ['BRACKET', 'TICK']);
  assert.deepStrictEqual(
    scanCode("import.meta.env?.VITE_A; import.meta.env?.['VITE_B']; import.meta.env?.[`VITE_C`];"),
    ['VITE_A', 'VITE_B', 'VITE_C']
  );
  // Chained further (`process.env?.A?.B`) still reports the env read `A`.
  assert.deepStrictEqual(scanCode('const y = process.env?.A?.B;'), ['A']);
  // A `?.` mention inside a comment, string or template text is still not a read.
  assert.deepStrictEqual(scanCode('// set process.env?.NOPE first'), []);
  assert.deepStrictEqual(scanCode('/* process.env?.BLOCK */'), []);
  assert.deepStrictEqual(scanCode('const s = "process.env?.STR";'), []);
  assert.deepStrictEqual(scanCode("const t = 'process.env?.QUOTE';"), []);
  assert.deepStrictEqual(scanCode('const u = `see process.env?.TMPL in docs`;'), []);
  // A real optional read and a decoy on the same line: only the read counts.
  assert.deepStrictEqual(scanCode('const g = process.env?.REAL; // process.env?.FAKE'), ['REAL']);
  assert.deepStrictEqual(scanCode('const g = process.env?.REAL; const s = "process.env?.STR2";'), ['REAL']);
  // An optional read inside a template's ${...} is a read; the text around it is not.
  assert.deepStrictEqual(scanCode('const v = `k=${process.env?.IN_TMPL} and process.env?.FAKE2`'), ['IN_TMPL']);
  // `process.env?.` with no identifier after it is not a read (and must not crash).
  assert.deepStrictEqual(scanCode('const z = process.env?.;'), []);
  // scanDir picks up optional-chained reads in real files, next to plain ones,
  // and still ignores comments — end to end through the CLI `scan` command.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const u = process.env?.TS_KEY; // process.env?.NOPE\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.mjs'), "import x from 'x';\nconst k = process.env['PLAIN'];\nconst o = process.env?.OPT_KEY;\n");
  const cli = path.join(__dirname, 'cli.js');
  const out = spawnSync('node', [cli, 'scan', path.join(dir, 'src'), '--json'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(JSON.parse(out.stdout).vars, ['OPT_KEY', 'PLAIN', 'TS_KEY']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #222 (edge cases): optional-chaining details and the `check` round-trip
{
  // Keys with digits/underscores, and the double-quoted bracket form.
  assert.deepStrictEqual(scanCode('process.env?._PRIVATE_2; process.env?.["DQ_KEY"];'), ['DQ_KEY', '_PRIVATE_2']);
  // Duplicates across plain and optional forms collapse into one sorted entry.
  assert.deepStrictEqual(scanCode('process.env?.SAME; process.env.SAME; process.env?.SAME;'), ['SAME']);
  // import.meta.env optional reads sort together with process.env ones.
  assert.deepStrictEqual(scanCode('process.env?.ZZZ; import.meta.env?.AAA;'), ['AAA', 'ZZZ']);
  // Empty / non-string input does not crash and finds nothing.
  assert.deepStrictEqual(scanCode(''), []);
  assert.deepStrictEqual(scanCode(null), []);
  assert.deepStrictEqual(scanCode(undefined), []);
  assert.deepStrictEqual(scanCode(42), []);
  // `process.env?.` followed by a non-identifier is not a read.
  assert.deepStrictEqual(scanCode('process.env?.9BAD; process.env?.-X;'), []);
  // An optional chain on something that is not `env` is not reported.
  assert.deepStrictEqual(scanCode('const a = foo?.env?.BAR;'), []);
  // A block comment spanning lines masks optional reads inside it.
  assert.deepStrictEqual(scanCode('/* process.env?.L1\nprocess.env?.L2 */ const a = process.env?.REAL;'), ['REAL']);
  // The bracket key sits in a (masked) literal, but the head is code: still a read.
  assert.deepStrictEqual(scanCode("const a = process.env?.['IN_BRACKET'];"), ['IN_BRACKET']);
  // Destructuring keeps working next to optional reads.
  assert.deepStrictEqual(scanCode('const { D } = process.env; const o = process.env?.O;'), ['D', 'O']);

  // The motivation end to end: a key read ONLY through `?.` is "used", so
  // `check` against a .env.example declaring it must not flag it as UNUSED.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const m = process.env?.MAYBE_KEY;\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'MAYBE_KEY=\n');
  const cli = path.join(__dirname, 'cli.js');
  const out = spawnSync('node', [cli, 'check', dir], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('all clean'), out.stdout);
  assert.ok(!out.stdout.includes('UNUSED'), out.stdout);
  // ...while a key declared but never read at all is still flagged (exit 1).
  fs.writeFileSync(path.join(dir, '.env.example'), 'MAYBE_KEY=\nNEVER_READ=\n');
  const out2 = spawnSync('node', [cli, 'check', dir], { encoding: 'utf8' });
  assert.strictEqual(out2.status, 1);
  assert.ok(out2.stdout.includes('UNUSED: NEVER_READ'), out2.stdout);
  assert.ok(!out2.stdout.includes('UNUSED: MAYBE_KEY'), out2.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const aliases = [
    'local.BEFORE_DECLARATION;',
    '// const phantom = /*',
    'const visible = /* note */ process.env; visible.VISIBLE;',
    '"const stringPhantom = /*";',
    'const afterString = /* note */ process.env; afterString.AFTER_STRING;',
    '\x60const templatePhantom = /*\x60;',
    'const afterTemplate = /* note */ import.meta.env; afterTemplate.AFTER_TEMPLATE;',
    'const tagged = import.meta.env\x60tagged\x60; tagged.EXTRA;',
    'const multilineTag = process.env',
    '\x60tagged\x60; multilineTag.EXTRA;',
    'const before = /* gap */ process.env; before.BEFORE_SOURCE;',
    'const comma = process.env, port = comma.COMMA;',
    'const unrelated = /* gap */ fallback; /* gap */ process.env; unrelated.NOPE;',
    'let increment = process.env',
    '++count; increment.INCREMENT;',
    'let decrement = process.env',
    '--count; decrement.DECREMENT;',
    'const $env = process.env;',
    'let local = process.env',
    'var vite = import.meta.env;',
    '$env.Z; local["A"]; local[\x60B\x60]; vite.VITE_X; $env.Z;',
    'const commented = process.env /* source */; commented.COMMENTED;',
    '[...local.ARGS]; local.PORT$NAME;',
    'config./* gap */local.OBJECT_ONLY; this.#local.OBJECT_ONLY;',
    'const continued = process.env',
    '["PORT"]; continued.length;',
    'other.NOPE; wrapper.$env.NOPE; prefix$env.NOPE;',
    '// local.COMMENT',
    '/* local.BLOCK; const hidden = process.env; */ hidden.NOPE;',
    '"const fake = process.env;"; fake.NOPE; "local.STRING";',
    '\x60local.TEXT ${local.EXPRESSION}\x60;',
    'const selected = process.env.SELECTED; selected.NOPE;',
    'const copy = process.env || {}; copy.NOPE;',
    'const { DIRECT } = process.env; import.meta.env?.VITE_DIRECT;',
  ].join('\n');
  assert.deepStrictEqual(scanCode(aliases),
    ['A', 'AFTER_STRING', 'AFTER_TEMPLATE', 'ARGS', 'B', 'BEFORE_SOURCE', 'COMMA', 'COMMENTED', 'DECREMENT', 'DIRECT', 'EXPRESSION', 'INCREMENT', 'SELECTED', 'VISIBLE', 'VITE_DIRECT', 'VITE_X', 'Z']);
}

// Issue #230: watch-mode integration test — spawn `cli.js check --watch` as a
// subprocess, edit files, and assert it re-runs (debounced) and exits 0 on Ctrl-C.
const watchModeTest = (async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-watch-'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(process.env.PORT);\n');
    const childEnv = { PATH: process.env.PATH || '' };
    if (process.platform === 'win32') { if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT; }
    else if (process.env.HOME) childEnv.HOME = process.env.HOME;
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--watch'], { cwd: dir, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const waitFor = async (pred, what, timeoutMs = 8000) => {
      const start = Date.now();
      while (!(typeof pred === 'function' ? pred() : pred.test(out))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
        await sleep(50);
      }
    };
    const runCount = () => (out.match(/check finished, exit/g) || []).length;

    // initial run happens and reports the clean state
    await waitFor(/all clean/, 'initial result');
    assert.ok(/watching/.test(out), 'watch banner printed');
    assert.strictEqual(runCount(), 1);

    // editing the source re-runs the check and reports the new MISSING key
    fs.appendFileSync(path.join(dir, 'app.js'), 'console.log(process.env.NEW_KEY);\n');
    await waitFor(() => /MISSING in \.env\.example: NEW_KEY/.test(out) && runCount() >= 2, 're-run after source edit');
    assert.strictEqual(runCount(), 2);

    // editing the real .env re-runs too (EXTRA finding)
    fs.appendFileSync(path.join(dir, '.env'), 'LOCAL_ONLY=1\n');
    await waitFor(() => /EXTRA in \.env: LOCAL_ONLY/.test(out) && runCount() >= 3, 're-run after .env edit');

    // debounce: two rapid successive saves collapse into a single re-run
    const before = runCount();
    fs.appendFileSync(path.join(dir, 'app.js'), '// touch 1\n');
    await sleep(25);
    fs.appendFileSync(path.join(dir, 'app.js'), '// touch 2\n');
    await sleep(900);
    assert.strictEqual(runCount() - before, 1, `two rapid saves must collapse into one re-run (got ${runCount() - before})`);

    // Ctrl-C exits cleanly with code 0
    const exitCode = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); });
    assert.strictEqual(exitCode, 0, 'SIGINT in watch mode exits 0');
    assert.ok(/stopped watching/.test(out), 'prints a stop message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('watch-mode tests passed');
})();

// Issue #230 (review blockers): watch mode survives error exits (missing
// template, malformed env file) and picks up --schema edits instead of
// re-running against the require()-cached schema.
const watchModeErrorPathTest = (async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-watch2-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(process.env.PORT);\n');
    fs.writeFileSync(path.join(dir, 'env.schema.cjs'), 'module.exports = { PORT: { type: "int", min: 1, max: 65535 } };\n');
    const childEnv = { PATH: process.env.PATH || '' };
    if (process.platform === 'win32') { if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT; }
    else if (process.env.HOME) childEnv.HOME = process.env.HOME;
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--schema', 'env.schema.cjs', '--watch'], { cwd: dir, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    const waitFor = async (pred, what, timeoutMs = 8000) => {
      const start = Date.now();
      while (!(typeof pred === 'function' ? pred() : pred.test(out))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
        await sleep(50);
      }
    };
    const runCount = () => (out.match(/check finished, exit/g) || []).length;

    // Blocker 1a: starting watch with no .env.example reports exit 2 but keeps watching.
    await waitFor(/\.env\.example not found/, 'missing template message');
    await waitFor(/check finished, exit 2/, 'missing template exit-2 line');
    await sleep(400);
    assert.strictEqual(exited, null, 'watcher must not exit on a missing template');

    // Creating the template re-runs and goes clean.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    await waitFor(() => /all clean/.test(out) && runCount() >= 2, 'clean re-run after template appears');

    // Blocker 1b: a malformed template mid-watch (duplicate key) reports the error,
    // logs exit 2, and the watcher stays alive; fixing it recovers.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nPORT=1\n');
    await waitFor(() => /duplicate key PORT/.test(out) && /check finished, exit 2/.test(out) && runCount() >= 3, 'duplicate-key error with exit 2, watcher alive');
    await sleep(400);
    assert.strictEqual(exited, null, 'watcher must not exit on a malformed template');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    await waitFor(() => /all clean/.test(out) && runCount() >= 4, 'recovery after template fix');

    // Blocker 2: a --schema edit must re-run against the NEW schema (no stale require cache).
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    await waitFor(() => runCount() >= 5, 're-run after .env appears');
    fs.writeFileSync(path.join(dir, 'env.schema.cjs'), 'module.exports = { PORT: { type: "int", min: 1, max: 100 } };\n');
    await waitFor(() => /INVALID: PORT/.test(out) && /check finished, exit 1/.test(out), 'schema edit picked up (INVALID from the new schema)');

    const exitCode = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); });
    assert.strictEqual(exitCode, 0, 'SIGINT in watch mode exits 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('watch-mode error-path tests passed');
})();

// Issue #285: watch mode picks up edits and syntax errors in an ESM (.mjs) --schema file.
const watchModeEsmSchemaTest = (async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-watch-esm-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(process.env.PORT);\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    fs.writeFileSync(path.join(dir, 'env.schema.mjs'), 'export default { PORT: { type: "int", min: 1, max: 65535 } };\n');
    const childEnv = { PATH: process.env.PATH || '' };
    if (process.platform === 'win32') { if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT; }
    else if (process.env.HOME) childEnv.HOME = process.env.HOME;
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--schema', 'env.schema.mjs', '--watch'], { cwd: dir, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    const waitFor = async (pred, what, timeoutMs = 8000) => {
      const start = Date.now();
      while (!(typeof pred === 'function' ? pred() : pred.test(out))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
        await sleep(50);
      }
    };
    const runCount = () => (out.match(/check finished, exit/g) || []).length;

    await waitFor(() => /all clean/.test(out) && /check finished, exit 0/.test(out), 'initial clean run with .mjs schema');
    assert.strictEqual(runCount(), 1);

    // Editing the .mjs schema reloads the new export default without stale module caching.
    fs.writeFileSync(path.join(dir, 'env.schema.mjs'), 'export default { PORT: { type: "int", min: 1, max: 100 } };\n');
    await waitFor(() => /INVALID: PORT/.test(out) && /check finished, exit 1/.test(out) && runCount() >= 2, 're-run after .mjs schema edit');

    // A broken .mjs edit mid-watch reports exit 2 and keeps watching; fixing it recovers.
    fs.writeFileSync(path.join(dir, 'env.schema.mjs'), 'export default {{{\n');
    await waitFor(() => /cannot load schema env\.schema\.mjs/.test(out) && /check finished, exit 2/.test(out) && runCount() >= 3, 'broken .mjs edit reports exit 2');
    await sleep(300);
    assert.strictEqual(exited, null, 'watcher must survive a broken .mjs schema');

    fs.writeFileSync(path.join(dir, 'env.schema.mjs'), 'export default { PORT: { type: "port", required: true } };\n');
    await waitFor(() => /check finished, exit 0/.test(out) && runCount() >= 4, 'recovery after fixing .mjs schema');

    const exitCode = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); });
    assert.strictEqual(exitCode, 0, 'SIGINT in watch mode exits 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('watch-mode ESM schema tests passed');
})();

const loadEnvAsyncTest = (async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { loadEnv, loadEnvAsync } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-async-'));
  const first = path.join(dir, 'first.env');
  const last = path.join(dir, 'last.env');
  const missing = path.join(dir, 'missing.env');
  const schema = { PORT: { type: 'port', required: true }, DATA: { type: 'json' } };
  try {
    fs.writeFileSync(first, 'PORT=3000\nDATA={"demo":true}\n');
    fs.writeFileSync(last, 'PORT=4000\n');
    const promise = loadEnvAsync(schema, { path: first, env: {} });
    assert.ok(promise instanceof Promise);
    assert.deepStrictEqual(await promise, { PORT: 3000, DATA: { demo: true } });
    assert.deepStrictEqual(await loadEnvAsync(schema, { paths: [missing, first, last], env: {} }),
      { PORT: 4000, DATA: { demo: true } });
    assert.deepStrictEqual(await loadEnvAsync({}, { paths: [missing], env: {} }), {});
    const groupedFile = path.join(dir, 'grouped.env');
    fs.writeFileSync(groupedFile, 'DB_HOST=db.internal\nDB_PORT=5432\n');
    const grouped = await loadEnvAsync({
      DB: { prefix: 'DB_', schema: {
        HOST: { type: 'host', required: true },
        PORT: { type: 'port', required: true },
      } },
    }, { path: groupedFile, env: {} });
    assert.deepStrictEqual(grouped, { DB: { HOST: 'db.internal', PORT: 5432 } });
    assert.ok(Object.isFrozen(grouped));
    assert.ok(Object.isFrozen(grouped.DB));
    assert.throws(() => { grouped.DB.HOST = 'changed.internal'; }, TypeError);
    assert.strictEqual(grouped.DB.HOST, 'db.internal');
    fs.writeFileSync(groupedFile, 'APP_DB_HOST=db.internal\n');
    const nestedTarget = {};
    const nested = await loadEnvAsync({ APP: { prefix: 'APP_', schema: {
      DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true } } },
    } } }, { path: groupedFile, env: nestedTarget, assign: true });
    assert.deepStrictEqual(nested, { APP: { DB: { HOST: 'db.internal' } } });
    assert.deepStrictEqual(nestedTarget, { APP_DB_HOST: 'db.internal' });
    assert.ok(Object.isFrozen(nested.APP));
    assert.ok(Object.isFrozen(nested.APP.DB));
    const defaultRead = fs.promises.readFile;
    try {
      fs.promises.readFile = async (file, encoding) => {
        assert.strictEqual(file, '.env');
        assert.strictEqual(encoding, 'utf8');
        throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' });
      };
      assert.deepStrictEqual(await loadEnvAsync({}, { env: {} }), {});
    } finally {
      fs.promises.readFile = defaultRead;
    }

    for (const override of [false, true]) {
      const env = { PORT: '5000' };
      const options = { path: [first, last], env, override, assign: true };
      const syncEnv = { ...env };
      const expected = loadEnv(schema, { ...options, env: syncEnv });
      assert.deepStrictEqual(await loadEnvAsync(schema, options), expected);
      assert.deepStrictEqual(env, syncEnv);
      assert.deepStrictEqual(env, { PORT: override ? '4000' : '5000', DATA: '{"demo":true}' });
    }

    async function assertSameError(inputSchema, options) {
      let expected;
      assert.throws(() => loadEnv(inputSchema, options), error => {
        expected = error;
        return true;
      });
      await assert.rejects(loadEnvAsync(inputSchema, options), error => {
        assert.strictEqual(error.constructor, expected.constructor);
        assert.strictEqual(error.message, expected.message);
        assert.deepStrictEqual(error.errors, expected.errors);
        return true;
      });
    }

    await assertSameError(schema, { path: missing, env: {} });
    await assertSameError(schema, { paths: [missing], env: { PORT: '5000' } });
    await assertSameError(schema, { paths: [missing, dir], env: {} });
    await assertSameError(null, { get path() { throw new Error('options read too soon'); } });

    fs.writeFileSync(last, 'PORT=invalid\n');
    const env = { KEEP: 'synthetic' };
    await assertSameError(schema, { paths: [first, last], env, assign: true, throwOnError: false });
    assert.deepStrictEqual(env, { KEEP: 'synthetic' });

    let rawErrors;
    assert.throws(() => loadEnv(schema, { path: last, env: {} }), error => {
      assert.ok(error instanceof EnvSaafError);
      rawErrors = error.errors;
      return true;
    });
    let formatterCalls = 0;
    const formatError = (errors, { keys }) => {
      formatterCalls++;
      assert.deepStrictEqual(errors, rawErrors);
      assert.deepStrictEqual(keys, ['PORT', 'DATA']);
      return 'Invalid test configuration';
    };
    const isFormatted = (error) => {
      assert.ok(error instanceof EnvSaafError);
      assert.strictEqual(error.message, 'Invalid test configuration');
      assert.deepStrictEqual(error.errors, rawErrors);
      return true;
    };
    const invalidOptions = { path: last, env: {}, formatError, throwOnError: false };
    assert.throws(() => loadEnv(schema, invalidOptions), isFormatted);
    await assert.rejects(loadEnvAsync(schema, invalidOptions), isFormatted);
    assert.strictEqual(formatterCalls, 2);

    fs.writeFileSync(last, 'PORT=4000\nPORT=5000\n');
    await assertSameError(schema, { paths: [last, dir], env: {}, formatError });
    await assertSameError(schema, { path: dir, env: {}, formatError });
    await assertSameError(schema, { path: missing, env: {}, formatError });
    assert.strictEqual(formatterCalls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// Issue #231: opt-in `formatError` hook customises the thrown message only.
{
  const schema = { PORT: { type: 'port', required: true }, TOKEN: { type: 'int', sensitive: true } };
  const bad = { PORT: 'abc', TOKEN: 'secret-synthetic-value' };
  let plain;
  assert.throws(() => validateEnv(schema, bad), (e) => { plain = e; return e instanceof EnvSaafError; });

  // Hook output becomes the message; raw errors are unchanged.
  let seen;
  assert.throws(() => validateEnv(schema, bad, {
    formatError: (errors, context) => { seen = { errors, context }; return `ALERT ${errors.length}: ${context.keys.join(',')}`; },
  }), (e) => {
    assert.ok(e instanceof EnvSaafError);
    assert.strictEqual(e.name, 'EnvSaafError');
    assert.strictEqual(e.message, 'ALERT 2: PORT,TOKEN');
    assert.deepStrictEqual(e.errors, plain.errors);
    return true;
  });
  assert.deepStrictEqual(seen.errors, plain.errors);
  assert.deepStrictEqual(Object.keys(seen.context), ['keys']);
  assert.deepStrictEqual(seen.context.keys, ['PORT', 'TOKEN']);
  assert.ok(!JSON.stringify(seen).includes('secret-synthetic-value'));

  // The hook gets an isolated copy: mutating it cannot change error.errors.
  assert.throws(() => validateEnv(schema, bad, {
    formatError: (errors) => { try { errors.push('x'); } catch (_) { /* frozen */ } return 'm'; },
  }), (e) => { assert.deepStrictEqual(e.errors, plain.errors); return true; });

  // Without the hook (or with an empty-string result), the default stays byte-for-byte.
  assert.strictEqual(plain.message, 'Invalid environment variables:\n' + plain.errors.map(x => `  - ${x}`).join('\n'));
  assert.throws(() => validateEnv(schema, bad, { formatError: () => '' }), (e) => e.message === '');

  // Non-string hooks fall back to the default message.
  for (const hook of [() => 42, () => undefined, () => null, () => ({})]) {
    assert.throws(() => validateEnv(schema, bad, { formatError: hook }), (e) => { assert.strictEqual(e.message, plain.message); assert.deepStrictEqual(e.errors, plain.errors); return true; });
  }

  // Never called when validation passes.
  let calls = 0;
  validateEnv(schema, { PORT: '3000' }, { formatError: () => { calls++; return 'x'; } });
  assert.strictEqual(calls, 0);

  // throwOnError:false: nothing is thrown, so the hook is skipped and errors stay raw.
  const collected = validateEnv(schema, bad, { throwOnError: false, formatError: () => { calls++; return 'x'; } });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(collected.errors, plain.errors);

  // A non-function hook is a programming error, rejected even when env is valid.
  for (const bad2 of [null, 'x', 1, {}]) {
    assert.throws(() => validateEnv(schema, { PORT: '3000' }, { formatError: bad2 }), /formatError/);
  }

  // Schema errors are bugs in code, not env problems: schema header, hook unused.
  assert.throws(() => validateEnv({ A: { type: 'nope' } }, {}, { formatError: () => { calls++; return 'x'; } }),
    (e) => { assert.ok(e instanceof EnvSaafError); assert.ok(e.message.startsWith('Invalid schema:')); return true; });
  assert.strictEqual(calls, 0);

  // loadEnv threads the option through (it always throws, so throwOnError:false is ignored).
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'env-saaf-231-'));
  const envFile = require('node:path').join(tmp, 'empty.env');
  try {
    require('node:fs').writeFileSync(envFile, '');
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad, formatError: (errs, ctx) => `L ${errs.length} ${ctx.keys.length}` }),
      (e) => e instanceof EnvSaafError && e.message === 'L 2 2' && e.errors.length === 2);
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad, throwOnError: false, formatError: () => 'y' }), (e) => e.message === 'y');
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad }), (e) => e.message === plain.message);
  } finally {
    require('node:fs').rmSync(tmp, { recursive: true, force: true });
  }
  console.log('formatError tests passed');
}

// Issue #279: a throwing `formatError` hook is a programming error — its
// error propagates out of validateEnv / loadEnv unchanged, instead of
// vanishing behind the default message.
const formatErrorThrowingHookTest = (async () => {
  const { loadEnvAsync } = require('./index');
  const schema = { A: { type: 'string', required: true } };
  const hookError = new Error('hook boom');
  assert.throws(() => validateEnv(schema, {}, { formatError: () => { throw hookError; } }),
    (e) => { assert.strictEqual(e, hookError); return true; });
  // Same through loadEnv, which forwards the hook for validation failures.
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'env-saaf-279-'));
  const envFile = require('node:path').join(tmp, 'empty.env');
  try {
    require('node:fs').writeFileSync(envFile, '');
    assert.throws(() => loadEnv(schema, { path: envFile, env: {}, formatError: () => { throw hookError; } }),
      (e) => { assert.strictEqual(e, hookError); return true; });
    // And through loadEnvAsync, which shares the same steps.
    await assert.rejects(loadEnvAsync(schema, { path: envFile, env: {}, formatError: () => { throw hookError; } }),
      (e) => { assert.strictEqual(e, hookError); return true; });
  } finally {
    require('node:fs').rmSync(tmp, { recursive: true, force: true });
  }
  console.log('formatError throwing-hook tests passed');
})();

// Issue #283: schema mistakes are reported as "Invalid schema:", not
// "Invalid environment variables:". A bad rule is a bug in the schema, so the
// header must point the developer at the schema instead of blaming the env.
{
  // Direct validateSchema: a bad type yields the schema header.
  assert.throws(() => validateSchema({ A: { type: 'nope' } }), (e) => {
    assert.ok(e instanceof EnvSaafError);
    assert.strictEqual(e.message.split('\n')[0], 'Invalid schema:');
    assert.ok(!e.message.startsWith('Invalid environment variables:'));
    return true;
  });

  // validateEnv: schema errors keep the schema header and never run formatError.
  let schemaHookCalls = 0;
  assert.throws(() => validateEnv({ A: { type: 'nope' } }, {}, { formatError: () => { schemaHookCalls++; return 'x'; } }), (e) => {
    assert.ok(e instanceof EnvSaafError);
    assert.strictEqual(e.message.split('\n')[0], 'Invalid schema:');
    return true;
  });
  assert.strictEqual(schemaHookCalls, 0);

  // Genuine value errors still use the env header (no regression).
  assert.throws(() => validateEnv({ PORT: { type: 'port', required: true } }, { PORT: 'abc' }), (e) => {
    assert.ok(e instanceof EnvSaafError);
    assert.strictEqual(e.message.split('\n')[0], 'Invalid environment variables:');
    return true;
  });
  console.log('schema-error header tests passed');
}

// Issue #276: non-string values in a hand-built env object. `null` counts
// as "not set" (like `undefined`) instead of becoming the string "null";
// objects and arrays on non-array rules fail with an error naming the key
// instead of coercing to "[object Object]" or "".
{
  assert.throws(() => validateEnv({ S: { type: 'string', required: true } }, { S: null }), /S: missing required variable/);
  assert.deepStrictEqual(validateEnv({ S: { type: 'string' } }, { S: null }), {});
  assert.strictEqual(validateEnv({ S: { type: 'string', default: 'dflt' } }, { S: null }).S, 'dflt');
  assert.strictEqual(validateEnv({ S: { type: 'string', default: 'dflt', aliases: ['OLD_S'] } }, { OLD_S: null }, { onWarn: () => {} }).S, 'dflt');
  assert.throws(() => validateEnv({ S: { type: 'string' } }, { S: {} }), /S: expected a string value, got an object/);
  assert.throws(() => validateEnv({ S: { type: 'string' } }, { S: [] }), /S: expected a string value, got an array/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: {} }), /N: expected a string value, got an object/);
  // `json` rules keep passing already-parsed values through, by design.
  assert.deepStrictEqual(validateEnv({ J: { type: 'json' } }, { J: { a: 1 } }).J, { a: 1 });
  const partial = validateEnv({ S: { type: 'string' }, N: { type: 'int' } }, { S: {}, N: '5' }, { throwOnError: false });
  assert.deepStrictEqual(partial.errors, ['S: expected a string value, got an object']);
  assert.strictEqual(partial.env.N, 5);
  // A real array still works for an array rule; numbers/booleans are untouched.
  assert.deepStrictEqual(validateEnv({ A: { type: 'array', of: 'int' } }, { A: [1, 2] }).A, [1, 2]);
  assert.strictEqual(validateEnv({ S: { type: 'string' } }, { S: 42 }).S, '42');
  assert.strictEqual(validateEnv({ B: { type: 'boolean' } }, { B: true }).B, true);
}

// Issue #282: `of` / `separator` only apply to `array` rules and
// `protocols` only to `url` rules (plus `array`, where it flows to
// `of: 'url'` items) — anywhere else they are dead config and are rejected
// up front, mirroring the string-only checks of #211. min/max stay allowed
// on every type: they apply to any numeric value.
{
  assert.throws(() => validateEnv({ S: { type: 'string', of: 'int' } }, {}), /S: "of" only applies to type 'array'/);
  assert.throws(() => validateEnv({ N: { type: 'int', separator: ';' } }, {}), /N: "separator" only applies to type 'array'/);
  assert.throws(() => validateEnv({ S: { type: 'string', protocols: ['https'] } }, {}), /S: "protocols" only applies to type 'url'/);
  assert.throws(() => validateEnv({ B: { type: 'boolean', protocols: ['https'] } }, {}), /B: "protocols" only applies to type 'url'/);
  // The combinations that do apply keep working:
  assert.deepStrictEqual(validateEnv({ A: { type: 'array', of: 'url', protocols: ['https'] } }, { A: 'https://a.com,https://b.com' }).A, ['https://a.com', 'https://b.com']);
  assert.throws(() => validateEnv({ A: { type: 'array', of: 'url', protocols: ['https'] } }, { A: 'http://a.com' }), /expected a URL with one of these protocols/);
  assert.strictEqual(validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'https://a.com' }).U, 'https://a.com');
  assert.strictEqual(validateEnv({ S: { type: 'string', min: 1 } }, { S: 'x' }).S, 'x');
}

// Issue #295: unknown requiredIf keys warn without disabling external flags.
{
  const { validateSchema } = require('./index');
  const schema = { MODE: { type: 'string' }, KEY: { type: 'string', requiredIf: { key: 'MOD', equals: 'prod' } } };
  const expected = 'env-saaf: KEY: requiredIf references undeclared key "MOD"; check for a typo or declare the key (external env flags still work)';
  const messages = [];
  const originalWarn = console.warn;
  try {
    console.warn = msg => messages.push(msg);
    validateSchema(schema);
  } finally { console.warn = originalWarn; }
  assert.deepStrictEqual(messages, [expected]);

  const warnings = [];
  const result = validateEnv(schema, {}, { onWarn: msg => warnings.push(msg), throwOnError: false });
  assert.deepStrictEqual(result, { env: {}, errors: [], details: [] });
  assert.deepStrictEqual(warnings, [expected]);

  // A legitimate undeclared NODE_ENV still makes the dependent key required.
  const external = { KEY: { type: 'string', requiredIf: { key: 'NODE_ENV', in: ['production'] } } };
  const externalWarnings = [];
  const missing = validateEnv(external, { NODE_ENV: 'production' }, { throwOnError: false, onWarn: msg => externalWarnings.push(msg) });
  assert.deepStrictEqual(missing.errors, ['KEY: missing required variable']);
  assert.strictEqual(externalWarnings.length, 1);
  assert.deepStrictEqual(validateEnv(external, { NODE_ENV: 'production', KEY: 'value' }, { onWarn: () => {} }), { KEY: 'value' });

  // Full env names can refer across groups and to a flat key without warnings.
  const grouped = {
    MODE: { type: 'string' },
    DB: { prefix: 'DB_', schema: { KEY: { type: 'string', requiredIf: { key: 'MODE', equals: 'prod' } } } },
    APP: { prefix: 'APP_', schema: { TOKEN: { type: 'string', requiredIf: { key: 'DB_KEY', equals: 'value' } } } },
  };
  const groupWarnings = [];
  validateEnv(grouped, {}, { onWarn: msg => groupWarnings.push(msg) });
  assert.deepStrictEqual(groupWarnings, []);
  grouped.DB.schema.KEY.requiredIf.key = 'MDOE';
  validateEnv(grouped, {}, { onWarn: msg => groupWarnings.push(msg) });
  assert.strictEqual(groupWarnings.length, 1);
  assert.ok(groupWarnings[0].includes('DB_KEY: requiredIf references undeclared key "MDOE"'));

  assert.throws(() => validateEnv(schema, {}, { onWarn: 1 }), TypeError);
}

// Issue #295: loadEnv forwards its existing warning hook to schema validation.
{
  const warnings = [];
  const result = loadEnv({ KEY: { type: 'string', requiredIf: { key: 'EXTERNAL_FLAG', equals: 'prod' } } }, {
    path: [], env: { EXTERNAL_FLAG: 'prod', KEY: 'value' }, onWarn: msg => warnings.push(msg),
  });
  assert.strictEqual(result.KEY, 'value');
  assert.strictEqual(warnings.length, 1);
}

// Issue #288: sensitive rules retain their annotation in exported JSON Schema.
{
  const schema = {
    SESSION: { type: 'string', sensitive: true, required: true },
    COUNT: { type: 'int', sensitive: true },
    TAGS: { type: 'array', sensitive: true },
    PLAIN: { type: 'string' },
    FALSE: { type: 'string', sensitive: false },
    DB: { prefix: 'DB_', schema: {
      PASSWORD: { type: 'string', sensitive: true },
      HOST: { type: 'host' },
    } },
  };
  const exported = toJsonSchema(schema);
  assert.deepStrictEqual(exported.properties.SESSION, { type: 'string', writeOnly: true });
  assert.strictEqual(exported.properties.COUNT.writeOnly, true);
  assert.strictEqual(exported.properties.TAGS.writeOnly, true);
  assert.deepStrictEqual(exported.properties.DB.properties.PASSWORD, { type: 'string', writeOnly: true });
  assert.deepStrictEqual(exported.properties.PLAIN, { type: 'string' });
  assert.deepStrictEqual(exported.properties.FALSE, { type: 'string' });
  assert.ok(!Object.prototype.hasOwnProperty.call(exported.properties.DB, 'writeOnly'));
  assert.ok(!Object.prototype.hasOwnProperty.call(exported.properties.DB.properties.HOST, 'writeOnly'));
  assert.deepStrictEqual(exported.required, ['SESSION']);
  const ordinary = { S: { type: 'string' }, N: { type: 'int' } };
  assert.strictEqual(JSON.stringify(toJsonSchema(ordinary)), JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { S: { type: 'string' }, N: { type: 'integer' } },
  }));
}

// Issue #303: toJsonSchema expresses `semver` as a pattern on scalar rules and array items.
{
  const scalar = toJsonSchema({ V: { type: 'semver' } });
  const arr = toJsonSchema({ VERSIONS: { type: 'array', of: 'semver' } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(scalar)), scalar);
  assert.strictEqual(scalar.properties.V.type, 'string');
  assert.strictEqual(typeof scalar.properties.V.pattern, 'string');
  assert.deepStrictEqual(arr.properties.VERSIONS, {
    type: 'array',
    items: { type: 'string', pattern: scalar.properties.V.pattern },
  });

  const schemaPattern = new RegExp(scalar.properties.V.pattern);
  const schemaPatternUnicode = new RegExp(scalar.properties.V.pattern, 'u');
  const itemPattern = new RegExp(arr.properties.VERSIONS.items.pattern, 'u');
  const validSemvers = [
    '1.2.3', 'v1.2.3', '1.2.3-beta.1+build.5',
    '0.0.0', '0.0.1+build.5', 'v1.2.3-rc.1', 'v1.2.3+build',
    '1.2.3-0', '1.2.3-01a', '1.2.3-alpha.0.1',
    '1.2.3+001.sha-5114f85', '10.20.30-alpha-1.2+exp.sha.5114f85',
  ];
  const invalidSemvers = [
    '1.2', 'banana', '01.2.3',
    '1.02.3', '1.2.03', 'v1.2', 'vv1.2.3', 'V1.2.3', 'v',
    '1.2.3.4', '1.2.x', '1.2.3-', '1.2.3+', '1.2.3-01',
    '1.2.3-alpha..1', '1.2.3+build..1', ' 1.2.3', '1.2.3 ', '1.2.3\n',
  ];
  for (const sample of validSemvers) {
    assert.strictEqual(schemaPattern.test(sample), true, `expected pattern to accept ${JSON.stringify(sample)}`);
    assert.strictEqual(schemaPatternUnicode.test(sample), true, `expected unicode pattern to accept ${JSON.stringify(sample)}`);
    assert.strictEqual(itemPattern.test(sample), true, `expected array item pattern to accept ${JSON.stringify(sample)}`);
    assert.deepStrictEqual(
      validateEnv({ V: { type: 'semver', trim: false } }, { V: sample }, { throwOnError: false }),
      { env: { V: sample }, errors: [], details: [] }
    );
    assert.deepStrictEqual(
      validateEnv({ VERSIONS: { type: 'array', of: 'semver', trim: false } }, { VERSIONS: [sample] }, { throwOnError: false }),
      { env: { VERSIONS: [sample] }, errors: [], details: [] }
    );
  }
  for (const sample of invalidSemvers) {
    assert.strictEqual(schemaPattern.test(sample), false, `expected pattern to reject ${JSON.stringify(sample)}`);
    assert.strictEqual(schemaPatternUnicode.test(sample), false, `expected unicode pattern to reject ${JSON.stringify(sample)}`);
    assert.strictEqual(itemPattern.test(sample), false, `expected array item pattern to reject ${JSON.stringify(sample)}`);
    assert.strictEqual(
      validateEnv({ V: { type: 'semver', trim: false } }, { V: sample }, { throwOnError: false }).errors.length,
      1,
      `expected runtime validateEnv to reject ${JSON.stringify(sample)}`
    );
    assert.strictEqual(
      validateEnv({ VERSIONS: { type: 'array', of: 'semver', trim: false } }, { VERSIONS: [sample] }, { throwOnError: false }).errors.length,
      1,
      `expected runtime array validateEnv to reject ${JSON.stringify(sample)}`
    );
  }

  // User-supplied pattern composes via allOf (same as hex/url), flagged pattern leaves semver pattern intact,
  // defaults and grouped schemas keep the semver pattern, and unrelated string types stay unconstrained.
  const composed = toJsonSchema({
    MAJOR1: { type: 'semver', pattern: /^v?1\./, default: 'v1.2.3' },
    FLAGGED: { type: 'semver', pattern: /^v?1\./i },
    LIST: { type: 'array', of: 'semver', default: '1.0.0,v2.0.0' },
    APP: { prefix: 'APP_', schema: { VERSION: { type: 'semver', required: true } } },
    PLAIN: { type: 'string' },
    B64: { type: 'base64' },
  });
  assert.deepStrictEqual(composed.properties.MAJOR1, {
    type: 'string',
    pattern: '^v?1\\.',
    allOf: [{ pattern: scalar.properties.V.pattern }],
    default: 'v1.2.3',
  });
  assert.deepStrictEqual(composed.properties.FLAGGED, {
    type: 'string',
    pattern: scalar.properties.V.pattern,
  });
  assert.deepStrictEqual(composed.properties.LIST, {
    type: 'array',
    items: { type: 'string', pattern: scalar.properties.V.pattern },
    default: ['1.0.0', 'v2.0.0'],
  });
  assert.deepStrictEqual(composed.properties.APP, {
    type: 'object',
    properties: { VERSION: { type: 'string', pattern: scalar.properties.V.pattern } },
    required: ['VERSION'],
  });
  assert.deepStrictEqual(composed.properties.PLAIN, { type: 'string' });
  assert.deepStrictEqual(composed.properties.B64,
    { type: 'string', pattern: toJsonSchema({ B: { type: 'base64' } }).properties.B.pattern });
}

// Issue #321: quoted keys share the env-file key grammar.
for (const head of ['process.env', 'import.meta.env']) {
  for (const key of ['DB.PORT', 'MY-KEY', 'PLAIN_KEY']) {
    for (const quote of ["'", '"', '`']) {
      assert.deepStrictEqual(scanCode(`${head}[${quote}${key}${quote}]`), [key]);
      assert.deepStrictEqual(scanCode(`${head}?.[${quote}${key}${quote}]`), [key]);
    }
    for (const quote of ["'", '"']) {
      assert.deepStrictEqual(scanCode(`const { ${quote}${key}${quote}: value } = ${head};`), [key]);
    }
  }
  assert.deepStrictEqual(scanCode(`// ${head}['DB.PORT']`), []);
  assert.deepStrictEqual(scanCode(`const s = "${head}['DB.PORT']";`), []);
  assert.deepStrictEqual(scanCode(`${head}['9BAD.KEY']; ${head}[\`DB.\${KEY}\`];`), []);
  assert.deepStrictEqual(scanCode(`const { A = "x,'FAKE.KEY': z" } = ${head};`), ['A']);
}

assert.deepStrictEqual(scanCode("const env = process.env; env['DB.PORT']; env[`MY-KEY`];"), ['DB.PORT', 'MY-KEY']);

// Issue #289: a flat equals condition requires a present discriminator.
{
  const schema = {
    TOKEN: { requiredIf: { key: 'MODE', equals: 'production', in: undefined } },
    MODE: { type: 'string' },
  };
  assert.deepStrictEqual(validateEnv(schema, {}, { throwOnError: false }), { env: {}, errors: [], details: [] });
  assert.deepStrictEqual(validateEnv(schema, { MODE: ' production ' }, { throwOnError: false }), {
    env: { MODE: 'production' }, errors: ['TOKEN: missing required variable'],
    details: [{ key: 'TOKEN', message: 'missing required variable' }],
  });
  assert.deepStrictEqual(toJsonSchema(schema), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { TOKEN: { type: 'string' }, MODE: { type: 'string' } },
    if: { required: ['MODE'], properties: { MODE: { const: 'production' } } },
    then: { required: ['TOKEN'] },
  });
}

// Issue #289: independent clauses use strict typed equality and membership.
{
  const schema = {
    NAME: { required: true },
    FLAG: { type: 'boolean' },
    COUNT: { type: 'int' },
    DATA: { type: 'json' },
    CERT: { requiredIf: { key: 'FLAG', equals: false } },
    NOTE: { requiredIf: { key: 'COUNT', in: [0, 2, 2, '2'] } },
    TEXT: { requiredIf: { key: 'COUNT', equals: '2' } },
    EXTRA: { requiredIf: { key: 'DATA', equals: null } },
  };
  const result = toJsonSchema(schema);
  assert.deepStrictEqual(result.required, ['NAME']);
  assert.deepStrictEqual(result.allOf, [
    { if: { required: ['FLAG'], properties: { FLAG: { const: false } } }, then: { required: ['CERT'] } },
    { if: { required: ['COUNT'], properties: { COUNT: { enum: [0, 2] } } }, then: { required: ['NOTE'] } },
    { if: { required: ['DATA'], properties: { DATA: { const: null } } }, then: { required: ['EXTRA'] } },
  ]);
}

// Issue #289: full env names resolve to the correct source and target paths.
{
  const schema = {
    SWITCH: {},
    APP: { prefix: 'CFG_', schema: {
      MODE: {},
      HOST: { required: true },
      AUTH: { requiredIf: { key: 'SWITCH', equals: 'on' } },
      CODE: { type: 'hex', pattern: /^ff/, requiredIf: { key: 'CFG_MODE', equals: 'on' } },
    } },
    MAIL: { prefix: 'EMAIL_', schema: {
      TOKEN: { requiredIf: { key: 'CFG_MODE', in: ['on', 'test'] } },
    } },
    NOTICE: { requiredIf: { key: 'CFG_MODE', equals: 'on' } },
  };
  const result = toJsonSchema(schema);
  const appOn = {
    required: ['APP'], properties: {
      APP: { type: 'object', required: ['MODE'], properties: { MODE: { const: 'on' } } },
    },
  };
  assert.deepStrictEqual(result.allOf, [
    {
      if: { required: ['SWITCH'], properties: { SWITCH: { const: 'on' } } },
      then: { required: ['APP'], properties: { APP: { type: 'object', required: ['AUTH'] } } },
    },
    { if: appOn, then: { required: ['APP'], properties: { APP: { type: 'object', required: ['CODE'] } } } },
    {
      if: { required: ['APP'], properties: {
        APP: { type: 'object', required: ['MODE'], properties: { MODE: { enum: ['on', 'test'] } } },
      } },
      then: { required: ['MAIL'], properties: { MAIL: { type: 'object', required: ['TOKEN'] } } },
    },
    { if: appOn, then: { required: ['NOTICE'] } },
  ]);
  assert.strictEqual(result.required, undefined);
  assert.deepStrictEqual(result.properties.APP.required, ['HOST']);
  assert.deepStrictEqual(result.properties.APP.properties.CODE, {
    type: 'string', pattern: '^ff', allOf: [{ pattern: '^[0-9a-fA-F]+$' }],
  });
  const single = toJsonSchema({
    SWITCH: {}, APP: { prefix: 'CFG_', schema: { AUTH: schema.APP.schema.AUTH } },
  });
  assert.deepStrictEqual(single.allOf, [result.allOf[0]]);
}

// Issue #289: aliases and defaults are resolved before matching canonical values.
{
  const condition = { key: 'MODE', equals: true };
  const schema = {
    MODE: { type: 'boolean', aliases: ['OLD_MODE'], default: 'yes' },
    TOKEN: { aliases: ['OLD_TOKEN'], default: undefined, requiredIf: condition },
    PORT: { type: 'int', default: 0, requiredIf: condition },
  };
  const options = { throwOnError: false, onWarn: () => {} };
  assert.deepStrictEqual(validateEnv(schema, {}, options), {
    env: { MODE: true, PORT: 0 }, errors: ['TOKEN: missing required variable'],
    details: [{ key: 'TOKEN', message: 'missing required variable' }],
  });
  assert.deepStrictEqual(validateEnv(schema, { OLD_MODE: 'on', OLD_TOKEN: 'value' }, options), {
    env: { MODE: true, TOKEN: 'value', PORT: 0 }, errors: [], details: [],
  });
  const result = toJsonSchema(schema);
  assert.deepStrictEqual(result.if, { required: ['MODE'], properties: { MODE: { const: true } } });
  assert.deepStrictEqual(result.then, { required: ['TOKEN'] });
  assert.deepStrictEqual(result.properties, {
    MODE: { type: 'boolean', default: true }, TOKEN: { type: 'string' }, PORT: { type: 'integer', default: 0 },
  });
}

// Issue #289: runtime-only or lossy comparisons do not become schema requirements.
{
  let calls = 0;
  const callback = () => { calls++; return 'changed'; };
  const reference = { active: true };
  const result = toJsonSchema({
    MODE: {},
    TRANSFORMED: { transform: callback },
    CHECKED: { validate: callback },
    DATA: { type: 'json' },
    DATE: { type: 'date' },
    LIST: { type: 'array' },
    GOOD: { requiredIf: { key: 'MODE', equals: 'prod' } },
    EXTERNAL: { requiredIf: { key: 'OUTSIDE', equals: 'prod' } },
    CHANGED: { requiredIf: { key: 'TRANSFORMED', equals: 'prod' } },
    CHECK: { requiredIf: { key: 'CHECKED', equals: 'prod' } },
    REF: { requiredIf: { key: 'DATA', equals: reference } },
    MIXED: { requiredIf: { key: 'DATA', in: [true, reference] } },
    NON_FINITE: { requiredIf: { key: 'DATA', in: [Infinity] } },
    SPARSE: { requiredIf: { key: 'DATA', in: Array(1) } },
    SERIALIZED_DATE: { requiredIf: { key: 'DATE', equals: '2026-01-31' } },
    ARRAY_ITEM: { requiredIf: { key: 'LIST', equals: 'first' } },
  });
  assert.deepStrictEqual(result.if, { required: ['MODE'], properties: { MODE: { const: 'prod' } } });
  assert.deepStrictEqual(result.then, { required: ['GOOD'] });
  assert.strictEqual(result.allOf, undefined);
  assert.strictEqual(calls, 0);
}

// Issue #289: non-JSON numbers do not hide representable JSON membership values.
{
  const schema = {
    DATA: { type: 'json' },
    TOKEN: { requiredIf: { key: 'DATA', in: [true, Infinity, NaN, null] } },
  };
  for (const [raw, coerced] of [['true', true], ['null', null]]) {
    assert.deepStrictEqual(validateEnv(schema, { DATA: raw }, { throwOnError: false }), {
      env: { DATA: coerced }, errors: ['TOKEN: missing required variable'],
      details: [{ key: 'TOKEN', message: 'missing required variable' }],
    });
  }
  const result = toJsonSchema(schema);
  assert.deepStrictEqual(result.if, { required: ['DATA'], properties: { DATA: { enum: [true, null] } } });
  assert.deepStrictEqual(result.then, { required: ['TOKEN'] });
}

// Issue #289: membership uses indexed values, not iteration or custom callbacks.
{
  const indexed = ['prod'];
  indexed[Symbol.iterator] = function* () { yield 'dev'; };
  const overridden = ['prod'];
  overridden.includes = value => value === 'test';
  const borrowed = ['prod'];
  borrowed.includes = String.prototype.includes;
  let reads = 0;
  const accessor = ['prod'];
  Object.defineProperty(accessor, 0, { get: () => { reads++; return 'prod'; } });
  const schema = {
    MODE: {},
    TOKEN: { requiredIf: { key: 'MODE', in: indexed } },
    CUSTOM: { requiredIf: { key: 'MODE', in: overridden } },
    BORROWED: { requiredIf: { key: 'MODE', in: borrowed } },
    ACCESSOR: { requiredIf: { key: 'MODE', in: accessor } },
  };
  assert.deepStrictEqual(validateEnv(schema, { MODE: 'dev' }, { throwOnError: false }).errors, []);
  assert.deepStrictEqual(validateEnv(schema, { MODE: 'prod' }, { throwOnError: false }).errors, [
    'TOKEN: missing required variable', 'BORROWED: missing required variable', 'ACCESSOR: missing required variable',
  ]);
  const before = reads;
  const result = toJsonSchema(schema);
  assert.deepStrictEqual(result.if, { required: ['MODE'], properties: { MODE: { enum: ['prod'] } } });
  assert.deepStrictEqual(result.then, { required: ['TOKEN'] });
  assert.strictEqual(result.allOf, undefined);
  assert.strictEqual(reads, before);
}

// Issue #289: plain membership arrays may come from another JavaScript realm.
{
  const members = require('node:vm').runInNewContext("['prod']");
  const schema = { MODE: {}, TOKEN: { requiredIf: { key: 'MODE', in: members } } };
  assert.deepStrictEqual(validateEnv(schema, { MODE: 'prod' }, { throwOnError: false }).errors,
    ['TOKEN: missing required variable']);
  const result = toJsonSchema(schema);
  assert.deepStrictEqual(result.if, { required: ['MODE'], properties: { MODE: { enum: ['prod'] } } });
  assert.deepStrictEqual(result.then, { required: ['TOKEN'] });
}

// Issue #289: omit proxy-backed membership without dropping ordinary lists.
{
  const handler = {
    get(target, key, receiver) {
      if (key === 'includes') return value => value === 'stage';
      return Reflect.get(target, key, receiver);
    },
  };
  const proxy = new Proxy(['prod'], handler);
  const inherited = Object.setPrototypeOf(['prod'], new Proxy(Array.prototype, handler));
  for (const members of [proxy, inherited]) {
    const schema = {
      MODE: {},
      OPAQUE: { requiredIf: { key: 'MODE', in: members } },
      TOKEN: { requiredIf: { key: 'MODE', in: ['prod'] } },
    };
    const options = { throwOnError: false };
    assert.deepStrictEqual(validateEnv(schema, { MODE: 'stage' }, options).errors, ['OPAQUE: missing required variable']);
    assert.deepStrictEqual(validateEnv(schema, { MODE: 'prod' }, options).errors, ['TOKEN: missing required variable']);
    const result = toJsonSchema(schema);
    assert.deepStrictEqual(result.if, { required: ['MODE'], properties: { MODE: { enum: ['prod'] } } });
    assert.deepStrictEqual(result.then, { required: ['TOKEN'] });
    assert.strictEqual(result.allOf, undefined);
  }
}

// Issue #289: nested groups export nested if/then paths for requiredIf.
{
  const schema = {
    APP: { prefix: 'APP_', schema: {
      DB: { prefix: 'DB_', schema: {
        MODE: {},
        AUTH: { requiredIf: { key: 'APP_DB_MODE', equals: 'tls' } },
      } },
      MAIL: { prefix: 'MAIL_', schema: {
        TOKEN: { requiredIf: { key: 'APP_DB_MODE', in: ['tls', 'mtls'] } },
      } },
    } },
    AUDIT: { requiredIf: { key: 'APP_DB_MODE', equals: 'tls' } },
  };
  assert.deepStrictEqual(validateEnv(schema, { APP_DB_MODE: 'tls' }, { throwOnError: false }).errors, [
    'APP_DB_AUTH: missing required variable',
    'APP_MAIL_TOKEN: missing required variable',
    'AUDIT: missing required variable',
  ]);
  const result = toJsonSchema(schema);
  const wrap = (path, leaf) => path.reduceRight((inner, name) => ({
    required: [name], properties: { [name]: { type: 'object', ...inner } },
  }), leaf);
  const dbTls = wrap(['APP', 'DB'], { required: ['MODE'], properties: { MODE: { const: 'tls' } } });
  assert.deepStrictEqual(result.allOf, [
    { if: dbTls, then: wrap(['APP', 'DB'], { required: ['AUTH'] }) },
    {
      if: wrap(['APP', 'DB'], { required: ['MODE'], properties: { MODE: { enum: ['tls', 'mtls'] } } }),
      then: wrap(['APP', 'MAIL'], { required: ['TOKEN'] }),
    },
    { if: dbTls, then: { required: ['AUDIT'] } },
  ]);
}

// Issue #294: structured `details` mirror `errors` one-to-one.
{
  const schema = {
    DB: { prefix: 'DB_', schema: {
      PORT: { type: 'port', required: true },
      HOST: { required: true },
    } },
    DEBUG: { type: 'boolean' },
  };
  const env = { DB_PORT: 'abc', DEBUG: 'maybe' };
  const expectedErrors = [
    'DB_PORT: expected a port (0-65535, e.g. 3000), got "abc"',
    'DB_HOST: missing required variable',
    'DEBUG: expected a boolean (e.g. true/false, yes/no, on/off, 1/0, y/n), got "maybe"',
  ];
  const expectedDetails = [
    { key: 'DB_PORT', message: 'expected a port (0-65535, e.g. 3000), got "abc"' },
    { key: 'DB_HOST', message: 'missing required variable' },
    { key: 'DEBUG', message: 'expected a boolean (e.g. true/false, yes/no, on/off, 1/0, y/n), got "maybe"' },
  ];

  // Throwing mode: same order, split by full (grouped) env name.
  let thrown;
  try { validateEnv(schema, env); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof EnvSaafError);
  assert.deepStrictEqual(thrown.errors, expectedErrors);
  assert.deepStrictEqual(thrown.details, expectedDetails);
  assert.strictEqual(thrown.details.length, thrown.errors.length);
  for (let i = 0; i < thrown.errors.length; i++) {
    assert.strictEqual(`${thrown.details[i].key}: ${thrown.details[i].message}`, thrown.errors[i]);
  }

  // Non-throwing mode carries the same details.
  const collected = validateEnv(schema, env, { throwOnError: false });
  assert.deepStrictEqual(collected.errors, expectedErrors);
  assert.deepStrictEqual(collected.details, expectedDetails);
  assert.deepStrictEqual(collected.details, thrown.details);

  // Clean results have no details.
  assert.deepStrictEqual(
    validateEnv({ PORT: { type: 'port' } }, { PORT: '3000' }, { throwOnError: false }).details,
    []
  );

  // Schema errors are structured too.
  assert.throws(() => validateEnv({ PORT: { type: 'emial' } }, {}), e =>
    e instanceof EnvSaafError
    && e.errors[0] === 'PORT: unknown type "emial"'
    && e.details[0].key === 'PORT'
    && e.details[0].message === 'unknown type "emial"');

  // Errors not tied to a key keep the full message with an empty key — the
  // colon inside "validateEnv accepts: ..." must not be treated as a separator.
  assert.throws(() => validateEnv({}, {}, { typo: true }), e =>
    e instanceof EnvSaafError
    && e.errors.length === 1
    && e.details.length === 1
    && e.details[0].key === ''
    && e.details[0].message === e.errors[0]);

  // Strict-mode errors keep their key.
  assert.throws(() => validateEnv({ A: {} }, { TYPO: 'x' }, { strict: true }), e =>
    e instanceof EnvSaafError
    && e.details[0].key === 'TYPO'
    && e.details[0].message === 'set but not in schema (strict mode)');

  // A custom formatError changes only `message`; `errors` and `details` stay raw.
  let formatted;
  try {
    validateEnv({ PORT: { required: true } }, {}, { formatError: () => 'CUSTOM MESSAGE' });
  } catch (e) { formatted = e; }
  assert.strictEqual(formatted.message, 'CUSTOM MESSAGE');
  assert.deepStrictEqual(formatted.errors, ['PORT: missing required variable']);
  assert.deepStrictEqual(formatted.details, [{ key: 'PORT', message: 'missing required variable' }]);
}

// Issue #293: pattern annotations compose without changing example values.
{
  const schema = {
    S: { type: 'string', pattern: /^[A-Z]+$/ },
    STR: { type: 'string', pattern: '^[a-z]+$' },
    EMPTY: { type: 'string', pattern: '' },
    MODE: { type: 'string', required: true, choices: ['YES', 'NO'], pattern: /^[A-Z]+$/i },
    GROUP: { prefix: 'APP_', schema: {
      CODE: { type: 'string', pattern: /^code_\d+$/ },
      STRCODE: { type: 'string', pattern: '^item_[0-9]+$' },
    } },
  };
  const example = generateExample(schema);
  assert.ok(example.includes('# type: string, pattern: /^[A-Z]+$/\nS=your_value_here\n'));
  assert.ok(example.includes('# type: string, required, one of: YES|NO, pattern: /^[A-Z]+$/i\nMODE=YES\n'));
  assert.ok(example.includes('# type: string, pattern: /^code_\\d+$/\nAPP_CODE=your_value_here\n'));
  assert.ok(example.includes('# type: string, pattern: ^[a-z]+$\nSTR=your_value_here\n'));
  assert.ok(example.includes('# type: string, pattern: \nEMPTY=your_value_here\n'));
  assert.ok(example.includes('# type: string, pattern: ^item_[0-9]+$\nAPP_STRCODE=your_value_here\n'));
  const plain = { S: { type: 'string' }, STR: { type: 'string' }, EMPTY: { type: 'string' }, MODE: { type: 'string', required: true, choices: ['YES', 'NO'] },
    GROUP: { prefix: 'APP_', schema: { CODE: { type: 'string' }, STRCODE: { type: 'string' } } } };
  const values = text => text.split('\n').filter(line => line && !line.startsWith('#'));
  assert.deepStrictEqual(values(example), values(generateExample(plain)));
  assert.ok(!generateExample(plain).includes('pattern:'));
}

// Issue #359: CLI `scan --stdin` scans piped code through scanCode.
{
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const runStdin = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    input,
  });

  const code = "const a = process.env.BETA;\n// process.env.IGNORED\nconst b = import.meta.env['ALPHA'];\n";
  const plain = runStdin(['scan', '--stdin'], code);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.strictEqual(plain.stdout, scanCode(code).join('\n') + '\n');
  assert.strictEqual(plain.stderr, '');

  const json = runStdin(['scan', '--stdin', '--json'], code);
  assert.strictEqual(json.status, 0, json.stderr);
  assert.deepStrictEqual(JSON.parse(json.stdout), {
    ok: true,
    vars: ['ALPHA', 'BETA'],
    locations: {
      ALPHA: [{ file: '-', line: 3 }],
      BETA: [{ file: '-', line: 1 }],
    },
  });

  const empty = runStdin(['scan', '--stdin'], '');
  assert.strictEqual(empty.status, 0);
  assert.strictEqual(empty.stdout, '');
  assert.strictEqual(empty.stderr, 'No process.env usage found.\n');

  const withDir = runStdin(['scan', '--stdin', __dirname], code);
  assert.strictEqual(withDir.status, 2);
  assert.match(withDir.stderr, /--stdin cannot be combined with a directory argument/);
}

// Issue #342: the ipv6 type
{
  assert.deepStrictEqual(
    validateEnv({ A: { type: 'ipv6' }, B: { type: 'ipv6' }, C: { type: 'ipv6' } },
      { A: '::1', B: '2001:db8::1', C: 'fe80::1%eth0' }),
    { A: '::1', B: '2001:db8::1', C: 'fe80::1%eth0' },
  );
  assert.deepStrictEqual(validateEnv({ A: { type: 'ipv6' } }, { A: '::ffff:192.168.0.1' }).A, '::ffff:192.168.0.1');
  for (const bad of ['192.168.0.1', 'example.com', 'gggg::1', '::1::2']) {
    assert.throws(() => validateEnv({ A: { type: 'ipv6', required: true } }, { A: bad }),
      /expected a valid IPv6 address/, bad);
  }
  // String-type options apply, as they do for ipv4.
  assert.throws(() => validateEnv({ A: { type: 'ipv6', pattern: '^fe80:' } }, { A: '::1' }), /expected to match/);
  assert.strictEqual(validateEnv({ A: { type: 'ipv6', minLength: 3 } }, { A: '::1' }).A, '::1');

  assert.deepStrictEqual(toJsonSchema({ A: { type: 'ipv6' } }).properties.A, { type: 'string', format: 'ipv6' });
  const example = generateExample({ A: { type: 'ipv6' } });
  assert.ok(example.includes('A=::1'), example);
  // The generated example itself validates.
  assert.strictEqual(validateEnv({ A: { type: 'ipv6' } }, { A: '::1' }).A, '::1');
}

// Issue #348: skipEmpty drops accidental empty array items
{
  const rule = { T: { type: 'array', skipEmpty: true } };
  assert.deepStrictEqual(validateEnv(rule, { T: 'a,b,' }).T, ['a', 'b']);
  assert.deepStrictEqual(validateEnv(rule, { T: 'a,,b' }).T, ['a', 'b']);
  assert.deepStrictEqual(validateEnv(rule, { T: ',,' }).T, []);
  assert.deepStrictEqual(validateEnv(rule, { T: ['a', '', 'b'] }).T, ['a', 'b']);
  // Counts and uniqueness apply to what remains.
  assert.deepStrictEqual(validateEnv({ T: { type: 'array', skipEmpty: true, minItems: 2, unique: true } }, { T: 'a,b,' }).T, ['a', 'b']);
  assert.throws(() => validateEnv({ T: { type: 'array', skipEmpty: true, minItems: 2 } }, { T: 'a,' }), /expected at least 2 items, got 1/);
  assert.throws(() => validateEnv({ T: { type: 'array', skipEmpty: true, unique: true } }, { T: 'a,a,' }), /duplicate value/);
  // Default behaviour and its message are unchanged.
  assert.throws(() => validateEnv({ T: { type: 'array' } }, { T: 'a,b,' }), /T\[2\]: expected a non-empty value/);
  // Like the other array-only options, it is rejected elsewhere.
  assert.throws(() => validateSchema({ T: { type: 'string', skipEmpty: true } }), /only applies to type 'array'/);
  assert.throws(() => validateSchema({ T: { type: 'array', skipEmpty: 'yes' } }), /"skipEmpty" must be a boolean/);
}

// Issue #349: near-miss key suggestions (case-only and one-edit swaps)
{
  const schema = { PORT: { type: 'port', required: true } };
  assert.throws(() => validateEnv(schema, { port: '3000' }), /did you mean port\? it is set/);

  let err;
  try { validateEnv(schema, { PROT: '3000' }, { strict: true }); } catch (e) { err = e; }
  assert.ok(err.errors.some((m) => /PROT: set but not in schema .*did you mean PORT\? it is declared/.test(m)));
  assert.ok(err.errors.some((m) => /PORT: missing required variable .*did you mean PROT\? it is set/.test(m)));

  // Unrelated keys stay quiet.
  try { validateEnv(schema, { TIMEOUT: '3' }, { strict: true }); } catch (e) { err = e; }
  assert.ok(err.errors.every((m) => !m.includes('did you mean')));

  // Only names are suggested; a sensitive value is never echoed.
  try {
    validateEnv({ API_TOKEN: { type: 'string', required: true, sensitive: true } }, { api_token: 'secret-value' }, { strict: true });
  } catch (e) { err = e; }
  assert.ok(err.errors.some((m) => m.includes('did you mean api_token?')));
  assert.ok(err.errors.every((m) => !m.includes('secret-value')));
}

// Issue #335: scan --json reports where each variable is used; plain output and
// vars/unused stay stable. Library helpers drive the CLI rather than a second walk.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-335-locations-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    // SHARED appears later in a.js than in b.js so file-major sort (a then b) differs from line-only sort.
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '\n\n\n\nconst x = process.env.SHARED;\nconst y = process.env.ONLY_A;\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'const z = process.env.SHARED;\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'SHARED=\nONLY_A=\nSTALE=\n');

    const detailed = scanDirLocations(dir);
    assert.deepStrictEqual(detailed.vars, scanDir(dir));
    assert.deepStrictEqual(detailed.vars, ['ONLY_A', 'SHARED']);
    assert.deepStrictEqual(detailed.locations.SHARED, [
      { file: 'src/a.js', line: 5 },
      { file: 'src/b.js', line: 1 },
    ]);
    assert.deepStrictEqual(detailed.locations.ONLY_A, [{ file: 'src/a.js', line: 6 }]);

    const plain = run(['scan', dir]);
    assert.strictEqual(plain.status, 0);
    assert.strictEqual(plain.stdout, 'ONLY_A\nSHARED\n');
    assert.match(plain.stderr, /UNUSED: STALE/);

    const json = run(['scan', dir, '--json']);
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: true,
      vars: ['ONLY_A', 'SHARED'],
      unused: ['STALE'],
      locations: detailed.locations,
    });

    const fromCode = scanCodeLocations('process.env.PORT;\nprocess.env.HOST;\n');
    assert.deepStrictEqual(fromCode.vars, ['HOST', 'PORT']);
    assert.deepStrictEqual(fromCode.locations, {
      HOST: [{ file: '-', line: 2 }],
      PORT: [{ file: '-', line: 1 }],
    });

    // Multi-line destructure: each binding keeps its own 1-based line (index math).
    const destructured = scanCodeLocations('const {\n  ALPHA,\n  BETA\n} = process.env;\n');
    assert.deepStrictEqual(destructured.locations, {
      ALPHA: [{ file: '-', line: 2 }],
      BETA: [{ file: '-', line: 3 }],
    });
    const quoted = scanCodeLocations("const {\n  X,\n  Y,\n  Z,\n  W,\n  'DB.HOST': host\n} = process.env;\n");
    assert.deepStrictEqual(quoted.locations['DB.HOST'], [{ file: '-', line: 6 }]);
    assert.deepStrictEqual(quoted.vars, ['DB.HOST', 'W', 'X', 'Y', 'Z']);

    // Same key twice: locations stay sorted by line even when later uses come last.
    const repeated = scanCodeLocations('process.env.Z;\nprocess.env.A;\nprocess.env.Z;\n');
    assert.deepStrictEqual(repeated.locations.Z, [
      { file: '-', line: 1 },
      { file: '-', line: 3 },
    ]);

    // Prototype-sensitive keys must not crash either locations builder.
    const protoKeys = 'process.env.constructor;\nprocess.env.__proto__;\nprocess.env.toString;\n';
    const protoScan = scanCodeLocations(protoKeys);
    assert.deepStrictEqual(protoScan.vars, ['__proto__', 'constructor', 'toString']);
    assert.deepStrictEqual(protoScan.locations.constructor, [{ file: '-', line: 1 }]);
    assert.deepStrictEqual(protoScan.locations.__proto__, [{ file: '-', line: 2 }]);
    assert.deepStrictEqual(protoScan.locations.toString, [{ file: '-', line: 3 }]);
    assert.ok(Object.prototype.hasOwnProperty.call(protoScan.locations, '__proto__'));
    assert.ok(Object.prototype.hasOwnProperty.call(protoScan.locations, 'constructor'));
    assert.ok(Object.prototype.hasOwnProperty.call(protoScan.locations, 'toString'));

    // Bare CR (and CRLF) line breaks: 1-based lines without double-counting CRLF.
    const bareCr = scanCodeLocations('process.env.A;\rprocess.env.B;\r');
    assert.deepStrictEqual(bareCr.locations.A, [{ file: '-', line: 1 }]);
    assert.deepStrictEqual(bareCr.locations.B, [{ file: '-', line: 2 }]);
    const crlf = scanCodeLocations('process.env.A;\r\nprocess.env.B;\r\n');
    assert.deepStrictEqual(crlf.locations.A, [{ file: '-', line: 1 }]);
    assert.deepStrictEqual(crlf.locations.B, [{ file: '-', line: 2 }]);

    // Directory builder: same prototype keys via synthetic files only.
    const protoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-335-proto-'));
    try {
      fs.writeFileSync(path.join(protoDir, 'c.js'), 'process.env.constructor;\n');
      fs.writeFileSync(path.join(protoDir, 'p.js'), 'process.env.__proto__;\n');
      fs.writeFileSync(path.join(protoDir, 't.js'), 'process.env.toString;\n');
      const dirProto = scanDirLocations(protoDir);
      assert.deepStrictEqual(dirProto.vars, ['__proto__', 'constructor', 'toString']);
      assert.deepStrictEqual(dirProto.locations.constructor, [{ file: 'c.js', line: 1 }]);
      assert.deepStrictEqual(dirProto.locations.__proto__, [{ file: 'p.js', line: 1 }]);
      assert.deepStrictEqual(dirProto.locations.toString, [{ file: 't.js', line: 1 }]);
      const dirJson = run(['scan', protoDir, '--json']);
      assert.strictEqual(dirJson.status, 0);
      const dirParsed = JSON.parse(dirJson.stdout);
      assert.deepStrictEqual(dirParsed.vars, ['__proto__', 'constructor', 'toString']);
      assert.deepStrictEqual(dirParsed.locations.constructor, [{ file: 'c.js', line: 1 }]);
      assert.deepStrictEqual(dirParsed.locations.__proto__, [{ file: 'p.js', line: 1 }]);
      assert.deepStrictEqual(dirParsed.locations.toString, [{ file: 't.js', line: 1 }]);
      assert.strictEqual(run(['scan', protoDir]).stdout, '__proto__\nconstructor\ntoString\n');
    } finally {
      fs.rmSync(protoDir, { recursive: true, force: true });
    }

    // Stdin --json: prototype keys and bare-CR line numbers through the CLI helper path.
    const runStdin = (args, input) => spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input,
    });
    const stdinProto = runStdin(['scan', '--stdin', '--json'], protoKeys);
    assert.strictEqual(stdinProto.status, 0, stdinProto.stderr);
    const stdinProtoJson = JSON.parse(stdinProto.stdout);
    assert.strictEqual(stdinProtoJson.ok, true);
    assert.deepStrictEqual(stdinProtoJson.vars, ['__proto__', 'constructor', 'toString']);
    assert.deepStrictEqual(stdinProtoJson.locations.constructor, [{ file: '-', line: 1 }]);
    assert.deepStrictEqual(stdinProtoJson.locations.__proto__, [{ file: '-', line: 2 }]);
    assert.deepStrictEqual(stdinProtoJson.locations.toString, [{ file: '-', line: 3 }]);
    const stdinCr = runStdin(['scan', '--stdin', '--json'], 'process.env.A;\rprocess.env.B;\r');
    assert.strictEqual(stdinCr.status, 0, stdinCr.stderr);
    const stdinCrLoc = JSON.parse(stdinCr.stdout).locations;
    assert.deepStrictEqual(stdinCrLoc.A, [{ file: '-', line: 1 }]);
    assert.deepStrictEqual(stdinCrLoc.B, [{ file: '-', line: 2 }]);

    // Line comments end at LF, CRLF, and bare CR; a following read must stay visible.
    const afterComment = (nl) => scanCodeLocations(`// heading${nl}process.env.PORT;`);
    assert.deepStrictEqual(afterComment('\n').locations.PORT, [{ file: '-', line: 2 }]);
    assert.deepStrictEqual(afterComment('\r\n').locations.PORT, [{ file: '-', line: 2 }]);
    assert.deepStrictEqual(afterComment('\r').locations.PORT, [{ file: '-', line: 2 }]);
    assert.deepStrictEqual(afterComment('\r').vars, ['PORT']);
    // Comment body itself is still filtered (no false positive from the comment text).
    assert.deepStrictEqual(scanCodeLocations('// process.env.HIDDEN\nprocess.env.PORT;\n').vars, ['PORT']);

    // Collating-equal but distinct paths (NFC vs NFD): ordinal tie-break is stable
    // without writing those names to disk (Windows may normalize file names).
    {
      const nfc = 'caf\u00e9.js';
      const nfd = 'cafe\u0301.js';
      assert.notStrictEqual(nfc, nfd);
      assert.strictEqual(nfc.localeCompare(nfd), 0);
      const expectedFirst = nfc < nfd ? nfc : nfd;
      const expectedSecond = nfc < nfd ? nfd : nfc;
      const realReaddir = fs.readdirSync;
      const realRead = fs.readFileSync;
      const virtualDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-335-nfc-'));
      try {
        const serve = (names) => {
          fs.readdirSync = (d, opts) => {
            if (path.resolve(d) === path.resolve(virtualDir)) {
              return names.map((name) => ({
                name,
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              }));
            }
            return realReaddir(d, opts);
          };
          fs.readFileSync = (p, enc) => {
            const base = path.basename(p);
            if (base === nfc || base === nfd) return 'process.env.SHARED;\n';
            return realRead(p, enc);
          };
          try {
            return scanDirLocations(virtualDir).locations.SHARED.map((e) => e.file);
          } finally {
            fs.readdirSync = realReaddir;
            fs.readFileSync = realRead;
          }
        };
        // Reverse enumeration must still yield the same ordinal order.
        assert.deepStrictEqual(serve([nfc, nfd]), [expectedFirst, expectedSecond]);
        assert.deepStrictEqual(serve([nfd, nfc]), [expectedFirst, expectedSecond]);
      } finally {
        fs.readdirSync = realReaddir;
        fs.readFileSync = realRead;
        fs.rmSync(virtualDir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #343: a rule description reaches the example comment and the JSON Schema
{
  const schema = {
    PORT: { type: 'port', required: true, description: 'HTTP listen port' },
    NAME: { description: 'Service name' },
    URL: { type: 'url', description: '  Public base URL  ' },
  };
  assert.deepStrictEqual(validateEnv(schema, { PORT: '3000' }), { PORT: 3000 });
  assert.throws(() => validateSchema({ BAD: { description: 3 } }), /"description" must be a string/);

  const example = generateExample(schema);
  assert.ok(example.includes('# HTTP listen port; type: port, required'), example);
  assert.ok(example.includes('# Service name; type: string'), example);
  // Trimmed, and it never becomes part of the value placeholder.
  assert.ok(example.includes('# Public base URL; type: url'), example);

  const properties = toJsonSchema(schema).properties;
  assert.strictEqual(properties.PORT.description, 'HTTP listen port');
  assert.strictEqual(properties.NAME.description, 'Service name');
  assert.strictEqual(properties.URL.description, 'Public base URL');

  // Grouped inner rules carry their own description.
  const grouped = toJsonSchema({ DB: { prefix: 'DB_', schema: { HOST: { type: 'host', description: 'Database host' } } } });
  assert.strictEqual(grouped.properties.DB.properties.HOST.description, 'Database host');
}


// Issue #350: loadEnv errors name the winning file a bad value came from.
const loadEnvSourceErrorsTest = (async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv, loadEnvAsync, validateEnv, EnvSaafError, maskValue } = require('./index');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-350-'));
  const baseFile = path.join(dir, '.env');
  const localFile = path.join(dir, '.env.local');
  const secretRaw = 'file-secret-not-uuid';
  fs.writeFileSync(baseFile, `PORT=not-a-port\nSECRET=${secretRaw}\nHOST=from-base\n`);
  fs.writeFileSync(localFile, 'PORT=also-bad\nHOST=from-local\n');

  const schema = {
    PORT: { type: 'port', required: true },
    SECRET: { type: 'uuid', required: true, sensitive: true },
    HOST: { type: 'host', required: true },
  };

  // 1. Single-file sync: name that file in the message and details.source.
  try {
    loadEnv(schema, { path: baseFile, env: {} });
    assert.fail('expected single-file loadEnv to throw');
  } catch (err) {
    assert.ok(err instanceof EnvSaafError);
    assert.strictEqual(
      err.errors[0],
      `PORT (from ${baseFile}): expected a port (0-65535, e.g. 3000), got "not-a-port"`
    );
    assert.deepStrictEqual(err.details[0], {
      key: 'PORT',
      message: 'expected a port (0-65535, e.g. 3000), got "not-a-port"',
      source: baseFile,
    });
    assert.strictEqual(
      err.errors[1],
      `SECRET (from ${baseFile}): expected a valid UUID (e.g. 550e8400-e29b-41d4-a716-446655440000), got "${maskValue(secretRaw)}"`
    );
    assert.ok(!err.errors[1].includes(secretRaw));
    assert.strictEqual(err.details[1].source, baseFile);
    assert.strictEqual(err.details[1].message.includes(maskValue(secretRaw)), true);
  }

  // 2. Layered paths: report the winning (later) file for overridden keys,
  // and the earlier file for keys only set there.
  try {
    loadEnv(schema, { paths: [baseFile, localFile], env: {} });
    assert.fail('expected layered loadEnv to throw');
  } catch (err) {
    assert.ok(err instanceof EnvSaafError);
    assert.strictEqual(
      err.errors[0],
      `PORT (from ${localFile}): expected a port (0-65535, e.g. 3000), got "also-bad"`
    );
    assert.strictEqual(err.details[0].source, localFile);
    assert.strictEqual(err.details[1].source, baseFile);
    assert.ok(err.errors[1].includes(`(from ${baseFile})`));
  }

  // 3. Ambient env wins by default: keep today's message, no source field.
  const ambientMsg = (() => {
    try {
      validateEnv({ PORT: { type: 'port', required: true } }, { PORT: 'nope' });
    } catch (err) {
      return { errors: err.errors.slice(), details: err.details.map(d => ({ ...d })) };
    }
    assert.fail('expected validateEnv control to throw');
  })();
  try {
    loadEnv({ PORT: { type: 'port', required: true } }, { path: baseFile, env: { PORT: 'nope' } });
    assert.fail('expected ambient-winning loadEnv to throw');
  } catch (err) {
    assert.deepStrictEqual(err.errors, ambientMsg.errors);
    assert.deepStrictEqual(err.details, ambientMsg.details);
    assert.strictEqual(err.details[0].source, undefined);
    assert.ok(!err.errors[0].includes('(from '));
  }

  // 4. override: true - file wins even when ambient is set, so name the file.
  try {
    loadEnv(
      { PORT: { type: 'port', required: true } },
      { path: baseFile, env: { PORT: 'nope' }, override: true }
    );
    assert.fail('expected override loadEnv to throw');
  } catch (err) {
    assert.strictEqual(
      err.errors[0],
      `PORT (from ${baseFile}): expected a port (0-65535, e.g. 3000), got "not-a-port"`
    );
    assert.strictEqual(err.details[0].source, baseFile);
  }

  // 5. validateEnv called directly stays byte-identical (no source).
  try {
    validateEnv({ PORT: { type: 'port', required: true } }, { PORT: 'nope' });
    assert.fail('expected direct validateEnv to throw');
  } catch (err) {
    assert.deepStrictEqual(err.errors, ambientMsg.errors);
    assert.deepStrictEqual(err.details, ambientMsg.details);
    assert.ok(!('source' in err.details[0]));
  }

  // 6. Async load path matches sync for layered winning-file reporting.
  try {
    await loadEnvAsync(schema, { paths: [baseFile, localFile], env: {} });
    assert.fail('expected layered loadEnvAsync to throw');
  } catch (err) {
    assert.ok(err instanceof EnvSaafError);
    assert.strictEqual(
      err.errors[0],
      `PORT (from ${localFile}): expected a port (0-65535, e.g. 3000), got "also-bad"`
    );
    assert.strictEqual(err.details[0].source, localFile);
    assert.strictEqual(err.details[1].source, baseFile);
  }

  // 7. Missing required key that is absent from files: still no source.
  try {
    loadEnv(
      { MISSING: { type: 'string', required: true } },
      { path: baseFile, env: {} }
    );
    assert.fail('expected missing-key loadEnv to throw');
  } catch (err) {
    assert.strictEqual(err.errors[0], 'MISSING: missing required variable');
    assert.deepStrictEqual(err.details[0], { key: 'MISSING', message: 'missing required variable' });
  }

  // 8. Alias origin: file supplies OLD_PORT for PORT - PORT carries that source.
  const aliasFile = path.join(dir, 'alias.env');
  fs.writeFileSync(aliasFile, 'OLD_PORT=not-a-port\n');
  const expectAlias = (err) => {
    assert.ok(err instanceof EnvSaafError);
    assert.strictEqual(
      err.errors[0],
      `PORT (from ${aliasFile}): expected a port (0-65535, e.g. 3000), got "not-a-port"`
    );
    assert.deepStrictEqual(err.details[0], {
      key: 'PORT',
      message: 'expected a port (0-65535, e.g. 3000), got "not-a-port"',
      source: aliasFile,
    });
  };
  try {
    loadEnv(
      { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
      { path: aliasFile, env: {}, onWarn: () => {} }
    );
    assert.fail('expected alias-from-file loadEnv to throw');
  } catch (err) { expectAlias(err); }
  try {
    await loadEnvAsync(
      { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
      { path: aliasFile, env: {}, onWarn: () => {} }
    );
    assert.fail('expected alias-from-file loadEnvAsync to throw');
  } catch (err) { expectAlias(err); }

  // 9. Empty file PORT falls back to ambient alias - do not blame the file.
  const emptyFile = path.join(dir, 'empty.env');
  fs.writeFileSync(emptyFile, 'PORT=\n');
  const expectNoSource = (err, got) => {
    assert.strictEqual(
      err.errors[0],
      `PORT: expected a port (0-65535, e.g. 3000), got "${got}"`
    );
    assert.deepStrictEqual(err.details[0], {
      key: 'PORT',
      message: `expected a port (0-65535, e.g. 3000), got "${got}"`,
    });
    assert.ok(!('source' in err.details[0]));
  };
  try {
    loadEnv(
      { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
      { path: emptyFile, env: { OLD_PORT: 'also-bad' }, onWarn: () => {} }
    );
    assert.fail('expected empty-file ambient alias loadEnv to throw');
  } catch (err) { expectNoSource(err, 'also-bad'); }
  try {
    await loadEnvAsync(
      { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
      { path: emptyFile, env: { OLD_PORT: 'also-bad' }, onWarn: () => {} }
    );
    assert.fail('expected empty-file ambient alias loadEnvAsync to throw');
  } catch (err) { expectNoSource(err, 'also-bad'); }

  // 10. Empty file PORT falls back to a bad schema default - no file source.
  try {
    loadEnv(
      { PORT: { type: 'port', default: 'not-a-port' } },
      { path: emptyFile, env: {} }
    );
    assert.fail('expected empty-file schema default loadEnv to throw');
  } catch (err) { expectNoSource(err, 'not-a-port'); }
  try {
    await loadEnvAsync(
      { PORT: { type: 'port', default: 'not-a-port' } },
      { path: emptyFile, env: {} }
    );
    assert.fail('expected empty-file schema default loadEnvAsync to throw');
  } catch (err) { expectNoSource(err, 'not-a-port'); }

  // 11. Punctuation path: details.source is the original path, not a parse of
  // the printable message (paths may contain `): `). Use a portable fake
  // relative name that Node can create on this OS.
  const weirdName = 'synthetic-path): suffix';
  const weirdFile = path.join(dir, weirdName);
  let weirdCreated = false;
  try {
    fs.writeFileSync(weirdFile, 'PORT=bad\n');
    weirdCreated = true;
  } catch (_) {
    // Some hosts reject `:` in names; Linux CI creates this fixture.
  }
  if (weirdCreated) {
    const expectWeird = (err) => {
      assert.strictEqual(
        err.errors[0],
        `PORT (from ${weirdFile}): expected a port (0-65535, e.g. 3000), got "bad"`
      );
      assert.strictEqual(err.details[0].source, weirdFile);
      assert.strictEqual(
        err.details[0].message,
        'expected a port (0-65535, e.g. 3000), got "bad"'
      );
    };
    try {
      loadEnv({ PORT: { type: 'port', required: true } }, { path: weirdFile, env: {} });
      assert.fail('expected punctuation-path loadEnv to throw');
    } catch (err) { expectWeird(err); }
    try {
      await loadEnvAsync({ PORT: { type: 'port', required: true } }, { path: weirdFile, env: {} });
      assert.fail('expected punctuation-path loadEnvAsync to throw');
    } catch (err) { expectWeird(err); }
  }

  // 12. Non-enumerable ambient PORT does not win over a file value (spread
  // ignores it), so loadEnv must still name the file - both loaders.
  {
    const neFile = path.join(dir, 'nonenum.env');
    fs.writeFileSync(neFile, 'PORT=bad\n');
    const nonEnumEnv = Object.defineProperty({}, 'PORT', {
      value: '3000',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const expectFileWins = (err) => {
      assert.ok(err instanceof EnvSaafError);
      assert.strictEqual(
        err.errors[0],
        `PORT (from ${neFile}): expected a port (0-65535, e.g. 3000), got "bad"`
      );
      assert.deepStrictEqual(err.details[0], {
        key: 'PORT',
        message: 'expected a port (0-65535, e.g. 3000), got "bad"',
        source: neFile,
      });
    };
    try {
      loadEnv({ PORT: { type: 'port', required: true } }, { path: neFile, env: nonEnumEnv });
      assert.fail('expected non-enumerable ambient sync loadEnv to throw');
    } catch (err) { expectFileWins(err); }
    try {
      await loadEnvAsync({ PORT: { type: 'port', required: true } }, { path: neFile, env: nonEnumEnv });
      assert.fail('expected non-enumerable ambient async loadEnvAsync to throw');
    } catch (err) { expectFileWins(err); }
  }

  fs.rmSync(dir, { recursive: true, force: true });
})();

// Issue #345: `conflictsWith` rejects mutually exclusive variables when both resolve as set.
const conflictsWithTest = (async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const {
    loadEnv, loadEnvAsync, validateEnv, validateSchema,
    toJsonSchema, generateExample, EnvSaafError,
  } = require('./index');

  // 1. Up-front schema validation: malformed shapes, self-references, and undeclared keys.
  const sparse = Array(1);
  const sparseMid = ['B', , 'C']; // eslint-disable-line no-sparse-arrays
  for (const bad of ['', '   ', [], [''], ['   '], ['B', ''], [123], [null], [undefined], sparse, sparseMid, null, 123, true, false, {}]) {
    for (const check of [
      s => validateSchema(s),
      s => toJsonSchema(s),
      s => validateEnv(s, {}, { throwOnError: false }),
    ]) {
      assert.throws(
        () => check({ A: { type: 'string', conflictsWith: bad }, B: {}, C: {} }),
        err => err instanceof EnvSaafError
          && err.message.startsWith('Invalid schema:')
          && err.errors.length === 1
          && err.errors[0] === 'A: "conflictsWith" must be a non-empty string or a non-empty array of non-empty strings'
          && err.details[0].key === 'A',
        `expected schema shape error for conflictsWith=${JSON.stringify(bad)}`,
      );
    }
  }

  // Self-conflict: single, list, duplicated self, and inside a group.
  for (const [schema, expectedKey] of [
    [{ A: { conflictsWith: 'A' } }, 'A'],
    [{ A: { conflictsWith: ['B', 'A'] }, B: {} }, 'A'],
    [{ A: { conflictsWith: ['A', 'A'] } }, 'A'],
    [{ DB: { prefix: 'DB_', schema: { HOST: { type: 'host', conflictsWith: 'DB_HOST' } } } }, 'DB_HOST'],
  ]) {
    assert.throws(
      () => validateEnv(schema, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === `${expectedKey}: "conflictsWith" must name a different key, not itself`,
    );
  }

  // Undeclared target: flat, list, unprefixed inner group name, alias name instead of canonical key,
  // and Object.prototype property names when not declared in the schema.
  for (const [schema, key, badTarget] of [
    [{ A: { conflictsWith: 'NO_SUCH_KEY' } }, 'A', 'NO_SUCH_KEY'],
    [{ A: { conflictsWith: ['B', 'MISSING_KEY'] }, B: {} }, 'A', 'MISSING_KEY'],
    [{ DB: { prefix: 'DB_', schema: { HOST: { conflictsWith: 'PORT' }, PORT: { type: 'port' } } } }, 'DB_HOST', 'PORT'],
    [{ A: { aliases: ['OLD_A'] }, B: { conflictsWith: 'OLD_A' } }, 'B', 'OLD_A'],
    [{ A: { conflictsWith: 'toString' } }, 'A', 'toString'],
    [{ A: { conflictsWith: 'constructor' } }, 'A', 'constructor'],
    [{ A: { conflictsWith: '__proto__' } }, 'A', '__proto__'],
  ]) {
    assert.throws(
      () => validateEnv(schema, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === `${key}: "conflictsWith" references undeclared key "${badTarget}"`,
      `expected undeclared error for ${key} -> ${badTarget}`,
    );
  }

  // Prototype property names ARE accepted when genuinely declared as schema keys.
  const protoSchema = {
    ['__proto__']: { type: 'string', conflictsWith: 'toString' },
    toString: { type: 'string', conflictsWith: 'constructor' },
    constructor: { type: 'string' },
  };
  assert.doesNotThrow(() => validateSchema(protoSchema));
  assert.throws(
    () => validateEnv(protoSchema, Object.assign(Object.create(null), { ['__proto__']: 'a', toString: 'b' })),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === '__proto__: conflicts with toString (cannot set both)',
  );

  // Group container rules reject `conflictsWith` directly on the group object; null rules do not crash root checks.
  assert.doesNotThrow(() => validateSchema({ N: null, A: { conflictsWith: 'N' } }));
  assert.throws(
    () => validateSchema({ A: {}, DB: { prefix: 'DB_', conflictsWith: 'A', schema: { HOST: {} } } }),
    err => err instanceof EnvSaafError
      && err.errors.includes('DB: group rules only support "prefix" and "schema" (unexpected "conflictsWith")'),
  );

  // 2. Single, one-sided (both declaration orders), and reciprocal declarations; set/missing/empty/null cases.
  const tokFile = path.join(__dirname, 'package.json');
  const oneSidedFirst = {
    API_KEY: { type: 'string', conflictsWith: 'OAUTH_TOKEN_FILE' },
    OAUTH_TOKEN_FILE: { type: 'file' },
  };
  const oneSidedSecond = {
    API_KEY: { type: 'string' },
    OAUTH_TOKEN_FILE: { type: 'file', conflictsWith: 'API_KEY' },
  };
  const reciprocal = {
    API_KEY: { type: 'string', conflictsWith: 'OAUTH_TOKEN_FILE' },
    OAUTH_TOKEN_FILE: { type: 'file', conflictsWith: ['API_KEY', 'API_KEY'] },
  };

  for (const s of [oneSidedFirst, oneSidedSecond, reciprocal]) {
    // Neither set (or empty string / null / undefined) passes.
    assert.deepStrictEqual(validateEnv(s, {}), {});
    assert.deepStrictEqual(validateEnv(s, { API_KEY: '', OAUTH_TOKEN_FILE: '' }), {});
    assert.deepStrictEqual(validateEnv(s, { API_KEY: null, OAUTH_TOKEN_FILE: undefined }), {});
    // Either key alone passes (even when the other is explicitly '' or null).
    assert.deepStrictEqual(validateEnv(s, { API_KEY: 'sk_test_only', OAUTH_TOKEN_FILE: '' }), { API_KEY: 'sk_test_only' });
    assert.deepStrictEqual(validateEnv(s, { API_KEY: '', OAUTH_TOKEN_FILE: tokFile }), { OAUTH_TOKEN_FILE: tokFile });
  }

  // Both set fails with a single diagnostic naming both keys (never duplicating on reciprocal).
  for (const [s, first, second] of [
    [oneSidedFirst, 'API_KEY', 'OAUTH_TOKEN_FILE'],
    [oneSidedSecond, 'OAUTH_TOKEN_FILE', 'API_KEY'],
    [reciprocal, 'API_KEY', 'OAUTH_TOKEN_FILE'],
  ]) {
    const secretVal = 'sk_live_super_secret_987654321';
    assert.throws(
      () => validateEnv(s, { API_KEY: secretVal, OAUTH_TOKEN_FILE: tokFile }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === `${first}: conflicts with ${second} (cannot set both)`
        && err.details.length === 1
        && err.details[0].key === first
        && err.details[0].message === `conflicts with ${second} (cannot set both)`
        // Secrecy: values (and even masked forms or file paths) never appear in conflict diagnostics.
        && !err.message.includes(secretVal)
        && !err.message.includes('sk***21')
        && !err.message.includes(tokFile),
    );
  }

  // Sensitive keys likewise never leak raw or masked values in conflict diagnostics.
  {
    const sensitiveSecret = 'top-secret-token-value';
    assert.throws(
      () => validateEnv(
        {
          PRIMARY_SECRET: { type: 'string', sensitive: true, conflictsWith: 'FALLBACK_SECRET' },
          FALLBACK_SECRET: { type: 'string', sensitive: true },
        },
        { PRIMARY_SECRET: sensitiveSecret, FALLBACK_SECRET: 'another-secret-value' },
      ),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'PRIMARY_SECRET: conflicts with FALLBACK_SECRET (cannot set both)'
        && !err.message.includes(sensitiveSecret)
        && !err.message.includes('another-secret-value')
        && !err.message.includes('***'),
    );
  }

  // Whitespace-only input on a string rule counts as provided (unlike ''), so it conflicts.
  assert.throws(
    () => validateEnv({ A: { type: 'string', conflictsWith: 'B' }, B: { type: 'string' } }, { A: '   ', B: 'ok' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'A: conflicts with B (cannot set both)',
  );

  // 3. List form + grouped / nested-grouped schemas using full flattened names.
  const backendSchema = Object.freeze({
    DATABASE_URL: Object.freeze({ type: 'url', conflictsWith: Object.freeze(['DB_HOST', 'DB_PORT', 'APP_CACHE_URL']) }),
    DB: Object.freeze({
      prefix: 'DB_',
      schema: Object.freeze({
        HOST: Object.freeze({ type: 'host' }),
        PORT: Object.freeze({ type: 'port' }),
      }),
    }),
    APP: Object.freeze({
      prefix: 'APP_',
      schema: Object.freeze({
        CACHE: Object.freeze({
          prefix: 'CACHE_',
          schema: Object.freeze({
            URL: Object.freeze({ type: 'url', conflictsWith: 'DATABASE_URL' }),
          }),
        }),
      }),
    }),
  });

  // URL alone passes; split DB group + nested APP.CACHE group together (without DATABASE_URL) pass.
  assert.deepStrictEqual(
    validateEnv(backendSchema, { DATABASE_URL: 'https://db.example.com' }),
    { DATABASE_URL: 'https://db.example.com' },
  );
  assert.deepStrictEqual(
    validateEnv(backendSchema, { DB_HOST: 'localhost', DB_PORT: '5432', APP_CACHE_URL: 'https://cache.example.com' }),
    { DB: { HOST: 'localhost', PORT: 5432 }, APP: { CACHE: { URL: 'https://cache.example.com' } } },
  );
  // Setting DATABASE_URL alongside multiple list targets reports each conflicting pair once (reciprocal APP_CACHE_URL de-duped).
  assert.throws(
    () => validateEnv(backendSchema, {
      DATABASE_URL: 'https://db.example.com',
      DB_HOST: 'localhost',
      DB_PORT: '5432',
      APP_CACHE_URL: 'https://cache.example.com',
    }),
    err => err instanceof EnvSaafError
      && JSON.stringify(err.errors) === JSON.stringify([
        'DATABASE_URL: conflicts with DB_HOST (cannot set both)',
        'DATABASE_URL: conflicts with DB_PORT (cannot set both)',
        'DATABASE_URL: conflicts with APP_CACHE_URL (cannot set both)',
      ]),
  );

  // One-sided conflict declared ONLY inside a group against another group or top-level key.
  {
    const innerOnly = {
      LEGACY_DSN: { type: 'url' },
      DB: { prefix: 'DB_', schema: { HOST: { type: 'host', conflictsWith: 'LEGACY_DSN' } } },
    };
    assert.deepStrictEqual(validateEnv(innerOnly, { LEGACY_DSN: 'https://db.example.com' }), { LEGACY_DSN: 'https://db.example.com' });
    assert.deepStrictEqual(validateEnv(innerOnly, { DB_HOST: 'localhost' }), { DB: { HOST: 'localhost' } });
    assert.throws(
      () => validateEnv(innerOnly, { LEGACY_DSN: 'https://db.example.com', DB_HOST: 'localhost' }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'DB_HOST: conflicts with LEGACY_DSN (cannot set both)'
        && err.details[0].key === 'DB_HOST',
    );
  }

  // 4. Resolved aliases and defaults (including falsy defaults) count as set; warnings are preserved.
  {
    const aliasSchema = {
      API_KEY: { type: 'string', aliases: ['LEGACY_API_KEY'], conflictsWith: 'BEARER_TOKEN' },
      BEARER_TOKEN: { type: 'string', aliases: ['OLD_BEARER_TOKEN'] },
    };
    const warnings = [];
    // Alias on one side only passes and emits its deprecation warning.
    assert.deepStrictEqual(
      validateEnv(aliasSchema, { LEGACY_API_KEY: 'k1' }, { onWarn: m => warnings.push(m) }),
      { API_KEY: 'k1' },
    );
    assert.deepStrictEqual(warnings, ['env-saaf: LEGACY_API_KEY is deprecated; use API_KEY instead']);

    // Alias on A + alias on B fails symmetrically under canonical names while preserving both deprecation warnings.
    const bothWarnings = [];
    assert.throws(
      () => validateEnv(
        aliasSchema,
        { API_KEY: '', LEGACY_API_KEY: 'k1', OLD_BEARER_TOKEN: 'b1' },
        { onWarn: m => bothWarnings.push(m) },
      ),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'API_KEY: conflicts with BEARER_TOKEN (cannot set both)'
        && !err.message.includes('k1')
        && !err.message.includes('b1'),
    );
    assert.deepStrictEqual(bothWarnings, [
      'env-saaf: LEGACY_API_KEY is deprecated; use API_KEY instead',
      'env-saaf: OLD_BEARER_TOKEN is deprecated; use BEARER_TOKEN instead',
    ]);

    // Empty alias does NOT count as set.
    assert.deepStrictEqual(
      validateEnv(aliasSchema, { LEGACY_API_KEY: '', BEARER_TOKEN: 'b1' }, { onWarn: () => {} }),
      { BEARER_TOKEN: 'b1' },
    );
  }

  // Defaults (including falsy false, 0, '', null) count as set and conflict when the other key is also set.
  for (const [ruleA, envB] of [
    [{ type: 'boolean', default: false, conflictsWith: 'B' }, { B: '1' }],
    [{ type: 'port', default: 0, conflictsWith: 'B' }, { B: '1' }],
    [{ type: 'string', default: '', conflictsWith: 'B' }, { B: '1' }],
    [{ type: 'json', default: null, conflictsWith: 'B' }, { B: '1' }],
  ]) {
    const defSchema = { A: ruleA, B: { type: 'string' } };
    // Without B, A resolves to its default and passes.
    const solo = validateEnv(defSchema, {});
    assert.strictEqual(Object.prototype.hasOwnProperty.call(solo, 'A'), true);
    // With B set, both A (from default) and B (from env) are set -> fails!
    assert.throws(
      () => validateEnv(defSchema, envB),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'A: conflicts with B (cannot set both)',
    );
    // One-sided reverse: B declares conflictsWith: 'A', A has the falsy default.
    const revSchema = { A: { type: ruleA.type, default: ruleA.default }, B: { type: 'string', conflictsWith: 'A' } };
    assert.throws(
      () => validateEnv(revSchema, envB),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'B: conflicts with A (cannot set both)',
    );
  }

  // Both keys having defaults conflicts even on an empty env `{}`.
  assert.throws(
    () => validateEnv({ A: { default: 'x', conflictsWith: 'B' }, B: { default: 'y' } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'A: conflicts with B (cannot set both)',
  );

  // 5. Non-throwing mode (`throwOnError: false`), `requiredIf` interaction, `toJsonSchema` & `generateExample`.
  {
    const nonThrowSchema = {
      A: { type: 'string' },
      B: { type: 'string', conflictsWith: 'A' },
      DEPENDENT: { type: 'string', requiredIf: { key: 'A', equals: 'trigger' } },
      PORT: { type: 'port', default: 3000 },
    };
    const collected = validateEnv(nonThrowSchema, { A: 'trigger', B: 'other' }, { throwOnError: false });
    // Both conflicted keys are omitted symmetrically from `env`; unrelated valid keys stay, and
    // `requiredIf` does not fire spuriously on conflicted `A`.
    assert.deepStrictEqual(collected.env, { PORT: 3000 });
    assert.deepStrictEqual(collected.errors, ['B: conflicts with A (cannot set both)']);
    assert.deepStrictEqual(collected.details, [{ key: 'B', message: 'conflicts with A (cannot set both)' }]);

    const exported = toJsonSchema(backendSchema);
    assertDraft202012Schema(exported);
    assert.ok(generateExample(oneSidedFirst).includes('API_KEY='));
  }

  // 6. `loadEnv`, `loadEnvAsync` (with #350 file source attribution) and CLI `check --schema`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-345-'));
  try {
    const envFile = path.join(dir, '.env');
    const schemaFile = path.join(dir, 'env.schema.js');
    fs.writeFileSync(
      schemaFile,
      "module.exports = { API_KEY: { type: 'string', sensitive: true, conflictsWith: 'AUTH_TOKEN' }, AUTH_TOKEN: { type: 'string', sensitive: true } };\n",
    );
    fs.writeFileSync(path.join(dir, '.env.example'), 'API_KEY=\nAUTH_TOKEN=\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'void (process.env.API_KEY || process.env.AUTH_TOKEN);\n');

    // Only one set in .env -> loadEnv, loadEnvAsync, and CLI check --schema all pass.
    fs.writeFileSync(envFile, 'API_KEY=live_secret_key\nAUTH_TOKEN=\n');
    const schema = require(schemaFile);
    assert.deepStrictEqual(loadEnv(schema, { path: envFile, env: {} }), { API_KEY: 'live_secret_key' });
    assert.deepStrictEqual(await loadEnvAsync(schema, { path: envFile, env: {} }), { API_KEY: 'live_secret_key' });
    const okCli = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--schema', 'env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(okCli.status, 0, okCli.stderr);
    assert.strictEqual(JSON.parse(okCli.stdout).ok, true);

    // Both set in .env -> loadEnv and loadEnvAsync attribute winning file source without leaking secrets; CLI exits 1.
    fs.writeFileSync(envFile, 'API_KEY=live_secret_key\nAUTH_TOKEN=live_token_val\n');
    for (const runLoad of [
      () => {
        try { loadEnv(schema, { path: envFile, env: {} }); assert.fail('expected loadEnv to throw'); }
        catch (e) { return e; }
      },
      async () => {
        try { await loadEnvAsync(schema, { path: envFile, env: {} }); assert.fail('expected loadEnvAsync to throw'); }
        catch (e) { return e; }
      },
    ]) {
      const err = await runLoad();
      assert.ok(err instanceof EnvSaafError);
      assert.deepStrictEqual(err.errors, [
        `API_KEY (from ${envFile}): conflicts with AUTH_TOKEN (cannot set both)`,
      ]);
      assert.deepStrictEqual(err.details, [{
        key: 'API_KEY',
        message: 'conflicts with AUTH_TOKEN (cannot set both)',
        source: envFile,
      }]);
      assert.ok(!err.message.includes('live_secret_key'));
      assert.ok(!err.message.includes('live_token_val'));
    }

    // Default-origin key conflicting with a file key does not falsely blame the file on the defaulted key.
    try {
      loadEnv(
        { MODE_A: { default: 'on', conflictsWith: 'AUTH_TOKEN' }, AUTH_TOKEN: { type: 'string' } },
        { path: envFile, env: {} },
      );
      assert.fail('expected default + file conflict to throw');
    } catch (err) {
      assert.deepStrictEqual(err.errors, ['MODE_A: conflicts with AUTH_TOKEN (cannot set both)']);
      assert.deepStrictEqual(err.details, [{ key: 'MODE_A', message: 'conflicts with AUTH_TOKEN (cannot set both)' }]);
    }

    const badCli = spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--schema', 'env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(badCli.status, 1);
    const badJson = JSON.parse(badCli.stdout);
    assert.strictEqual(badJson.ok, false);
    assert.deepStrictEqual(badJson.invalid, ['API_KEY: conflicts with AUTH_TOKEN (cannot set both)']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// Issue #347: POSIX `${VAR:?message}`, `${VAR?message}`, `${VAR:+alt}`, and `${VAR+alt}` interpolation.
const interpolationOperatorsTest = (async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const {
    parseEnvFile, loadEnv, loadEnvAsync, EnvSaafError,
  } = require('./index');

  assert.strictEqual(parseEnvFile.length, 1);
  // Extra callback arguments (e.g. Array.prototype.map) must never leak as file provenance.
  assert.deepStrictEqual(['A=1\n'].map(parseEnvFile), [{ A: '1' }]);
  assert.throws(
    () => ['A=${ENV_SAAF_347_ABSENT:?missing in map}\n'].map(parseEnvFile),
    err => err instanceof Error
      && err.message === 'env-saaf: A at line 1: ENV_SAAF_347_ABSENT: missing in map'
      && !('source' in err),
  );

  const missingKey = 'ENV_SAAF_347_MISSING';
  const extSetKey = 'ENV_SAAF_347_EXT_SET';
  const extEmptyKey = 'ENV_SAAF_347_EXT_EMPTY';
  const extOverrideKey = 'ENV_SAAF_347_EXT_OVERRIDE';
  const prior = {
    [missingKey]: process.env[missingKey],
    [extSetKey]: process.env[extSetKey],
    [extEmptyKey]: process.env[extEmptyKey],
    [extOverrideKey]: process.env[extOverrideKey],
  };

  try {
    delete process.env[missingKey];
    process.env[extSetKey] = 'from-process';
    process.env[extEmptyKey] = '';
    process.env[extOverrideKey] = 'proc-non-empty';

    // 1. Set, empty, expanded-empty, process.env, and unset cases for `:+`, `+`, `:?`, `?`, `:-`, `-`, and plain `${VAR}`.
    const expanded = parseEnvFile([
      'SET=alpha',
      'ZERO=0',
      'FALSE_STR=false',
      'SPACE=" "',
      'EMPTY=',
      `ALIAS=\${${missingKey}}`,
      'CHAIN=${SET}',
      `${extOverrideKey}=`,
      // `:+` (set and non-empty -> alt; empty or unset -> '')
      'COLON_PLUS_SET=${SET:+yes}',
      'COLON_PLUS_ZERO=${ZERO:+zero-set}',
      'COLON_PLUS_FALSE=${FALSE_STR:+false-set}',
      'COLON_PLUS_SPACE=${SPACE:+space-set}',
      'COLON_PLUS_CHAIN=${CHAIN:+chained-yes}',
      `COLON_PLUS_EXT_SET=\${${extSetKey}:+proc-yes}`,
      'COLON_PLUS_EMPTY=${EMPTY:+no}',
      'COLON_PLUS_ALIAS=${ALIAS:+no}',
      `COLON_PLUS_EXT_EMPTY=\${${extEmptyKey}:+no}`,
      `COLON_PLUS_FILE_EMPTY_WINS=\${${extOverrideKey}:+no}`,
      `COLON_PLUS_UNSET=\${${missingKey}:+no}`,
      'COLON_PLUS_EMPTY_ALT=x${SET:+}y',
      // `+` (set even when empty -> alt; unset -> '')
      'PLUS_SET=${SET+yes}',
      'PLUS_EMPTY=${EMPTY+empty-still-set}',
      'PLUS_ALIAS=${ALIAS+alias-still-set}',
      `PLUS_EXT_SET=\${${extSetKey}+proc-yes}`,
      `PLUS_EXT_EMPTY=\${${extEmptyKey}+proc-empty-set}`,
      `PLUS_FILE_EMPTY_WINS=\${${extOverrideKey}+file-empty-set}`,
      `PLUS_UNSET=\${${missingKey}+no}`,
      'PLUS_EMPTY_ALT=x${EMPTY+}y',
      // `:?` and `?` when satisfied (non-empty for `:?`; set including empty for `?`)
      'REQ_COLON_SET=https://${SET:?missing set}/api',
      'REQ_COLON_ZERO=${ZERO:?missing zero}',
      'REQ_COLON_SPACE="${SPACE:?missing space}"',
      'REQ_COLON_CHAIN=${CHAIN:?missing chain}',
      `REQ_COLON_EXT=\${${extSetKey}:?missing ext}`,
      'REQ_PLAIN_SET=${SET?missing set}',
      'REQ_PLAIN_EMPTY=x${EMPTY?unset only}y',
      'REQ_PLAIN_ALIAS=x${ALIAS?unset only}y',
      `REQ_PLAIN_EXT_EMPTY=x\${${extEmptyKey}?unset only}y`,
      'REQ_EMPTY_MSG_SATISFIED=${SET:?}/${EMPTY?}',
      // Existing plain, `:-`, and `-` forms stay unchanged alongside new forms
      'PLAIN_REF=${SET}-${EMPTY}-' + `\${${missingKey}}`,
      'DEF_COLON_EMPTY=${EMPTY:-def}',
      'DEF_DASH_EMPTY=${EMPTY-def}',
      `DEF_DASH_UNSET=\${${missingKey}-def}`,
    ].join('\n'));

    assert.deepStrictEqual(expanded, {
      SET: 'alpha',
      ZERO: '0',
      FALSE_STR: 'false',
      SPACE: ' ',
      EMPTY: '',
      ALIAS: '',
      CHAIN: 'alpha',
      [extOverrideKey]: '',
      COLON_PLUS_SET: 'yes',
      COLON_PLUS_ZERO: 'zero-set',
      COLON_PLUS_FALSE: 'false-set',
      COLON_PLUS_SPACE: 'space-set',
      COLON_PLUS_CHAIN: 'chained-yes',
      COLON_PLUS_EXT_SET: 'proc-yes',
      COLON_PLUS_EMPTY: '',
      COLON_PLUS_ALIAS: '',
      COLON_PLUS_EXT_EMPTY: '',
      COLON_PLUS_FILE_EMPTY_WINS: '',
      COLON_PLUS_UNSET: '',
      COLON_PLUS_EMPTY_ALT: 'xy',
      PLUS_SET: 'yes',
      PLUS_EMPTY: 'empty-still-set',
      PLUS_ALIAS: 'alias-still-set',
      PLUS_EXT_SET: 'proc-yes',
      PLUS_EXT_EMPTY: 'proc-empty-set',
      PLUS_FILE_EMPTY_WINS: 'file-empty-set',
      PLUS_UNSET: '',
      PLUS_EMPTY_ALT: 'xy',
      REQ_COLON_SET: 'https://alpha/api',
      REQ_COLON_ZERO: '0',
      REQ_COLON_SPACE: ' ',
      REQ_COLON_CHAIN: 'alpha',
      REQ_COLON_EXT: 'from-process',
      REQ_PLAIN_SET: 'alpha',
      REQ_PLAIN_EMPTY: 'xy',
      REQ_PLAIN_ALIAS: 'xy',
      REQ_PLAIN_EXT_EMPTY: 'xy',
      REQ_EMPTY_MSG_SATISFIED: 'alpha/',
      PLAIN_REF: 'alpha--',
      DEF_COLON_EMPTY: 'def',
      DEF_DASH_EMPTY: '',
      DEF_DASH_UNSET: 'def',
    });

    // 2. Unsatisfied `:?` and `?` throw plain Error with key, 1-based line, variable name, and message (no source field).
    const assertParseThrows = (input, expectedMessage) => {
      assert.throws(
        () => parseEnvFile(input),
        err => err instanceof Error
          && !(err instanceof SyntaxError)
          && !(err instanceof EnvSaafError)
          && err.message === expectedMessage
          && !('source' in err),
        `expected "${expectedMessage}" for input ${JSON.stringify(input)}`,
      );
    };

    assertParseThrows(
      `A=\${${missingKey}:?need it}\n`,
      `env-saaf: A at line 1: ${missingKey}: need it`,
    );
    assertParseThrows(
      `EMPTY=\nA=\${EMPTY:?cannot be blank}\n`,
      'env-saaf: A at line 2: EMPTY: cannot be blank',
    );
    assertParseThrows(
      `ALIAS=\${${missingKey}}\nA=\${ALIAS:?expanded blank}\n`,
      'env-saaf: A at line 2: ALIAS: expanded blank',
    );
    assertParseThrows(
      `A=\${${extEmptyKey}:?process blank}\n`,
      `env-saaf: A at line 1: ${extEmptyKey}: process blank`,
    );
    assertParseThrows(
      `${extOverrideKey}=\nA=\${${extOverrideKey}:?file blank overrides process}\n`,
      `env-saaf: A at line 2: ${extOverrideKey}: file blank overrides process`,
    );
    assertParseThrows(
      `A=\${${missingKey}?must be defined}\n`,
      `env-saaf: A at line 1: ${missingKey}: must be defined`,
    );
    // Omitted message after `:?` and `?` falls back to distinct clear defaults.
    assertParseThrows(
      `A=\${${missingKey}:?}\n`,
      `env-saaf: A at line 1: ${missingKey}: is unset or empty`,
    );
    assertParseThrows(
      'EMPTY=\nA=${EMPTY:?}\n',
      'env-saaf: A at line 2: EMPTY: is unset or empty',
    );
    assertParseThrows(
      `A=\${${missingKey}?}\n`,
      `env-saaf: A at line 1: ${missingKey}: is unset`,
    );

    // 3. Nested defaults/alternates/messages, untaken branches, quotes, escapes, and unterminated spans.
    assert.deepStrictEqual(
      parseEnvFile([
        'FLAG=1',
        'EMPTY=',
        'HOST=service.internal',
        // Nested inside `:+` and `+`, including JSON braces and nested `:-`
        'NESTED_ALT=${FLAG:+https://${HOST}:${PORT_UNSET_347:-8443}/health}',
        'NESTED_PLUS=${EMPTY+${FLAG:+inner-alt}}',
        'BRACE_ALT=${FLAG:+{"enabled":true}}',
        // Nested `:+` inside `:-`
        'FALLBACK_TO_ALT=${EMPTY:-${FLAG:+from-alt}}',
        // Untaken branches containing `:?` / `?` must NOT evaluate or throw
        `UNTAKEN_COLON_DEF=\${FLAG:-\${${missingKey}:?must not fire}}`,
        `UNTAKEN_DASH_DEF=\${EMPTY-\${${missingKey}:?must not fire}}`,
        `UNTAKEN_COLON_PLUS=\${EMPTY:+\${${missingKey}:?must not fire}}`,
        `UNTAKEN_PLUS=\${${missingKey}+\${${missingKey}?must not fire}}`,
        // Single quotes, backslash escapes, double-quote escapes, and unterminated spans
        `SINGLE_REQ='\${${missingKey}:?literal single}'`,
        "SINGLE_ALT='${FLAG:+literal single}'",
        `ESCAPED_REQ=\\\${${missingKey}:?literal escaped}`,
        'ESCAPED_ALT=\\${FLAG:+literal escaped}',
        `NESTED_ESCAPED_ALT=\${FLAG:+\\\${${missingKey}:?still literal}}`,
        'DOUBLE_ESCAPED="${FLAG:+line1\\n\\"quoted\\"}"',
        `UNTERMINATED_REQ=ok \${${missingKey}:?unterminated`,
        'UNTERMINATED_ALT=ok ${FLAG:+unterminated',
      ].join('\n')),
      {
        FLAG: '1',
        EMPTY: '',
        HOST: 'service.internal',
        NESTED_ALT: 'https://service.internal:8443/health',
        NESTED_PLUS: 'inner-alt',
        BRACE_ALT: '{"enabled":true}',
        FALLBACK_TO_ALT: 'from-alt',
        UNTAKEN_COLON_DEF: '1',
        UNTAKEN_DASH_DEF: '',
        UNTAKEN_COLON_PLUS: '',
        UNTAKEN_PLUS: '',
        SINGLE_REQ: `\${${missingKey}:?literal single}`,
        SINGLE_ALT: '${FLAG:+literal single}',
        ESCAPED_REQ: `\${${missingKey}:?literal escaped}`,
        ESCAPED_ALT: '${FLAG:+literal escaped}',
        NESTED_ESCAPED_ALT: `\${${missingKey}:?still literal}`,
        DOUBLE_ESCAPED: 'line1\n"quoted"',
        UNTERMINATED_REQ: `ok \${${missingKey}:?unterminated`,
        UNTERMINATED_ALT: 'ok ${FLAG:+unterminated',
      },
    );

    // Taken branches with nested `:?` DO evaluate and report the outer assignment key and line.
    assertParseThrows(
      `EMPTY=\nTAKEN_DEF=\${EMPTY:-\${${missingKey}:?fallback missing}}\n`,
      `env-saaf: TAKEN_DEF at line 2: ${missingKey}: fallback missing`,
    );
    assertParseThrows(
      `FLAG=1\nTAKEN_ALT=\${FLAG:+\${${missingKey}:?dependent missing}}\n`,
      `env-saaf: TAKEN_ALT at line 2: ${missingKey}: dependent missing`,
    );
    // Nested interpolation and escaped `\${...}` inside `:?` error messages resolve cleanly without control-char leaks.
    assertParseThrows(
      `STAGE=staging\nAPI_KEY=\${${missingKey}:?missing key for \${STAGE} (set \\\${API_KEY})}\n`,
      `env-saaf: API_KEY at line 2: ${missingKey}: missing key for staging (set \${API_KEY})`,
    );

    // 4. Self-references (#185), bounded cycles, and Object.prototype property names.
    assert.deepStrictEqual(parseEnvFile('A=${A:+alt}\nB=${B+alt}\nSET=1\nC=${SET:+${C:-self-fb}}\n'), {
      A: '',
      B: '',
      SET: '1',
      C: 'self-fb',
    });
    assertParseThrows('A=${A:?self unset}\n', 'env-saaf: A at line 1: A: self unset');
    assertParseThrows('A=${A?self unset plain}\n', 'env-saaf: A at line 1: A: self unset plain');
    assert.doesNotThrow(() => parseEnvFile('A=${B:+cycle}\nB=${A}\n'));

    for (const protoKey of ['toString', 'constructor', 'hasOwnProperty']) {
      if (!Object.prototype.hasOwnProperty.call(process.env, protoKey)) {
        assert.deepStrictEqual(
          parseEnvFile(`DEF=\${${protoKey}:-proto-fb}\nALT=\${${protoKey}:+nope}\nPLUS=\${${protoKey}+nope}\n`),
          { DEF: 'proto-fb', ALT: '', PLUS: '' },
        );
        assertParseThrows(
          `REQ=\${${protoKey}:?proto missing}\n`,
          `env-saaf: REQ at line 1: ${protoKey}: proto missing`,
        );
      }
    }

    // 5. Multiline preceding values, CRLF/LF line numbers, value secrecy, loadEnv / loadEnvAsync provenance, and CLI.
    for (const nl of ['\n', '\r\n']) {
      const withMultiline = [
        '# header comment',
        '',
        'CERT="line-one',
        'line-two',
        'line-three"',
        `export TARGET_URL = https://\${SECRET_PART}@\${${missingKey}:?missing target host}`,
        'SECRET_PART=synthetic_token_991122',
      ].join(nl);
      assert.throws(
        () => parseEnvFile(withMultiline),
        err => err.message === `env-saaf: TARGET_URL at line 6: ${missingKey}: missing target host`
          && !err.message.includes('synthetic_token_991122')
          && !('source' in err),
      );
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-347-'));
    try {
      const baseFile = path.join(dir, '.env');
      const localFile = path.join(dir, '.env.local');
      const validSchema = {
        HOST: { type: 'host', required: true },
        TLS: { type: 'boolean', default: false },
        ENDPOINT: { type: 'url', required: true },
      };

      fs.writeFileSync(baseFile, 'HOST=api.example.com\nTLS=true\n');
      fs.writeFileSync(localFile, [
        'HOST=local.example.com',
        'TLS=1',
        'ENDPOINT=https://${HOST:?missing host}${TLS:+:8443}/v1',
      ].join('\n'));

      assert.deepStrictEqual(loadEnv(validSchema, { paths: [baseFile, localFile], env: {} }), {
        HOST: 'local.example.com',
        TLS: true,
        ENDPOINT: 'https://local.example.com:8443/v1',
      });
      assert.deepStrictEqual(await loadEnvAsync(validSchema, { paths: [baseFile, localFile], env: {} }), {
        HOST: 'local.example.com',
        TLS: true,
        ENDPOINT: 'https://local.example.com:8443/v1',
      });

      // Failing `:?` inside layered `.env.local` preserves exact file, key, line, variable, and message without mutating env.
      fs.writeFileSync(localFile, [
        'SECRET_TOKEN=synthetic_secret_445566',
        `ENDPOINT=https://\${SECRET_TOKEN}@\${${missingKey}:?need endpoint host}`,
      ].join('\n'));
      const callerEnv = { KEEP: 'untouched' };
      const expectedLoadMsg = `env-saaf: ENDPOINT (from ${localFile}) at line 2: ${missingKey}: need endpoint host`;

      assert.throws(
        () => loadEnv(validSchema, { paths: [baseFile, localFile], env: callerEnv, assign: true }),
        err => err instanceof Error
          && !(err instanceof EnvSaafError)
          && err.message === expectedLoadMsg
          && err.source === localFile
          && !err.message.includes('synthetic_secret_445566'),
      );
      await assert.rejects(
        loadEnvAsync(validSchema, { paths: [baseFile, localFile], env: callerEnv, assign: true }),
        err => err instanceof Error
          && !(err instanceof EnvSaafError)
          && err.message === expectedLoadMsg
          && err.source === localFile
          && !err.message.includes('synthetic_secret_445566'),
      );
      assert.deepStrictEqual(callerEnv, { KEEP: 'untouched' });

      // Invalid value produced by `:+` keeps #350 winning-file validation provenance.
      fs.writeFileSync(localFile, 'FLAG=1\nPORT=${FLAG:+not-a-port}\n');
      for (const runLoader of [
        () => {
          try { loadEnv({ PORT: { type: 'port', required: true } }, { path: localFile, env: {} }); assert.fail('expected throw'); }
          catch (e) { return e; }
        },
        async () => {
          try { await loadEnvAsync({ PORT: { type: 'port', required: true } }, { path: localFile, env: {} }); assert.fail('expected reject'); }
          catch (e) { return e; }
        },
      ]) {
        const err = await runLoader();
        assert.ok(err instanceof EnvSaafError);
        assert.deepStrictEqual(err.errors, [`PORT (from ${localFile}): expected a port (0-65535, e.g. 3000), got "not-a-port"`]);
        assert.strictEqual(err.details[0].source, localFile);
      }

      // CLI `check` (text and `--json`) formats relative file provenance with a single `env-saaf: ` prefix and no secret leak.
      const cliDir = path.join(dir, 'cli-proj');
      fs.mkdirSync(cliDir);
      fs.writeFileSync(path.join(cliDir, 'app.js'), 'void process.env.ENDPOINT;\n');
      fs.writeFileSync(path.join(cliDir, '.env.example'), 'ENDPOINT=\n');
      fs.writeFileSync(
        path.join(cliDir, '.env'),
        `SECRET_PART=synthetic_cli_778899\nENDPOINT=https://\${SECRET_PART}@\${${missingKey}:?cli host required}\n`,
      );
      const cliPath = path.join(__dirname, 'cli.js');
      const humanCli = spawnSync(process.execPath, [cliPath, 'check', cliDir], { encoding: 'utf8' });
      assert.strictEqual(humanCli.status, 2);
      assert.strictEqual(
        humanCli.stderr.trim(),
        `env-saaf: .env: ENDPOINT at line 2: ${missingKey}: cli host required`,
      );
      assert.ok(!humanCli.stderr.includes('synthetic_cli_778899'));

      const jsonCli = spawnSync(process.execPath, [cliPath, 'check', cliDir, '--json'], { encoding: 'utf8' });
      assert.strictEqual(jsonCli.status, 2);
      assert.strictEqual(jsonCli.stderr, '');
      const parsedCli = JSON.parse(jsonCli.stdout);
      assert.deepStrictEqual(parsedCli, {
        ok: false,
        error: `.env: ENDPOINT at line 2: ${missingKey}: cli host required`,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
})();

// Issue #346: `options.rules` schema-level cross-field validation hooks.
const crossFieldRulesTest = (async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {
    validateEnv, loadEnv, loadEnvAsync, EnvSaafError,
  } = require('./index');

  const baseSchema = {
    CACHE_TTL: { type: 'duration', default: '5m' },
    SESSION_TTL: { type: 'duration', required: true },
    WORKERS: { type: 'int', default: 4 },
    QUEUE_DEPTH: { type: 'int', default: 5 },
    MAX_CONNECTIONS: { type: 'int', default: 50 },
    SENTRY_DSN: { type: 'url' },
    LOG_FILE: { type: 'string', aliases: ['LEGACY_LOG_FILE'] },
    FEATURE_TAGS: { type: 'array', of: 'string', default: ['core'] },
    NORMALIZED: { type: 'string', transform: s => s.toLowerCase() },
    DB: {
      prefix: 'DB_',
      schema: {
        HOST: { type: 'host', default: 'localhost' },
        MIN_POOL: { type: 'int', default: 2 },
        MAX_POOL: { type: 'int', default: 10 },
      },
    },
  };

  // 1. Coerced/typed snapshot (including defaults, aliases, transforms, and frozen groups) + no-error return forms.
  let inspected = null;
  const warnings = [];
  const validEnv = validateEnv(
    baseSchema,
    {
      CACHE_TTL: '2m',
      SESSION_TTL: '15m',
      WORKERS: '3',
      QUEUE_DEPTH: '10',
      MAX_CONNECTIONS: '40',
      LEGACY_LOG_FILE: '/var/log/app.log',
      NORMALIZED: 'MIXED_CASE',
      DB_MIN_POOL: '4',
      DB_MAX_POOL: '12',
    },
    {
      onWarn: msg => warnings.push(msg),
      rules: [
        (cfg) => {
          inspected = cfg;
          assert.strictEqual(Object.isFrozen(cfg), true);
          assert.strictEqual(Object.isFrozen(cfg.DB), true);
          assert.strictEqual(typeof cfg.CACHE_TTL, 'number');
          assert.strictEqual(cfg.CACHE_TTL, 120000);
          assert.strictEqual(cfg.SESSION_TTL, 900000);
          assert.strictEqual(cfg.WORKERS, 3);
          assert.strictEqual(cfg.QUEUE_DEPTH, 10);
          assert.strictEqual(cfg.MAX_CONNECTIONS, 40);
          assert.strictEqual(cfg.SENTRY_DSN, undefined);
          assert.strictEqual(cfg.LOG_FILE, '/var/log/app.log');
          assert.strictEqual('LEGACY_LOG_FILE' in cfg, false);
          assert.deepStrictEqual(cfg.FEATURE_TAGS, ['core']);
          assert.strictEqual(cfg.NORMALIZED, 'mixed_case');
          assert.deepStrictEqual(cfg.DB, { HOST: 'localhost', MIN_POOL: 4, MAX_POOL: 12 });
          assert.throws(() => { cfg.WORKERS = 99; }, TypeError);
          assert.throws(() => { cfg.DB.MIN_POOL = 99; }, TypeError);
        },
        () => null,
        () => '',
        () => [],
        () => ['', ''],
      ],
    },
  );
  assert.strictEqual(inspected, validEnv);
  assert.deepStrictEqual(warnings, ['env-saaf: LEGACY_LOG_FILE is deprecated; use LOG_FILE instead']);

  // Single no-op hook, empty rules array, and non-throwing clean run all succeed with zero errors.
  assert.deepStrictEqual(
    validateEnv({ PORT: { type: 'port', default: 3000 } }, {}, { rules: () => undefined }),
    { PORT: 3000 },
  );
  assert.deepStrictEqual(
    validateEnv({ PORT: { type: 'port', default: 3000 } }, {}, { rules: [] }),
    { PORT: 3000 },
  );
  const cleanNonThrow = validateEnv(
    { PORT: { type: 'port', default: 3000 } },
    {},
    { throwOnError: false, rules: [() => undefined, () => null, () => []] },
  );
  assert.deepStrictEqual(cleanNonThrow, {
    env: { PORT: 3000 },
    errors: [],
    details: [],
  });

  // 2. Single hook (string and array returns, including 1-char message) & multiple hooks aggregating in order.
  assert.throws(
    () => validateEnv({ A: { type: 'int', default: 1 } }, {}, { rules: () => 'x' }),
    err => err instanceof EnvSaafError
      && err.message === 'Invalid environment variables:\n  - x'
      && JSON.stringify(err.errors) === JSON.stringify(['x'])
      && JSON.stringify(err.details) === JSON.stringify([{ key: '', message: 'x' }]),
  );

  const crossRules = [
    cfg => (cfg.CACHE_TTL >= cfg.SESSION_TTL ? 'CACHE_TTL must be smaller than SESSION_TTL' : undefined),
    cfg => (!cfg.SENTRY_DSN && !cfg.LOG_FILE ? 'At least one of SENTRY_DSN, LOG_FILE must be set' : null),
    () => undefined,
    cfg => {
      const errs = [];
      if (cfg.WORKERS * cfg.QUEUE_DEPTH > cfg.MAX_CONNECTIONS) {
        errs.push('WORKERS * QUEUE_DEPTH must not exceed MAX_CONNECTIONS');
      }
      if (cfg.DB && cfg.DB.MIN_POOL > cfg.DB.MAX_POOL) {
        errs.push('DB_MIN_POOL: must not exceed DB_MAX_POOL');
      }
      errs.push('');
      return errs;
    },
  ];

  const violatingInput = {
    CACHE_TTL: '30m',
    SESSION_TTL: '10m',
    WORKERS: '8',
    QUEUE_DEPTH: '10',
    MAX_CONNECTIONS: '50',
    DB_MIN_POOL: '20',
    DB_MAX_POOL: '10',
  };
  const expectedCrossErrors = [
    'CACHE_TTL must be smaller than SESSION_TTL',
    'At least one of SENTRY_DSN, LOG_FILE must be set',
    'WORKERS * QUEUE_DEPTH must not exceed MAX_CONNECTIONS',
    'DB_MIN_POOL: must not exceed DB_MAX_POOL',
  ];
  const expectedCrossDetails = [
    { key: '', message: 'CACHE_TTL must be smaller than SESSION_TTL' },
    { key: '', message: 'At least one of SENTRY_DSN, LOG_FILE must be set' },
    { key: '', message: 'WORKERS * QUEUE_DEPTH must not exceed MAX_CONNECTIONS' },
    { key: 'DB_MIN_POOL', message: 'must not exceed DB_MAX_POOL' },
  ];

  assert.throws(
    () => validateEnv(baseSchema, violatingInput, { rules: crossRules }),
    err => err instanceof EnvSaafError
      && err.message === 'Invalid environment variables:\n' + expectedCrossErrors.map(e => `  - ${e}`).join('\n')
      && JSON.stringify(err.errors) === JSON.stringify(expectedCrossErrors)
      && JSON.stringify(err.details) === JSON.stringify(expectedCrossDetails),
  );

  // 3. Non-throwing mode (`throwOnError: false`) collects hook errors while keeping the coerced frozen `env`.
  let fmtCalls = 0;
  const collected = validateEnv(baseSchema, violatingInput, {
    throwOnError: false,
    formatError: () => { fmtCalls++; return 'unused'; },
    rules: crossRules,
  });
  assert.strictEqual(fmtCalls, 0);
  assert.strictEqual(Object.isFrozen(collected.env), true);
  assert.strictEqual(Object.isFrozen(collected.env.DB), true);
  assert.strictEqual(collected.env.CACHE_TTL, 1800000);
  assert.strictEqual(collected.env.SESSION_TTL, 600000);
  assert.deepStrictEqual(collected.errors, expectedCrossErrors);
  assert.deepStrictEqual(collected.details, expectedCrossDetails);

  // `formatError` receives a frozen copy of `errors` including cross-field errors in throwing mode.
  let formattedSeen = null;
  assert.throws(
    () => validateEnv(baseSchema, violatingInput, {
      rules: crossRules[0],
      formatError: (errs, ctx) => {
        formattedSeen = { errs, frozen: Object.isFrozen(errs), keys: ctx.keys };
        return `CROSS_FAIL(${errs.length})`;
      },
    }),
    err => err instanceof EnvSaafError
      && err.message === 'CROSS_FAIL(1)'
      && JSON.stringify(err.errors) === JSON.stringify(['CACHE_TTL must be smaller than SESSION_TTL'])
      && JSON.stringify(err.details) === JSON.stringify([{ key: '', message: 'CACHE_TTL must be smaller than SESSION_TTL' }]),
  );
  assert.strictEqual(formattedSeen.frozen, true);
  assert.deepStrictEqual(formattedSeen.errs, ['CACHE_TTL must be smaller than SESSION_TTL']);

  // 4. Incomplete-snapshot rule: skip `rules` whenever earlier checks produced 1+ errors.
  let skippedCalls = 0;
  const mustNotRun = () => {
    skippedCalls++;
    return 'secondary cascade error that must not appear';
  };

  const incompleteCases = [
    // Missing required variable (1 error)
    [{ SESSION_TTL: { type: 'duration', required: true } }, {}, {}],
    // Multiple per-key errors (2 errors)
    [{ A: { type: 'port', required: true }, B: { type: 'int', required: true } }, { A: 'bad' }, {}],
    // Optional key supplied with uncoercible value (prevents bogus "at least one must be set" cascade)
    [{ SENTRY_DSN: { type: 'url' }, LOG_FILE: { type: 'string' } }, { SENTRY_DSN: 'not-a-url' }, {}],
    // Bounds failure
    [{ N: { type: 'int', min: 10 } }, { N: '5' }, {}],
    // Per-key custom validate failure
    [{ N: { type: 'int', validate: v => v % 2 === 0 || 'must be even' } }, { N: '3' }, {}],
    // Per-key transform failure
    [{ S: { type: 'string', transform: () => { throw new Error('bad transform'); } } }, { S: 'hi' }, {}],
    // Pass 2a `conflictsWith` failure
    [{ A: { type: 'string', conflictsWith: 'B' }, B: { type: 'string' } }, { A: '1', B: '2' }, {}],
    // Pass 2b `requiredIf` failure
    [{ MODE: { default: 'prod' }, DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'prod' } } }, {}, {}],
    // `strict: true` undeclared variable typo (prevents cascading missing-optional cross-field error)
    [{ SENTRY_DSN: { type: 'url' }, LOG_FILE: { type: 'string' } }, { SENTRY_DNS: 'https://example.com' }, { strict: true }],
  ];

  for (const [schema, envInput, extraOpts] of incompleteCases) {
    assert.throws(
      () => validateEnv(schema, envInput, { ...extraOpts, rules: mustNotRun }),
      err => err instanceof EnvSaafError && !err.errors.some(e => e.includes('secondary cascade')),
    );
    const nonThrowIncomplete = validateEnv(schema, envInput, {
      ...extraOpts,
      throwOnError: false,
      rules: [mustNotRun],
    });
    assert.ok(nonThrowIncomplete.errors.length >= 1);
    assert.ok(!nonThrowIncomplete.errors.some(e => e.includes('secondary cascade')));
  }
  // Malformed schema throws Invalid schema without running rules.
  assert.throws(
    () => validateEnv({ BAD: { type: 'unknown_type' } }, {}, { rules: mustNotRun }),
    err => err instanceof EnvSaafError && err.message.startsWith('Invalid schema:'),
  );
  assert.strictEqual(skippedCalls, 0);

  // 5. `loadEnv` and `loadEnvAsync` forwarding, `assign: true` atomicity, and source-free cross-field details.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-346-'));
  try {
    const envFile = path.join(dir, '.env');
    const loadSchema = {
      PORT: { type: 'port', required: true },
      ADMIN_PORT: { type: 'port', default: 9000 },
    };
    const distinctPortsRule = cfg => (cfg.PORT === cfg.ADMIN_PORT
      ? ['PORT must differ from ADMIN_PORT', 'PORT: collides with ADMIN_PORT']
      : undefined);

    fs.writeFileSync(envFile, 'PORT=8080\nADMIN_PORT=9090\n');
    const targetSync = {};
    const loadedSync = loadEnv(loadSchema, {
      path: envFile,
      env: targetSync,
      assign: true,
      rules: distinctPortsRule,
    });
    assert.deepStrictEqual(loadedSync, { PORT: 8080, ADMIN_PORT: 9090 });
    assert.strictEqual(Object.isFrozen(loadedSync), true);
    assert.deepStrictEqual(targetSync, { PORT: '8080', ADMIN_PORT: '9090' });

    const targetAsync = {};
    const loadedAsync = await loadEnvAsync(loadSchema, {
      path: envFile,
      env: targetAsync,
      assign: true,
      rules: [distinctPortsRule],
    });
    assert.deepStrictEqual(loadedAsync, { PORT: 8080, ADMIN_PORT: 9090 });
    assert.strictEqual(Object.isFrozen(loadedAsync), true);
    assert.deepStrictEqual(targetAsync, { PORT: '8080', ADMIN_PORT: '9090' });

    // Failing cross-field rule in loadEnv / loadEnvAsync throws EnvSaafError (even with throwOnError: false),
    // leaves `assign: true` target unmutated, honours `formatError`, and never fabricates `details[].source`.
    fs.writeFileSync(envFile, 'PORT=9000\n');
    const untouchedSync = { EXISTING: 'keep' };
    const untouchedAsync = { EXISTING: 'keep' };
    const assertLoadFailure = (err) => {
      assert.ok(err instanceof EnvSaafError);
      assert.strictEqual(err.message, 'LOAD_RULE_ERR:2');
      assert.deepStrictEqual(err.errors, [
        'PORT must differ from ADMIN_PORT',
        'PORT: collides with ADMIN_PORT',
      ]);
      assert.deepStrictEqual(err.details, [
        { key: '', message: 'PORT must differ from ADMIN_PORT' },
        { key: 'PORT', message: 'collides with ADMIN_PORT' },
      ]);
      assert.strictEqual('source' in err.details[0], false);
      assert.strictEqual('source' in err.details[1], false);
      return true;
    };

    assert.throws(
      () => loadEnv(loadSchema, {
        path: envFile,
        env: untouchedSync,
        assign: true,
        throwOnError: false,
        formatError: errs => `LOAD_RULE_ERR:${errs.length}`,
        rules: distinctPortsRule,
      }),
      assertLoadFailure,
    );
    await assert.rejects(
      loadEnvAsync(loadSchema, {
        path: envFile,
        env: untouchedAsync,
        assign: true,
        throwOnError: false,
        formatError: errs => `LOAD_RULE_ERR:${errs.length}`,
        rules: [distinctPortsRule],
      }),
      assertLoadFailure,
    );
    assert.deepStrictEqual(untouchedSync, { EXISTING: 'keep' });
    assert.deepStrictEqual(untouchedAsync, { EXISTING: 'keep' });

    // 6. Invalid `options.rules` shapes, invalid hook return types, throwing hooks, and unknown-option messages.
    const sparseRules = Array(1);
    for (const badRules of [null, 0, 123, 'fn', true, false, {}, [null], [123], [() => undefined, 'not-fn'], sparseRules]) {
      assert.throws(
        () => validateEnv({ REQ: { required: true } }, {}, { throwOnError: false, rules: badRules }),
        err => err instanceof TypeError && err.message === 'env-saaf: "rules" option must be a function or an array of functions',
      );
      assert.throws(
        () => loadEnv({ OPT: { type: 'string' } }, { path: envFile, env: {}, rules: badRules }),
        err => err instanceof TypeError && err.message === 'env-saaf: "rules" option must be a function or an array of functions',
      );
      await assert.rejects(
        loadEnvAsync({ OPT: { type: 'string' } }, { path: envFile, env: {}, rules: badRules }),
        err => err instanceof TypeError && err.message === 'env-saaf: "rules" option must be a function or an array of functions',
      );
    }

    const sparseReturn = Array(1);
    for (const badOutcome of [false, true, 0, 42, {}, Promise.resolve('async'), [123], ['ok', null], sparseReturn]) {
      assert.throws(
        () => validateEnv({ PORT: { type: 'port', default: 3000 } }, {}, { throwOnError: false, rules: () => badOutcome }),
        err => err instanceof TypeError && err.message === 'env-saaf: "rules" hook must return a string, an array of strings, or undefined',
      );
    }

    // A hook that throws a programming error propagates unchanged (matching #279 formatError).
    const bug = new RangeError('unexpected bug inside cross-field hook');
    assert.throws(
      () => validateEnv({ PORT: { type: 'port', default: 3000 } }, {}, { throwOnError: false, rules: () => { throw bug; } }),
      err => err === bug,
    );
    assert.throws(
      () => loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: envFile, env: {}, rules: () => { throw bug; } }),
      err => err === bug,
    );
    await assert.rejects(
      loadEnvAsync({ PORT: { type: 'port', default: 3000 } }, { path: envFile, env: {}, rules: () => { throw bug; } }),
      err => err === bug,
    );

    // Unknown-option diagnostics advertise `rules` on both validateEnv and loadEnv.
    assert.throws(
      () => validateEnv({}, {}, { rule: () => undefined }),
      err => err instanceof EnvSaafError
        && err.errors[0] === 'unknown option "rule" (validateEnv accepts: throwOnError, strict, onWarn, formatError, rules)',
    );
    assert.throws(
      () => loadEnv({}, { rule: () => undefined }),
      err => err instanceof EnvSaafError
        && err.errors[0] === 'unknown option "rule" (loadEnv accepts: path, paths, env, override, assign, throwOnError, strict, onWarn, formatError, rules)',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

Promise.all([watchModeTest, watchModeErrorPathTest, watchModeEsmSchemaTest, loadEnvAsyncTest, formatErrorThrowingHookTest, loadEnvSourceErrorsTest, conflictsWithTest, interpolationOperatorsTest, crossFieldRulesTest])
  .then(() => console.log('env-saaf v1.5.0: all tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
