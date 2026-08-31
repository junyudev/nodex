import { StrictMode, useLayoutEffect } from "react";
import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ProjectSession } from "../../shared/types";
import {
  AppShellHeaderContentRegistrar,
  ComposerScope,
  IdentityPromotionConflict,
  promoteThreadScopeToPending,
  SelectedAppShellHeaderContent,
  WorkbenchSessionScopePath,
  createThreadScopeIdentityRegistry,
  resolveComposerScopeIdentity,
  resolvePendingThreadScopeDescriptor,
  resolveProjectDraftThreadScopeDescriptor,
  resolveProjectSessionThreadScopeDescriptor,
  type ThreadScopeDescriptor,
} from "./workbench-ui-scopes";
import {
  createMaitaiStore,
  MaitaiProvider,
  ScopeProvider,
  scopedAtom,
  useScopeHandle,
  type ScopeHandle,
} from "./maitai";

const composerSignal = scopedAtom(ComposerScope, "empty", { debugLabel: "composer-signal-test" });

function descriptor(stableKey: `session:${string}`, threadId: string): ThreadScopeDescriptor {
  return {
    stableKey,
    phase: "attached",
    projectSessionId: stableKey.slice("session:".length),
    clientThreadId: null,
    threadId,
  };
}

function projectSession(threadId: string | null = null): ProjectSession {
  return {
    id: "session-1",
    projectId: "project-1",
    noThreadFallbackTitle: "New task",
    displayTitle: "New task",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: threadId
      ? {
          sessionId: "session-1",
          projectId: "project-1",
          threadId,
          threadPreview: "Task",
          backendBinding: { kind: "codex" },
          executionHostId: "local",
          statusType: "idle",
          statusActiveFlags: [],
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          linkedAt: "2026-08-01T00:00:00.000Z",
        }
      : null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("Workbench Maitai scopes", () => {
  test("keeps client identity stable when a server thread attaches", () => {
    const registry = createThreadScopeIdentityRegistry();
    expect(registry.resolve({ clientThreadId: "pending-1" })).toBe("client:pending-1");
    expect(
      registry.resolve({
        projectSessionId: "session-1",
        clientThreadId: "pending-1",
        threadId: "thread-1",
      }),
    ).toBe("client:pending-1");
    expect(registry.resolve({ projectSessionId: "session-1" })).toBe("client:pending-1");
    expect(registry.resolve({ threadId: "thread-1", projectSessionId: "session-1" })).toBe(
      "client:pending-1",
    );
  });

  test("promotes a Project draft through Session and Thread identities", () => {
    const registry = createThreadScopeIdentityRegistry();
    expect(resolveProjectDraftThreadScopeDescriptor(registry, "draft-1").stableKey).toBe(
      "draft:draft-1",
    );
    registry.register("draft:draft-1", {
      draftId: "draft-1",
      projectSessionId: "session-1",
    });
    expect(registry.resolve({ projectSessionId: "session-1" })).toBe("draft:draft-1");
    registry.register("draft:draft-1", {
      projectSessionId: "session-1",
      clientThreadId: "client-1",
      threadId: "thread-1",
    });
    expect(registry.resolve({ threadId: "thread-1" })).toBe("draft:draft-1");
  });

  test("direct, duplicate, and stale attachment metadata preserve one session identity", () => {
    const registry = createThreadScopeIdentityRegistry();
    expect(registry.resolve({ projectSessionId: "session-1", threadId: "thread-1" })).toBe(
      "session:session-1",
    );
    expect(registry.resolve({ projectSessionId: "session-1", threadId: "thread-1" })).toBe(
      "session:session-1",
    );
    expect(registry.resolve({ projectSessionId: "session-1", threadId: "thread-stale" })).toBe(
      "session:session-1",
    );
    expect(registry.resolve({ threadId: "thread-stale" })).toBe("session:session-1");
  });

  test("rejects promotion conflicts instead of merging two identity graphs", () => {
    const registry = createThreadScopeIdentityRegistry();
    registry.resolve({ projectSessionId: "session-1" });
    registry.resolve({ clientThreadId: "pending-1" });
    expect(() =>
      registry.resolve({
        projectSessionId: "session-1",
        clientThreadId: "pending-1",
      }),
    ).toThrow(IdentityPromotionConflict);
  });

  test("allocates pending work from its immutable client identity", () => {
    const registry = createThreadScopeIdentityRegistry();
    expect(resolvePendingThreadScopeDescriptor(registry, " pending-1 ")).toEqual({
      stableKey: "client:pending-1",
      phase: "pending",
      projectSessionId: null,
      clientThreadId: "pending-1",
      threadId: null,
    });
  });

  test("rejoins a pending sidebar route to its already-known origin Session", () => {
    const registry = createThreadScopeIdentityRegistry();
    registry.resolve({ projectSessionId: "session-1" });

    expect(resolvePendingThreadScopeDescriptor(registry, "client-1", "session-1")).toMatchObject({
      stableKey: "session:session-1",
      projectSessionId: "session-1",
      clientThreadId: "client-1",
    });
  });

  test("keeps a Project Session scope stable from pending worktree to attached Thread", () => {
    const registry = createThreadScopeIdentityRegistry();
    const pending = resolveProjectSessionThreadScopeDescriptor(
      registry,
      projectSession(),
      "client-1",
    );
    const attached = resolveProjectSessionThreadScopeDescriptor(
      registry,
      projectSession("thread-1"),
      "client-1",
    );

    expect(pending).toEqual({
      stableKey: "client:client-1",
      phase: "pending",
      projectSessionId: "session-1",
      clientThreadId: "client-1",
      threadId: null,
    });
    expect(attached).toEqual({
      ...pending,
      phase: "attached",
      threadId: "thread-1",
    });
  });

  test("promotes an existing Session before the pending route resolves the client id", () => {
    const registry = createThreadScopeIdentityRegistry();
    const source = resolveProjectSessionThreadScopeDescriptor(registry, projectSession());
    const promoted = promoteThreadScopeToPending(registry, source, " client-1 ");
    const pending = resolvePendingThreadScopeDescriptor(registry, "client-1");
    const attached = resolveProjectSessionThreadScopeDescriptor(
      registry,
      projectSession("thread-1"),
      "client-1",
    );

    expect(promoted).toMatchObject({
      stableKey: "session:session-1",
      phase: "pending",
      clientThreadId: "client-1",
    });
    expect(pending.stableKey).toBe("session:session-1");
    expect(attached.stableKey).toBe("session:session-1");
  });

  test("uses the actual target Session when a pending start changes Project", () => {
    const registry = createThreadScopeIdentityRegistry();
    const source = resolveProjectSessionThreadScopeDescriptor(registry, projectSession());

    const pending = promoteThreadScopeToPending(registry, source, "client-2", "session-2");

    expect(pending).toMatchObject({
      stableKey: "client:client-2",
      projectSessionId: "session-2",
      clientThreadId: "client-2",
    });
    expect(registry.resolve({ projectSessionId: "session-2" })).toBe("client:client-2");
    expect(registry.resolve({ projectSessionId: "session-1" })).toBe("session:session-1");
  });

  test("keeps composer entry identity stable while carrying focus signals", () => {
    expect(resolveComposerScopeIdentity({ kind: "new-conversation" }).identity).toBe(
      "new-conversation",
    );
    expect(resolveComposerScopeIdentity({ kind: "panel-new-conversation" }).identity).toBe(
      "panel-new-conversation",
    );
    expect(
      resolveComposerScopeIdentity({
        kind: "preview",
        attachmentIdentity: "page-1",
      }).identity,
    ).toBe("preview:page-1");
    expect(
      resolveComposerScopeIdentity({
        kind: "task",
        stableIdentity: "session-1",
        focusComposerNonce: 3,
      }),
    ).toEqual({
      identity: "task:session-1",
      focusComposerNonce: 3,
    });
  });

  test("pending-to-attached preserves the ThreadScope and Composer signal", () => {
    const store = createMaitaiStore();
    const handles: ScopeHandle[] = [];
    function Probe() {
      const handle = useScopeHandle(ComposerScope);
      useLayoutEffect(() => {
        handles.push(handle);
      }, [handle]);
      return null;
    }
    const tree = (thread: ThreadScopeDescriptor) => (
      <MaitaiProvider store={store}>
        <WorkbenchSessionScopePath
          thread={thread}
          route={{ routeKey: "/thread", kind: "thread" }}
          selected
        >
          <ScopeProvider
            scope={ComposerScope}
            descriptor={{ identity: "task:client:pending-1", focusComposerNonce: null }}
          >
            <Probe />
          </ScopeProvider>
        </WorkbenchSessionScopePath>
      </MaitaiProvider>
    );
    const pending: ThreadScopeDescriptor = {
      stableKey: "client:pending-1",
      phase: "pending",
      projectSessionId: null,
      clientThreadId: "pending-1",
      threadId: null,
    };
    const view = render(tree(pending));
    handles[0]?.set(composerSignal, "authored draft");
    const firstConcrete = handles[0]?.resolve(composerSignal);
    view.rerender(
      tree({
        ...pending,
        phase: "attached",
        projectSessionId: "session-1",
        threadId: "thread-1",
      }),
    );
    expect(handles.at(-1)?.resolve(composerSignal)).toBe(firstConcrete);
    expect(handles.at(-1)?.get(composerSignal)).toBe("authored draft");

    view.unmount();
    render(
      tree({
        ...pending,
        phase: "attached",
        projectSessionId: "session-1",
        threadId: "thread-1",
      }),
    );
    expect(handles.at(-1)?.get(composerSignal)).toBe("authored draft");
  });

  test("selected route renders one isolated header under StrictMode", () => {
    const store = createMaitaiStore();
    const tree = (selected: "a" | "b", includeA = true) => (
      <StrictMode>
        <MaitaiProvider store={store}>
          <SelectedAppShellHeaderContent />
          {includeA ? (
            <WorkbenchSessionScopePath
              thread={descriptor("session:a", "thread-a")}
              route={{ routeKey: "/thread", kind: "thread" }}
              selected={selected === "a"}
            >
              <AppShellHeaderContentRegistrar
                content={<h1 data-testid="thread-stage-title">A</h1>}
              />
            </WorkbenchSessionScopePath>
          ) : null}
          <WorkbenchSessionScopePath
            thread={descriptor("session:b", "thread-b")}
            route={{ routeKey: "/thread", kind: "thread" }}
            selected={selected === "b"}
          >
            <AppShellHeaderContentRegistrar content={<h1 data-testid="thread-stage-title">B</h1>} />
          </WorkbenchSessionScopePath>
        </MaitaiProvider>
      </StrictMode>
    );
    const view = render(tree("a"));
    expect(view.getAllByTestId("thread-stage-title").map((node) => node.textContent)).toEqual([
      "A",
    ]);
    view.rerender(tree("b"));
    expect(view.getAllByTestId("thread-stage-title").map((node) => node.textContent)).toEqual([
      "B",
    ]);
    view.rerender(tree("b", false));
    expect(view.getAllByTestId("thread-stage-title").map((node) => node.textContent)).toEqual([
      "B",
    ]);
    view.rerender(tree("a"));
    expect(view.getAllByTestId("thread-stage-title").map((node) => node.textContent)).toEqual([
      "A",
    ]);
  });

  test("session descriptor updates do not republish an unchanged route owner", () => {
    const store = createMaitaiStore();
    const setAtom = vi.spyOn(store.jotaiStore, "set");
    const stableHeader = <h1 data-testid="stable-thread-stage-title">A</h1>;
    const tree = (revision: number) => (
      <MaitaiProvider store={store}>
        <SelectedAppShellHeaderContent />
        <WorkbenchSessionScopePath
          thread={descriptor("session:a", `thread-revision-${revision}`)}
          route={{ routeKey: "/thread", kind: "thread" }}
          selected
        >
          <AppShellHeaderContentRegistrar content={stableHeader} />
        </WorkbenchSessionScopePath>
      </MaitaiProvider>
    );

    const view = render(tree(0));
    setAtom.mockClear();
    view.rerender(tree(1));

    const routeOwnerWrites = setAtom.mock.calls.filter(([atom]) =>
      (atom as { readonly debugLabel?: string }).debugLabel?.endsWith(
        "/selected-route-scope-handle",
      ),
    );
    expect(routeOwnerWrites).toHaveLength(0);
    expect(view.getByTestId("stable-thread-stage-title").textContent).toBe("A");
  });
});
