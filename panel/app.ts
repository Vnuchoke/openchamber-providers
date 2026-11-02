/**
 * Panel application: state, layout and interactions.
 *
 * Separated from `main.ts` so the same code can run against the real host in
 * OpenChamber and against a fake host in a browser preview. Everything it
 * needs from the outside is a `FileHost` plus a toast sink.
 */
import {
  mountButton,
  mountSelect,
  mountSpinner,
  mountSwitch,
  mountTextField,
  type SelectOption,
} from '@openchamber/sdk/ui';
import {
  hasProvider,
  NEW_FILE_PATH,
  readSnapshot,
  removeProvider,
  writeProvider,
  type FileHost,
  type Snapshot,
} from './core/config';
import { isObject } from './core/json';
import {
  buildProvider,
  draftFrom,
  emptyDraft,
  emptyModel,
  REASONING_LEVELS,
  uniqueIDFrom,
  type ModelDraft,
  type ProviderDraft,
  type ProviderEntry,
} from './core/provider';
import { PROTOCOLS, packageFrom, packageLabel, packageOfProtocol, type ProtocolId } from './core/protocols';
import { hasErrors, validateDraft, type DraftErrors } from './core/validate';
import { DICTIONARIES, type Locale, type MessageKey } from './i18n';
import { clear, el, span } from './ui/dom';
import { icon } from './ui/icons';

type Disposable = { dispose: () => void };

export type ToastSink = {
  toast: (request: { kind: 'success' | 'error' | 'info'; message: string }) => Promise<unknown>;
};

export type ModelFetchRequest = {
  baseURL: string;
  apiKey: string;
  protocol: ProtocolId;
};

/** A failed model-list request, split so the panel can localise the service case. */
export class ModelFetchError extends Error {
  constructor(readonly code: 'service' | 'request', message: string) {
    super(message);
  }
}

export type PanelHost = FileHost & ToastSink & {
  fetchModels: (request: ModelFetchRequest) => Promise<string[]>;
};

export type PendingConfirm =
  | { kind: 'select'; id: string }
  | { kind: 'new' }
  | { kind: 'reload' }
  | { kind: 'back' };

const fill = (template: string, values: Record<string, string>): string => (
  template.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? `{${name}}`)
);

const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/** Sentinel option that switches a fetched model list back to free text. */
const CUSTOM_MODEL_OPTION = '__openchamber_custom_model__';

