import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRightLgIcon, EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ChevronDownSm16Icon,
  CopyLightIcon,
  SearchInFilesIcon,
} from "@/components/shared/icons/file-viewer-icons";
import { CheckmarkMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { SkillGitHubIcon } from "@/components/shared/icons/skill-fallback-icons";
import { SidePanelFilesIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ViewerButton,
  ViewerCapsule,
  ViewerControlGroup,
  ViewerHeader,
  ViewerIconButton,
  ViewerSplitButton,
} from "@/components/ui/viewer-header";
import { writeTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type {
  WorkspaceFileBreadcrumb,
  WorkspaceFilePathVariants,
} from "./workspace-file-header-model";
import { preferredWorkspaceFileCopyPath } from "./workspace-file-header-model";

const COPIED_FEEDBACK_MS = 2000;

function copyText(value: string) {
  void writeTextToClipboard(value);
}

function WorkspaceFileBreadcrumbNav({ breadcrumb }: { breadcrumb: WorkspaceFileBreadcrumb }) {
  const { segments, title } = breadcrumb;
  return (
    <NodexTooltip tooltipContent={title} delayOpen>
      <nav
        aria-label="File path"
        className="flex h-full min-w-0 items-center overflow-hidden ps-2 pe-1"
      >
        <ol
          className="flex min-w-0 flex-1 items-center gap-1 text-sm semantic-text-secondary select-text"
          onCopy={(event) => {
            // Selecting the whole trail copies it as a path rather than run-together names.
            const selected = event.currentTarget.ownerDocument.getSelection()?.toString();
            if (selected !== segments.join("")) return;
            event.preventDefault();
            event.clipboardData.setData("text/plain", title);
          }}
        >
          {segments.map((segment, index) => {
            const last = index === segments.length - 1;
            return (
              <li
                key={`${index}:${segment}`}
                className={cn("flex items-center", last ? "min-w-0" : "shrink-0 gap-1")}
                data-file-ancestor={last ? undefined : index}
              >
                <span
                  className={
                    last
                      ? "min-w-0 truncate pe-1 font-medium text-(--color-text)"
                      : "whitespace-nowrap"
                  }
                >
                  {segment}
                </span>
                {last ? null : <ChevronRightLgIcon className="shrink-0 text-tertiary" />}
              </li>
            );
          })}
        </ol>
      </nav>
    </NodexTooltip>
  );
}

function CopyPathButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <NodexTooltip tooltipContent={label}>
      <ViewerButton
        aria-label={label}
        uniform
        onClick={() => {
          void writeTextToClipboard(value).then((written) => setCopied(written));
        }}
      >
        {copied ? <CheckmarkMdIcon /> : <CopyLightIcon />}
      </ViewerButton>
    </NodexTooltip>
  );
}

function WorkspaceFilePathActions({
  path,
  variants,
  gitHubUrl,
  onOpenGitHub,
}: {
  path: string;
  variants: WorkspaceFilePathVariants;
  gitHubUrl: string | null;
  onOpenGitHub: (url: string) => void;
}) {
  const copyLabel =
    variants.repoRelative !== null
      ? "Copy repo-relative path"
      : variants.projectRelative !== null
        ? "Copy project-relative path"
        : "Copy path";
  return (
    <>
      <ViewerControlGroup label={copyLabel}>
        <CopyPathButton
          key={preferredWorkspaceFileCopyPath(path, variants)}
          label={copyLabel}
          value={preferredWorkspaceFileCopyPath(path, variants)}
        />
        <NodexDropdownMenu
          align="start"
          contentWidth="menu"
          triggerTooltipContent="Copy path options"
          triggerButton={
            <ViewerButton aria-label="Copy path options" uniform>
              <ChevronDownSm16Icon />
            </ViewerButton>
          }
        >
          <NodexDropdownItem
            disabled={variants.absolute === null}
            onSelect={() => variants.absolute && copyText(variants.absolute)}
          >
            Absolute path
          </NodexDropdownItem>
          <NodexDropdownItem
            disabled={variants.projectRelative === null}
            onSelect={() => variants.projectRelative && copyText(variants.projectRelative)}
          >
            Relative to project
          </NodexDropdownItem>
          <NodexDropdownItem
            disabled={variants.repoRelative === null}
            onSelect={() => variants.repoRelative && copyText(variants.repoRelative)}
          >
            Relative to repo
          </NodexDropdownItem>
        </NodexDropdownMenu>
      </ViewerControlGroup>
      {gitHubUrl ? (
        <ViewerIconButton label="Open in GitHub" onClick={() => onOpenGitHub(gitHubUrl)}>
          <SkillGitHubIcon className="icon-sm" />
        </ViewerIconButton>
      ) : null}
    </>
  );
}

