/**
 * Panel entry: connect to the OpenChamber host, paint the theme, and hand the
 * root to the application. All behaviour lives in `./app`, which knows only
 * the small file and toast interface it is given.
 */
import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { ModelFetchError, ProviderPanel } from './app';
import { localeOf } from './i18n';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('#root is missing');

const describe = (error: unknown): string => {
  if (error instanceof HostRequestError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
};

const panel = new ProviderPanel(root, {
  stat: (path) => host.stat(path),
  readFile: (path) => host.readFile(path),
  writeFile: (path, content) => host.writeFile(path, content),
  toast: async (request) => host.toast({ kind: request.kind, message: request.message }),
  fetchModels: async ({ baseURL, apiKey, protocol }) => {
    let result: { status: number; body: string };
    try {
      result = await host.serviceRequest({
        method: 'POST',
        path: '/models',
        body: JSON.stringify({ baseURL, apiKey, protocol }),
      });
    } catch (error) {
      if (error instanceof HostRequestError && error.code === 'NO_SERVICE') {
        throw new ModelFetchError('service', 'The local model service is not enabled.');
      }
      throw new ModelFetchError('request', describe(error));
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(result.body);
    } catch {
      // A non-JSON failure is reported through the status below.
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (result.status < 200 || result.status >= 300) {
      const message = typeof body.error === 'string' ? body.error : `HTTP ${result.status}`;
      throw new ModelFetchError('request', message);
    }
    return Array.isArray(body.models)
      ? body.models.filter((item): item is string => typeof item === 'string')
      : [];
  },
});

document.addEventListener('keydown', (event) => panel.handleKeydown(event));

window.addEventListener('beforeunload', (event) => {
  if (!panel.hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = '';
});

let didMount = false;
let lastLocale = '';

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  document.documentElement.dataset.surface = ctx.surface;
  const locale = localeOf(ctx.locale);
  const changed = locale !== lastLocale;
  lastLocale = locale;
  if (!didMount) {
    didMount = true;
    panel.setLocale(locale);
    void panel.start().catch((error: unknown) => {
      void host.toast({ kind: 'error', message: describe(error) });
    });
    return;
  }
  if (changed) panel.setLocale(locale);
});
