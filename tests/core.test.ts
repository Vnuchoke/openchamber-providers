import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import { readSnapshot, removeProvider, writeProvider, type FileHost } from '../panel/core/config';
import {
  buildProvider,
  collectProviders,
  draftFrom,
  emptyDraft,
  emptyModel,
  readModels,
  type ProviderDraft,
} from '../panel/core/provider';
import { positiveInt } from '../panel/core/json';
import { idFromName, uniqueIDFrom } from '../panel/core/provider';
import { packageFrom, protocolOfPackage } from '../panel/core/protocols';
import { validateDraft } from '../panel/core/validate';
import { modelCandidates, modelHeaders, parseModelIDs } from '../service/models';

const draft = (overrides: Partial<ProviderDraft> = {}): ProviderDraft => ({
  ...emptyDraft(),
  providerID: 'acme',
  name: 'Acme',
  baseURL: 'https://api.acme.test/v1',
  models: [{ ...emptyModel(), id: 'coder', name: 'Coder' }],
  ...overrides,
});

/* ------------------------------------------------------------------ limits */

test('a provider name becomes a usable ID', () => {
  assert.equal(idFromName('Acme Gateway'), 'acme-gateway');
  assert.equal(idFromName('  Relay.Fast  '), 'relay-fast');
  assert.equal(idFromName('中转站'), '');
  assert.equal(uniqueIDFrom('Relay Fast', []), 'relay-fast');
  assert.equal(uniqueIDFrom('Relay Fast', ['relay-fast']), 'relay-fast-2');
  assert.equal(uniqueIDFrom('Relay Fast', ['relay-fast', 'relay-fast-2']), 'relay-fast-3');
  assert.equal(uniqueIDFrom('中转站', []), 'provider');
});

test('a provider name equal to its ID is not written twice', () => {
  const block = buildProvider(draft({ providerID: 'acme', name: 'acme' }));
  assert.equal(block.name, undefined);
  const named = buildProvider(draft({ providerID: 'acme', name: 'Acme Gateway' }));
  assert.equal(named.name, 'Acme Gateway');
});

test('positiveInt accepts only positive safe whole numbers', () => {
  assert.equal(positiveInt('128000'), 128000);
  for (const value of ['128000abc', '1.5', '0', '-2', '9007199254740992', '']) {
    assert.equal(positiveInt(value), undefined, `${value} should be rejected`);
  }
});

test('blank limits are omitted instead of invented', () => {
  const block = buildProvider(draft());
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal(model.limit, undefined);
});

