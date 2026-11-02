# OpenChamber Providers

> A focused provider manager for OpenCode, built as an OpenChamber extension.

[![OpenChamber](https://img.shields.io/badge/OpenChamber-extension-66800b)](https://openchamber.dev)
[![OpenCode](https://img.shields.io/badge/OpenCode-provider%20manager-555)](https://opencode.ai)
[![License](https://img.shields.io/github/license/leoporoluo/openchamber-providers)](LICENSE)

An [OpenChamber](https://openchamber.dev) extension that manages custom OpenAI-compatible
providers for OpenCode from a panel on the right-hand rail, or as a full-screen page.

It writes the `providers` block of `~/.config/opencode/opencode.jsonc` (or `opencode.json`)
directly, so OpenCode reloads it on its own and the provider appears in
**Settings → Providers** — with its models, context length, capabilities and reasoning
levels. Everything else in the file stays as it was: comments, formatting, key order and
unrelated settings are preserved byte for byte.

## Features

- Add, edit and delete custom providers (third-party gateways, self-hosted runtimes)
- Provider ID, display name, API protocol, base URL and API key
- Models with decimal context and output limits, upstream model ID, image input and tool calling
- **Fetch** a provider's model list and pick the model ID from a dropdown, instead of typing it
- Reasoning levels as clickable cards, written as OpenCode's own `capabilities.reasoning`;
  a custom package also gets the matching `variants`, since OpenCode derives none for it
- Reads both `opencode.json` and `opencode.jsonc`; edits write back to the file they came from
- Saving merges with the block on disk, so headers, request bodies, pricing, disabled
  models and hand-written variants survive
- Reads and rewrites the legacy V1 spelling (`npm` / `options` / `variants` record) into V2
- Panel follows the OpenChamber theme and layout: two columns on a page, drill-down on the rail
- Saving and editing make no network calls; **Fetch** uses a small local service you approve

## Install

In OpenChamber: **Settings → Extensions → Folder, ZIP or URL**, paste:

```
https://github.com/leoporoluo/openchamber-providers.git
```

then choose **Add** and approve the filesystem permission (it may read and write
`~/.config/opencode/opencode.json` and `opencode.jsonc`). Approve the local service too if
you want to use **Fetch**; the rest of the panel works without it.

Install from a local clone instead:

```bash
git clone https://github.com/leoporoluo/openchamber-providers.git
```

and paste the absolute path of the cloned folder into the same field.

## Usage

1. Open the panel on the rail, or **Extension pages → OpenChamber Providers** for full screen.
2. Choose **Add provider**.
3. Fill in the provider ID (e.g. `acme`), display name, API protocol, base URL and API key.
4. Add at least one model: ID, context length, max output, reasoning levels, and whether it
   accepts images and calls tools.
   Context length and max output may be left blank: no `limit` is written and OpenCode
   applies its own defaults, rather than baking in numbers that may be wrong.
5. With the base URL and API key filled in, choose **Fetch** next to a model to load the
   provider's model list, then pick the model ID from the dropdown. **Custom ID…** switches
   back to free text.
6. Choose **Save**. The block is written and the provider appears under
   **Settings → Providers**.

Editing and deleting work the same way. **Reload** in the provider list header (or the
editor footer) re-reads both config files when something changed outside the panel.

The API key is written to `settings.apiKey` as plain text. To keep the secret out of the
file, enter `{env:VAR_NAME}` (or `{file:path/to/secret}`) instead.

### Fetching models

**Fetch** asks the provider for its model list and turns the model ID field into a
searchable dropdown. It tries `{baseURL}/models`, then `{baseURL}/v1/models` when the base
URL does not already end in `/v1`. OpenAI-compatible protocols send
`Authorization: Bearer …`; **Anthropic Messages** sends `x-api-key` and
`anthropic-version`. The response may be an array, `{ data: [...] }` or `{ models: [...] }`.

The request is made by a small local service (`service/main.js`) that OpenChamber starts on
demand and stops with the app. It listens only on `127.0.0.1`, requires the host's token, and
keeps no key. If the extension was just updated, approve the local service in
**Settings → Extensions** first; otherwise Fetch reports that the service is not enabled.
The service uses the host's direct network access, so a proxy configured only in the
browser is not used.

`{file:…}` key references with an absolute or `~/` path are read by the service.
`{env:…}` references only work when the variable is visible to the service process; a
literal key is the simplest choice for Fetch.

### Built-in overrides

A `providers.anthropic` entry that only sets `settings.baseURL` overrides a built-in
provider rather than defining a new one. The panel lists these as **Built-in override** and
leaves them untouched: it has no package or models to manage, and rewriting one would break
the override.

## Security and permissions

Saving, editing and deleting make no network requests and send no prompts to an agent. The
panel only reads and updates the OpenCode config files listed in its permission request.

**Fetch** is the one network action. It goes through a local service the host starts on
demand: the panel sends the base URL, API key and protocol to the service over the host's
loopback proxy, and the service makes one `GET` request to the provider's model endpoint.
The service binds `127.0.0.1`, requires the host's bearer token, keeps no key and logs no
request body. It is stopped with the app. Approve the service in **Settings → Extensions**
to use Fetch; without that approval the rest of the panel still works.

Writes are surgical: only `providers.<id>` is replaced (and a legacy `provider.<id>` twin
removed), using `jsonc-parser` edits. The file is parsed before and after, so a broken file
is reported with its line and column instead of being overwritten.

## Compatibility

- OpenChamber 2.0.0 or newer
- OpenCode 2.x configuration format (`providers` / `package` / `settings` / `modelID`),
  with V1 configs migrated on save
- Web and Desktop OpenChamber clients

## Development

```bash
npm install
npm run typecheck   # panel + service TypeScript
npm test            # core and model-list helpers, no host needed
npm run build       # bundle panel/main.ts and service/main.ts
npm run build:dev   # same, unminified
npm run preview     # build a local preview page in scripts/preview
npm run check       # typecheck + test + build + preview
```

The preview runs the real panel against an in-memory config and a fake model list: serve
the repository with any static server and open
`scripts/preview/index.html?theme=dark&locale=zh`. Add `&surface=rail` to check the narrow
layout. It is a development aid and is not shipped in the extension.

OpenChamber never builds an extension on install, so commit the built `panel/main.js` and
`service/main.js` with the sources. To ship an update, bump `version` in `package.json`,
rebuild, commit and push; the Extensions page then offers **Update**.

## Layout

```
package.json           extension manifest (openchamber block) + build scripts
icon.svg               rail icon, masked in the current text color
panel/index.html       panel page
panel/styles.css       layout and chrome, using only host theme tokens
panel/main.ts          host connection, theme, locale, model fetch bridge
panel/app.ts           panel state, layout and interactions
panel/i18n.ts          English and Chinese copy
panel/core/json.ts     JSON value helpers
panel/core/config.ts   file location, read, and surgical JSONC writes
panel/core/provider.ts provider drafts <-> config blocks, V1 migration
panel/core/protocols.ts protocol <-> runtime package
panel/core/validate.ts form validation
panel/ui/               small DOM and icon helpers
service/main.ts        on-demand loopback service for the model-list request
service/models.ts      URL, header and response helpers (no Node imports)
service/main.js        built service entry the host runs
tests/core.test.ts     core logic and model-list helper tests
scripts/preview/       development preview (not shipped)
```

The `core` layer has no DOM and no host dependency: it takes JSON text and values in,
returns text out, so it is testable in Node and the panel stays a thin shell over it.

## Upgrading from 1.x

Version 2.0.0 writes reasoning levels as `capabilities.reasoning` instead of hand-written
`variants`, which is what OpenCode 2 uses to build protocol-correct variants. On the first
save of a model, variants the old panel generated are dropped (standard level IDs whose
settings contain only the reasoning keys it wrote) and hand-written variants are kept. The
panel reads the old shape, so existing providers open with their levels and limits intact.

## Troubleshooting reasoning levels

OpenCode 2 only turns `capabilities.reasoning` into variants for the runtime packages it
knows. With a **Custom package** it derives nothing, so the panel writes the variants for
the selected levels itself; they are plain `reasoningEffort` overlays, which is what an
OpenAI-compatible endpoint expects.

If a model shows no levels in the picker after saving, check these in order:

1. The model has at least one level selected. Every card off writes
   `reasoning: { supported: false }`, which hides the picker on purpose.
2. The selected level is supported by the endpoint. A gateway that only accepts `low`,
   `medium` and `high` rejects `xhigh` or `max`; pick the ones it documents.
3. The protocol matches the endpoint. **OpenAI Chat Completions** covers `/chat/completions`,
   **OpenAI Responses** covers `/responses` (and attaches `reasoning.encrypted_content`),
   **Anthropic Messages** covers `/messages` (and sends `thinking` plus `effort`).
   Using the wrong one produces a request the endpoint refuses, even though the level shows.

A hand-written `reasoning: { supported: true }` that names no levels is left alone when
every card is off, because the package decides the levels in that mode. A model renamed in
the panel also drops a display name that only repeated the old ID, so the picker never shows
the previous name.

## License

MIT
