import { getIntl } from "@/lib/i18n";
import type { NativeMenuTarget } from "@/lib/file-reference-open-targets";
import {
  joinNativeContextMenuGroups,
  type NativeContextMenuItem,
} from "../../../../shared/native-context-menu";

export interface ReviewFileContextMenuInput {
  readonly canOpenFile: boolean;
  readonly canOpenInNewTab: boolean;
  readonly selectedText: string;
  readonly canRequestChanges: boolean;
  readonly wrap: boolean;
  readonly relativePath: string | null;
  readonly githubUrl: string | null;
  readonly primary: NativeMenuTarget | null;
  readonly alternatives: readonly NativeMenuTarget[];
}

export const reviewFileOpenTargetActionId = (target: NativeMenuTarget): string =>
  `open-target:${target.id}`;

/** Choosing an editor updates the configured opener; native viewers and terminals do not. */
export function reviewFileTargetPreferredOpener(target: NativeMenuTarget) {
  if (target.appPath || !target.opener) return null;
  const opener = target.opener;
  if (
    opener === "fileManager" ||
    opener === "terminal" ||
    opener === "iterm2" ||
    opener === "ghostty" ||
    opener === "warp"
  )
    return null;
  return opener;
}

export function reviewWordWrapLabel(wrap: boolean): string {
  const intl = getIntl();
  return wrap
    ? intl.formatMessage({
        id: "workbench.reviewDiffPanel.disableWrap",
        defaultMessage: "Disable word wrap",
      })
    : intl.formatMessage({
        id: "workbench.reviewDiffPanel.enableWrap",
        defaultMessage: "Enable word wrap",
      });
}

/** The file menu keeps text selection actions alongside the file's own commands. */
export function buildReviewFileContextMenu(
  input: ReviewFileContextMenuInput,
): NativeContextMenuItem[] {
  const intl = getIntl();
  const primary = input.canOpenFile ? input.primary : null;
  const openItems: NativeContextMenuItem[] = [];
  if (input.canOpenFile && input.canOpenInNewTab) {
    openItems.push({
      id: "open-in-new-tab",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.newTab",
        defaultMessage: "Open in new tab",
      }),
      iconKey: "newTab",
    });
  }
  if (primary) {
    openItems.push({
      id: "open-primary",
      label: intl.formatMessage(
        { id: "review.reviewFileContextMenu.openIn", defaultMessage: "Open in {app}" },
        { app: primary.label },
      ),
      iconKey: "openIn",
      iconUrl: primary.iconUrl,
    });
  }
  if (input.canOpenFile && input.alternatives.length > 0) {
    openItems.push({
      id: "open-with",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.openWith",
        defaultMessage: "Open with",
      }),
      type: "submenu",
      iconKey: "window",
      submenu: input.alternatives.map((target) => ({
        id: reviewFileOpenTargetActionId(target),
        label: target.label,
        iconKey: "openIn",
        iconUrl: target.iconUrl,
      })),
    });
  }
  if (input.githubUrl) {
    openItems.push({
      id: "open-in-github",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.openGitHub",
        defaultMessage: "Open in GitHub",
      }),
      iconKey: "openIn",
    });
  }
  const copyItems: NativeContextMenuItem[] = [];
  if (input.selectedText)
    copyItems.push({
      id: "copy-selection",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.copySelection",
        defaultMessage: "Copy selection",
      }),
      iconKey: "copy",
    });
  if (input.canOpenFile)
    copyItems.push({
      id: "copy-path",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.copyPath",
        defaultMessage: "Copy path",
      }),
      iconKey: "copy",
    });
  if (input.relativePath)
    copyItems.push({
      id: "copy-relative-path",
      label: intl.formatMessage({
        id: "review.reviewFileContextMenu.copyRelativePath",
        defaultMessage: "Copy relative path",
      }),
      iconKey: "copy",
    });
  return joinNativeContextMenuGroups(
    openItems,
    input.canRequestChanges
      ? [
          {
            id: "request-changes",
            label: intl.formatMessage({
              id: "review.reviewFileContextMenu.requestChanges",
              defaultMessage: "Request changes",
            }),
            iconKey: "edit",
          },
        ]
      : [],
    copyItems,
    [
      {
        id: "toggle-wrap",
        label: reviewWordWrapLabel(input.wrap),
        iconKey: input.wrap ? "noWordWrap" : "wordWrap",
      },
    ],
  );
}

/** Context clicks inside Pierre's Shadow DOM retain their exact source line. */
export function readReviewContextMenuLine(path: readonly EventTarget[]): number | null {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) continue;
    const value = target.getAttribute("data-line") ?? target.getAttribute("data-column-number");
    if (value === null) continue;
    const line = Number.parseInt(value, 10);
    if (!Number.isNaN(line)) return line;
  }
  return null;
}
