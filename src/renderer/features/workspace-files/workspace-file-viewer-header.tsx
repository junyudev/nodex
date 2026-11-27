import { useIntl } from "@/lib/i18n";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRightLgIcon, EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ChevronDownSm16Icon,
  CopyLightIcon,
  SearchInFilesIcon,
} from "@/components/shared/icons/file-viewer-icons";
import { CheckmarkMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { SkillGitHubIcon } from "@/components/shared/icons/skill-fallback-icons";
import {
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  OpenInIcon,
  SidePanelFilesIcon,
} from "@/components/shared/icons";
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
import { getFileManagerRevealMessage } from "../../../shared/file-link-openers";
import type {
  WorkspaceFileBreadcrumb,
  WorkspaceFilePathVariants,
} from "./workspace-file-header-model";
import { preferredWorkspaceFileCopyPath } from "./workspace-file-header-model";
import { WorkspaceFileBrowsePopover } from "./workspace-file-browse-popover";
import {
  WorkspaceFileChangeNavigator,
  WorkspaceFileComparisonGroup,
  WorkspaceFileDiffLayoutToggle,
  WorkspaceFileShowChangesButton,
  type WorkspaceFileComparisonControl,
} from "./workspace-file-comparison-controls";

const COPIED_FEEDBACK_MS = 2000;

function copyText(value: string) {
  void writeTextToClipboard(value);
}

export interface WorkspaceFileBreadcrumbBrowse {
  readonly workspaceRoot: string;
  /** Whether the trail ends at a file (its last segment) rather than the workspace folder. */
  readonly endsAtFile: boolean;
  readonly onOpenFile: (relativePath: string, mode: "preview" | "durable") => void;
}

function WorkspaceFileBreadcrumbNav({
  breadcrumb,
  browse,
}: {
  breadcrumb: WorkspaceFileBreadcrumb;
  browse: WorkspaceFileBreadcrumbBrowse | null;
}) {
  const intl = useIntl();
  const { segments, title, workspacePaths } = breadcrumb;
  return (
    <NodexTooltip tooltipContent={title} delayOpen>
      <nav
        aria-label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileViewerHeader.path",
          defaultMessage: "File path",
        })}
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
            const labelClassName = last
              ? "min-w-0 truncate pe-1 font-medium text-(--color-text)"
              : "whitespace-nowrap";
            const workspacePath = workspacePaths?.[index];
            return (
              <li
                key={`${index}:${segment}`}
                className={cn("flex items-center", last ? "min-w-0" : "shrink-0 gap-1")}
                data-file-ancestor={last ? undefined : index}
              >
                {browse && workspacePath !== undefined ? (
                  <WorkspaceFileBrowsePopover
                    workspaceRoot={browse.workspaceRoot}
                    focusPath={workspacePath}
                    focusIsDirectory={!(last && browse.endsAtFile)}
                    label={segment}
                    labelClassName={labelClassName}
                    onOpenFile={browse.onOpenFile}
                  />
                ) : (
                  <span className={labelClassName}>{segment}</span>
                )}
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
  const intl = useIntl();
  const copyLabel =
    variants.repoRelative !== null
      ? intl.formatMessage({
          id: "workspaceFiles.workspaceFileViewerHeader.copyRepoPath",
          defaultMessage: "Copy repo-relative path",
        })
      : variants.projectRelative !== null
        ? intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.copyProjectPath",
            defaultMessage: "Copy project-relative path",
          })
        : intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.copyPath",
            defaultMessage: "Copy path",
          });
  const pathOptions = [
    [
      variants.absolute,
      intl.formatMessage({
        id: "workspaceFiles.workspaceFileViewerHeader.absolutePath",
        defaultMessage: "Absolute path",
      }),
    ],
    [
      variants.projectRelative,
      intl.formatMessage({
        id: "workspaceFiles.workspaceFileViewerHeader.relativeToProject",
        defaultMessage: "Relative to project",
      }),
    ],
    [
      variants.repoRelative,
      intl.formatMessage({
        id: "workspaceFiles.workspaceFileViewerHeader.relativeToRepo",
        defaultMessage: "Relative to repo",
      }),
    ],
  ] as const;
  const availablePaths = pathOptions.flatMap(([value, label]) =>
    value === null ? [] : [{ value, label }],
  );
  return (
    <>
      <ViewerControlGroup label={copyLabel}>
        <CopyPathButton
          key={preferredWorkspaceFileCopyPath(path, variants)}
          label={copyLabel}
          value={preferredWorkspaceFileCopyPath(path, variants)}
        />
        {availablePaths.length > 0 ? (
          <NodexDropdownMenu
            align="start"
            contentWidth="menu"
            triggerTooltipContent="Copy path options"
            triggerButton={
              <ViewerButton
                aria-label={intl.formatMessage({
                  id: "workspaceFiles.workspaceFileViewerHeader.copyPathOptions",
                  defaultMessage: "Copy path options",
                })}
                uniform
              >
                <ChevronDownSm16Icon />
              </ViewerButton>
            }
          >
            {availablePaths.map(({ value, label }) => (
              <NodexDropdownItem
                key={label}
                leftSlot={<CopyIcon />}
                onSelect={() => copyText(value)}
              >
                {label}
              </NodexDropdownItem>
            ))}
          </NodexDropdownMenu>
        ) : null}
      </ViewerControlGroup>
      {gitHubUrl ? (
        <ViewerIconButton
          label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.openGitHub",
            defaultMessage: "Open in GitHub",
          })}
          onClick={() => onOpenGitHub(gitHubUrl)}
        >
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
  readonly icon: ReactNode;
  readonly group: "copy" | "view" | "refresh";
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
  return url ? <img alt="" className="icon-sm" src={url} /> : <OpenInIcon className="icon-sm" />;
}

