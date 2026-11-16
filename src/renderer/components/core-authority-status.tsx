import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { AlertTriangle } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { AppStatusNotice, AppStatusNoticeAction } from "@/components/app-status-notice";

import type { CoreAuthorityStatus } from "../../shared/core-authority-status";

export interface CoreAuthorityStatusPresentation {
  readonly detail: string | null;
  readonly kind: "recovering" | "unavailable";
  readonly label: string;
}

export const resolveCoreAuthorityStatusPresentation = (
  status: CoreAuthorityStatus,
  intl: IntlShape = getIntl(),
): CoreAuthorityStatusPresentation | null => {
  if (status.kind === "ready") return null;
  if (status.kind === "recovering") {
    return {
      detail: null,
      kind: "recovering",
      label: intl.formatMessage({
        id: "components.coreAuthorityStatus.reconnecting",
        defaultMessage: "Reconnecting to Nodex Core…",
      }),
    };
  }
  return {
    detail: status.message,
    kind: "unavailable",
    label: intl.formatMessage({
      id: "components.coreAuthorityStatus.unavailable",
      defaultMessage: "Nodex Core is unavailable",
    }),
  };
};

export function CoreAuthorityStatusNotice({
  status,
  onRelaunch,
  onRetry,
}: {
  readonly status: CoreAuthorityStatus;
  readonly onRelaunch: () => void;
  readonly onRetry: () => void;
}) {
  const intl = useIntl();
  const presentation = resolveCoreAuthorityStatusPresentation(status, intl);
  if (!presentation) return null;

  return (
    <AppStatusNotice
      actions={
        presentation.kind === "unavailable" ? (
          <>
            <AppStatusNoticeAction onClick={onRetry}>
              {intl.formatMessage({
                id: "components.coreAuthorityStatus.retry",
                defaultMessage: "Retry",
              })}
            </AppStatusNoticeAction>
            <AppStatusNoticeAction onClick={onRelaunch} subdued>
              {intl.formatMessage({
                id: "components.coreAuthorityStatus.restart",
                defaultMessage: "Restart Nodex",
              })}
            </AppStatusNoticeAction>
          </>
        ) : null
      }
      detail={presentation.detail}
      icon={
        presentation.kind === "recovering" ? (
          <ActivitySpinnerIcon className="icon-2xs shrink-0 text-token-description-foreground" />
        ) : (
          <AlertTriangle className="icon-2xs shrink-0 text-[var(--color-text-warning)]" />
        )
      }
      label={presentation.label}
      urgent={presentation.kind === "unavailable"}
    />
  );
}
