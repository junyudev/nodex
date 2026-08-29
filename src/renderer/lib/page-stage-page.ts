import type { LibraryPageDetail, PageDetail } from "../../shared/page-detail";
import type { DatabasePageLayoutV2 } from "../../shared/database-module-v2";
import type { PageRunInTarget, RecurrenceConfig, ReminderConfig } from "../../shared/types";
import type { PortableRichText } from "../../shared/block-documents/portable-rich-text";
import {
  buildPageStageDataSourceProperties,
  readPageStageSemanticProperties,
  type PageStageDataSourceProperty,
  type PageStageSemanticProperties,
} from "./page-stage-properties";

const RUN_TARGETS = new Set<PageRunInTarget>(["localProject", "newWorktree", "cloud"]);

export interface PageStageCorePage {
  readonly id: string;
  readonly pageKey: string | null;
  readonly archived: boolean;
  readonly title: string;
  readonly richTitle: PortableRichText;
  readonly isAllDay: boolean;
  readonly recurrence?: RecurrenceConfig;
  readonly reminders: readonly ReminderConfig[];
  readonly scheduleTimezone?: string;
  readonly runInTarget?: PageRunInTarget;
  readonly runInLocalPath?: string;
  readonly runInBaseBranch?: string;
  readonly runInWorktreePath?: string;
  readonly runInEnvironmentPath?: string;
  readonly revision: number;
  readonly created: Date;
}

export type PageStageDatabaseContext =
  | { readonly kind: "standalone" }
  | {
      readonly kind: "member";
      readonly membership: {
        readonly id: string;
        readonly dataSourceId: string;
        readonly databaseId: string;
        readonly revision: number;
      };
      readonly properties: readonly PageStageDataSourceProperty[];
      readonly semanticProperties: PageStageSemanticProperties;
      readonly pageLayout: DatabasePageLayoutV2;
    };

export interface PageStagePageModel {
  readonly page: PageStageCorePage;
  readonly databaseContext: PageStageDatabaseContext;
}

export type PageStageMetadataMutationResult =
  | { readonly status: "updated"; readonly didMutate: boolean }
  | { readonly status: "conflict" }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly error: string };

export class PageStagePageProjectionError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PageStagePageProjectionError";
  }
}

const requireIntrinsic = (detail: PageDetail | LibraryPageDetail, key: string) => {
  const property = detail.intrinsicProperties.find((candidate) => candidate.key === key);
  if (property) return property;
  throw new PageStagePageProjectionError(
    `Page ${detail.page.pageId} is missing intrinsic property ${key}`,
  );
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === null) return undefined;
  if (typeof value === "string") return value || undefined;
  throw new PageStagePageProjectionError(`${label} must be a string or null`);
};

const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === "boolean") return value;
  throw new PageStagePageProjectionError(`${label} must be a boolean`);
};

const recurrence = (value: unknown): RecurrenceConfig | undefined => {
  if (value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageStagePageProjectionError("Page recurrence must be an object or null");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    candidate.frequency !== "daily" &&
    candidate.frequency !== "weekly" &&
    candidate.frequency !== "monthly" &&
    candidate.frequency !== "yearly"
  ) {
    throw new PageStagePageProjectionError("Page recurrence frequency is invalid");
  }
  if (!Number.isInteger(candidate.interval) || (candidate.interval as number) < 1) {
    throw new PageStagePageProjectionError("Page recurrence interval is invalid");
  }
  return value as RecurrenceConfig;
};

const reminders = (value: unknown): readonly ReminderConfig[] => {
  if (!Array.isArray(value)) {
    throw new PageStagePageProjectionError("Page reminders must be an array");
  }
  return value.map((entry, index) => {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as { readonly offsetMinutes?: unknown }).offsetMinutes === "number" &&
      Number.isFinite((entry as { readonly offsetMinutes: number }).offsetMinutes)
    ) {
      return {
        offsetMinutes: (entry as { readonly offsetMinutes: number }).offsetMinutes,
      };
    }
    throw new PageStagePageProjectionError(`Page reminder ${index} is invalid`);
  });
};

export const projectPageDetailToStageModel = (
  detail: PageDetail | LibraryPageDetail,
): PageStagePageModel => {
  const runTargetValue = requireIntrinsic(detail, "run.target").value;
  if (runTargetValue !== null && !RUN_TARGETS.has(runTargetValue as PageRunInTarget)) {
    throw new PageStagePageProjectionError("Page run target is invalid");
  }
  const created = new Date(detail.page.createdAt);
  if (Number.isNaN(created.getTime())) {
    throw new PageStagePageProjectionError("Page created timestamp is invalid");
  }
  const page: PageStageCorePage = {
    id: detail.page.pageId,
    pageKey:
      detail.dataSourceContext.kind === "member"
        ? (detail.dataSourceContext.pageKey ?? null)
        : null,
    archived: detail.page.lifecycle === "archived",
    title: detail.page.title,
    richTitle: detail.page.richTitle,
    isAllDay: requireBoolean(
      requireIntrinsic(detail, "schedule.isAllDay").value,
      "Page all-day state",
    ),
    recurrence: recurrence(requireIntrinsic(detail, "recurrence.config").value),
    reminders: reminders(requireIntrinsic(detail, "reminders.config").value),
    scheduleTimezone: optionalString(
      requireIntrinsic(detail, "schedule.timezone").value,
      "Page schedule timezone",
    ),
    ...(runTargetValue === null ? {} : { runInTarget: runTargetValue as PageRunInTarget }),
    runInLocalPath: optionalString(
      requireIntrinsic(detail, "run.localPath").value,
      "Page local path",
    ),
    runInBaseBranch: optionalString(
      requireIntrinsic(detail, "run.baseBranch").value,
      "Page base branch",
    ),
    runInWorktreePath: optionalString(
      requireIntrinsic(detail, "run.worktreePath").value,
      "Page worktree path",
    ),
    runInEnvironmentPath: optionalString(
      requireIntrinsic(detail, "run.environmentPath").value,
      "Page environment path",
    ),
    revision: detail.page.metadataRevision,
    created,
  };

  if (detail.dataSourceContext.kind === "standalone") {
    return { page, databaseContext: { kind: "standalone" } };
  }
  const properties = buildPageStageDataSourceProperties(detail);
  return {
    page,
    databaseContext: {
      kind: "member",
      membership: {
        id: detail.dataSourceContext.membership.membershipId,
        dataSourceId: detail.dataSourceContext.membership.dataSourceId,
        databaseId: detail.dataSourceContext.database.databaseId,
        revision: detail.dataSourceContext.membership.revision,
      },
      properties,
      semanticProperties: readPageStageSemanticProperties(properties),
      pageLayout: detail.dataSourceContext.pageLayout,
    },
  };
};
