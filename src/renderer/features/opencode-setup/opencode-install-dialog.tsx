import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { OpenCodeIcon, SuccessCircleIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { CodexShimmerText } from "@/features/local-conversation/view/shared/codex-shimmer-text";
import { ThreadExecShellContainer } from "@/features/local-conversation/view/shared/tools/thread-command-shell-block";
import type { ScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import type { OpenCodeInstallerLog } from "../../../shared/opencode-setup";
import {
  formatInstallProgress,
  openCodeInstallView,
  type OpenCodeInstallView,
} from "./opencode-setup-model";
import type { OpenCodeSetupOwner } from "./opencode-setup-owner";

export interface OpenCodeInstallDialogProps extends ModalCloseProps {
  readonly owner: OpenCodeSetupOwner;
  /** Supplied by a model menu that can reopen with the newly available models. */
  readonly onShowModels?: () => void;
}

/** Opens the shared installation surface; only its Install action starts the official command. */
export function openOpenCodeInstallDialog(
  appHandle: ScopeHandle,
  input: { readonly owner: OpenCodeSetupOwner; readonly onShowModels?: () => void },
): void {
  openModal(appHandle, OpenCodeInstallDialog, {
    owner: input.owner,
    onShowModels: input.onShowModels,
  });
}

function InstallProgress({ progress }: { readonly progress: number | null }) {
  const percent = progress === null ? null : Math.round(progress * 100);
  return (
    <div
      role="progressbar"
      aria-label="Installation progress"
      {...(percent === null
        ? {}
        : { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent })}
      className="h-0.5 w-full overflow-hidden bg-text/10"
    >
      {percent === null ? (
        <div className="size-full bg-text-info/50 motion-safe:animate-pulse" />
      ) : (
        <div
          className="h-full bg-text-info transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}

/** The exact command and its real output; shown before running, while running, and after. */
function InstallerShell({
  command,
  log,
  running,
}: {
  readonly command: string;
  readonly log: OpenCodeInstallerLog | null;
  readonly running: boolean;
}) {
  return (
    <ThreadExecShellContainer
      surface="plain"
      command={command}
      output={log?.lines.join("\n") ?? ""}
      // Before output arrives the block stays empty instead of claiming the command printed nothing.
      isInProgress={running || log === null}
      autoScrollToBottom
      footer={running && log ? <InstallProgress progress={log.progress} /> : null}
    />
  );
}

const showsShell = (
  view: OpenCodeInstallView,
): view is Extract<OpenCodeInstallView, { readonly command: string }> =>
  view.kind === "idle" ||
  view.kind === "running" ||
  ("log" in view && view.log !== null && view.log.lines.length > 0);

function OutcomeLine({
  tone,
  children,
}: {
  readonly tone: "default" | "danger";
  readonly children: ReactNode;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={tone === "danger" ? "text-sm text-danger" : "text-sm text-token-text-secondary"}
    >
      {children}
    </p>
  );
}

function ViewOutcome({ view }: { readonly view: OpenCodeInstallView }) {
  switch (view.kind) {
    case "loading":
      return <OutcomeLine tone="default">Checking OpenCode…</OutcomeLine>;
    case "unreadable":
      return <OutcomeLine tone="danger">{view.message}</OutcomeLine>;
    case "idle":
      return view.supported ? null : (
        <OutcomeLine tone="default">OpenCode installation requires macOS or Linux.</OutcomeLine>
      );
    case "running":
      return view.cancelError ? <OutcomeLine tone="danger">{view.cancelError}</OutcomeLine> : null;
    case "ready":
      return null;
    case "outdated":
      return (
        <OutcomeLine tone="default">
          OpenCode {view.version} is installed, but Nodex needs {view.minimumVersion} or newer.
          Update it with <code className="font-code">opencode upgrade</code>.
        </OutcomeLine>
      );
    case "unusable":
      return <OutcomeLine tone="default">{view.message}</OutcomeLine>;
    case "failed":
      return <OutcomeLine tone="danger">{view.message}</OutcomeLine>;
  }
}

export function OpenCodeInstallDialog({
  owner,
  onShowModels,
  onClose,
}: OpenCodeInstallDialogProps) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  useEffect(() => owner.retainViewer(), [owner]);
  const view = openCodeInstallView(snapshot);
  const close = (
    <NodexDialogAction
      tone={view.kind === "failed" && !view.retryable ? "primary" : "ghost"}
      onClick={onClose}
    >
      Close
    </NodexDialogAction>
  );
  const done = (
    <NodexDialogAction tone="primary" onClick={onClose}>
      Done
    </NodexDialogAction>
  );
  let status: ReactNode = null;
  let actions: ReactNode = null;
  switch (view.kind) {
    case "loading":
      break;
    case "unreadable":
      actions = (
        <>
          {close}
          <NodexDialogAction tone="primary" onClick={owner.refresh}>
            Try again
          </NodexDialogAction>
        </>
      );
      break;
    case "idle":
      actions = (
        <>
          {close}
          <NodexDialogAction
            tone="primary"
            disabled={!view.supported}
            onClick={() => void owner.install()}
          >
            Install
          </NodexDialogAction>
        </>
      );
      break;
    case "running": {
      const progress = formatInstallProgress(view.log.progress);
      status = view.cancelling ? (
        <span>Cancelling…</span>
      ) : (
        <span className="flex items-center gap-1.5">
          <CodexShimmerText>Installing…</CodexShimmerText>
          {progress ? <span className="tabular-nums">{progress}</span> : null}
        </span>
      );
      actions = (
        <NodexDialogAction
          disabled={view.cancelling}
          onClick={async () => {
            await owner.cancel();
            // A refused cancel keeps the dialog open with its reason beside the running output.
            if (owner.getSnapshot().requestError?.request !== "cancel") onClose();
          }}
        >
          Cancel
        </NodexDialogAction>
      );
      break;
    }
    case "ready":
      status = (
        <span role="status" className="flex items-center gap-1.5 text-info">
          <SuccessCircleIcon className="icon-xs" />
          <span className="tabular-nums">OpenCode {view.version} is ready</span>
        </span>
      );
      actions = onShowModels ? (
        <NodexDialogAction
          tone="primary"
          onClick={() => {
            onClose();
            onShowModels();
          }}
        >
          Show free models
        </NodexDialogAction>
      ) : (
        done
      );
      break;
    case "outdated":
    case "unusable":
      actions = done;
      break;
    case "failed":
      actions = view.retryable ? (
        <>
          {close}
          <NodexDialogAction tone="primary" onClick={() => void owner.install()}>
            Retry
          </NodexDialogAction>
        </>
      ) : (
        close
      );
      break;
  }

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="default">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle className="flex items-center gap-2">
              <OpenCodeIcon />
              Install OpenCode
            </NodexDialogTitle>
            {showsShell(view) ? (
              <NodexDialogDescription>
                Runs OpenCode’s official installer, which adds{" "}
                <code className="font-code">opencode</code> to your shell PATH.
              </NodexDialogDescription>
            ) : null}
          </NodexDialogHeader>
          <NodexDialogBody className="gap-2">
            {showsShell(view) ? (
              <InstallerShell
                command={view.command}
                log={"log" in view ? view.log : null}
                running={view.kind === "running"}
              />
            ) : null}
            <ViewOutcome view={view} />
          </NodexDialogBody>
          {status || actions ? (
            <NodexDialogFooter className="justify-between">
              <div className="min-w-0 text-sm text-token-text-secondary">{status}</div>
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            </NodexDialogFooter>
          ) : null}
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
