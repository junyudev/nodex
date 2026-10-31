import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { createMaitaiStore, MaitaiProvider, ScopeProvider, disposeMaitaiStore } from "@/lib/maitai";
import { createScopeHandle, getMaitaiRootView } from "@/lib/maitai/maitai-store";
import { ComposerScope, RouteScope, ThreadScope } from "@/lib/workbench-ui-scopes";
import { getWorkbenchWindowOwner } from "@/lib/workbench-window-owner";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
} from "../../../../../shared/workbench-scene";
import { createPageEditorSelectionObservation } from "@/lib/page-editor-selection";
import { registerPageEditorObservationParticipant } from "@/lib/page-editor-observation-registry";
import { workbenchPageEditorKey } from "@/lib/workbench-page-editor-key";
import { PageTitleProjectionProvider } from "@/lib/page-title-projection-context";
import {
  createPageTitleProjectionStore,
  makePageTitleResourceKey,
} from "@/lib/page-title-projection-store";
import { useComposerPageContext } from "./use-composer-page-context";

function setup() {
  const store = createMaitaiStore();
  const sceneOwner = { kind: "session", sessionId: "s" } as const;
  const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(sceneOwner), {
    panelId: "right",
    surface: {
      id: "page-tab",
      kind: "page_stage",
      titleSnapshot: "Plan",
      state: null,
      stateKey: 0,
      config: { routingContext: { kind: "library" }, pageId: "page-a" },
    },
  });
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    location: { ...sceneOwner, projectContextId: null },
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  const titles = createPageTitleProjectionStore();
  let ids: readonly string[] = ["a"];
  const selection = createPageEditorSelectionObservation({ read: () => ids, focused: () => true });
  const release = registerPageEditorObservationParticipant(
    workbenchPageEditorKey(sceneOwner, "page-tab"),
    {
      ...selection,
      read: () => {
        throw new Error("Selection must not read content");
      },
      prepare: async () => {
        throw new Error("Selection must not prepare content");
      },
    },
  );
  let current: ReturnType<typeof useComposerPageContext>;
  function Probe() {
    const context = useComposerPageContext();
    useLayoutEffect(() => {
      current = context;
    });
    return <output aria-label="Page references">{JSON.stringify(context.references)}</output>;
  }
  const tree = (mounted: boolean) => (
    <MaitaiProvider store={store}>
      <PageTitleProjectionProvider currentLibraryId="library-a" store={titles}>
        <ScopeProvider
          scope={ThreadScope}
          descriptor={{
            stableKey: "session:s",
            phase: "attached",
            projectSessionId: "s",
            clientThreadId: null,
            threadId: "thread-s",
          }}
        >
          <ScopeProvider scope={RouteScope} descriptor={{ kind: "thread", routeKey: "s" }}>
            <ScopeProvider
              scope={ComposerScope}
              descriptor={{ identity: "main", focusComposerNonce: null }}
            >
              {mounted ? <Probe /> : null}
            </ScopeProvider>
          </ScopeProvider>
        </ScopeProvider>
      </PageTitleProjectionProvider>
    </MaitaiProvider>
  );
  const view = render(tree(true));
  return {
    view,
    current: () => current!,
    tree,
    update() {
      titles.publishLive(
        makePageTitleResourceKey("library-a", "page-a"),
        "editor",
        "Revised plan",
        1,
      );
      ids = ["b", "c"];
      selection.update();
    },
    dispose() {
      view.unmount();
      release();
      disposeMaitaiStore(store);
    },
  };
}

test("removed Page context stays excluded across live title/selection updates and Composer remount, then resets after success", async () => {
  const subject = setup();
  try {
    expect(subject.current().references).toEqual([
      { pageId: "page-a", titleSnapshot: "Plan", selectedBlockIds: ["a"] },
    ]);
    await act(async () => {
      subject.current().remove("page-a");
      subject.update();
    });
    expect(subject.current().readSnapshot()).toEqual([]);
    subject.view.rerender(subject.tree(false));
    subject.view.rerender(subject.tree(true));
    expect(subject.current().references).toEqual([]);
    await act(async () => {
      await subject.current().submit(async () => true);
    });
    await waitFor(() =>
      expect(subject.current().references).toEqual([
        { pageId: "page-a", titleSnapshot: "Revised plan", selectedBlockIds: ["b", "c"] },
      ]),
    );
  } finally {
    subject.dispose();
  }
});

test("submit freezes the current title and selection and failed delivery preserves draft exclusions", async () => {
  const subject = setup();
  try {
    const submitted = subject.current().readSnapshot();
    await act(async () => {
      subject.update();
    });
    expect(submitted).toEqual([
      { pageId: "page-a", titleSnapshot: "Plan", selectedBlockIds: ["a"] },
    ]);
    expect(subject.current().readSnapshot()[0]?.selectedBlockIds).toEqual(["b", "c"]);
    await act(async () => {
      subject.current().remove("page-a");
    });
    const deliver = vi.fn().mockRejectedValue(new Error("Unavailable"));
    await act(async () => {
      await expect(subject.current().submit(deliver)).rejects.toThrow("Unavailable");
    });
    expect(subject.current().references).toEqual([]);
  } finally {
    subject.dispose();
  }
});