export interface WorkspaceFileViewerOption {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly icon?: ReactNode;
}

export interface WorkspaceFileOpenTarget {
  readonly id: string;
  readonly label: string;
  readonly iconUrl: string | null;
  readonly open: () => void;
}

export interface WorkspaceFileOpenControl {
  /** The target the primary button opens; `null` opens with the system default app. */
  readonly primary: WorkspaceFileOpenTarget | null;
  readonly onOpenDefault: () => void;
  readonly targets: readonly WorkspaceFileOpenTarget[];
  readonly onRevealInFolder: (() => void) | null;
  readonly onOpenGitHub: (() => void) | null;
  readonly onSaveAs: (() => void) | null;
}

function TargetIcon({ url }: { url: string | null }) {
  return url ? <img alt="" className="icon-sm" src={url} /> : null;
}

function WorkspaceFileOpenButton({ control }: { control: WorkspaceFileOpenControl }) {
  const { primary } = control;
  return (
    <ViewerSplitButton
      label={primary ? `Open in ${primary.label}` : "Open"}
      onClick={() => (primary ? primary.open() : control.onOpenDefault())}
      menuLabel="Open options"
      menu={
        <>
          {control.targets.map((target) => (
            <NodexDropdownItem
              key={target.id}
              leftSlot={<TargetIcon url={target.iconUrl} />}
              onSelect={target.open}
            >
              {target.label}
            </NodexDropdownItem>
          ))}
          {control.targets.length > 0 &&
          (control.onRevealInFolder || control.onOpenGitHub || control.onSaveAs) ? (
            <NodexDropdownSeparator />
          ) : null}
          {control.onRevealInFolder ? (
            <NodexDropdownItem onSelect={control.onRevealInFolder}>
              Open in folder
            </NodexDropdownItem>
          ) : null}
          {control.onOpenGitHub ? (
            <NodexDropdownItem onSelect={control.onOpenGitHub}>Open in GitHub</NodexDropdownItem>
          ) : null}
          {control.onSaveAs ? (
            <NodexDropdownItem onSelect={control.onSaveAs}>Save as…</NodexDropdownItem>
          ) : null}
        </>
      }
    >
      {primary?.iconUrl ? <TargetIcon url={primary.iconUrl} /> : null}
      <span className="whitespace-nowrap">Open</span>
    </ViewerSplitButton>
  );
}