test('filled limits are written as numbers', () => {
  const block = buildProvider(draft({
    models: [{ ...emptyModel(), id: 'coder', context: '1000', output: '500' }],
  }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.limit, { context: 1000, output: 500 });
});

test('clearing a limit removes only that key', () => {
  const existing = { models: { coder: { modelID: 'coder', limit: { context: 1000, output: 500, input: 900 } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', context: '2000', sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.limit, { context: 2000, input: 900 });
});

/* --------------------------------------------------------------- reasoning */

test('reasoning is written in the V2 shape, not as variants', () => {
  const block = buildProvider(draft({
    models: [{ ...emptyModel(), id: 'coder', levels: ['low', 'high'] }],
  }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: true, effort: ['low', 'high'] });
  // OpenCode derives the variants from `capabilities.reasoning` for the
  // packages this panel offers, so none are written by hand.
  assert.equal(model.variants, undefined);
});

test('variants follow the protocol so the request carries the right field', () => {
  const build = (protocol: ProviderDraft['protocol'], customPackage = ''): Record<string, any> => (
    (buildProvider(draft({
      protocol,
      customPackage,
      models: [{ ...emptyModel(), id: 'coder', levels: ['high'] }],
    })).models as Record<string, any>).coder
  );
  // OpenCode derives these itself from `capabilities.reasoning`; writing them
  // again would only duplicate what the runtime already computes.
  assert.equal(build('openai-chat').variants, undefined);
  assert.equal(build('openai-responses').variants, undefined);
  assert.equal(build('anthropic-messages').variants, undefined);
  // A custom package gets no variants from OpenCode at all, so the panel has
  // to write them or the levels never reach the picker.
  assert.deepEqual(build('custom', 'aisdk:my-gateway').variants, [{ id: 'high', settings: { reasoningEffort: 'high' } }]);
});

test('a known package keeps a hand-written standard level with its own headers', () => {
  const existing = {
    package: 'aisdk:@ai-sdk/openai-compatible',
    models: {
      coder: {
        variants: [
          { id: 'high', settings: { reasoningEffort: 'low' }, headers: { 'X-Keep': '1' } },
          { id: 'vendor', settings: { vendorFlag: true } },
        ],
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models[0]!.levels = ['low', 'high'];
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  // OpenCode builds `low` from `capabilities.reasoning`; the variant with its
  // own headers is the user's and stays, with its overlay refreshed.
  assert.deepEqual(model.variants, [
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
    { id: 'vendor', settings: { vendorFlag: true } },
  ]);
});

test('a custom package keeps a hand-written variant alongside generated ones', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        variants: [
          { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
          { id: 'vendor', settings: { vendorFlag: true } },
        ],
      },
    },
  };
  const current = draftFrom({ id: 'gw', block: existing, file: 'f', overlay: false });
  current.models[0]!.levels = ['low', 'high'];
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
    { id: 'vendor', settings: { vendorFlag: true } },
  ]);
});

test('a package that decides its own levels is not turned off by a save', () => {
  const existing = { models: { coder: { capabilities: { reasoning: { supported: true } } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [], sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: true });
});

test('a renamed model drops a display name that only repeated the old ID', () => {
  const existing = { models: { old: { name: 'old', modelID: 'old' } } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'x', overlay: false });
  current.models[0]!.id = 'new';
  // The form keeps the name it read; it must not survive under the new key.
  assert.equal(current.models[0]!.name, 'old');
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).new!;
  assert.equal(model.name, undefined);
});

test('turning every level off declares reasoning unsupported', () => {
  const existing = { models: { coder: { capabilities: { reasoning: { supported: true, effort: ['low'] } } } } };
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [], sourceID: 'coder' }] }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual((model.capabilities as Record<string, unknown>).reasoning, { supported: false });
});

test('a model that never declared reasoning keeps the key absent when all cards are off', () => {
  const block = buildProvider(draft({ models: [{ ...emptyModel(), id: 'coder', levels: [] }] }));
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal((model.capabilities as Record<string, unknown>).reasoning, undefined);
});

test('previously generated variants are replaced and hand-written ones survive', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        modelID: 'coder',
        variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } },
          { id: 'high', settings: { reasoningEffort: 'high', thinking: { type: 'adaptive' }, effort: 'high' } },
          { id: 'vendor', settings: { reasoningEffort: 'low', vendorFlag: true } },
          { id: 'high-custom', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
        ],
      },
    },
  };
  const block = buildProvider(draft({
    protocol: 'custom',
    customPackage: 'aisdk:my-gateway',
    models: [{ ...emptyModel(), id: 'coder', sourceID: 'coder', levels: ['low'] }],
  }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'low', settings: { reasoningEffort: 'low' } },
    { id: 'vendor', settings: { reasoningEffort: 'low', vendorFlag: true } },
    { id: 'high-custom', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
  ]);
});

test('a hand-written standard level keeps its headers while the overlay is refreshed', () => {
  const existing = {
    package: 'aisdk:my-gateway',
    models: {
      coder: {
        variants: [{ id: 'high', settings: { reasoningEffort: 'low' }, headers: { 'X-Keep': '1' } }],
      },
    },
  };
  const block = buildProvider(draft({
    protocol: 'custom',
    customPackage: 'aisdk:my-gateway',
    models: [{ ...emptyModel(), id: 'coder', sourceID: 'coder', levels: ['high'] }],
  }), existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [
    { id: 'high', settings: { reasoningEffort: 'high' }, headers: { 'X-Keep': '1' } },
  ]);
});

