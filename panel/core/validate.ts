/**
 * Form validation. Pure functions returning message keys, so the same rules
 * drive inline errors and the save barrier.
 */
import { positiveInt } from './json';
import type { ProviderDraft } from './provider';

export type DraftErrors = {
  providerID?: 'errorID' | 'errorIDTaken';
  name?: 'errorName';
  baseURL?: 'errorBaseURL';
  apiKey?: 'errorAPIKey';
  models?: 'errorModels' | 'errorModelsDuplicate' | 'errorModelsIncomplete' | 'errorLimits';
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

export type ValidateOptions = {
  /** Providers already on disk, keyed by ID. */
  existingIDs: readonly string[];
  /** The provider being edited, if any; its own ID may be unchanged. */
  editingID: string | null;
};

export const validateDraft = (draft: ProviderDraft, options: ValidateOptions): DraftErrors => {  const errors: DraftErrors = {};
  const id = draft.providerID.trim();

  if (!ID_PATTERN.test(id)) {
    errors.providerID = 'errorID';
  } else if (id !== options.editingID && options.existingIDs.includes(id)) {
    errors.providerID = 'errorIDTaken';
  }

  if (!draft.name.trim()) errors.name = 'errorName';

  if (!isWebURL(draft.baseURL.trim())) errors.baseURL = 'errorBaseURL';

  const key = draft.apiKey.trim();
  if (key && !isKeyReference(key) && !isPrintableKey(key)) errors.apiKey = 'errorAPIKey';

  const ids = draft.models.map((model) => model.id.trim()).filter(Boolean);
  if (ids.length === 0) {
    errors.models = 'errorModels';
  } else if (new Set(ids).size !== ids.length) {
    errors.models = 'errorModelsDuplicate';
  } else if (draft.models.some((model) => (
    !model.id.trim()
    && (model.modelID.trim()
      || model.name.trim()
      || model.context.trim()
      || model.output.trim()
      || model.levels.length > 0)
  ))) {
    errors.models = 'errorModelsIncomplete';
  }

  const badLimits = draft.models.some((model) => (
    (model.context.trim() !== '' && positiveInt(model.context) === undefined)
    || (model.output.trim() !== '' && positiveInt(model.output) === undefined)
  ));
  if (badLimits) errors.models = 'errorLimits';

  return errors;
};

export const isWebURL = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** `{env:NAME}` and `{file:path}` are OpenCode substitutions, not literal keys. */
export const isKeyReference = (value: string): boolean => /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
  || /^\{file:.+\}$/.test(value);

const isPrintableKey = (value: string): boolean => value.length >= 8 && !/\s/.test(value);

export const hasErrors = (errors: DraftErrors): boolean => Object.values(errors).some((value) => value !== undefined);
