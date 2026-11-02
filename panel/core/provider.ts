/**
 * Provider drafts ↔ `providers` entries in opencode.json.
 *
 * Pure data code: no DOM, no host, no file system. `buildProvider` merges the
 * form with the block already on disk so fields this panel does not manage —
 * request headers, body overlays, cost, disabled models, custom variants —
 * survive a save. `draftFrom` reads both the V2 spelling (`package`,
 * `settings`, `modelID`, array `variants`) and the V1 one (`npm`, `options`,
 * `variants` record).
 */
import {
  isObject,
  positiveInt,
  stringList,
  stringOf,
  withoutUndefined,
  type Json,
  type JsonObject,
} from './json';
import {
  DEFAULT_PROTOCOL,
  packageFrom,
  packageOfProtocol,
  protocolOfPackage,
  type ProtocolId,
} from './protocols';

/** Reasoning levels offered as cards, in display order. */
export const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Levels written for a new model: none, until the user picks them. */
export const DEFAULT_REASONING_LEVELS: string[] = [];

export type ModelDraft = {
  /** Stable key for this row, independent of the model ID. */
  key: string;
  /** Catalog ID: the key under `providers.<id>.models`. */
  id: string;
  /** Upstream ID sent to the endpoint. Empty means "same as `id`". */
  modelID: string;
  /** Model ID the row was read from, used to carry preserved fields across a rename. */
  sourceID?: string;
  name: string;
  context: string;
  output: string;
  levels: string[];
  image: boolean;
  tools: boolean;
};

export type ProviderDraft = {
  providerID: string;
  /** Display name; on a new provider it also suggests the ID. */
  name: string;
  protocol: ProtocolId;
  /** Only used when `protocol` is `custom`. */
  customPackage: string;
  baseURL: string;
  apiKey: string;
  models: ModelDraft[];
};

export type ProviderEntry = {
  id: string;
  block: JsonObject;
  /** Which config file the block came from. */
  file: string;
  /** A provider with no package only overrides defaults of a built-in one. */
  overlay: boolean;
};

let modelKeySeq = 0;
const nextKey = (): string => `m${(modelKeySeq += 1)}`;

/**
 * The provider ID a name suggests: lowercase latin letters, digits and
 * dashes. Names without latin characters yield nothing, which is why the
 * panel still offers the ID field for them.
 */
export const idFromName = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return /^[a-z0-9][a-z0-9-_]*$/.test(slug) ? slug : '';
};

/**
 * An ID for a provider name that is not taken yet: the name in slug form, a
 * numeric suffix when that is taken, and `provider` when the name has no
 * latin characters to build from.
 */
