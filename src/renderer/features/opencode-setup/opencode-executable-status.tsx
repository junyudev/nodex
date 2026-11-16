import { useIntl, type IntlShape } from "@/lib/i18n";
import { useEffect, type ReactNode } from "react";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { cn } from "@/lib/utils";
import { openOpenCodeInstallDialog } from "./opencode-install-dialog";
import {
  formatInstallProgress,
  openCodeExecutableStatusAction,
  openCodeInstallView,
  type OpenCodeInstallView,
} from "./opencode-setup-model";
import type { OpenCodeSetupOwner } from "./opencode-setup-owner";
import { useOpenCodeSetup } from "./use-opencode-setup";

function statusText(view: OpenCodeInstallView, intl: IntlShape): ReactNode {
  switch (view.kind) {
    case "loading":
      return null;
    case "idle":
      return intl.formatMessage({
        id: "opencodeSetup.opencodeExecutableStatus.notInstalled",
        defaultMessage: "Not installed",
      });
    case "running":
      return [
        intl.formatMessage({
          id: "opencodeSetup.opencodeExecutableStatus.installing",
          defaultMessage: "Installing…",
        }),
        formatInstallProgress(view.log.progress),
      ]
        .filter(Boolean)
        .join(" ");
    case "ready":
      return (
        <>
          OpenCode {view.version} · <span className="font-code">{view.binaryPath}</span>
        </>
      );
    case "outdated":
      return (
        <>
          {intl.formatMessage(
            {
              id: "opencodeSetup.opencodeExecutableStatus.upgrade",
              defaultMessage:
                "OpenCode {version} needs {minimumVersion} or newer. Update it with <code>opencode upgrade</code>.",
            },
            {
              version: view.version,
              minimumVersion: view.minimumVersion,
              code: (chunks) => <code className="font-code">{chunks}</code>,
            },
          )}
        </>
      );
    case "unreadable":
    case "unusable":
    case "failed":
      return view.message;
  }
}

/** The saved default executable's host status, with at most one next step. */
export function OpenCodeExecutableStatus({
  owner,
  open,
}: {
  readonly owner: OpenCodeSetupOwner;
  readonly open: boolean;
}) {
  const intl = useIntl();
  const snapshot = useOpenCodeSetup(owner, true);
  const appHandle = useScopeHandle(appScope);
  // Settings re-check the host each time they open, catching installs made outside Nodex.
  useEffect(() => {
    if (open) owner.refresh();
  }, [open, owner]);
  const view = openCodeInstallView(snapshot);
  const action = openCodeExecutableStatusAction(view, intl);
  const text = statusText(view, intl);
  if (!text && !action) return null;
  return (
    <span>
      <span className={cn(view.kind === "failed" && "text-danger")}>{text}</span>
      {text && action ? <span aria-hidden="true"> · </span> : null}
      {action ? (
        <button
          type="button"
          className="cursor-interaction text-token-foreground underline-offset-2 hover:underline"
          onClick={() => {
            if (action.kind === "refresh") owner.refresh();
            else openOpenCodeInstallDialog(appHandle, { owner });
          }}
        >
          {action.label}
        </button>
      ) : null}
    </span>
  );
}
