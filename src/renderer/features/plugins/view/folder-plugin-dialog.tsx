import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { localPathPresentationContextQueryOptions } from "@/lib/query-options";
import { abbreviateHomeDirectory } from "../../../../shared/local-path-presentation";
import type {
  FolderPluginPreview,
  FolderPluginPreviewResult,
  PluginSelector,
} from "../../../../shared/codex-plugin-management";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { describeAgentSupport } from "../model/plugin-agent-support";
import { usePluginManagement, type PluginContext } from "../plugin-management";
import { PluginLogoTile } from "./plugin-logo";

export interface InstalledFolderPlugin {
  readonly pluginId: string;
  readonly selector: PluginSelector;
}

type DialogState =
  | { readonly kind: "reading" }
  | { readonly kind: "result"; readonly result: FolderPluginPreviewResult }
  | { readonly kind: "failed"; readonly message: string };

/** One label/value line of the review. Values wrap; labels hold a fixed column. */
function ReviewRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 py-1 text-sm leading-5">
      <dt className="text-token-description-foreground">{label}</dt>
      <dd className="m-0 min-w-0 wrap-anywhere text-token-foreground">{children}</dd>
    </div>
  );
}

function PreviewBody({
  preview,
  folderLabel,
}: {
  readonly preview: FolderPluginPreview;
  readonly folderLabel: string;
}) {
  const title = preview.displayName ?? preview.name;
  const byline = [preview.version, preview.developer].filter(Boolean).join(" · ");
  const { agents, codexOnly } = describeAgentSupport(preview.agentSupport);
  return (
    <>
      <div className="flex items-center gap-3">
        <PluginLogoTile source={{ logoUrl: preview.logoUrl, logoDarkUrl: null, name: title }} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-base font-medium text-token-foreground">{title}</span>
          <span className="truncate text-sm text-token-description-foreground">
            {byline || folderLabel}
          </span>
        </div>
      </div>
      {preview.description == null ? null : (
        <p className="line-clamp-3 text-sm text-token-text-secondary">{preview.description}</p>
      )}
      {preview.replacesPluginId == null ? null : (
        <p className="text-sm text-token-text-secondary">
          This replaces the installed copy of {title}.
        </p>
      )}
      <dl className="flex flex-col">
        {preview.skills.length === 0 ? null : (
          <ReviewRow label="Skills">
            {preview.skills.map((skill) => skill.name).join(", ")}
          </ReviewRow>
        )}
        {preview.mcpServers.length === 0 ? null : (
          <ReviewRow label="Runs">
            <ul className="flex flex-col gap-1">
              {preview.mcpServers.map((server) => (
                <li key={server.key} className="min-w-0">
                  <span className="text-token-foreground">{server.key}</span>{" "}
                  <code className="font-mono text-xs break-all text-token-description-foreground">
                    {server.launch}
                  </code>
                </li>
              ))}
            </ul>
          </ReviewRow>
        )}
        {preview.hookCount === 0 ? null : (
          <ReviewRow label="Hooks">
            {preview.hookCount === 1 ? "1 hook" : `${preview.hookCount} hooks`}, reviewed in Codex
            before they run
          </ReviewRow>
        )}
        {preview.connectedAppCount === 0 ? null : (
          <ReviewRow label="Apps">
            {preview.connectedAppCount === 1
              ? "1 connected app"
              : `${preview.connectedAppCount} connected apps`}
          </ReviewRow>
        )}
        <ReviewRow label="Agents">
          {agents}
          {codexOnly == null ? null : (
            <span className="block text-token-description-foreground">{codexOnly}</span>
          )}
        </ReviewRow>
      </dl>
      {preview.warnings.length === 0 ? null : (
        <details className="text-sm text-token-description-foreground">
          <summary className="cursor-interaction select-none hover:text-token-foreground">
            {preview.warnings.length === 1 ? "1 warning" : `${preview.warnings.length} warnings`}
          </summary>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-5">
            {preview.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * Reviews a folder before it is installed as a plugin. Nodex copies the folder first, so the
 * person reviews and installs the same files; closing the dialog discards the copy.
 */
function FolderPluginDialog({
  context,
  folder,
  onDone,
  onInstalled,
}: {
  readonly context: PluginContext;
  readonly folder: string;
  readonly onDone: () => void;
  readonly onInstalled: (installed: InstalledFolderPlugin) => void;
}) {
  const management = usePluginManagement(context);
  const pathContext = useQuery(localPathPresentationContextQueryOptions()).data ?? null;
  const [state, setState] = useState<DialogState>({ kind: "reading" });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const staged = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    void management.prepareFolder({ folder }).then((result) => {
      if (pluginMutationSucceeded(result)) {
        const value = result.value;
        if (value.status === "ready") staged.current = value.preview.stagingId;
        if (current) setState({ kind: "result", result: value });
        else if (value.status === "ready")
          void management.discardFolder({ stagingId: value.preview.stagingId });
      } else if (current) {
        setState({ kind: "failed", message: result.error.message });
      }
    });
    return () => {
      current = false;
    };
    // The folder identifies one review; management is recreated on every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Prepare once per folder.
  }, [folder]);

  const close = () => {
    if (installing) return;
    if (staged.current != null) void management.discardFolder({ stagingId: staged.current });
    staged.current = null;
    onDone();
  };

  const install = async (preview: FolderPluginPreview) => {
    setInstalling(true);
    setInstallError(null);
    const result = await management.installFolder({ stagingId: preview.stagingId });
    setInstalling(false);
    if (!pluginMutationSucceeded(result)) {
      // The reviewed copy stays staged, so the person can try again or cancel.
      setInstallError(result.error.message);
      return;
    }
    staged.current = null;
    toast.success(`${preview.displayName ?? preview.name} plugin installed`);
    onInstalled(result.value);
    onDone();
  };

  const folderLabel = abbreviateHomeDirectory(folder, pathContext);
  const preview =
    state.kind === "result" && state.result.status === "ready" ? state.result.preview : null;
  const title =
    state.kind === "result" && state.result.status === "rejected"
      ? "This folder isn’t a plugin"
      : state.kind === "failed"
        ? "Couldn’t add this plugin"
        : "Add plugin from folder";

  return (
    <NodexDialog
      open
      disablePointerDismissal={installing}
      onOpenChange={(next, details) => {
        if (installing) {
          details.cancel();
          return;
        }
        if (!next) close();
      }}
    >
      <NodexDialogContent showCloseButton={!installing}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>{title}</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody className="gap-3">
            {state.kind === "reading" ? (
              <div
                role="status"
                className="flex items-center gap-2 py-6 text-sm text-token-description-foreground"
              >
                <ActivitySpinnerIcon className="icon-xs" />
                Reading {folderLabel}
              </div>
            ) : preview != null ? (
              <>
                <PreviewBody preview={preview} folderLabel={folderLabel} />
                {installError == null ? null : (
                  <p role="alert" className="text-sm text-danger">
                    {installError}
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-2 text-sm">
                <span className="font-mono text-xs break-all text-token-description-foreground">
                  {folderLabel}
                </span>
                {state.kind === "failed" ? (
                  <p role="alert" className="text-danger">
                    {state.message}
                  </p>
                ) : state.result.status === "rejected" ? (
                  <ul className="flex list-disc flex-col gap-0.5 ps-5 text-token-foreground">
                    {state.result.reasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction disabled={installing} onClick={close}>
              {preview == null && state.kind !== "reading" ? "Close" : "Cancel"}
            </NodexDialogAction>
            {preview == null ? null : (
              <NodexDialogAction
                tone="primary"
                disabled={installing}
                aria-busy={installing || undefined}
                onClick={() => void install(preview)}
              >
                {installing ? "Installing" : "Install"}
              </NodexDialogAction>
            )}
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/**
 * "Add › From folder…": picks a folder, then reviews and installs it. Returns the action that
 * starts the flow and the dialog element to render.
 */
export function useAddPluginFromFolder(
  context: PluginContext,
  onInstalled: (installed: InstalledFolderPlugin) => void,
): { readonly start: () => void; readonly dialog: ReactNode } {
  const management = usePluginManagement(context);
  const [folder, setFolder] = useState<string | null>(null);
  const start = () => {
    void management.pickFolder().then((picked) => {
      if (picked != null) setFolder(picked);
    });
  };
  return {
    start,
    dialog:
      folder == null ? null : (
        <FolderPluginDialog
          key={folder}
          context={context}
          folder={folder}
          onDone={() => setFolder(null)}
          onInstalled={onInstalled}
        />
      ),
  };
}
