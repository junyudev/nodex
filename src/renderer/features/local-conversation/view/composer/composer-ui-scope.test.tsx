import { useLayoutEffect } from "react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import {
  ComposerScope,
  RouteScope,
  ThreadScope,
  type ComposerScopeDescriptor,
  type RouteScopeDescriptor,
  type ThreadScopeDescriptor,
} from "@/lib/workbench-ui-scopes";
import {
  MaitaiProvider,
  ScopeProvider,
  appScope,
  createMaitaiStore,
  disposeMaitaiStore,
  useScopeHandle,
  type MaitaiStore,
  type ScopeHandle,
} from "@/lib/maitai";
import {
  clearComposerCompletedDraftAtom,
  composerFileAttachmentsAtom,
  composerGoalModeActiveAtom,
  composerResetGenerationAtom,
  consumeComposerDraftTransfer,
  createComposerDraftTransfer,
  publishComposerDraftTransfer,
} from "./composer-draft-state";

const THREAD: ThreadScopeDescriptor = {
  stableKey: "session:composer-ui-scope-test",
  phase: "attached",
  projectSessionId: "composer-ui-scope-test",
  clientThreadId: null,
  threadId: "thread_1",
};
const ROUTE: RouteScopeDescriptor = {
  routeKey: "/composer-ui-scope-test",
  kind: "thread",
};
const stores: MaitaiStore[] = [];

function createStore(): MaitaiStore {
  const store = createMaitaiStore();
  stores.push(store);
  return store;
}

function ComposerScopeProbe({ onHandle }: { readonly onHandle: (handle: ScopeHandle) => void }) {
  const handle = useScopeHandle(ComposerScope);
  useLayoutEffect(() => onHandle(handle), [handle, onHandle]);
  return null;
}

function ScopeTree({
  identity,
  onHandle,
}: {
  readonly identity: string;
  readonly onHandle: (handle: ScopeHandle) => void;
}) {
  const descriptor: ComposerScopeDescriptor = { identity, focusComposerNonce: null };
  return (
    <ScopeProvider scope={ThreadScope} descriptor={THREAD}>
      <ScopeProvider scope={RouteScope} descriptor={ROUTE}>
        <ScopeProvider scope={ComposerScope} descriptor={descriptor}>
          <ComposerScopeProbe onHandle={onHandle} />
        </ScopeProvider>
      </ScopeProvider>
    </ScopeProvider>
  );
}

afterEach(() => {
  for (const store of stores.splice(0)) disposeMaitaiStore(store);
});

describe("ComposerScope draft ownership", () => {
  test("clears the completed draft atom set and increments reset generation once", () => {
    const store = createStore();
    let handle: ScopeHandle | null = null;
    render(
      <MaitaiProvider store={store}>
        <ScopeTree
          identity="task:clear"
          onHandle={(next) => {
            handle = next;
          }}
        />
      </MaitaiProvider>,
    );
    const committedHandle = handle as ScopeHandle | null;
    if (!committedHandle) throw new Error("Expected committed ComposerScope handle");

    act(() => {
      committedHandle.set(composerFileAttachmentsAtom, [
        {
          uiId: "file_1",
          attachment: { label: "plan.md", path: "/tmp/plan.md", fsPath: "/tmp/plan.md" },
        },
      ]);
      committedHandle.set(composerGoalModeActiveAtom, true);
      committedHandle.set(clearComposerCompletedDraftAtom);
    });

    expect(committedHandle.get(composerFileAttachmentsAtom)).toEqual([]);
    expect(committedHandle.get(composerGoalModeActiveAtom)).toBe(false);
    expect(committedHandle.get(composerResetGenerationAtom)).toBe(1);
  });

  test("publishes and consumes a conversation transfer exactly once", () => {
    const store = createStore();
    let appHandle: ScopeHandle | null = null;
    function AppProbe() {
      const handle = useScopeHandle(appScope);
      useLayoutEffect(() => {
        appHandle = handle;
      }, [handle]);
      return null;
    }
    render(
      <MaitaiProvider store={store}>
        <AppProbe />
      </MaitaiProvider>,
    );
    const committedAppHandle = appHandle as ScopeHandle | null;
    if (!committedAppHandle) throw new Error("Expected AppScope handle");
    const transfer = createComposerDraftTransfer("thread_target", {
      prompt: "continue in target",
      fileAttachments: [],
      addedFiles: [],
      imageAttachments: [],
      appshotContexts: [],
      pastedTextAttachments: [],
      commentAttachments: [],
      goalModeActive: false,
    });

    publishComposerDraftTransfer(committedAppHandle, transfer);
    expect(consumeComposerDraftTransfer(committedAppHandle, "thread_target")).toEqual(transfer);
    expect(consumeComposerDraftTransfer(committedAppHandle, "thread_target")).toBeNull();
  });

  test("evicts the least-recent unmounted composer after the exact max-100 boundary", () => {
    const store = createStore();
    let currentHandle: ScopeHandle | null = null;
    const tree = (identity: string) => (
      <MaitaiProvider store={store}>
        <ScopeTree
          identity={identity}
          onHandle={(next) => {
            currentHandle = next;
          }}
        />
      </MaitaiProvider>
    );
    const view = render(tree("composer:0"));
    const initialHandle = currentHandle as ScopeHandle | null;
    if (!initialHandle) throw new Error("Expected initial ComposerScope handle");
    act(() => initialHandle.set(composerGoalModeActiveAtom, true));

    for (let index = 1; index <= 101; index += 1) {
      act(() => view.rerender(tree(`composer:${index}`)));
    }
    act(() => view.rerender(tree("composer:0")));

    const remountedHandle = currentHandle as ScopeHandle | null;
    if (!remountedHandle) throw new Error("Expected remounted ComposerScope handle");
    expect(remountedHandle.get(composerGoalModeActiveAtom)).toBe(false);
  });
});