export const uniqueIDFrom = (name: string, taken: readonly string[]): string => {
  const base = idFromName(name) || 'provider';
  if (!taken.includes(base)) return base;
  let suffix = 2;
  while (taken.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

export const emptyModel = (): ModelDraft => ({
  key: nextKey(),
  id: '',
  modelID: '',
  name: '',
  context: '',
  output: '',
  levels: [...DEFAULT_REASONING_LEVELS],
  image: true,
  tools: true,
});

export const emptyDraft = (): ProviderDraft => ({
  providerID: '',
  name: '',  protocol: DEFAULT_PROTOCOL,
  customPackage: '',
  baseURL: '',
  apiKey: '',
  models: [emptyModel()],
});

export const settingsOf = (provider: JsonObject): JsonObject => {
  if (isObject(provider.settings)) return provider.settings;
  if (isObject(provider.options)) return provider.options;
  return {};
};

const headersOf = (provider: JsonObject): JsonObject | undefined => {
  if (isObject(provider.headers)) return provider.headers;
  const options = isObject(provider.options) ? provider.options : undefined;
  return options && isObject(options.headers) ? options.headers : undefined;
};

const bodyOf = (provider: JsonObject): JsonObject | undefined => {
  if (isObject(provider.body)) return provider.body;
  const options = isObject(provider.options) ? provider.options : undefined;
  return options && isObject(options.body) ? options.body : undefined;
};

/**
 * Names of the keys OpenCode's variant overlays carry. A V1 record flattened
 * them next to `id` instead of under `settings`, so they are not "extra".
 */
const LEGACY_OVERLAY_KEYS = new Set(['reasoningEffort', 'reasoningSummary', 'include', 'thinking', 'effort']);

type VariantParts = { id: string; overlay: JsonObject };

/** Variants from the V2 array or the V1 record spelling. */
const variantsOf = (model: JsonObject): VariantParts[] => {
  const source = model.variants;
  if (Array.isArray(source)) {
    return source.flatMap((item) => (
      isObject(item) && typeof item.id === 'string' && item.id.trim()
        ? [{ id: item.id, overlay: item as JsonObject }]
        : []
    ));
  }
  if (isObject(source)) {
    return Object.entries(source).flatMap(([id, value]) => (
      isObject(value) && value.disabled !== true ? [{ id, overlay: value }] : []
    ));
  }
  return [];
};

/** Levels the config declares, as shown on the cards. */
const levelsOf = (model: JsonObject): string[] => {
  const capabilities = isObject(model.capabilities) ? model.capabilities : undefined;
  const reasoning = capabilities && isObject(capabilities.reasoning) ? capabilities.reasoning : undefined;
  if (reasoning) {
    if (reasoning.supported === false) return [];
    if (Array.isArray(reasoning.effort)) return stringList(reasoning.effort);
    // Supported without `effort`: the package decides the variants, so there
    // is no level list to edit. The cards start off rather than guessing.
    if (reasoning.supported === true) return [];
  }
  // Old entries carry their levels as variants instead.
  const ids = variantsOf(model)
    .map((variant) => variant.id)
    .filter((id) => (REASONING_LEVELS as readonly string[]).includes(id));
  return [...new Set(ids)];
};

const imageInputOf = (model: JsonObject): boolean => {
  const capabilities = isObject(model.capabilities) ? model.capabilities : undefined;
  if (capabilities && Array.isArray(capabilities.input)) {
    return stringList(capabilities.input).includes('image');
  }
  if (typeof model.attachment === 'boolean') return model.attachment;
  return true;
};

const toolCallOf = (model: JsonObject): boolean => {
  const capabilities = isObject(model.capabilities) ? model.capabilities : undefined;
  if (capabilities && typeof capabilities.tools === 'boolean') return capabilities.tools;
  if (typeof model.tool_call === 'boolean') return model.tool_call;
  return true;
};

export const readModels = (provider: JsonObject): ModelDraft[] => {
  const models = provider.models;
  const pairs: Array<[string, Json]> = Array.isArray(models)
    ? models.map((item, index) => {
      const entry = isObject(item) ? item : {};
      const id = stringOf(entry.modelID) || stringOf(entry.id) || String(index);
      return [id, item];
    })
    : isObject(models)
      ? Object.entries(models)
      : [];

  const drafts = pairs.map(([key, value]) => {
    const entry = isObject(value) ? value : {};
    const id = key;
    const upstream = stringOf(entry.modelID) || stringOf(entry.id);
    const limit = isObject(entry.limit) ? entry.limit : {};
    const levels = levelsOf(entry);
    const context = typeof limit.context === 'number' ? String(limit.context) : '';
    const output = typeof limit.output === 'number' ? String(limit.output) : '';
    return {
      key: nextKey(),
      id,
      modelID: upstream && upstream !== id ? upstream : '',
      sourceID: id,
      // Only an explicit name; one that repeats the ID is not repeated here.
      name: stringOf(entry.name),
      context,
      output,
      // The config is the source of truth: a model with no reasoning record
      // shows every card off, so saving does not invent reasoning for it.
      levels,
      image: imageInputOf(entry),
      tools: toolCallOf(entry),
    };
  });

  return drafts.length > 0 ? drafts : [emptyModel()];
};

export const draftFrom = (entry: ProviderEntry): ProviderDraft => {
  const provider = entry.block;
  const settings = settingsOf(provider);
  const pkg = packageFrom(provider);
  const protocol = protocolOfPackage(pkg);
  return {
    providerID: entry.id,
    name: stringOf(provider.name) || entry.id,
    protocol,
    customPackage: protocol === 'custom' ? pkg : '',
    baseURL: stringOf(settings.baseURL),
    apiKey: stringOf(settings.apiKey),
    models: readModels(provider),
  };
};

/** Capabilities block for a model, preserving modalities the form does not edit. */
const capabilitiesFor = (previous: JsonObject, model: ModelDraft): JsonObject => {
  const carried = isObject(previous.capabilities) ? previous.capabilities : {};
  const extraInput = stringList(carried.input).filter((media) => media !== 'text' && media !== 'image');
  const output = stringList(carried.output);
  const reasoning = reasoningFor(carried, model.levels);
  const next: JsonObject = {
    ...carried,
    tools: model.tools,
    input: ['text', ...(model.image ? ['image'] : []), ...extraInput],
    output: output.length > 0 ? output : ['text'],
  };
  if (reasoning === undefined) delete next.reasoning;
  else next.reasoning = reasoning;
  return next;
};

/**
 * `capabilities.reasoning` in OpenCode's V2 shape. OpenCode builds the
 * protocol-correct variants from it, so switching protocols cannot leave a
 * stale `thinking` / `reasoningEffort` behind.
 *
 * A previous `reasoning: { supported: true }` that names no levels is left as
 * it is when every card is off: OpenCode takes the levels from the runtime
 * package there, and a save must not silently declare reasoning unsupported.
 * Picking a card replaces it with an explicit `effort` list.
 */
const reasoningFor = (capabilities: JsonObject, levels: readonly string[]): JsonObject | undefined => {
  const previous = isObject(capabilities.reasoning) ? capabilities.reasoning : undefined;
  const unique = [...new Set(levels.map((level) => level.trim()).filter(Boolean))];
  if (unique.length === 0) {
    if (previous?.supported === true && !Array.isArray(previous.effort)) return { supported: true };
    // Nothing to reason with. Keep the explicit "off" only when the previous
    // block declared reasoning; otherwise leave the key absent.
    return previous === undefined ? undefined : { supported: false };
  }
  return {
    // `toggle` and `budget` are hand-written extras the form does not edit.
    ...(previous && previous.toggle !== undefined ? { toggle: previous.toggle } : {}),
    supported: true,
    effort: unique,
    ...(previous && previous.budget !== undefined ? { budget: previous.budget } : {}),
  };
};

/**
 * Settings OpenCode 2 derives for one level of a package. Kept in step with
 * the runtime: `@ai-sdk/anthropic` takes `thinking`/`effort`,
 * `@ai-sdk/openai` takes `reasoningEffort` with a summary, and everything
 * else (including custom packages, which OpenCode cannot map) takes
 * `reasoningEffort`.
 */
export const variantSettingsFor = (pkg: string, level: string): JsonObject => {
  const protocol = protocolOfPackage(pkg);
  if (protocol === 'anthropic-messages') {
    return { thinking: { type: 'adaptive', display: 'summarized' }, effort: level };
  }
  if (protocol === 'openai-responses') {
    return { reasoningEffort: level, reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] };
  }
  return { reasoningEffort: level };
};

/**
 * Variants for the selected levels.
 *
 * OpenCode derives variants from `capabilities.reasoning` by itself, but only
 * for the runtime packages it knows: for a custom `aisdk:` package it derives
 * none, and the levels then never reach the picker or the request. Those
 * packages get their levels written out as variants too; known packages keep
 * relying on `capabilities.reasoning`, so the file stays as small as before.
 *
 * A generated standard level carries any extra keys (headers, body) the
 * previous variant of that id had. A variant with another id is hand-written
 * and always survives; a standard level with extra keys survives for a known
 * package too, since OpenCode merges named variants over the ones it derives.
 */
const variantsFor = (previous: JsonObject, pkg: string, levels: readonly string[]): JsonObject[] => {
  const standard = new Set<string>(REASONING_LEVELS);
  const selected = [...new Set(levels.map((level) => level.trim()).filter(Boolean))];
  const extrasOf = (id: string): JsonObject => {
    const found = variantsOf(previous).find((variant) => variant.id === id);
    if (!found) return {};
    // A V1 record kept the overlay inline rather than under `settings`; only
    // keys with no V2 meaning (headers, body) count as extras either way.
    const rest: JsonObject = {};
    for (const [key, value] of Object.entries(found.overlay)) {
      if (key !== 'id' && key !== 'settings' && !LEGACY_OVERLAY_KEYS.has(key)) rest[key] = value;
    }
    return rest;
  };
  const byHand = protocolOfPackage(pkg) === 'custom';
  const generated = selected.flatMap((level) => {
    const extras = extrasOf(level);
    // A known package needs no overlay, but a variant with its own headers or
    // body is the user's and stays.
    if (!byHand && Object.keys(extras).length === 0) return [];
    return [{ ...extras, id: level, settings: variantSettingsFor(pkg, level) }];
  });
  const taken = new Set(generated.map((variant) => String(variant.id)));
  const handWritten = variantsOf(previous)
    .filter((variant) => !standard.has(variant.id) && !taken.has(variant.id))
    .map((variant) => ({ ...variant.overlay, id: variant.id }));
  return [...generated, ...handWritten];
};

const limitFor = (previous: JsonObject, model: ModelDraft): JsonObject | undefined => {
  const kept = isObject(previous.limit) ? { ...previous.limit } : {};
  const context = positiveInt(model.context);
  const output = positiveInt(model.output);
  if (context === undefined) delete kept.context;
  else kept.context = context;
  if (output === undefined) delete kept.output;
  else kept.output = output;
  return Object.keys(kept).length > 0 ? kept : undefined;
};

const modelFor = (model: ModelDraft, previous: JsonObject, pkg: string): JsonObject => {
  const id = model.id.trim();
  const upstream = model.modelID.trim() || id;
  // V1 spellings of what we write below.
  const carried: JsonObject = { ...previous };
  delete carried.id;
  delete carried.provider;
  delete carried.attachment;
  delete carried.tool_call;

  const entry: JsonObject = { ...carried };

  // The form edits neither the display name nor the upstream alias, so both
  // come from the block on disk. OpenCode falls back to the catalog ID for
  // each, so a value that only repeats the ID is not written at all. A name
  // that only repeated the *previous* ID is dropped on a rename too, or the
  // picker would keep showing the old model name.
  const name = model.name.trim();
  const repeating = name === id || (model.sourceID !== undefined && name === model.sourceID);
  if (name && !repeating) entry.name = name;
  else delete entry.name;

  if (upstream && upstream !== id) entry.modelID = upstream;
  else delete entry.modelID;

  const limit = limitFor(previous, model);
  if (limit) entry.limit = limit;
  else delete entry.limit;

  entry.capabilities = capabilitiesFor(previous, model);

  // Levels are written twice on purpose: `capabilities.reasoning` is what
  // OpenCode reads to list the levels, and the variants carry the per-protocol
  // settings for the packages it cannot map. Hand-written variants survive.
  const variants = variantsFor(previous, pkg, model.levels);
  if (variants.length > 0) entry.variants = variants;
  else delete entry.variants;

  return entry;
};

export const buildProvider = (draft: ProviderDraft, existing?: JsonObject): JsonObject => {
  const previous = existing ?? {};
  const previousModels = isObject(previous.models) ? previous.models : {};

  const pkg = draft.protocol === 'custom'
    ? draft.customPackage.trim() || packageOfProtocol(DEFAULT_PROTOCOL)
    : packageOfProtocol(draft.protocol);

  const models: JsonObject = {};
  for (const model of draft.models) {
    const id = model.id.trim();
    if (!id) continue;
    const candidate = model.sourceID ? previousModels[model.sourceID] : previousModels[id];
    const fallback = previousModels[id];
    const source = isObject(candidate) ? candidate : isObject(fallback) ? fallback : undefined;
    models[id] = modelFor(model, source ? { ...source } : {}, pkg);
  }

  const settings: JsonObject = {
    ...settingsOf(previous),
    baseURL: draft.baseURL.trim(),
  };
  const apiKey = draft.apiKey.trim();
  if (apiKey) settings.apiKey = apiKey;
  else delete settings.apiKey;

  // `npm`, `options` and `api` are the V1 spellings of `package`, `settings`
  // and the header/body overlays. Writing one spelling keeps the file clean.
  const carried: JsonObject = { ...previous };
  delete carried.npm;
  delete carried.options;
  delete carried.api;
  delete carried.id;

  const headers = headersOf(previous);
  const body = bodyOf(previous);

  const name = draft.name.trim() || draft.providerID.trim();
  const id = draft.providerID.trim();

  return withoutUndefined({
    ...carried,
    // OpenCode shows the provider ID when there is no name, so one that only
    // repeats the ID is not written.
    name: name && name !== id ? name : undefined,
    package: pkg,
    settings,
    ...(headers ? { headers } : {}),
    ...(body ? { body } : {}),
    models,
  });
};

/**
 * Every provider block in one config file, in file order. `file` records where
 * it came from so a save writes back to the same place.
 */
export const collectProviders = (config: JsonObject, file: string): ProviderEntry[] => {
  const found = new Map<string, JsonObject>();
  // Read the deprecated `provider` block first so `providers` (V2) wins.
  for (const key of ['provider', 'providers'] as const) {
    const block = config[key];
    if (!isObject(block)) continue;
    for (const [id, value] of Object.entries(block)) {
      if (isObject(value)) found.set(id, value);
    }
  }
  return [...found.entries()].map(([id, block]) => ({
    id,
    block,
    file,
    overlay: packageFrom(block) === '',
  }));
};

export const protocolLabelKey = (protocol: ProtocolId): string => `protocol.${protocol}`;