test('editing only the name preserves a hand-written variant untouched', () => {
  const existing = {
    models: {
      coder: {
        modelID: 'coder',
        variants: [{ id: 'deep', settings: { reasoningEffort: 'high', vendorFlag: true } }],
      },
    },
  };
  const current = draftFrom({ id: 'acme', block: existing, file: 'x', overlay: false });
  current.models[0]!.name = 'Renamed';
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.variants, [{ id: 'deep', settings: { reasoningEffort: 'high', vendorFlag: true } }]);
  // A name the form does not edit is carried, but one equal to the ID is not written.
  assert.equal(model.name, 'Renamed');
});

test('reading a model reports the levels its config declares', () => {
  const models = readModels({
    models: {
      a: { capabilities: { reasoning: { supported: true, effort: ['low', 'max'] } } },
      b: { capabilities: { reasoning: { supported: false } } },
      c: {},
    },
  });
  assert.deepEqual(models.map((model) => model.levels), [['low', 'max'], [], []]);
});

/* --------------------------------------------------------------- migration */

test('a V1 provider is read and rewritten in the V2 spelling', () => {
  const legacy = {
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: 'https://old.test/v1',
      apiKey: 'sk-old',
      headers: { 'X-Team': 'platform' },
      body: { service_tier: 'flex' },
    },
    models: {
      coder: {
        id: 'upstream-id',
        name: 'Coder',
        tool_call: true,
        attachment: false,
        limit: { context: 1000, output: 100 },
        variants: { high: { reasoningEffort: 'high' } },
      },
    },
  };
  const current = draftFrom({ id: 'legacy', block: legacy, file: 'a.json', overlay: false });
  assert.equal(current.baseURL, 'https://old.test/v1');
  assert.equal(current.apiKey, 'sk-old');
  assert.equal(current.models[0]!.modelID, 'upstream-id');
  assert.deepEqual(current.models[0]!.levels, ['high']);
  assert.equal(current.models[0]!.image, false);

  const block = buildProvider(current, legacy);
  assert.equal(block.npm, undefined);
  assert.equal(block.options, undefined);
  assert.equal(block.package, 'aisdk:@ai-sdk/openai-compatible');
  assert.deepEqual(block.headers, { 'X-Team': 'platform' });
  assert.deepEqual(block.body, { service_tier: 'flex' });
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.equal(model.modelID, 'upstream-id');
  assert.deepEqual(model.capabilities, { tools: true, input: ['text'], output: ['text'], reasoning: { supported: true, effort: ['high'] } });
});

/* ---------------------------------------------------------------- packages */

test('packages map to protocols without confusing the responses variant', () => {
  assert.equal(protocolOfPackage('aisdk:@ai-sdk/openai-compatible'), 'openai-chat');
  assert.equal(protocolOfPackage('@opencode/ai/providers/openai-compatible'), 'openai-chat');
  assert.equal(protocolOfPackage('@opencode/ai/providers/openai-compatible/responses'), 'openai-responses');
  assert.equal(protocolOfPackage('aisdk:@ai-sdk/anthropic'), 'anthropic-messages');
  assert.equal(protocolOfPackage('@opencode/ai/providers/anthropic-compatible'), 'anthropic-messages');
  assert.equal(protocolOfPackage('aisdk:my-custom-provider'), 'custom');
  assert.equal(protocolOfPackage(''), 'openai-chat');
});

test('an unknown package survives a save instead of being replaced', () => {
  const existing = { package: 'aisdk:my-gateway-provider', settings: { baseURL: 'https://x.test' } };
  const current = draftFrom({ id: 'gw', block: existing, file: 'a', overlay: false });
  assert.equal(current.protocol, 'custom');
  assert.equal(current.customPackage, 'aisdk:my-gateway-provider');
  const block = buildProvider(current, existing);
  assert.equal(block.package, 'aisdk:my-gateway-provider');
});