function WorkspaceFileOptionsMenu({ options }: { options: readonly WorkspaceFileViewerOption[] }) {
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menu"
      triggerTooltipContent="File viewer options"
      triggerButton={
        <ViewerButton aria-label="File viewer options" uniform>
          <EllipsisIcon />
        </ViewerButton>
      }
    >
      {options.map((option) => (
        <NodexDropdownItem key={option.id} leftSlot={option.icon} onSelect={option.onSelect}>
          {option.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

export interface WorkspaceFileControlsProps {
  readonly onSearchInFiles: (() => void) | null;
  readonly options: readonly WorkspaceFileViewerOption[];
  readonly open: WorkspaceFileOpenControl | null;
  readonly fileTree: { readonly visible: boolean; readonly onToggle: () => void } | null;
}

function WorkspaceFileControlItems({
  onSearchInFiles,
  options,
  open,
  fileTree,
}: WorkspaceFileControlsProps) {
  return (
    <>
      {onSearchInFiles ? (
        <ViewerIconButton label="Search in files" tooltipDelayOpen onClick={onSearchInFiles}>
          <SearchInFilesIcon />
        </ViewerIconButton>
      ) : null}
      {options.length > 0 ? <WorkspaceFileOptionsMenu options={options} /> : null}
      {open ? <WorkspaceFileOpenButton control={open} /> : null}
      {fileTree ? (
        <NodexTooltip tooltipContent="Toggle file tree" delayOpen>
          <ViewerButton
            aria-label="Toggle file tree"
            aria-pressed={fileTree.visible}
            variant={fileTree.visible ? "selected" : "default"}
            uniform
            className="ms-auto"
            onClick={fileTree.onToggle}
          >
            <SidePanelFilesIcon className="icon-sm" />
          </ViewerButton>
        </NodexTooltip>
      ) : null}
    </>
  );
}

/**
 * File controls sit inline once the header is at least 625px wide; narrower headers fold them
 * into one popover button.
 */
function WorkspaceFileControls(props: WorkspaceFileControlsProps) {
  const [open, setOpen] = useState(false);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={inlineRef} className="hidden items-center gap-1.5 @min-[625px]/file-header:flex">
        <ViewerControlGroup label="File controls">
          <WorkspaceFileControlItems {...props} />
        </ViewerControlGroup>
      </div>
      <NodexPopover open={open} onOpenChange={setOpen}>
        <NodexTooltip tooltipContent="File controls">
          <NodexPopoverTrigger>
            <ViewerButton
              aria-label="File controls"
              uniform
              className="@min-[625px]/file-header:hidden"
            >
              <EllipsisIcon />
            </ViewerButton>
          </NodexPopoverTrigger>
        </NodexTooltip>
        <NodexPopoverContent
          align="end"
          aria-label="File controls"
          data-viewer-density="compact"
          className="w-auto"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {open ? <WorkspaceFileControlItems {...props} /> : null}
          </div>
        </NodexPopoverContent>
      </NodexPopover>
    </>
  );
}

export interface WorkspaceFileViewerHeaderProps extends WorkspaceFileControlsProps {
  readonly breadcrumb: WorkspaceFileBreadcrumb;
  readonly path: string | null;
  readonly pathVariants: WorkspaceFilePathVariants | null;
  readonly gitHubUrl: string | null;
  readonly onOpenUrl: (url: string) => void;
}

export function WorkspaceFileViewerHeader({
  breadcrumb,
  path,
  pathVariants,
  gitHubUrl,
  onOpenUrl,
  ...controls
}: WorkspaceFileViewerHeaderProps) {
  const ancestors = Math.max(0, breadcrumb.segments.length - 1);
  return (
    <ViewerHeader
      className="group @container/file-header w-full"
      density="compact"
      leading={[
        {
          id: "file-path",
          allowShrink: true,
          grow: true,
          collapseSteps: Array.from({ length: ancestors }, (_, index) => ({
            priority: index,
            selector: `[data-file-ancestor="${index}"]`,
          })),
          content:
            breadcrumb.segments.length > 0 ? (
              <ViewerCapsule className="flex min-w-0 items-center">
                <WorkspaceFileBreadcrumbNav breadcrumb={breadcrumb} />
              </ViewerCapsule>
            ) : null,
        },
        {
          id: "path-actions",
          content:
            path && pathVariants ? (
              <WorkspaceFilePathActions
                path={path}
                variants={pathVariants}
                gitHubUrl={gitHubUrl}
                onOpenGitHub={onOpenUrl}
              />
            ) : null,
        },
        { id: "file-actions", content: <WorkspaceFileControls {...controls} /> },
      ]}
    />
  );
}