function WorkspaceFileOpenButton({ control }: { control: WorkspaceFileOpenControl }) {
  const intl = useIntl();
  const { primary } = control;
  const alternatives = control.targets.filter((target) => target.id !== primary?.id);
  return (
    <ViewerSplitButton
      label={
        primary
          ? intl.formatMessage(
              {
                id: "workspaceFiles.workspaceFileViewerHeader.openIn",
                defaultMessage: "Open in {app}",
              },
              { app: primary.label },
            )
          : intl.formatMessage({
              id: "workspaceFiles.workspaceFileViewerHeader.open",
              defaultMessage: "Open",
            })
      }
      onClick={() => (primary ? primary.open() : control.onOpenDefault())}
      menuLabel={intl.formatMessage({
        id: "workspaceFiles.workspaceFileViewerHeader.openOptions",
        defaultMessage: "Open options",
      })}
      menu={
        <>
          {alternatives.map((target) => (
            <NodexDropdownItem
              key={target.id}
              leftSlot={<TargetIcon url={target.iconUrl} />}
              onSelect={target.open}
            >
              {intl.formatMessage(
                {
                  id: "workspaceFiles.workspaceFileViewerHeader.openIn",
                  defaultMessage: "Open in {app}",
                },
                { app: target.label },
              )}
            </NodexDropdownItem>
          ))}
          {control.onOpenGitHub ? (
            <NodexDropdownItem leftSlot={<SkillGitHubIcon />} onSelect={control.onOpenGitHub}>
              {intl.formatMessage({
                id: "workspaceFiles.workspaceFileViewerHeader.openGitHub",
                defaultMessage: "Open in GitHub",
              })}
            </NodexDropdownItem>
          ) : null}
          {(alternatives.length > 0 || control.onOpenGitHub) &&
          (control.onRevealInFolder || control.onSaveAs) ? (
            <NodexDropdownSeparator />
          ) : null}
          {control.onRevealInFolder ? (
            <NodexDropdownItem leftSlot={<FolderIcon />} onSelect={control.onRevealInFolder}>
              {intl.formatMessage(getFileManagerRevealMessage(navigator.platform))}
            </NodexDropdownItem>
          ) : null}
          {control.onSaveAs ? (
            <NodexDropdownItem leftSlot={<DownloadIcon />} onSelect={control.onSaveAs}>
              {intl.formatMessage({
                id: "workspaceFiles.workspaceFileViewerHeader.saveCopy",
                defaultMessage: "Save a copy",
              })}
            </NodexDropdownItem>
          ) : null}
        </>
      }
    >
      {primary?.iconUrl ? <TargetIcon url={primary.iconUrl} /> : null}
      <span className="whitespace-nowrap">
        {intl.formatMessage({
          id: "workspaceFiles.workspaceFileViewerHeader.open",
          defaultMessage: "Open",
        })}
      </span>
    </ViewerSplitButton>
  );
}