test('switching protocol changes the package', () => {
  const existing = { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://x.test' } };
  const current = draftFrom({ id: 'gw', block: existing, file: 'a', overlay: false });
  current.protocol = 'anthropic-messages';
  const block = buildProvider(current, existing);
  assert.equal(block.package, 'aisdk:@ai-sdk/anthropic');
});

test('packageFrom reads the V1 spellings', () => {
  assert.equal(packageFrom({ npm: '@ai-sdk/openai' }), 'aisdk:@ai-sdk/openai');
  assert.equal(packageFrom({ api: { npm: '@ai-sdk/anthropic' } }), 'aisdk:@ai-sdk/anthropic');
  assert.equal(packageFrom({ package: 'aisdk:x' }), 'aisdk:x');
  assert.equal(packageFrom({}), '');
});

/* --------------------------------------------------------------- providers */

test('collecting providers keeps the V2 block over the V1 twin', () => {
  const entries = collectProviders({
    provider: { acme: { name: 'old' } },
    providers: { acme: { name: 'new', package: 'aisdk:x' } },
  }, 'file.jsonc');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.block.name, 'new');
});

test('a provider without a package is flagged as an overlay', () => {
  const entries = collectProviders({ providers: { anthropic: { settings: { baseURL: 'https://proxy' } } } }, 'f');
  assert.equal(entries[0]!.overlay, true);
});

test('saving keeps headers, body and models the panel does not manage', () => {
  const existing = {
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'https://x.test/v1', apiKey: 'sk-1', timeout: 60000 },
    headers: { 'X-Team': 'platform' },
    body: { metadata: { app: 'opencode' } },
    models: {
      coder: {
        modelID: 'coder',
        cost: { input: 1, output: 2 },
        headers: { 'X-Model': '1' },
        capabilities: { tools: true, input: ['text', 'image', 'pdf'], output: ['text'], temperature: false },
      },
      other: { modelID: 'other', name: 'Other' },
    },
  };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  const block = buildProvider(current, existing);
  assert.deepEqual(block.headers, { 'X-Team': 'platform' });
  assert.deepEqual(block.body, { metadata: { app: 'opencode' } });
  assert.equal((block.settings as Record<string, unknown>).timeout, 60000);
  const model = (block.models as Record<string, Record<string, unknown>>).coder!;
  assert.deepEqual(model.cost, { input: 1, output: 2 });
  assert.deepEqual(model.headers, { 'X-Model': '1' });
  assert.deepEqual((model.capabilities as Record<string, unknown>).input, ['text', 'image', 'pdf']);
  assert.deepEqual((model.capabilities as Record<string, unknown>).output, ['text']);
  assert.equal((model.capabilities as Record<string, unknown>).temperature, false);
  assert.ok((block.models as Record<string, unknown>).other);
});

