import { FormattedMessage, useIntl } from "@/lib/i18n";
import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useState } from "react";
import {
  ChevronRightIcon,
  ReviewCollapseAllDiffsIcon,
  ReviewExpandAllDiffsIcon,
} from "@/components/shared/icons";
import { NodexIconButton } from "@/components/ui/button";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { InlineFileDiff } from "@/features/local-conversation/view/shared/tools/inline-file-diff";
import { reviewDiffPreferencesAtom } from "@/features/review/model/review-view-state";
import {
  getNodexDiffHostStyle,
  getNodexDiffOptions,
  NODEX_DIFF_HOST_CLASS,
} from "@/lib/diff-presentation";
import { useScopedAtomValue } from "@/lib/maitai";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import type {
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubPullRequestFileStatus,
} from "../../../shared/github-thread";
import { useOpenOnGitHub } from "./github-thread-parts";
import { useGitHubPullRequestFiles } from "./use-github-thread";

/** Files changing more lines than this start folded, so one generated file does not bury the rest. */
const LARGE_FILE_LINES = 400;
/** Past this many changed lines in all, only the first files start open. */
const LARGE_CHANGE_LINES = 2000;
const OPEN_FILES_IN_LARGE_CHANGE = 5;

function changedLines(file: GitHubPullRequestFile) {
  return file.additions + file.deletions;
}

/** Which files start open: all of a small change, the first few of a large one, never a huge file. */
export function initiallyOpenFiles(files: readonly GitHubPullRequestFile[]): ReadonlySet<string> {
  const total = files.reduce((sum, file) => sum + changedLines(file), 0);
  const candidates = files.filter(
    (file) => file.patch !== null && changedLines(file) <= LARGE_FILE_LINES,
  );
  const open =
    total > LARGE_CHANGE_LINES ? candidates.slice(0, OPEN_FILES_IN_LARGE_CHANGE) : candidates;
  return new Set(open.map((file) => file.path));
}

function fileDiffMetadata(file: GitHubPullRequestFile): FileDiffMetadata | null {
  if (file.patch === null) return null;
  const before = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
  const after = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  const header = `diff --git a/${file.previousPath ?? file.path} b/${file.path}\n--- ${before}\n+++ ${after}\n`;
  try {
    return parsePatchFiles(`${header}${file.patch}\n`, `github:${file.path}`)[0]?.files[0] ?? null;
  } catch {
    return null;
  }
}

const STATUS_MARK: Record<
  GitHubPullRequestFileStatus,
  { readonly mark: string; readonly tone: string }
> = {
  added: { mark: "A", tone: "text-token-git-decoration-added-resource-foreground" },
  removed: { mark: "D", tone: "text-token-git-decoration-deleted-resource-foreground" },
  modified: { mark: "M", tone: "text-token-description-foreground" },
  changed: { mark: "M", tone: "text-token-description-foreground" },
  renamed: { mark: "R", tone: "text-token-description-foreground" },
  copied: { mark: "C", tone: "text-token-description-foreground" },
  unchanged: { mark: "·", tone: "text-token-description-foreground" },
};

