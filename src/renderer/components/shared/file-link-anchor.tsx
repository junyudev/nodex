import {
  createContext,
  useContext,
  useMemo,
  type MouseEventHandler,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { type FileLinkTarget } from "../../../shared/file-link-openers";
import { NodexTooltip } from "@/components/ui/tooltip";
import { writeTextToClipboard } from "@/lib/clipboard";
import {
  getFileReferenceOpenWithMenuItems,
  parseFileReferenceOpenWithMenuId,
  resolveFileReferenceTarget,
  useFileReferenceRouter,
} from "@/lib/file-reference-router";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import { resolveNfmLinkAction, resolveNfmLinkTooltipLabel } from "@/lib/nfm-link-actions";
import { cn } from "@/lib/utils";
import { readWorkspaceFileText } from "@/lib/workspace-file-operations";

export interface FileLinkWorkspaceContextValue {
  cwd?: string | null;
  workspacePath?: string | null;
}

export const FileLinkWorkspaceContext = createContext<FileLinkWorkspaceContextValue | undefined>(
  undefined,
);

export function FileLinkWorkspaceProvider({
  children,
  cwd,
  workspacePath,
}: {
  children: ReactNode;
  cwd?: string | null;
  workspacePath?: string | null;
}) {
  const value = useMemo(() => ({ cwd, workspacePath }), [cwd, workspacePath]);
  return (
    <FileLinkWorkspaceContext.Provider value={value}>{children}</FileLinkWorkspaceContext.Provider>
  );
}

interface FileLinkAnchorProps {
  href?: string;
  className?: string;
  children: ReactNode;
  showLocalFileTooltip?: boolean;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
}

function readLinkLabel(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  return "Open file";
}

function isFileAction(action: ReturnType<typeof resolveNfmLinkAction>): action is Extract<
  ReturnType<typeof resolveNfmLinkAction>,
  {
    kind: "local-file" | "workspace-file";
  }
> {
  return action?.kind === "local-file" || action?.kind === "workspace-file";
}

const OPEN_WITH_PREFIX = "file-reference:open-with:";

export interface FileReferenceContextMenuRequest {
  hostId?: string;
  target: FileLinkTarget;
  label: string;
  open: ReturnType<typeof useFileReferenceRouter>["open"];
  x: number;
  y: number;
  isCurrent?: () => boolean;
}

const isCurrentReference = () => true;

export async function openFileReferenceContextMenu({
  hostId = "local",
  target,
  label,
  open,
  x,
  y,
  isCurrent = isCurrentReference,
}: FileReferenceContextMenuRequest): Promise<void> {
  if (!isCurrent()) return;
  const selected = await showNativeContextMenu(
    [
      {
        id: "file-reference:open",
        label: "Open in Files",
        iconKey: "folder",
      },
      {
        id: "file-reference:open-with",
        label: "Open with",
        iconKey: "window",
        type: "submenu",
        enabled: hostId === "local",
        submenu: getFileReferenceOpenWithMenuItems(),
      },
      { type: "separator" },
      {
        id: "file-reference:copy-path",
        label: "Copy path",
        iconKey: "copy",
      },
      {
        id: "file-reference:copy-contents",
        label: "Copy contents",
        iconKey: "copy",
      },
      { type: "separator" },
      {
        id: "file-reference:reveal",
        label: "Reveal in Finder",
        iconKey: "folder",
        enabled: hostId === "local",
      },
    ],
    { x, y },
  );

  if (!selected || !isCurrent()) return;
  if (selected === "file-reference:open") {
    await open(target, { title: label, mode: "preview" });
    return;
  }
  if (selected === "file-reference:copy-path") {
    await writeTextToClipboard(target.path);
    return;
  }
  if (selected === "file-reference:copy-contents") {
    try {
      const result = await readWorkspaceFileText({
        hostId,
        path: target.path,
        maxBytes: 2 * 1024 * 1024,
      });
      if (!isCurrent()) return;
      await writeTextToClipboard(result.contents);
    } catch {
      // A native menu action should not turn a transient read failure into a
      // renderer error; the Files panel remains the full-fidelity fallback.
    }
    return;
  }
  if (selected === "file-reference:reveal") {
    if (hostId !== "local") return;
    await open(target, { external: true, opener: "fileManager" });
    return;
  }
  if (selected.startsWith(OPEN_WITH_PREFIX)) {
    if (hostId !== "local") return;
    const opener = parseFileReferenceOpenWithMenuId(selected);
    if (opener) await open(target, { external: true, opener });
  }
}

async function handleFileReferenceContextMenu(
  event: ReactMouseEvent<HTMLElement>,
  request: Omit<FileReferenceContextMenuRequest, "x" | "y">,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  await openFileReferenceContextMenu({
    ...request,
    x: event.clientX,
    y: event.clientY,
  });
}

export function FileLinkAnchor({
  href,
  className,
  children,
  cwd: explicitCwd,
  showLocalFileTooltip = false,
  projectWorkspacePath,
}: FileLinkAnchorProps) {
  const inheritedWorkspacePath = useContext(FileLinkWorkspaceContext);
  const router = useFileReferenceRouter();
  const workspacePath =
    projectWorkspacePath ?? inheritedWorkspacePath?.workspacePath ?? router.workspaceRoot;
  const cwd = explicitCwd ?? inheritedWorkspacePath?.cwd ?? workspacePath;
  const action = resolveNfmLinkAction(href, cwd);
  const tooltipLabel = resolveNfmLinkTooltipLabel(action, showLocalFileTooltip);
  const label = readLinkLabel(children);

  if (!isFileAction(action)) {
    const handleClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
      if (!action || action.kind === "literal-anchor") return;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === "blocked" || action.kind === "unresolved-file-like") return;
      if (action.kind === "web-url") {
        window.open(action.url, "_blank", "noopener,noreferrer");
      }
    };

    const link = (
      <a
        href={href}
        data-agent-activity-file-link
        onClick={handleClick}
        aria-disabled={
          action?.kind === "blocked" || action?.kind === "unresolved-file-like" ? true : undefined
        }
        className={cn(
          "cursor-interaction inline-block max-w-full appearance-none border-0 bg-transparent p-0 text-left align-baseline whitespace-normal text-token-text-link-foreground hover:underline",
          action?.kind === "blocked" || action?.kind === "unresolved-file-like"
            ? "cursor-not-allowed"
            : "",
          className,
        )}
        target={action?.kind === "literal-anchor" ? undefined : "_blank"}
        rel={action?.kind === "literal-anchor" ? undefined : "noopener noreferrer"}
      >
        <span className="break-words whitespace-normal" data-state="closed">
          {children}
        </span>
      </a>
    );

    if (!tooltipLabel) return link;
    return (
      <NodexTooltip
        tooltipContent={tooltipLabel}
        side="top"
        delay={0}
        tooltipBodyClassName="font-mono text-xs leading-4"
      >
        {link}
      </NodexTooltip>
    );
  }

  return (
    <FileReferenceButton
      target={action.target}
      href={action.href}
      className={className}
      label={label}
      cwd={cwd}
      projectWorkspacePath={workspacePath}
      tooltipLabel={tooltipLabel}
    >
      {children}
    </FileReferenceButton>
  );
}