test('an emptied API key is removed while other settings stay', () => {
  const existing = { package: 'aisdk:x', settings: { baseURL: 'https://x.test', apiKey: 'sk-1', timeout: 5 } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  current.apiKey = '';
  const block = buildProvider(current, existing);
  assert.deepEqual(block.settings, { baseURL: 'https://x.test', timeout: 5 });
});

test('a renamed model keeps the fields of its previous row', () => {
  const existing = { models: { coder: { modelID: 'coder', cost: { input: 1, output: 2 }, limit: { context: 10, output: 5 } } } };
  const current = draftFrom({ id: 'acme', block: existing, file: 'a', overlay: false });
  current.models[0]!.id = 'renamed';
  const block = buildProvider(current, existing);
  const model = (block.models as Record<string, Record<string, unknown>>).renamed!;
  assert.deepEqual(model.cost, { input: 1, output: 2 });
  assert.deepEqual(model.limit, { context: 10, output: 5 });
  assert.equal((block.models as Record<string, unknown>).coder, undefined);
});

/* -------------------------------------------------------------------- jsonc */

const messy = `{
  // Providers live here.
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "acme": {
      "name": "Acme", // kept
      "package": "aisdk:@ai-sdk/openai-compatible",
      "settings": { "baseURL": "https://a.test/v1" },
    },
  },
  "model": "acme/coder",
  /* tail */
}
`;

test('writing a provider keeps comments, order and trailing commas', () => {
  const next = writeProvider(messy, 'acme', {
    name: 'Acme Renamed',
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'https://b.test/v1' },
    models: { coder: { modelID: 'coder' } },
  });
  assert.ok(next.includes('// Providers live here.'));
  assert.ok(next.includes('/* tail */'));
  assert.ok(next.includes('"model": "acme/coder"'));
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.providers.acme.name, 'Acme Renamed');
  assert.equal(parsed.providers.acme.settings.baseURL, 'https://b.test/v1');
  assert.equal(parsed.providers.acme.models.coder.modelID, 'coder');
});

test('a new provider joins the existing block without disturbing it', () => {
  const next = writeProvider(messy, 'zeta', { name: 'Zeta', package: 'aisdk:x', settings: {}, models: {} });
  const parsed = parse(next) as Record<string, any>;
  assert.ok(parsed.providers.acme);
  assert.equal(parsed.providers.zeta.name, 'Zeta');
  assert.ok(next.includes('// kept'));
});

test('a fresh file gets a schema and the provider', () => {
  const next = writeProvider(null, 'first', { name: 'First', package: 'aisdk:x', settings: {}, models: {} });
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.equal(parsed.providers.first.name, 'First');
});

test('CRLF and BOM files stay that way', () => {
  const crlf = '\uFEFF{\r\n  "providers": {\r\n    "a": { "name": "A" }\r\n  }\r\n}\r\n';
  const next = writeProvider(crlf, 'b', { name: 'B' });
  assert.ok(next.startsWith('\uFEFF'));
  assert.ok(next.includes('\r\n'));
  assert.equal(next.includes('\n\n'), false);
  const parsed = parse(next.charCodeAt(0) === 0xfeff ? next.slice(1) : next) as Record<string, any>;
  assert.equal(parsed.providers.b.name, 'B');
});

test('writing a provider removes a V1 twin', () => {
  const text = '{\n  "provider": { "acme": { "name": "old" } }\n}\n';
  const next = writeProvider(text, 'acme', { name: 'new', package: 'aisdk:x' });
  const parsed = parse(next) as Record<string, any>;
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.providers.acme.name, 'new');
});

test('removing a provider cleans both spellings', () => {
  const text = '{\n  "provider": { "acme": { "name": "a" } },\n  "providers": { "acme": { "name": "a" }, "keep": { "name": "k" } }\n}\n';
  const next = removeProvider(text, 'acme');
  assert.ok(next);
  const parsed = parse(next!) as Record<string, any>;
  assert.equal(parsed.providers.acme, undefined);
  assert.equal(parsed.provider, undefined);
  assert.equal(parsed.providers.keep.name, 'k');
});

test('removing an absent provider reports no change', () => {
  assert.equal(removeProvider('{ "providers": { "a": {} } }', 'b'), null);
});

/* ----------------------------------------------------------------- snapshot */

const hostWith = (files: Record<string, string>): FileHost => ({
  stat: async (path) => ({ kind: path in files ? 'file' : 'missing' }),
  readFile: async (path) => ({ content: files[path]! }),
  writeFile: async () => ({ written: true }),
});

test('both config files are read, jsonc winning on a shared ID', async () => {
  const host = hostWith({
    '~/.config/opencode/opencode.json': '{ "providers": { "a": { "name": "from-json" }, "b": { "name": "b" } } }',
    '~/.config/opencode/opencode.jsonc': '{ "providers": { "a": { "name": "from-jsonc" } } }',
  });
  const snapshot = await readSnapshot(host);
  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(snapshot.providers.map((entry) => entry.id), ['a', 'b']);
  assert.equal(snapshot.providers[0]!.block.name, 'from-jsonc');
  assert.equal(snapshot.providers[0]!.file, '~/.config/opencode/opencode.jsonc');
  assert.equal(snapshot.target, '~/.config/opencode/opencode.jsonc');
});

