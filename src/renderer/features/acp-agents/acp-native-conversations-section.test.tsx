import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { acpProviderId, type AcpNativeSession } from "./acp-agent-model";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import {
  fakeAcpRuntime,
  memoryJournal,
  ok,
  providerSnapshot,
  registryInstance,
} from "./acp-agents.test-fixtures";
import { AcpNativeConversationsSection } from "./acp-native-conversations-section";

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

const session = (patch: Partial<AcpNativeSession>): AcpNativeSession => ({
  sessionId: "native-1",
  cwd: "/work/app",
  additionalDirectories: [],
  title: "Fix the parser",
  updatedAt: "2026-10-24T10:00:00.000Z",
  importedThreadId: null,
  ...patch,
});

function mount(
  capabilities: { canLoad: boolean; canResume: boolean; canDelete: boolean },
  sessions: readonly AcpNativeSession[],
) {
  const qoder = registryInstance();
  const main = fakeAcpRuntime({ instances: [qoder] });
  main.runtime.knownProviders.mockResolvedValue([
    providerSnapshot({
      instanceId: acpProviderId(qoder)!,
      nativeSessions: {
        canList: true,
        canLoad: capabilities.canLoad,
        canResume: capabilities.canResume,
      },
    }),
  ]);
  main.runtime.listSessions.mockResolvedValue(
    ok({ sessions: [...sessions], nextCursor: null, ...capabilities }),
  );
  main.runtime.prepareImport.mockImplementation(async ({ sessionId }) =>
    ok({
      threadId: `thread-${sessionId}`,
      sourceFingerprint: "fp",
      title: "Fix the parser",
      cwd: "/work/app",
      imported: false,
      canLoad: capabilities.canLoad,
      canResume: capabilities.canResume,
    }),
  );
  main.runtime.importSession.mockImplementation(async ({ sessionId }) =>
    ok({
      sessionId: `session-${sessionId}`,
      threadId: `thread-${sessionId}`,
      projectId: "project",
    }),
  );
  main.runtime.deleteSession.mockResolvedValue(ok({ deleted: true as const }));
  const owner = createAcpAgentsOwner({
    runtime: main.runtime,
    subscribeChanges: () => () => {},
    journal: memoryJournal(),
  });
  const onOpenThread = vi.fn();
  const view = renderWithAppMaitai(
    <NodexTooltipProvider delay={0}>
      <AcpNativeConversationsSection
        owner={owner}
        defaultProjectId="project"
        destinations={() => ({
          options: [
            { projectId: null, label: "Projectless" },
            { projectId: "project", label: "App" },
          ],
          hasMore: false,
          loadingMore: false,
          loadMore: () => {},
        })}
        onOpenThread={onOpenThread}
      />
    </NodexTooltipProvider>,
  );
  return { main, view, onOpenThread };
}

describe("ACP native conversations", () => {
  test("a loadable conversation imports without a prompt and opens the new chat", async () => {
    const { main, view, onOpenThread } = mount(
      { canLoad: true, canResume: false, canDelete: false },
      [session({})],
    );
    const row = await view.findByRole("group", { name: "Fix the parser" });
    expect(main.runtime.listSessions).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      projectId: "project",
    });
    expect(within(row).queryByRole("button", { name: "Delete from Qoder" })).toBeNull();
    await press(within(row).getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(onOpenThread).toHaveBeenCalledWith("thread-native-1", {
        runtimeSessionId: "session-native-1",
      }),
    );
    const request = main.runtime.importSession.mock.calls[0]![0];
    expect(request).toMatchObject({
      instanceId: "qoder-main",
      projectId: "project",
      sessionId: "native-1",
    });
    await within(row).findByRole("button", { name: "Open" });

    // Opening again reuses the same request, so Main returns the same chat.
    await press(within(row).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(main.runtime.importSession).toHaveBeenCalledTimes(2));
    expect(main.runtime.importSession.mock.calls[1]![0].requestId).toBe(request.requestId);
  });

  test("a resume-only Agent explains that earlier messages won't appear before importing", async () => {
    const { main, view } = mount({ canLoad: false, canResume: true, canDelete: false }, [
      session({ sessionId: "native-2" }),
    ]);
    const row = await view.findByRole("group", { name: "Fix the parser" });
    await press(within(row).getByRole("button", { name: "Import" }));
    await within(row).findByText(/can't show its earlier messages/);
    expect(main.runtime.importSession).not.toHaveBeenCalled();
    const confirm = within(row).getAllByRole("button", { name: "Import" });
    await press(confirm[confirm.length - 1]!);
    await waitFor(() => expect(main.runtime.importSession).toHaveBeenCalledOnce());
  });

  test("deleting from the Agent asks first and is offered only for unimported conversations", async () => {
    const { main, view } = mount({ canLoad: true, canResume: false, canDelete: true }, [
      session({ sessionId: "kept", title: "Imported", importedThreadId: "thread-kept" }),
      session({ sessionId: "gone", title: "Scratch" }),
    ]);
    const imported = await view.findByRole("group", { name: "Imported" });
    expect(within(imported).queryByRole("button", { name: "Delete from Qoder" })).toBeNull();
    const scratch = view.getByRole("group", { name: "Scratch" });
    await press(within(scratch).getByRole("button", { name: "Delete from Qoder" }));
    expect(main.runtime.deleteSession).not.toHaveBeenCalled();
    await press(within(scratch).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(main.runtime.deleteSession).toHaveBeenCalledWith({
        instanceId: "qoder-main",
        projectId: "project",
        sessionId: "gone",
      }),
    );
    await waitFor(() => expect(view.queryByRole("group", { name: "Scratch" })).toBeNull());
  });

  test("an Agent that doesn't list conversations is shown as unavailable instead of empty", async () => {
    const qoder = registryInstance();
    const main = fakeAcpRuntime({ instances: [qoder] });
    main.runtime.knownProviders.mockResolvedValue([
      providerSnapshot({
        instanceId: acpProviderId(qoder)!,
        nativeSessions: { canList: false, canLoad: false, canResume: false },
      }),
    ]);
    const owner = createAcpAgentsOwner({
      runtime: main.runtime,
      subscribeChanges: () => () => {},
      journal: memoryJournal(),
    });
    const view = renderWithAppMaitai(
      <AcpNativeConversationsSection
        owner={owner}
        defaultProjectId={null}
        destinations={() => ({
          options: [],
          hasMore: false,
          loadingMore: false,
          loadMore: () => {},
        })}
      />,
    );
    await view.findByText("Connected Agents that list their conversations appear here.");
    expect(main.runtime.listSessions).not.toHaveBeenCalled();
  });
});