function WorkspaceFileOptionsMenu({ options }: { options: readonly WorkspaceFileViewerOption[] }) {
  const intl = useIntl();
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menu"
      triggerTooltipContent="File viewer options"
      triggerButton={
        <ViewerButton
          aria-label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.viewerOptions",
            defaultMessage: "File viewer options",
          })}
          uniform
        >
          <EllipsisIcon />
        </ViewerButton>
      }
    >
      {options.map((option, index) => (
        <Fragment key={option.id}>
          {index > 0 && options[index - 1]?.group !== option.group ? (
            <NodexDropdownSeparator />
          ) : null}
          <NodexDropdownItem leftSlot={option.icon} onSelect={option.onSelect}>
            {option.label}
          </NodexDropdownItem>
        </Fragment>
      ))}
    </NodexDropdownMenu>
  );
}

/** The editable-text header: comparison controls instead of path actions and viewer options. */
export interface WorkspaceFileEditorControls {
  readonly comparison: WorkspaceFileComparisonControl | null;
  /** A Markdown file switches between its rendered preview and its source. */
  readonly markdown: { readonly preview: boolean; readonly onToggle: () => void } | null;
}

export interface WorkspaceFileControlsProps {
  readonly onSearchInFiles: (() => void) | null;
  readonly options: readonly WorkspaceFileViewerOption[];
  readonly open: WorkspaceFileOpenControl | null;
  readonly fileTree: { readonly visible: boolean; readonly onToggle: () => void } | null;
  readonly pluginActions?: ReactNode;
  readonly editor?: WorkspaceFileEditorControls | null;
}

function WorkspaceFileControlItems({
  onSearchInFiles,
  options,
  open,
  fileTree,
  pluginActions,
  editor,
}: WorkspaceFileControlsProps) {
  const intl = useIntl();
  const treeToggle = fileTree ? (
    <NodexTooltip
      tooltipContent={intl.formatMessage({
        id: "workspaceFiles.workspaceFileViewerHeader.toggleTree",
        defaultMessage: "Toggle file tree",
      })}
      delayOpen
    >
      <ViewerButton
        aria-label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileViewerHeader.toggleTree",
          defaultMessage: "Toggle file tree",
        })}
        aria-pressed={fileTree.visible}
        variant={fileTree.visible ? "selected" : "default"}
        uniform
        className={editor ? undefined : "ms-auto"}
        onClick={fileTree.onToggle}
      >
        <SidePanelFilesIcon className="icon-sm" />
      </ViewerButton>
    </NodexTooltip>
  ) : null;
  const openButton = open ? <WorkspaceFileOpenButton control={open} /> : null;
  const comparing = editor?.comparison?.active ? editor.comparison : null;
  return (
    <>
      {onSearchInFiles ? (
        <ViewerIconButton
          label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.search",
            defaultMessage: "Search in files",
          })}
          tooltipDelayOpen
          onClick={onSearchInFiles}
        >
          <SearchInFilesIcon />
        </ViewerIconButton>
      ) : null}
      {pluginActions}
      {editor ? (
        <>
          {comparing ? (
            <WorkspaceFileDiffLayoutToggle
              layout={comparing.layout}
              onToggle={comparing.onToggleLayout}
            />
          ) : editor.markdown ? (
            <ViewerButton onClick={editor.markdown.onToggle}>
              {editor.markdown.preview
                ? intl.formatMessage({
                    id: "workspaceFiles.workspaceFileViewerHeader.viewSource",
                    defaultMessage: "View source",
                  })
                : intl.formatMessage({
                    id: "workspaceFiles.workspaceFileViewerHeader.viewPreview",
                    defaultMessage: "View preview",
                  })}
            </ViewerButton>
          ) : null}
          {treeToggle}
          {openButton}
        </>
      ) : (
        <>
          {options.length > 0 ? <WorkspaceFileOptionsMenu options={options} /> : null}
          {openButton}
          {treeToggle}
        </>
      )}
    </>
  );
}