/** A resolved native reference bypasses href decoding and retains the Files interaction owner. */
export function FileReferenceButton({
  target,
  href,
  label,
  children,
  className,
  cwd: explicitCwd,
  projectWorkspacePath,
  hostId: explicitHostId,
  tooltipLabel,
  isCurrent: sourceIsCurrent,
}: {
  readonly target: Readonly<FileLinkTarget>;
  readonly href?: string;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
  readonly hostId?: string;
  readonly tooltipLabel?: string | null;
  readonly isCurrent?: () => boolean;
}) {
  const isCurrent = sourceIsCurrent ?? isCurrentReference;
  const inheritedWorkspace = useContext(FileLinkWorkspaceContext);
  const router = useFileReferenceRouter();
  const hostId = explicitHostId ?? router.hostId;
  const workspacePath =
    projectWorkspacePath !== undefined
      ? projectWorkspacePath
      : (inheritedWorkspace?.workspacePath ?? router.workspaceRoot);
  const cwd = explicitCwd !== undefined ? explicitCwd : (inheritedWorkspace?.cwd ?? workspacePath);
  const resolvedTarget = resolveFileReferenceTarget(target, cwd ?? workspacePath);
  const open = (options?: Parameters<typeof router.open>[1]) => {
    if (!resolvedTarget || !isCurrent()) return;
    void router.open(resolvedTarget, {
      hostId,
      cwd,
      workspaceRoot: workspacePath,
      title: label,
      ...(sourceIsCurrent ? { isCurrent } : {}),
      ...options,
    });
  };
  if (!resolvedTarget) return <>{children}</>;
  const fileReference = (
    <button
      type="button"
      data-file-reference="true"
      data-agent-activity-file-link
      data-prompt-link-href={href}
      data-prompt-link-label={label}
      className={cn(
        "cursor-interaction inline-block max-w-full appearance-none border-0 bg-transparent p-0 text-left align-baseline whitespace-normal text-token-text-link-foreground hover:underline focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none",
        className,
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open({
          external: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey,
          mode: "preview",
        });
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open({ mode: "durable" });
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        open({ external: true });
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          void openFileReferenceContextMenu({
            hostId,
            target: resolvedTarget,
            label,
            isCurrent,
            open: async (nextTarget, options) =>
              isCurrent() &&
              router.open(nextTarget, {
                hostId,
                cwd,
                workspaceRoot: workspacePath,
                title: label,
                ...(sourceIsCurrent ? { isCurrent } : {}),
                ...options,
              }),
            x: bounds.left,
            y: bounds.bottom,
          }).catch(() => undefined);
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        open({ mode: "preview" });
      }}
      onContextMenu={(event) => {
        void handleFileReferenceContextMenu(event, {
          hostId,
          target: resolvedTarget,
          label,
          isCurrent,
          open: async (nextTarget, options) =>
            isCurrent() &&
            router.open(nextTarget, {
              hostId,
              cwd,
              workspaceRoot: workspacePath,
              title: label,
              ...(sourceIsCurrent ? { isCurrent } : {}),
              ...options,
            }),
        }).catch(() => undefined);
      }}
    >
      <span className="break-words whitespace-normal" data-state="closed">
        {children}
      </span>
    </button>
  );

  if (!tooltipLabel) return fileReference;

  return (
    <NodexTooltip
      tooltipContent={tooltipLabel}
      side="top"
      delay={0}
      tooltipBodyClassName="font-mono text-xs leading-4"
    >
      {fileReference}
    </NodexTooltip>
  );
}
