import { useSyncExternalStore } from "react";
import { GitHubThreadSurface } from "@/features/github-thread/github-thread-surface";
import { useGitHubThreadTabPresentation } from "@/features/github-thread/github-thread-tab-presentation";
import { writeTextToClipboard } from "@/lib/clipboard";
import { openLink, type LinkRouter } from "@/lib/link-opening";
import type { IntlShape } from "@/lib/i18n";
import type { CodexPromptInput } from "@/lib/types";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import type { PendingGitHubThreadReveal } from "@/lib/workbench-ephemeral-panel-state";
import {
  DEFAULT_GITHUB_THREAD_SURFACE_STATE,
  gitHubThreadLabel,
  gitHubThreadSurfaceStateSchema,
  gitHubThreadUrl,
  type GitHubThreadSurfaceConfig,
} from "../../../shared/github-thread";
import {
  makeWorkbenchSceneKey,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
} from "../../../shared/workbench-scene";
import type { AppShellTabItem } from "./app-shell-tabs";

interface GitHubTabPresentationInput {
  readonly config: GitHubThreadSurfaceConfig;
  readonly titleSnapshot: string;
}

type TabChrome = Pick<AppShellTabItem, "title" | "location" | "iconElement">;

export function GitHubThreadTabChrome({
  config,
  titleSnapshot,
  render,
}: GitHubTabPresentationInput & { readonly render: (chrome: TabChrome) => React.ReactNode }) {
  const { title, location, icon } = useGitHubThreadTabPresentation({
    thread: config.thread,
    kindHint: config.kind,
    titleSnapshot,
  });
  return render({ title, location: [location], iconElement: icon });
}

export function gitHubThreadTabChrome(
  input: GitHubTabPresentationInput,
  intl: IntlShape,
  openWebLink: LinkRouter["openLink"] = openLink,
): Pick<AppShellTabItem, "location" | "renderPresentation" | "contextMenuItems"> {
  const url = gitHubThreadUrl(input.config.thread, input.config.kind);
  return {
    location: [gitHubThreadLabel(input.config.thread)],
    renderPresentation: (render) => <GitHubThreadTabChrome {...input} render={render} />,
    contextMenuItems: [
      {
        id: "github-open-on-web",
        label: intl.formatMessage({
          id: "inbox.inboxActivity.openOnGitHub",
          defaultMessage: "Open on GitHub",
        }),
        iconKey: "openIn",
        onSelect: () => void openWebLink({ url, initiator: "github_tab_menu", webOnly: true }),
      },
      {
        id: "github-copy-link",
        label: intl.formatMessage({
          id: "lib.webLinkContextMenu.copyLink",
          defaultMessage: "Copy link",
        }),
        iconKey: "copy",
        onSelect: () => void writeTextToClipboard(url),
      },
    ],
  };
}

type GitHubThreadRevealsByScene = Record<string, Record<string, PendingGitHubThreadReveal>>;

/** Drops one tab's pending reveal, unless a newer link already replaced it. */
function withoutConsumedReveal(
  current: GitHubThreadRevealsByScene,
  sceneKey: string,
  surfaceId: string,
  operationId: string,
): GitHubThreadRevealsByScene {
  const sceneReveals = current[sceneKey];
  if (sceneReveals?.[surfaceId]?.operationId !== operationId) return current;
  const remaining = { ...sceneReveals };
  delete remaining[surfaceId];
  return { ...current, [sceneKey]: remaining };
}

export function WorkbenchGitHubThreadSurface({
  sceneOwner,
  surfaceId,
  config,
  state,
  onAddToChatComposer,
}: {
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly config: GitHubThreadSurfaceConfig;
  readonly state: unknown;
  /** Present when the tab sits beside a chat whose draft can take GitHub context. */
  readonly onAddToChatComposer?: (input: CodexPromptInput) => void;
}) {
  const windowOwner = useWorkbenchWindowOwner();
  const sceneKey = makeWorkbenchSceneKey(sceneOwner);
  const pending = useSyncExternalStore(
    windowOwner.subscribe,
    () => windowOwner.read().ephemeralPanels.gitHubThreadRevealsByScene[sceneKey]?.[surfaceId],
  );
  const view =
    gitHubThreadSurfaceStateSchema.safeParse(state).data?.view ??
    DEFAULT_GITHUB_THREAD_SURFACE_STATE.view;
  const update = (patch: Parameters<typeof updateWorkbenchSceneSurface>[2]) => {
    const scene = windowOwner.read().windowState.scenesByOwnerKey[sceneKey];
    if (scene?.panelSurfacesById[surfaceId]?.kind !== "github_thread") return;
    windowOwner.setScene(sceneOwner, updateWorkbenchSceneSurface(scene, surfaceId, patch), {
      recordHistory: false,
    });
  };
  return (
    <GitHubThreadSurface
      thread={config.thread}
      kindHint={config.kind}
      titleSnapshot={
        windowOwner.read().windowState.scenesByOwnerKey[sceneKey]?.panelSurfacesById[surfaceId]
          ?.titleSnapshot ?? null
      }
      {...(onAddToChatComposer ? { onAddToChatComposer } : {})}
      view={view}
      onViewChange={(view) => update({ state: { view } })}
      onTitleSnapshotChange={(title) => {
        const titleSnapshot = title.slice(0, 2_000);
        const surface =
          windowOwner.read().windowState.scenesByOwnerKey[sceneKey]?.panelSurfacesById[surfaceId];
        if (titleSnapshot.trim() && titleSnapshot !== surface?.titleSnapshot)
          update({ titleSnapshot });
      }}
      reveal={pending?.target ?? null}
      onRevealConsumed={() => {
        if (!pending) return;
        windowOwner.dispatchEphemeral({
          type: "update",
          field: "gitHubThreadRevealsByScene",
          update: (current) =>
            withoutConsumedReveal(current, sceneKey, surfaceId, pending.operationId),
        });
      }}
    />
  );
}
