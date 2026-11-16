import { defineMessages, type MessageDescriptor } from "@/lib/i18n";
import {
  PROVIDER_KEY_BASE_URL_PROBLEM_MESSAGES,
  PROVIDER_KEY_MODEL_LIMIT,
  providerKeyBaseUrlProblem,
  providerKeyModelName,
  providerKeyPreset,
  type ProviderKeyConnectInput,
  type ProviderKeyEndpoint,
  type ProviderKeyFailureReason,
  type ProviderKeyModel,
  type ProviderKeyPresetId,
} from "../../../shared/provider-keys";

export interface ProviderKeyDraft {
  readonly preset: ProviderKeyPresetId;
  /** The chosen endpoint of each preset that offers more than one. */
  readonly endpoints: Readonly<Partial<Record<ProviderKeyPresetId, ProviderKeyEndpoint["id"]>>>;
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Model IDs typed for a custom endpoint that doesn't list its own, one per line. */
  readonly modelsText: string;
}

export const initialProviderKeyDraft = (
  preset: ProviderKeyPresetId = "deepseek",
): ProviderKeyDraft => ({ preset, endpoints: {}, baseUrl: "", apiKey: "", modelsText: "" });

/**
 * Providers with a China and an international service start on the one that matches the app's
 * language; either can be chosen.
 */
export function providerKeyEndpoint(
  draft: ProviderKeyDraft,
  language: string,
): ProviderKeyEndpoint | null {
  const { endpoints } = providerKeyPreset(draft.preset);
  if (endpoints.length === 0) return null;
  const chosen = draft.endpoints[draft.preset];
  const preferred = /^zh\b/iu.test(language) ? "china" : "international";
  return (
    endpoints.find(({ id }) => id === chosen) ??
    endpoints.find(({ id }) => id === preferred) ??
    endpoints[0]!
  );
}

export function parseTypedModels(
  preset: ProviderKeyPresetId,
  text: string,
): readonly ProviderKeyModel[] {
  const ids = [
    ...new Set(
      text
        .split(/[\n,]+/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  return ids
    .slice(0, PROVIDER_KEY_MODEL_LIMIT)
    .map((id) => ({ id, name: providerKeyModelName(preset, id) }));
}

const draftMessages = defineMessages({
  noBaseUrl: {
    id: "providerKeys.providerKeyForm.enterTheBaseUrl",
    defaultMessage: "Enter the endpoint’s base URL.",
  },
  noKey: { id: "providerKeys.providerKeyForm.pasteYourKey", defaultMessage: "Paste your API key." },
  keyHasSpaces: {
    id: "providerKeys.providerKeyForm.keyHasSpaces",
    defaultMessage: "A key has no spaces. Check what you pasted.",
  },
});

export type ProviderKeyDraftProblem = {
  readonly field: "baseUrl" | "apiKey";
  readonly message: MessageDescriptor;
};

/** The first thing keeping the draft from being sent, named for its field. */
export function providerKeyDraftProblem(draft: ProviderKeyDraft): ProviderKeyDraftProblem | null {
  if (draft.preset === "custom") {
    if (!draft.baseUrl.trim()) return { field: "baseUrl", message: draftMessages.noBaseUrl };
    const problem = providerKeyBaseUrlProblem(draft.baseUrl);
    if (problem)
      return { field: "baseUrl", message: PROVIDER_KEY_BASE_URL_PROBLEM_MESSAGES[problem] };
  }
  if (!draft.apiKey.trim()) return { field: "apiKey", message: draftMessages.noKey };
  if (/\s/u.test(draft.apiKey.trim()))
    return { field: "apiKey", message: draftMessages.keyHasSpaces };
  return null;
}

export function providerKeyConnectInput(
  draft: ProviderKeyDraft,
  language: string,
): ProviderKeyConnectInput {
  const apiKey = draft.apiKey.trim();
  if (draft.preset === "custom") {
    const models = parseTypedModels("custom", draft.modelsText);
    return {
      target: { preset: "custom", baseUrl: draft.baseUrl.trim() },
      apiKey,
      ...(models.length ? { models: [...models] } : {}),
    };
  }
  return {
    target: { preset: draft.preset, endpoint: providerKeyEndpoint(draft, language)!.id },
    apiKey,
  };
}

/** A failure the person fixes in the form: which field it concerns, so focus can go there. */
export const providerKeyFailureField = (
  reason: ProviderKeyFailureReason,
  preset: ProviderKeyPresetId,
): "baseUrl" | "apiKey" | "models" | null =>
  reason === "rejected"
    ? "apiKey"
    : reason === "no-models"
      ? "models"
      : reason === "unreachable" && preset === "custom"
        ? "baseUrl"
        : null;