/** The change itself: every file the pull request touches, as diffs. */
export function GitHubPullRequestFilesView({ pr }: { readonly pr: GitHubPullRequestDetail }) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const query = useGitHubPullRequestFiles(pr.ref, pr.headSha);
  const result = query.data;
  const files = result?.status === "ready" ? result.files.files : null;
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string> | null>(null);
  const filesUrl = `${pr.url}/files`;

  if (!result) {
    return (
      <div className="pt-20" role="status" aria-busy="true">
        <LoadingResultsShimmer
          lines={6}
          maxWidth={96}
          minWidth={60}
          seed={`github-files:${pr.url}`}
          size="md"
        />
      </div>
    );
  }
  if (result.status !== "ready" || !files) {
    return (
      <div className="flex flex-col items-start gap-2 pt-20 text-sm">
        <span className="text-token-text-secondary">
          <FormattedMessage
            id="githubThread.files.unavailable"
            defaultMessage="Couldn’t load the changed files"
          />
        </span>
        <div className="flex gap-3">
          <button
            type="button"
            className="cursor-interaction text-token-text-primary hover:underline"
            onClick={() => void query.refetch()}
          >
            <FormattedMessage id="githubThread.retry" defaultMessage="Try again" />
          </button>
          <a
            href={filesUrl}
            onClick={(event) => openOnGitHub(filesUrl, event)}
            className="text-token-description-foreground hover:underline"
          >
            <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
          </a>
        </div>
      </div>
    );
  }

  const open = openPaths ?? initiallyOpenFiles(files);
  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpenPaths(next);
  };
  const allOpen = files.every((file) => file.patch === null || open.has(file.path));

  return (
    <div className="flex flex-col gap-2 pt-14 pb-10" data-github-thread-files="">
      <div className="flex h-8 items-center gap-2 text-sm text-token-text-secondary">
        <FormattedMessage
          id="githubThread.files.summary"
          defaultMessage="{count, plural, one {# file changed} other {# files changed}}"
          values={{ count: pr.changedFiles }}
        />
        <span className="tabular-nums text-token-git-decoration-added-resource-foreground">
          +{pr.additions}
        </span>
        <span className="tabular-nums text-token-git-decoration-deleted-resource-foreground">
          −{pr.deletions}
        </span>
        <NodexIconButton
          size="sm"
          className="ml-auto"
          icon={allOpen ? ReviewCollapseAllDiffsIcon : ReviewExpandAllDiffsIcon}
          ariaLabel={
            allOpen
              ? intl.formatMessage({
                  id: "githubThread.files.collapseAll",
                  defaultMessage: "Collapse all files",
                })
              : intl.formatMessage({
                  id: "githubThread.files.expandAll",
                  defaultMessage: "Expand all files",
                })
          }
          title={
            allOpen
              ? intl.formatMessage({
                  id: "githubThread.files.collapseAll",
                  defaultMessage: "Collapse all files",
                })
              : intl.formatMessage({
                  id: "githubThread.files.expandAll",
                  defaultMessage: "Expand all files",
                })
          }
          onClick={() =>
            setOpenPaths(
              allOpen
                ? new Set()
                : new Set(files.filter((file) => file.patch !== null).map((file) => file.path)),
            )
          }
        />
      </div>
      {files.map((file) => (
        <FileCard
          key={file.path}
          file={file}
          open={open.has(file.path)}
          onToggle={() => toggle(file.path)}
          filesUrl={filesUrl}
        />
      ))}
      {result.files.truncated ? (
        <a
          href={filesUrl}
          onClick={(event) => openOnGitHub(filesUrl, event)}
          className="self-start py-1 text-sm text-token-description-foreground hover:text-token-text-primary hover:underline"
        >
          <FormattedMessage
            id="githubThread.files.truncated"
            defaultMessage="{shown} of {count} files shown. The rest are on GitHub."
            values={{ shown: files.length, count: pr.changedFiles }}
          />
        </a>
      ) : null}
    </div>
  );
}

function FileCard({
  file,
  open,
  onToggle,
  filesUrl,
}: {
  readonly file: GitHubPullRequestFile;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly filesUrl: string;
}) {
  const openOnGitHub = useOpenOnGitHub();
  const { resolved } = useTheme();
  const { wrap } = useScopedAtomValue(reviewDiffPreferencesAtom);
  const slash = file.path.lastIndexOf("/");
  const directory = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const status = STATUS_MARK[file.status];
  const metadata = open ? fileDiffMetadata(file) : null;
  return (
    <section className="overflow-hidden rounded-lg ring-[0.5px] ring-token-border ring-inset">
      <button
        type="button"
        aria-expanded={open}
        disabled={file.patch === null}
        onClick={onToggle}
        className={cn(
          "cursor-interaction flex h-8 w-full min-w-0 items-center gap-2 px-2.5 text-left text-sm disabled:cursor-default",
          open && "border-b-[0.5px] border-token-border",
          "bg-token-list-hover-background/60 hover:bg-token-list-hover-background",
        )}
      >
        <ChevronRightIcon
          className={cn(
            "icon-2xs shrink-0 text-token-description-foreground transition-transform duration-150",
            open && "rotate-90",
            file.patch === null && "opacity-0",
          )}
        />
        <span className={cn("w-3 shrink-0 text-center font-mono text-xs", status.tone)}>
          {status.mark}
        </span>
        <span className="min-w-0 truncate font-mono text-xs">
          <span className="text-token-description-foreground">{directory}</span>
          <span className="text-token-text-primary">{name}</span>
        </span>
        {file.previousPath && file.previousPath !== file.path ? (
          <span className="min-w-0 shrink truncate font-mono text-xs text-token-description-foreground">
            ← {file.previousPath}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs tabular-nums">
          <span className="text-token-git-decoration-added-resource-foreground">
            +{file.additions}
          </span>
          <span className="text-token-git-decoration-deleted-resource-foreground">
            −{file.deletions}
          </span>
        </span>
      </button>
      {file.patch === null ? (
        <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-token-description-foreground">
          <FormattedMessage
            id="githubThread.files.noDiff"
            defaultMessage="GitHub doesn’t show this diff here."
          />
          <a
            href={filesUrl}
            onClick={(event) => openOnGitHub(filesUrl, event)}
            className="hover:text-token-text-primary hover:underline"
          >
            <FormattedMessage id="githubThread.openOnGitHub" defaultMessage="Open on GitHub" />
          </a>
        </div>
      ) : metadata ? (
        <div className="bg-token-editor-background">
          <InlineFileDiff
            fileDiff={metadata}
            className={NODEX_DIFF_HOST_CLASS}
            style={getNodexDiffHostStyle(resolved)}
            options={getNodexDiffOptions(resolved, true, { wrap })}
            displayPath={file.path}
          />
        </div>
      ) : null}
    </section>
  );
}