/**
 * File controls sit inline once the header is at least 625px wide; narrower headers fold them
 * into one popover button.
 */
function WorkspaceFileControls(props: WorkspaceFileControlsProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <div ref={inlineRef} className="hidden items-center gap-1.5 @min-[625px]/file-header:flex">
        <ViewerControlGroup
          label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.controls",
            defaultMessage: "File controls",
          })}
        >
          <WorkspaceFileControlItems {...props} />
        </ViewerControlGroup>
      </div>
      <NodexPopover open={open} onOpenChange={setOpen}>
        <NodexTooltip
          tooltipContent={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.controls",
            defaultMessage: "File controls",
          })}
        >
          <NodexPopoverTrigger>
            <ViewerButton
              aria-label={intl.formatMessage({
                id: "workspaceFiles.workspaceFileViewerHeader.controls",
                defaultMessage: "File controls",
              })}
              uniform
              className="@min-[625px]/file-header:hidden"
            >
              <EllipsisIcon />
            </ViewerButton>
          </NodexPopoverTrigger>
        </NodexTooltip>
        <NodexPopoverContent
          align="end"
          aria-label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileViewerHeader.controls",
            defaultMessage: "File controls",
          })}
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
  readonly browse: WorkspaceFileBreadcrumbBrowse | null;
  readonly path: string | null;
  readonly pathVariants: WorkspaceFilePathVariants | null;
  readonly gitHubUrl: string | null;
  readonly onOpenUrl: (url: string) => void;
}

export function WorkspaceFileViewerHeader({
  breadcrumb,
  browse,
  path,
  pathVariants,
  gitHubUrl,
  onOpenUrl,
  ...controls
}: WorkspaceFileViewerHeaderProps) {
  const ancestors = Math.max(0, breadcrumb.segments.length - 1);
  const comparison = controls.editor?.comparison ?? null;
  const showGitHubButton = Boolean(!controls.editor && path && pathVariants && gitHubUrl);
  const open =
    showGitHubButton && controls.open ? { ...controls.open, onOpenGitHub: null } : controls.open;
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
                <WorkspaceFileBreadcrumbNav breadcrumb={breadcrumb} browse={browse} />
              </ViewerCapsule>
            ) : null,
        },
        {
          id: "leading-actions",
          allowShrink: true,
          collapseSteps: [
            {
              priority: -1,
              selector: "[data-review-source-branch], [data-file-comparison-detail]",
            },
            { priority: breadcrumb.segments.length, selector: "[data-file-comparison-label]" },
          ],
          content: comparison ? (
            comparison.active ? (
              <WorkspaceFileComparisonGroup control={comparison} />
            ) : (
              <WorkspaceFileShowChangesButton control={comparison} />
            )
          ) : null,
        },
        {
          id: "path-actions",
          content: controls.editor ? (
            comparison?.active && comparison.navigation ? (
              <WorkspaceFileChangeNavigator
                navigation={comparison.navigation}
                onNavigate={comparison.onNavigate}
              />
            ) : null
          ) : path && pathVariants ? (
            <WorkspaceFilePathActions
              path={path}
              variants={pathVariants}
              gitHubUrl={gitHubUrl}
              onOpenGitHub={onOpenUrl}
            />
          ) : null,
        },
        { id: "file-actions", content: <WorkspaceFileControls {...controls} open={open} /> },
      ]}
    />
  );
}
