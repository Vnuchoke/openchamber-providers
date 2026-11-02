/**
 * Which runtime package a provider talks through.
 *
 * OpenCode V2 stores that as `package`, either a native
 * `@opencode/ai/providers/...` entrypoint or an AI SDK package prefixed with
 * `aisdk:`. The panel offers the three protocols a custom endpoint usually
 * speaks. An existing provider with any other package keeps that package and
 * is shown as a custom package, but the form no longer offers creating one.
 */

export type ProtocolId = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'custom';

export type Protocol = {
  id: ProtocolId;
  /** Package written when this protocol is picked. */
  package: string;
};

export const PROTOCOLS: readonly Protocol[] = [
  { id: 'openai-chat', package: 'aisdk:@ai-sdk/openai-compatible' },
  { id: 'openai-responses', package: 'aisdk:@ai-sdk/openai' },
  { id: 'anthropic-messages', package: 'aisdk:@ai-sdk/anthropic' },
];

export const DEFAULT_PROTOCOL: ProtocolId = 'openai-chat';

export const packageOfProtocol = (id: ProtocolId): string => (
  PROTOCOLS.find((protocol) => protocol.id === id)?.package ?? ''
);

/** Reads `package` and the V1 `npm` / `api.npm` spellings. */
export const packageFrom = (provider: Record<string, unknown>): string => {
  const bare = (value: string): string => (value.startsWith('aisdk:') ? value : `aisdk:${value}`);
  const pkg = provider.package;
  if (typeof pkg === 'string' && pkg.trim()) return pkg.trim();
  const npm = provider.npm;
  if (typeof npm === 'string' && npm.trim()) return bare(npm.trim());
  const api = provider.api;
  if (api && typeof api === 'object' && !Array.isArray(api)) {
    const inner = (api as Record<string, unknown>).npm;
    if (typeof inner === 'string' && inner.trim()) return bare(inner.trim());
  }
  return '';
};

/**
 * Protocol for a package string. Unknown packages are `custom`, so the form
 * keeps the package on disk instead of pretending it is OpenAI Chat.
 */
export const protocolOfPackage = (pkg: string): ProtocolId => {
  const name = pkg.trim().toLowerCase().replace(/^aisdk:/, '');
  if (!name) return DEFAULT_PROTOCOL;
  if (name.includes('anthropic')) return 'anthropic-messages';
  if (name.includes('/responses') || name.endsWith('-responses')) return 'openai-responses';
  const known = PROTOCOLS.some((protocol) => protocol.package === `aisdk:${name}`);
  if (known) {
    const protocol = PROTOCOLS.find((item) => item.package === `aisdk:${name}`);
    if (protocol) return protocol.id;
  }
  if (name.includes('openai-compatible')) return 'openai-chat';
  if (name.includes('/chat')) return 'openai-chat';
  if (name.includes('openai')) return 'openai-responses';
  return 'custom';
};

/** `aisdk:@ai-sdk/openai-compatible` → `@ai-sdk/openai-compatible`, for display. */
export const packageLabel = (pkg: string): string => pkg.replace(/^aisdk:/, '');