test('a missing config reads as empty and targets a new jsonc file', async () => {
  const snapshot = await readSnapshot(hostWith({}));
  assert.deepEqual(snapshot.providers, []);
  assert.deepEqual(snapshot.files, []);
  assert.equal(snapshot.target, '~/.config/opencode/opencode.jsonc');
});

test('a broken config file names its position', async () => {
  const host = hostWith({ '~/.config/opencode/opencode.json': '{\n  "providers": {\n' });
  await assert.rejects(() => readSnapshot(host), /opencode\.json: .+ at line \d+, column \d+/);
});

/* --------------------------------------------------------------- validation */

test('validation catches the mistakes the form can make', () => {
  const base = { existingIDs: ['taken'], editingID: null };
  assert.deepEqual(validateDraft(draft(), base), {});
  assert.equal(validateDraft(draft({ providerID: 'Bad ID' }), base).providerID, 'errorID');
  assert.equal(validateDraft(draft({ providerID: 'taken' }), base).providerID, 'errorIDTaken');
  assert.equal(validateDraft(draft({ providerID: 'taken' }), { ...base, editingID: 'taken' }).providerID, undefined);
  assert.equal(validateDraft(draft({ name: ' ' }), base).name, 'errorName');
  assert.equal(validateDraft(draft({ baseURL: 'ftp://x' }), base).baseURL, 'errorBaseURL');
  assert.equal(validateDraft(draft({ models: [] }), base).models, 'errorModels');
  assert.equal(validateDraft(draft({ models: [{ ...emptyModel(), id: 'a' }, { ...emptyModel(), id: 'a' }] }), base).models, 'errorModelsDuplicate');
  assert.equal(validateDraft(draft({ models: [{ ...emptyModel(), context: '1.5' }] }), base).models, 'errorLimits');
});

test('env and file key references are accepted', () => {
  const base = { existingIDs: [], editingID: null };
  assert.deepEqual(validateDraft(draft({ apiKey: '{env:ACME_KEY}' }), base), {});
  assert.deepEqual(validateDraft(draft({ apiKey: '{file:~/.secrets/acme}' }), base), {});
  assert.equal(validateDraft(draft({ apiKey: 'short' }), base).apiKey, 'errorAPIKey');
});

/* --------------------------------------------------------------- model fetch */

test('a new model starts with every reasoning level off', () => {
  assert.deepEqual(emptyModel().levels, []);
});

test('model list URLs cover a bare origin and a /v1 base', () => {
  assert.deepEqual(modelCandidates('https://relay.fast/v1'), ['https://relay.fast/v1/models']);
  assert.deepEqual(modelCandidates('https://relay.fast/'), ['https://relay.fast/models', 'https://relay.fast/v1/models']);
  assert.deepEqual(modelCandidates('ftp://relay.fast'), []);
});

test('model list headers follow the protocol', () => {
  assert.equal(modelHeaders('openai-chat', 'sk-1').authorization, 'Bearer sk-1');
  assert.equal(modelHeaders('anthropic-messages', 'sk-1')['x-api-key'], 'sk-1');
  assert.equal(modelHeaders('anthropic-messages', 'sk-1')['anthropic-version'], '2023-06-01');
});

test('model IDs are read from the shapes gateways return', () => {
  assert.deepEqual(parseModelIDs({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelIDs({ models: ['c', { model: 'd' }] }), ['c', 'd']);
  assert.deepEqual(parseModelIDs(['e', { name: 'f' }]), ['e', 'f']);
  assert.deepEqual(parseModelIDs({ data: [] }), []);
});