/** Second line for a provider row: ID and host, minus the scheme. */
const rowSubtitle = (entry: ProviderEntry, overlayLabel: string): string => {
  if (entry.overlay) return `${entry.id} · ${overlayLabel}`;
  const settings = isObject(entry.block.settings) ? entry.block.settings : {};
  const url = typeof settings.baseURL === 'string' ? settings.baseURL.replace(/^https?:\/\//, '') : '';
  return url ? `${entry.id} · ${url}` : entry.id;
};

const modelCount = (entry: ProviderEntry): number => (isObject(entry.block.models) ? Object.keys(entry.block.models).length : 0);

export class ProviderPanel {
  private readonly root: HTMLElement;
  private readonly host: PanelHost;

  private t = DICTIONARIES.en;

  private snapshot: Snapshot | null = null;
  private loading = true;
  private fatal: string | null = null;

  private query = '';
  private selectedID: string | null = null;

  private draft: ProviderDraft | null = null;
  private editingID: string | null = null;
  private baseline = '';
  private errors: DraftErrors = {};
  private busy = false;
  private confirmingDelete = false;
  private pending: PendingConfirm | null = null;
  private keyVisible = false;
  private expanded = new Set<string>();
  private detailScroll = 0;

  private modelOptions: string[] = [];
  private fetchingModelKey: string | null = null;
  private manualModelIDs = new Set<string>();

  private mounted: Disposable[] = [];

  constructor(root: HTMLElement, host: PanelHost) {
    this.root = root;
    this.host = host;
  }

  setLocale(locale: Locale): void {
    this.t = DICTIONARIES[locale];
    if (!this.loading) this.paint();
  }

  async start(): Promise<void> {
    await this.load();
  }

  /* ---------------------------------------------------------------- helpers */

  private tr(key: MessageKey): string {
    return this.t[key];
  }

  private entryOf(id: string | null): ProviderEntry | undefined {
    return id ? this.snapshot?.providers.find((entry) => entry.id === id) : undefined;
  }

  /** First provider that has a form, else any provider. */
  private defaultSelection(): string | null {
    const providers = this.snapshot?.providers ?? [];
    return providers.find((entry) => !entry.overlay)?.id ?? providers[0]?.id ?? null;
  }

  private isDirty(): boolean {
    if (!this.draft) return false;
    // A provider that has never been saved is always unsaved, even if the
    // form still holds its opening values.
    if (this.editingID === null) return true;
    return JSON.stringify(this.draft) !== this.baseline;  }

  /* ------------------------------------------------------------------- load */

  private async load(): Promise<void> {
    this.loading = true;
    this.fatal = null;
    this.paint();
    try {
      const snapshot = await readSnapshot(this.host);
      this.snapshot = snapshot;
      this.draft = null;
      this.editingID = null;
      this.baseline = '';
      this.errors = {};
      this.confirmingDelete = false;
      this.pending = null;
      this.modelOptions = [];
      this.fetchingModelKey = null;
      this.manualModelIDs.clear();
      if (!this.selectedID || !snapshot.providers.some((entry) => entry.id === this.selectedID)) {
        this.selectedID = this.defaultSelection();
      }
      const entry = this.entryOf(this.selectedID);
      if (entry && !entry.overlay) this.openDraft(entry);
    } catch (error) {
      this.fatal = errorText(error);
      this.snapshot = null;
    } finally {
      this.loading = false;
      this.paint();
    }
  }

  /** Re-reads the config without dropping an edit that is already open. */
  private async refresh(): Promise<void> {
    this.busy = true;
    this.paint();
    try {
      const snapshot = await readSnapshot(this.host);
      this.snapshot = snapshot;
      if (this.editingID) {
        const entry = this.entryOf(this.editingID);
        if (!entry || entry.overlay) {
          this.closeDraft();
          this.selectedID = this.defaultSelection();
          const next = this.entryOf(this.selectedID);
          if (next && !next.overlay) this.openDraft(next);
        }
      } else {
        // A reload from the list must stay on the list: only an edit that was
        // already open is kept, never opened on the user's behalf.
        this.selectedID = this.snapshot.providers.some((entry) => entry.id === this.selectedID)
          ? this.selectedID
          : this.defaultSelection();
      }
    } catch (error) {
      this.fatal = errorText(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  /* ------------------------------------------------------------------ draft */

  private openDraft(entry: ProviderEntry): void {
    this.editingID = entry.id;
    this.selectedID = entry.id;
    this.draft = draftFrom(entry);
    this.baseline = JSON.stringify(this.draft);
    this.errors = {};
    this.confirmingDelete = false;
    this.pending = null;
    this.keyVisible = false;
    this.detailScroll = 0;
    this.modelOptions = [];
    this.fetchingModelKey = null;
    this.manualModelIDs.clear();
    this.expanded = new Set(this.draft.models.slice(0, 1).map((model) => model.key));
  }

  private openNew(): void {
    this.selectedID = null;
    this.editingID = null;
    this.draft = emptyDraft();
    this.baseline = JSON.stringify(this.draft);
    this.errors = {};
    this.confirmingDelete = false;
    this.pending = null;
    this.keyVisible = false;
    this.detailScroll = 0;
    this.modelOptions = [];
    this.fetchingModelKey = null;
    this.manualModelIDs.clear();
    this.expanded = new Set(this.draft.models.map((model) => model.key));
  }

  private closeDraft(): void {
    this.draft = null;
    this.editingID = null;
    this.baseline = '';
    this.errors = {};
    this.confirmingDelete = false;
    this.pending = null;
    this.modelOptions = [];
    this.fetchingModelKey = null;
    this.manualModelIDs.clear();
  }

  private select(id: string): void {
    const entry = this.entryOf(id);
    if (!entry) return;
    if (this.draft && id === this.editingID) return;
    if (this.isDirty()) {
      this.pending = { kind: 'select', id };
      this.paint();
      return;
    }
    this.selectedID = id;
    if (entry.overlay) {
      this.closeDraft();
      this.paint();
      return;
    }
    this.openDraft(entry);
    this.paint();
  }

  private startNew(): void {
    if (this.isDirty()) {
      this.pending = { kind: 'new' };
      this.paint();
      return;
    }
    this.openNew();
    this.paint();
  }

  private askBack(): void {
    if (this.isDirty()) {
      this.pending = { kind: 'back' };
      this.paint();
      return;
    }
    this.closeDraft();
    this.paint();
  }

  private askReload(): void {
    if (this.isDirty()) {
      this.pending = { kind: 'reload' };
      this.paint();
      return;
    }
    void this.refresh();
  }

  private resolvePending(discard: boolean): void {
    const action = this.pending;
    this.pending = null;
    if (!action) {
      this.paint();
      return;
    }
    if (!discard) {
      this.paint();
      return;
    }
    this.closeDraft();
    if (action.kind === 'new') {
      this.openNew();
      this.paint();
      return;
    }
    if (action.kind === 'select') {
      const entry = this.entryOf(action.id);
      this.selectedID = action.id;
      if (entry && !entry.overlay) this.openDraft(entry);
      this.paint();
      return;
    }
    if (action.kind === 'back') {
      this.selectedID = this.defaultSelection();
      this.paint();
      return;
    }
    void this.refresh();
  }

  /* ---------------------------------------------------------------- actions */

  /** Fetch is available once the connection fields can form a request. */
  private canFetchModels(): boolean {
    if (!this.draft) return false;
    const baseURL = this.draft.baseURL.trim();
    const apiKey = this.draft.apiKey.trim();
    return /^https?:\/\/\S+$/i.test(baseURL) && apiKey.length > 0;
  }

  /** Keeps the per-card Fetch buttons in step with the connection fields. */
  private updateFetchButtons(): void {
    const disabled = this.busy || this.fetchingModelKey !== null || !this.canFetchModels();
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-fetch]')) {
      button.disabled = disabled;
    }
  }

  private async fetchModels(modelKey: string): Promise<void> {
    const draft = this.draft;
    if (!draft || this.busy || this.fetchingModelKey) return;
    const baseURL = draft.baseURL.trim();
    const apiKey = draft.apiKey.trim();
    if (!baseURL || !apiKey) {
      await this.host.toast({ kind: 'error', message: this.tr('fetchNeedsConnection') });
      return;
    }

    this.fetchingModelKey = modelKey;
    this.paint();
    try {
      const models = await this.host.fetchModels({ baseURL, apiKey, protocol: draft.protocol });
      if (this.draft !== draft) return;
      if (models.length === 0) {
        await this.host.toast({ kind: 'error', message: this.tr('fetchEmpty') });
        return;
      }
      this.modelOptions = models;
      this.manualModelIDs.clear();
      await this.host.toast({
        kind: 'success',
        message: fill(this.tr('fetchDone'), { count: String(models.length) }),
      });
    } catch (error) {
      if (this.draft !== draft) return;
      const message = error instanceof ModelFetchError && error.code === 'service'
        ? this.tr('fetchService')
        : errorText(error);
      await this.host.toast({
        kind: 'error',
        message: fill(this.tr('fetchFailed'), { message }),
      });
    } finally {
      this.fetchingModelKey = null;
      this.paint();
    }
  }

  private validate(): boolean {
    if (!this.draft) return false;
    this.errors = validateDraft(this.draft, {
      existingIDs: this.snapshot?.providers.map((entry) => entry.id) ?? [],
      editingID: this.editingID,
    });
    return !hasErrors(this.errors);
  }

  private async save(): Promise<void> {
    if (!this.draft || this.busy) return;
    if (!this.validate()) {
      this.confirmingDelete = false;
      this.paint();
      return;
    }
    const current = this.draft;
    const id = current.providerID.trim();
    this.busy = true;
    this.paint();
    try {
      const fresh = await readSnapshot(this.host);
      const existing = fresh.providers.find((entry) => entry.id === id);
      const path = existing?.file ?? fresh.target;
      const file = fresh.files.find((item) => item.path === path);
      const block = buildProvider(current, existing?.block);
      await this.host.writeFile(path, writeProvider(file?.text ?? null, id, block));

      // One copy only: an ID edited in json while jsonc also holds it would
      // otherwise keep an old block alive.
      for (const other of fresh.files) {
        if (other.path === path || !other.text || !hasProvider(other.text, id)) continue;
        const next = removeProvider(other.text, id);
        if (next !== null) await this.host.writeFile(other.path, next);
      }

      this.snapshot = await readSnapshot(this.host);
      this.closeDraft();
      this.selectedID = id;
      const saved = this.entryOf(id);
      if (saved && !saved.overlay) this.openDraft(saved);
      await this.host.toast({
        kind: 'success',
        message: fill(this.tr('savedToast'), { name: String(block.name ?? id) }),
      });
    } catch (error) {
      this.fatal = errorText(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  private async deleteProvider(): Promise<void> {
    const id = this.editingID;
    if (!id || this.busy) return;
    this.busy = true;
    this.paint();
    try {
      const fresh = await readSnapshot(this.host);
      const name = String(fresh.providers.find((entry) => entry.id === id)?.block.name ?? id);
      for (const file of fresh.files) {
        if (!file.text || !hasProvider(file.text, id)) continue;
        const next = removeProvider(file.text, id);
        if (next !== null) await this.host.writeFile(file.path, next);
      }
      this.closeDraft();
      this.snapshot = await readSnapshot(this.host);
      this.selectedID = this.snapshot.providers[0]?.id ?? null;
      const next = this.entryOf(this.selectedID);
      if (next && !next.overlay) this.openDraft(next);
      await this.host.toast({ kind: 'success', message: fill(this.tr('deletedToast'), { name }) });
    } catch (error) {
      this.fatal = errorText(error);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  /* ----------------------------------------------------------------- render */

  private paint(): void {
    const focus = this.focusKey();
    for (const item of this.mounted.splice(0)) item.dispose();
    clear(this.root);

    const shell = el('div', 'shell');
    shell.dataset.editing = String(this.draft !== null);
    const panes = el('div', 'panes');
    shell.append(panes);
    this.root.append(shell);

    panes.append(this.renderSidebar(), this.renderDetail());

    const selector = this.focusSelector(focus);
    if (selector) this.root.querySelector<HTMLElement>(selector)?.focus();
  }

  /** Keeps keyboard focus on the same control across a full repaint. */
  private focusKey(): string | null {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement)) return null;
    if (node.dataset.focus) return node.dataset.focus;
    const owner = node.closest<HTMLElement>('[data-focus]');
    return owner?.dataset.focus ?? null;
  }

  private focusSelector(key: string | null): string | null {
    if (!key) return null;
    try {
      return `[data-focus="${CSS.escape(key)}"]`;
    } catch {
      return null;
    }
  }

  private renderSidebar(): HTMLElement {
    const sidebar = el('aside', 'sidebar');

    const head = el('div', 'sidebar-head');
    const title = el('h2', 'sidebar-title');
    title.textContent = this.tr('listTitle');
    const count = span(head, String(this.snapshot?.providers.length ?? 0), 'sidebar-count');
    count.setAttribute('aria-hidden', 'true');
    head.append(title, count, el('div', 'spacer'));

    const actions = el('div', 'sidebar-actions');

    const reload = el('button', 'icon-button', {
      type: 'button',
      'aria-label': this.tr('refresh'),
      title: this.tr('refresh'),
      disabled: this.busy || this.loading,
    });
    reload.dataset.focus = 'refresh';
    reload.append(icon('refresh', 17));
    reload.addEventListener('click', () => this.askReload());
    actions.append(reload);

    const add = el('button', 'icon-button', { type: 'button', 'aria-label': this.tr('add'), title: this.tr('add') });
    add.dataset.focus = 'add-provider';
    add.dataset.emphasis = 'true';
    add.append(icon('plus', 15));
    add.addEventListener('click', () => this.startNew());
    actions.append(add);
    head.append(actions);
    sidebar.append(head);

    const searchWrap = el('div', 'sidebar-search');
    const search = el('div', 'oc-sdk oc-sdk-search');
    const searchIcon = el('span', 'oc-sdk-search-icon');
    searchIcon.append(icon('search', 14));
    const input = el('input', 'oc-sdk oc-sdk-input', {
      type: 'search',
      placeholder: this.tr('searchPlaceholder'),
      'aria-label': this.tr('searchPlaceholder'),
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.dataset.focus = 'search';
    input.value = this.query;
    input.addEventListener('input', () => {
      this.query = input.value;
      this.renderRowsOnly(sidebar);
    });
    search.append(searchIcon, input);
    searchWrap.append(search);
    sidebar.append(searchWrap);

    const list = el('div', 'sidebar-list');
    list.dataset.role = 'provider-list';
    sidebar.append(list);
    this.renderRows(list);
    return sidebar;
  }

  /** Repaints only the rows, so typing in the search box keeps its cursor. */
  private renderRowsOnly(sidebar: HTMLElement): void {
    const list = sidebar.querySelector<HTMLElement>('.sidebar-list');
    if (!list) return;
    clear(list);
    this.renderRows(list);
  }

  private filteredProviders(): ProviderEntry[] {
    const needle = this.query.trim().toLowerCase();
    const providers = this.snapshot?.providers ?? [];
    if (!needle) return providers;
    return providers.filter((entry) => {
      const name = String(entry.block.name ?? entry.id).toLowerCase();
      const settings = isObject(entry.block.settings) ? entry.block.settings : {};
      const url = typeof settings.baseURL === 'string' ? settings.baseURL.toLowerCase() : '';
      return entry.id.toLowerCase().includes(needle) || name.includes(needle) || url.includes(needle);
    });
  }

  private renderRows(list: HTMLElement): void {
    if (this.loading) {
      const note = el('div', 'sidebar-empty');
      note.textContent = this.tr('loading');
      list.append(note);
      return;
    }
    if (this.fatal) {
      const note = el('div', 'sidebar-empty');
      note.textContent = this.tr('readFailed');
      list.append(note);
      return;
    }
    const providers = this.filteredProviders();
    if (providers.length === 0) {
      const note = el('div', 'sidebar-empty');
      note.textContent = (this.snapshot?.providers.length ?? 0) === 0
        ? this.tr('emptyTitle')
        : this.tr('emptyFilteredBody');
      list.append(note);
      return;
    }

    for (const entry of providers) {
      const active = (this.draft ? this.editingID : this.selectedID) === entry.id;
      const row = el('button', 'provider-row', {
        type: 'button',
        'aria-current': active ? 'true' : undefined,
        'data-focus': `row:${entry.id}`,
      });
      row.dataset.id = entry.id;

      const label = String(entry.block.name ?? entry.id).trim() || entry.id;
      span(row, label.slice(0, 1).toUpperCase(), 'provider-mark');

      const main = el('div', 'provider-main');
      const name = el('div', 'provider-name');
      name.textContent = label;
      const sub = el('div', 'provider-sub');
      sub.textContent = rowSubtitle(entry, this.tr('overlayBadge'));
      main.append(name, sub);
      row.append(main);

      const meta = el('div', 'provider-meta');
      span(meta, String(modelCount(entry)));
      row.append(meta);

      row.addEventListener('click', () => this.select(entry.id));
      list.append(row);
    }
  }

  /* ----------------------------------------------------------------- detail */

  private protocolLabel(protocol: ProtocolId): string {
    if (protocol === 'openai-chat') return this.tr('protocolOpenAIChat');
    if (protocol === 'openai-responses') return this.tr('protocolOpenAIResponses');
    if (protocol === 'anthropic-messages') return this.tr('protocolAnthropic');
    return this.tr('protocolCustom');
  }

  private renderDetail(): HTMLElement {
    const detail = el('section', 'detail');

    const head = el('header', 'detail-head');
    const back = el('button', 'icon-button back', {
      type: 'button',
      'aria-label': this.tr('back'),
      title: this.tr('back'),
    });
    back.dataset.focus = 'back';
    back.append(icon('arrowLeft', 16));
    back.addEventListener('click', () => this.askBack());
    head.append(back);

    const titleWrap = el('div', 'detail-title');
    const h1 = el('h1');
    const sub = el('div', 'detail-sub');
    titleWrap.append(h1, sub);

    const actions = el('div', 'detail-actions');
    head.append(titleWrap, actions);

    const body = el('div', 'detail-body');
    body.dataset.role = 'detail-body';
    body.addEventListener('scroll', () => {
      this.detailScroll = body.scrollTop;
    }, { passive: true });

    const foot = el('footer', 'detail-foot');
    detail.append(head, body, foot);

    if (this.loading) {
      h1.textContent = this.tr('appTitle');
      sub.textContent = this.tr('appSubtitle');
      this.mounted.push(mountSpinner(body, { label: this.tr('loading') }));
      return detail;
    }

    if (this.fatal && !this.draft) {
      h1.textContent = this.tr('readFailed');
      sub.textContent = this.tr('appSubtitle');
      body.append(this.notice('error', this.tr('readFailed'), this.fatal, [{
        label: this.tr('retry'),
        onClick: () => void this.load(),
      }]));
      return detail;
    }

    const entry = this.entryOf(this.draft ? this.editingID : this.selectedID);

    if (this.draft) {
      h1.textContent = this.draft.name.trim() || this.draft.providerID.trim() || this.tr('newProvider');
      sub.textContent = this.editingID === null
        ? this.tr('newTag')
        : `${this.draft.providerID} · ${this.protocolLabel(this.draft.protocol)}`;
      this.renderDraftActions(actions);
      this.renderDraftBody(body, this.draft);
      this.renderDraftFooter(foot);
      body.scrollTop = this.detailScroll;
      return detail;
    }

    if (entry?.overlay) {
      h1.textContent = String(entry.block.name ?? entry.id);
      sub.textContent = entry.id;
      body.append(this.notice('info', this.tr('overlayTitle'), this.tr('overlayBody')));
      const preview = el('pre', 'json-preview');
      preview.textContent = JSON.stringify({ [entry.id]: entry.block }, null, 2);
      body.append(preview);
      foot.append(this.footPath(entry.file));
      return detail;
    }

    h1.textContent = this.tr('appTitle');
    sub.textContent = this.tr('appSubtitle');
    const empty = el('div', 'placeholder');
    const mark = el('div', 'placeholder-icon');
    mark.append(icon('code', 18));
    const emptyTitle = el('h2');
    const emptyBody = el('p');
    if ((this.snapshot?.providers.length ?? 0) === 0) {
      emptyTitle.textContent = this.tr('emptyTitle');
      emptyBody.textContent = this.tr('emptyBody');
      const action = el('div', 'actions');
      this.mounted.push(mountButton(action, { label: this.tr('add'), size: 'sm', onClick: () => this.startNew() }));
      empty.append(mark, emptyTitle, emptyBody, action);
    } else {
      emptyTitle.textContent = this.tr('selectPrompt');
      emptyBody.textContent = this.tr('selectHint');
      empty.append(mark, emptyTitle, emptyBody);
    }
    body.append(empty);
    foot.append(this.footPath(this.snapshot?.target ?? NEW_FILE_PATH));
    return detail;
  }

  private footPath(path: string): HTMLElement {
    const wrap = el('span', 'path');
    wrap.textContent = fill(this.tr('targetFile'), { path });
    wrap.title = path;
    return wrap;
  }

  private renderDraftActions(actions: HTMLElement): void {
    if (!this.editingID) return;

    const remove = el('button', 'icon-button', {
      type: 'button',
      'aria-label': this.tr('delete'),
      title: this.tr('delete'),
    });
    remove.dataset.focus = 'delete-provider';
    remove.dataset.tone = 'danger';
    remove.append(icon('trash', 15));
    remove.addEventListener('click', () => {
      this.confirmingDelete = true;
      this.pending = null;
      this.paint();
    });
    actions.append(remove);
  }

  private sectionHead(title: string, extra?: string): HTMLElement {
    const head = el('div', 'section-head');
    span(head, title, 'eyebrow');
    if (extra !== undefined) span(head, extra, 'count');
    head.append(el('div', 'spacer'));
    return head;
  }

  private notice(
    tone: 'info' | 'warning' | 'error',
    title: string,
    body: string,
    actions: Array<{ label: string; onClick: () => void; variant?: 'default' | 'outline' | 'ghost' | 'destructive' }> = [],
  ): HTMLElement {
    const box = el('div', 'notice');
    box.dataset.tone = tone;
    const main = el('div', 'notice-main');
    const heading = el('div', 'notice-title');
    heading.textContent = title;
    main.append(heading);
    if (body) {
      const text = el('div', 'notice-body');
      text.textContent = body;
      main.append(text);
    }
    box.append(main);
    if (actions.length > 0) {
      const row = el('div', 'notice-actions');
      for (const action of actions) {
        this.mounted.push(mountButton(row, {
          label: action.label,
          size: 'xs',
          variant: action.variant ?? 'outline',
          onClick: action.onClick,
        }));
      }
      box.append(row);
    }
    return box;
  }

  private renderDraftBody(body: HTMLElement, current: ProviderDraft): void {
    const name = current.name.trim() || current.providerID.trim() || this.tr('newProvider');

    if (this.pending) {
      body.append(this.notice('warning', this.tr('discardTitle'), fill(this.tr('discardBody'), { name }), [
        { label: this.tr('discardCancel'), onClick: () => this.resolvePending(false), variant: 'ghost' },
        { label: this.tr('discardAction'), onClick: () => this.resolvePending(true), variant: 'destructive' },
      ]));
    }

    if (this.confirmingDelete && this.editingID) {
      body.append(this.notice('warning', fill(this.tr('deleteConfirm'), { name }), this.tr('deleteBody'), [
        { label: this.tr('deleteCancel'), onClick: () => { this.confirmingDelete = false; this.paint(); }, variant: 'ghost' },
        { label: this.tr('deleteConfirmAction'), onClick: () => void this.deleteProvider(), variant: 'destructive' },
      ]));
    }

    if (this.fatal) {
      body.append(this.notice('error', this.tr('readFailed'), this.fatal, [{
        label: this.tr('retry'),
        onClick: () => void this.load(),
      }]));
    }

    const firstError = this.errors.providerID
      ?? this.errors.name
      ?? this.errors.baseURL
      ?? this.errors.apiKey
      ?? this.errors.customPackage;
    if (firstError) {
      body.append(this.notice('error', this.tr(firstError), ''));
    }
    if (this.errors.models) {
      body.append(this.notice('error', this.tr('models'), this.tr(this.errors.models)));
    }
    /* ------------------------------------------------------------ connection */
    const connection = el('section', 'section');
    connection.append(this.sectionHead(this.tr('connection')));
    const card = el('div', 'card');
    const grid = el('div', 'field-grid');
    card.append(grid);
    connection.append(card);
    body.append(connection);

    const isNew = this.editingID === null;

    /*
     * One field for the provider: its name. The ID OpenCode keys the block by
     * is derived from that name, so it is never a second field. A name with no
     * latin characters falls back to `provider`, with a suffix when taken.
     */
    const nameField = mountTextField(grid, {
      label: this.tr('providerName'),
      value: current.name,
      placeholder: 'Acme',
      error: this.errors.name ? this.tr(this.errors.name) : undefined,
      onChange: (value) => {
        current.name = value;
        if (this.errors.name) {
          this.errors.name = undefined;
        }
        if (!isNew) {
          nameField.update({ value: current.name, error: undefined });
          return;
        }
        current.providerID = uniqueIDFrom(value, this.snapshot?.providers.map((entry) => entry.id) ?? []);
        // The kit repaints `value` on update, so the current text travels with it.
        nameField.update({ value: current.name, error: undefined });
      },
    });
    this.mounted.push(nameField);

    const protocolField = mountSelect(grid, {
      label: this.tr('protocol'),
      value: current.protocol,
      options: [
        ...PROTOCOLS.map((item) => ({ id: item.id, label: this.protocolLabel(item.id), hint: packageLabel(item.package) })),
        { id: 'custom', label: this.tr('protocolCustom') },
      ],
      onChange: (id) => {
        // Carry the package the provider already uses when switching to a
        // custom one, so the field starts from what is on disk.
        if (id === 'custom' && !current.customPackage.trim()) {
          const existing = this.entryOf(this.editingID);
          current.customPackage = existing
            ? packageFrom(existing.block)
            : packageOfProtocol(current.protocol);
        }
        if (id !== 'custom' && current.protocol === 'custom' && this.editingID === null) {
          current.customPackage = '';
        }
        current.protocol = id as ProtocolId;
        // A protocol change can reveal or hide the package field.
        this.paint();
      },
    });
    this.mounted.push(protocolField);

    if (current.protocol === 'custom') {
      const packageField = mountTextField(grid, {
        label: this.tr('customPackage'),
        value: current.customPackage,
        mono: true,
        placeholder: 'aisdk:@ai-sdk/openai-compatible',
        error: this.errors.customPackage ? this.tr(this.errors.customPackage) : undefined,
        onChange: (value) => {
          current.customPackage = value;
          if (this.errors.customPackage) {
            this.errors.customPackage = undefined;
            packageField.update({ value: current.customPackage, error: undefined });
          }
        },
      });
      this.mounted.push(packageField);
    }

    const urlField = mountTextField(grid, {
      label: this.tr('baseURL'),
      value: current.baseURL,
      mono: true,
      placeholder: 'https://api.example.com/v1',
      error: this.errors.baseURL ? this.tr(this.errors.baseURL) : undefined,
      onChange: (value) => {
        current.baseURL = value;
        if (this.errors.baseURL) {
          this.errors.baseURL = undefined;
          urlField.update({ value: current.baseURL, error: undefined });
        }
        this.updateFetchButtons();
      },
    });
    this.mounted.push(urlField);

    const keyBlock = el('div', 'field-key');
    grid.append(keyBlock);

    const keyField = mountTextField(keyBlock, {
      value: current.apiKey,
      password: !this.keyVisible,
      mono: true,
      placeholder: 'sk-... or {env:ACME_API_KEY}',
      error: this.errors.apiKey ? this.tr(this.errors.apiKey) : undefined,
      onChange: (value) => {
        current.apiKey = value;
        if (this.errors.apiKey) {
          this.errors.apiKey = undefined;
          keyField.update({ value: current.apiKey, error: undefined });
        }
        this.updateFetchButtons();
      },
    });
    this.mounted.push(keyField);

    // The reveal toggle rides in the label row above the field, so the input
    // keeps the full width of its column.
    const keyLabelRow = el('div', 'field-label-row');
    span(keyLabelRow, this.tr('apiKey'), 'mini-label');
    const toggleKey = mountButton(keyLabelRow, {
      label: this.keyVisible ? this.tr('hideKey') : this.tr('showKey'),
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        this.keyVisible = !this.keyVisible;
        // Only these two controls repaint, so the cursor stays in the field,
        // and the current text travels with the repaint.
        keyField.update({ value: current.apiKey, password: !this.keyVisible });
        toggleKey.update({ label: this.keyVisible ? this.tr('hideKey') : this.tr('showKey') });
      },
    });
    this.mounted.push(toggleKey);
    keyBlock.insertBefore(keyLabelRow, keyBlock.firstChild);

    /* ---------------------------------------------------------------- models */
    const models = el('section', 'section');
    models.append(this.sectionHead(this.tr('models'), String(current.models.length)));

    for (const [index, model] of current.models.entries()) {
      models.append(this.renderModelCard(model, index, current));
    }

    const addModel = el('button', 'add-model', { type: 'button', 'data-focus': 'add-model' });
    addModel.append(icon('plus', 13));
    span(addModel, this.tr('addModel'));
    addModel.addEventListener('click', () => {
      const model = emptyModel();
      current.models.push(model);
      this.expanded.add(model.key);
      this.paint();
      this.root.querySelector<HTMLElement>(`[data-model="${CSS.escape(model.key)}"] input`)?.focus();
    });
    models.append(addModel);
    body.append(models);
  }

  /** Inline hint for the row that causes a model-level validation error. */
  private modelIDError(model: ModelDraft, current: ProviderDraft): string | undefined {
    if (!this.errors.models) return undefined;
    const ids = current.models.map((item) => item.id.trim()).filter(Boolean);
    const id = model.id.trim();
    if (this.errors.models === 'errorModelsDuplicate' && id && ids.filter((item) => item === id).length > 1) {
      return this.tr('errorModelsDuplicate');
    }
    if (this.errors.models === 'errorModelsIncomplete' && !id) return this.tr('errorModelsIncomplete');
    return undefined;
  }

  private renderModelCard(model: ModelDraft, index: number, current: ProviderDraft): HTMLElement {
    const card = el('div', 'model-card');
    card.dataset.model = model.key;

    const head = el('div', 'model-head');
    const open = this.expanded.has(model.key);
    const toggle = el('button', 'model-toggle', {
      type: 'button',
      'aria-expanded': String(open),
      'aria-label': this.tr('advanced'),
      title: this.tr('advanced'),
      'data-focus': `model-toggle:${model.key}`,
    });
    toggle.append(icon('chevronRight', 13));
    toggle.addEventListener('click', () => {
      if (this.expanded.has(model.key)) this.expanded.delete(model.key);
      else this.expanded.add(model.key);
      this.paint();
    });
    head.append(toggle);

    const id = span(head, model.id.trim() || `#${index + 1}`, 'model-id');
    id.title = model.id.trim();

    const fetch = el('button', 'model-fetch', {
      type: 'button',
      'aria-label': this.tr('fetchModels'),
      title: this.tr('fetchModels'),
      disabled: this.busy || this.fetchingModelKey !== null || !this.canFetchModels(),
    });
    fetch.dataset.fetch = model.key;
    fetch.dataset.focus = `model-fetch:${model.key}`;
    fetch.textContent = this.fetchingModelKey === model.key ? this.tr('fetching') : this.tr('fetch');
    fetch.addEventListener('click', () => void this.fetchModels(model.key));
    head.append(fetch);

    if (current.models.length > 1) {
      const remove = el('button', 'model-toggle', {
        type: 'button',
        'aria-label': this.tr('removeModel'),
        title: this.tr('removeModel'),
        'data-focus': `model-remove:${model.key}`,
      });
      remove.append(icon('close', 12));
      remove.addEventListener('click', () => {
        current.models = current.models.filter((item) => item.key !== model.key);
        this.expanded.delete(model.key);
        this.paint();
      });
      head.append(remove);
    }
    card.append(head);

    if (!open) return card;

    const fields = el('div', 'model-body');
    card.append(fields);

    const idSlot = el('div', 'model-id-slot');
    fields.append(idSlot);
    const idError = this.modelIDError(model, current);
    const useSelect = this.modelOptions.length > 0 && !this.manualModelIDs.has(model.key);

    if (useSelect) {
      const currentID = model.id.trim();
      const options: SelectOption[] = this.modelOptions.map((id) => ({ id, label: id }));
      if (currentID && !this.modelOptions.includes(currentID)) {
        options.unshift({ id: currentID, label: currentID, hint: this.tr('currentModel') });
      }
      options.push({ id: CUSTOM_MODEL_OPTION, label: this.tr('customModel') });
      this.mounted.push(mountSelect(idSlot, {
        label: this.tr('modelID'),
        value: currentID || null,
        options,
        searchable: true,
        searchPlaceholder: this.tr('searchModels'),
        placeholder: this.tr('selectModel'),
        onChange: (id) => {
          if (id === CUSTOM_MODEL_OPTION) {
            this.manualModelIDs.add(model.key);
            this.paint();
            this.root.querySelector<HTMLElement>(`[data-model="${CSS.escape(model.key)}"] input`)?.focus();
            return;
          }
          model.id = id;
          this.paint();
        },
      }));
      const trigger = idSlot.querySelector<HTMLElement>('.oc-sdk-trigger');
      if (trigger) trigger.dataset.focus = `model-id:${model.key}`;
      if (idError) {
        const note = el('span', 'oc-sdk-field-note model-id-error');
        note.textContent = idError;
        idSlot.append(note);
      }
    } else {
      this.mounted.push(mountTextField(idSlot, {
        label: this.tr('modelID'),
        value: model.id,
        mono: true,
        placeholder: 'gpt-4o',
        error: idError,
        onChange: (value) => { model.id = value; },
      }));
      const input = idSlot.querySelector<HTMLInputElement>('input');
      if (input) input.dataset.focus = `model-id:${model.key}`;
    }

    this.mounted.push(mountTextField(fields, {
      label: this.tr('context'),
      value: model.context,
      placeholder: this.tr('limitPlaceholder'),
      onChange: (value) => { model.context = value; },
    }));

    this.mounted.push(mountTextField(fields, {
      label: this.tr('output'),
      value: model.output,
      placeholder: this.tr('limitPlaceholder'),
      onChange: (value) => { model.output = value; },
    }));

    /*
     * The ID is the only name this form needs: the config keeps whatever
     * display name and upstream alias it already has, and OpenCode falls back
     * to the ID for both.
     */
    const levels = el('div', 'wide field-stack');
    const levelsLabel = el('div', 'mini-label');
    levelsLabel.textContent = this.tr('reasoning');
    const levelRow = el('div', 'levels');
    levelRow.setAttribute('role', 'group');
    levelRow.setAttribute('aria-label', this.tr('reasoning'));

    const hints: Record<string, MessageKey> = {
      low: 'reasoningHintLow',
      medium: 'reasoningHintMedium',
      high: 'reasoningHintHigh',
      xhigh: 'reasoningHintXHigh',
      max: 'reasoningHintMax',
    };
    const extras = model.levels.filter((level) => !(REASONING_LEVELS as readonly string[]).includes(level));
    for (const level of [...REASONING_LEVELS, ...extras]) {
      const on = model.levels.includes(level);
      const chip = el('button', 'level', {
        type: 'button',
        'aria-pressed': String(on),
        'data-focus': `level:${model.key}:${level}`,
        title: hints[level] ? this.tr(hints[level]) : undefined,
      });
      chip.textContent = level;
      chip.addEventListener('click', () => {
        model.levels = on
          ? model.levels.filter((item) => item !== level)
          : [...model.levels, level];
        this.paint();
        this.root.querySelector<HTMLElement>(`[data-focus="level:${CSS.escape(model.key)}:${CSS.escape(level)}"]`)?.focus();
      });
      levelRow.append(chip);
    }
    levels.append(levelsLabel, levelRow);
    fields.append(levels);

    const switches = el('div', 'switches wide');
    this.mounted.push(mountSwitch(switches, {
      label: this.tr('image'),
      checked: model.image,
      onChange: (checked) => { model.image = checked; },
    }));
    this.mounted.push(mountSwitch(switches, {
      label: this.tr('tools'),
      checked: model.tools,
      onChange: (checked) => { model.tools = checked; },
    }));
    fields.append(switches);

    return card;
  }

  private renderDraftFooter(foot: HTMLElement): void {
    const isNew = this.editingID === null;
    const path = (isNew ? this.snapshot?.target : this.entryOf(this.editingID)?.file) ?? NEW_FILE_PATH;
    foot.append(this.footPath(path));

    const state = el('span', 'state');
    state.dataset.dirty = String(this.isDirty());
    state.textContent = this.isDirty() ? this.tr('unsaved') : this.tr('savedState');
    foot.append(state, el('div', 'spacer'));

    this.mounted.push(mountButton(foot, {
      label: this.tr('refresh'),
      variant: 'ghost',
      size: 'sm',
      disabled: this.busy,
      onClick: () => this.askReload(),
    }));
    this.mounted.push(mountButton(foot, {
      label: this.busy ? this.tr('saving') : this.tr('save'),
      size: 'sm',
      loading: this.busy,
      onClick: () => void this.save(),
    }));
  }

  /* --------------------------------------------------------------- keyboard */

  handleKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void this.save();
    }
  }

  hasUnsavedChanges(): boolean {
    return this.isDirty();
  }
}

