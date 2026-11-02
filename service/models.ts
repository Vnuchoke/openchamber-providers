/**
 * Pure helpers for the model-list request. No Node imports, so the core tests
 * can exercise them without starting the service.
 */

/** URL candidates for a provider's model list, in the order to try them. */
export const modelCandidates = (baseURL: string): string[] => {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return [];
  const paths = [`${base}/models`];
  // A bare origin often exposes the OpenAI-compatible list under /v1, while a
  // base URL that already names /v1 must not double it.
  if (!/\/v1$/i.test(base)) paths.push(`${base}/v1/models`);
  return [...new Set(paths)];
};

/** Headers a provider's model endpoint expects, keyed by its protocol. */
export const modelHeaders = (protocol: string, apiKey: string): Record<string, string> => {
  if (protocol === 'anthropic-messages') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    };
  }
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };
};

const idOf = (item: unknown): string => {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/** Model IDs from the shapes OpenAI, Anthropic and compatible gateways return. */
export const parseModelIDs = (payload: unknown): string[] => {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
  const ids: string[] = [];
  for (const item of list) {
    const id = idOf(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};
