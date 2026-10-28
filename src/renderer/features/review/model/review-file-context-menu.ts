import type { NativeMenuTarget } from "@/lib/file-reference-open-targets";
import type { NativeContextMenuItem } from "../../../../shared/native-context-menu";

export interface ReviewFileContextMenuInput {
  readonly canOpenFile: boolean;
  readonly canOpenInNewTab: boolean;
  readonly selectedText: string;
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

/** The file menu keeps text selection actions alongside the file's own commands. */
export function buildReviewFileContextMenu(
  input: ReviewFileContextMenuInput,
): NativeContextMenuItem[] {
  const primary = input.canOpenFile ? input.primary : null;
  const canOpenInNewTab = input.canOpenFile && input.canOpenInNewTab;
  const openItems: NativeContextMenuItem[] = [
    ...(primary
      ? [{ id: "open-primary", label: `Open in ${primary.label}`, iconUrl: primary.iconUrl }]
      : []),
    ...(primary || canOpenInNewTab
      ? [
          {
            id: "open-with",
            label: "Open with",
            type: "submenu" as const,
            submenu: [
              ...(canOpenInNewTab ? [{ id: "open-in-new-tab", label: "New tab" }] : []),
              ...input.alternatives.map((target) => ({
                id: reviewFileOpenTargetActionId(target),
                label: target.label,
                iconUrl: target.iconUrl,
              })),
            ],
          },
        ]
      : []),
    ...(input.githubUrl ? [{ id: "open-in-github", label: "Open in GitHub" }] : []),
  ];
  return [
    { id: "request-changes", label: "Request changes" },
    ...openItems,
    ...(openItems.length > 0 ? [{ type: "separator" as const }] : []),
    { id: "copy-selection", label: "Copy selection", enabled: input.selectedText.length > 0 },
    { id: "copy-path", label: "Copy path", enabled: input.canOpenFile },
    ...(input.relativePath !== null
      ? [{ id: "copy-relative-path", label: "Copy relative path" }]
      : []),
    { id: "toggle-wrap", label: "Toggle line wrap" },
  ];
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
