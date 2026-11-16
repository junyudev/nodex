import { getIntl } from "@/lib/i18n";
import { isPlausiblePageKeyPrefixDraft, normalizePageKeyPrefixInput } from "../../shared/page-key";
import type { DatabasePageKeyNamespaceV2 } from "../../shared/database-module-v2";
import type { PageKeyPrefixPreviewState } from "./use-page-key-prefix-preview";

export interface ProjectPageKeySaveFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly detailsSaved?: boolean;
}

export interface ProjectPageKeyEditorModel {
  readonly prefix: string;
  readonly canSubmit: boolean;
  readonly statusText: string;
  readonly prefixError: string | null;
  readonly formError: string | null;
  readonly impactText: string | null;
  readonly history: readonly {
    readonly prefix: string;
    readonly detail: string;
  }[];
  readonly suggestedPrefix: string | null;
}

interface ProjectPageKeyEditorModelInput {
  readonly expanded: boolean;
  readonly draftPrefix: string;
  readonly currentPrefix?: string;
  readonly preview: PageKeyPrefixPreviewState;
  readonly settings?: DatabasePageKeyNamespaceV2;
  readonly settingsStatus: "idle" | "loading" | "ready" | "error";
  readonly saveFailure?: ProjectPageKeySaveFailure | null;
}

export function projectPageKeyEditorModel({
  expanded,
  draftPrefix,
  currentPrefix,
  preview,
  settings,
  settingsStatus,
  saveFailure,
}: ProjectPageKeyEditorModelInput): ProjectPageKeyEditorModel {
  const prefix = normalizePageKeyPrefixInput(draftPrefix);
  const valid = isPlausiblePageKeyPrefixDraft(prefix);
  const renamed = currentPrefix !== undefined && prefix !== currentPrefix;
  const confirmed = preview.kind === "available" || preview.kind === "current";
  let statusText = "";
  if (!valid) {
    statusText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.prefixFormat",
      defaultMessage: "Use 2–8 letters or numbers, starting with a letter.",
    });
  } else if (preview.kind === "checking") {
    statusText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.checking",
      defaultMessage: "Checking…",
    });
  } else if (preview.kind === "available") {
    statusText = preview.exampleKeys[0]
      ? getIntl().formatMessage(
          {
            id: "lib.projectPageKeyEditorModel.availableKey",
            defaultMessage: "{key} is available",
          },
          { key: preview.exampleKeys[0] },
        )
      : getIntl().formatMessage(
          {
            id: "lib.projectPageKeyEditorModel.availablePrefix",
            defaultMessage: "{prefix} is available",
          },
          { prefix: preview.prefix },
        );
  } else if (preview.kind === "current") {
    statusText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.currentPrefix",
      defaultMessage: "Current prefix",
    });
  } else if (preview.kind === "reserved") {
    statusText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.alreadyUsed",
      defaultMessage: "Already used in this Library",
    });
  } else if (preview.kind === "error") {
    statusText = preview.error.message;
  }

  let impactText: string | null = null;
  if (expanded && renamed && settingsStatus === "loading") {
    impactText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.loadingImpact",
      defaultMessage: "Loading rename impact…",
    });
  } else if (expanded && renamed && settingsStatus === "error") {
    impactText = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.impactUnavailable",
      defaultMessage: "Rename impact is unavailable. Try again before saving.",
    });
  } else if (expanded && renamed && settings) {
    impactText =
      settings.assignedPageCount === 0
        ? getIntl().formatMessage(
            {
              id: "lib.projectPageKeyEditorModel.noAssignedPages",
              defaultMessage: "No Pages use {prefix} yet. The old prefix will be released.",
            },
            { prefix: settings.currentPrefix },
          )
        : getIntl().formatMessage(
            {
              id: "lib.projectPageKeyEditorModel.prefixImpact",
              defaultMessage:
                "{count, plural, one {# Page} other {# Pages}} will use prefix {prefix}; existing IDs with {oldPrefix} will keep working and remain reserved.",
            },
            { count: settings.assignedPageCount, prefix, oldPrefix: settings.currentPrefix },
          );
  }

  let prefixError: string | null = null;
  let formError: string | null = null;
  if (saveFailure?.code === "identity_conflict") {
    prefixError = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.claimed",
      defaultMessage:
        "This prefix was claimed in another window. Check again or use the suggested prefix.",
    });
  } else if (saveFailure?.code === "revision_conflict") {
    formError = saveFailure.detailsSaved
      ? getIntl().formatMessage({
          id: "lib.projectPageKeyEditorModel.changedPrefix",
          defaultMessage:
            "Project details were saved, but the prefix changed in another window. Review the latest prefix and try again.",
        })
      : getIntl().formatMessage({
          id: "lib.projectPageKeyEditorModel.changedProject",
          defaultMessage:
            "This project changed in another window. Review the latest values and try again.",
        });
  } else if (saveFailure?.code === "not_found") {
    formError = getIntl().formatMessage({
      id: "lib.projectPageKeyEditorModel.projectUnavailable",
      defaultMessage: "This project is no longer available.",
    });
  } else if (saveFailure) {
    formError = saveFailure.detailsSaved
      ? getIntl().formatMessage(
          {
            id: "lib.projectPageKeyEditorModel.partialSave",
            defaultMessage: "Project details were saved, but the prefix was not changed. {reason}",
          },
          { reason: saveFailure.message },
        )
      : saveFailure.message;
  }

  const renameImpactReady = !renamed || settingsStatus === "ready";
  const namespaceReady = !expanded || settingsStatus === "ready";
  const canSubmit = !renamed ? namespaceReady : valid && confirmed && renameImpactReady;
  return {
    prefix: confirmed ? preview.prefix : prefix,
    canSubmit,
    statusText,
    prefixError,
    formError,
    impactText,
    history:
      expanded && settings
        ? settings.retiredPrefixes.map((retired) => ({
            prefix: retired.prefix,
            detail: getIntl().formatMessage(
              {
                id: "lib.projectPageKeyEditorModel.retiredRange",
                defaultMessage: "Numbers through {count} still resolve",
              },
              { count: retired.lastNumber },
            ),
          }))
        : [],
    suggestedPrefix: preview.kind === "reserved" ? preview.alternativePrefix : null,
  };
}
