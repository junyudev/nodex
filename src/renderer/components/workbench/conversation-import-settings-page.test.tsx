import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
  NativeConversationImportPreview,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ClaudeAgentSettings, ProjectWindow } from "../../../shared/types";
import {
  createNativeConversationImportLedger,
  type NativeConversationImportLedger,
} from "../../lib/native-conversation-import-ledger";
import { openNodexMenu, render, settleAsyncRender } from "../../test/dom";
import {
  ConversationImportSettingsPage,
  type ConversationImportRuntime,
} from "./conversation-import-settings-page";

const BILLING = "0199a7c4-5b7e-7d10-9a3e-2f4b6c8d0e12";
const LOGS = "0199a7c4-5b7e-7d10-9a3e-2f4b6c8d0e13";
const AUTH = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const REQUEST_ID = /^[0-9a-f-]{36}$/u;

const codexPage: NativeSessionCatalogPage = {
  nativeHome: "/home/.codex",
  entries: [
    {
      nativeSessionId: BILLING,
      title: "Migrate billing",
      cwd: "/repo/gone",
      cwdAvailable: false,
      updatedAt: 3_000,
    },
    {
      nativeSessionId: LOGS,
      title: "Tidy logs",
      cwd: "/repo/gone",
      cwdAvailable: false,
      updatedAt: 1_000,
    },
  ],
  nextCursor: null,
};
const claudePage: NativeSessionCatalogPage = {
  nativeHome: "/profiles/claude-work",
  entries: [
    { nativeSessionId: AUTH, title: "Fix authentication", cwd: "/repo/work", updatedAt: 2_000 },
  ],
  nextCursor: null,
};
const billingPreview: NativeConversationImportPreview = {
  backendKind: "codex",
  nativeSessionId: BILLING,
  nativeHome: "/home/.codex",
  title: "Migrate billing",
  cwd: "/repo/billing",
  cwdAvailable: true,
  updatedAt: 3_000,
};
const projectWindow: ProjectWindow = {
  items: [{ id: "project-nodex", name: "Nodex" } as ProjectWindow["items"][number]],
  nextCursor: null,
  hasMore: false,
  storeEpoch: "epoch",
  projectionRevision: 1,
};
const workProfiles: ClaudeAgentSettings = {
  instances: [{ ...defaultClaudeInstance(), id: "work", displayName: "Work" }],
};
const imported = (input: NativeConversationImportInput): NativeConversationImportOutcome => ({
  kind: "imported",
  sessionId: `session-${input.requestId}`,
  threadId: `thread-${input.nativeSessionId}`,
  projectId: input.projectId,
});

const makeRuntime = (overrides: Partial<ConversationImportRuntime> = {}) =>
  ({
    profiles: async () => workProfiles,
    projects: async () => projectWindow,
    list: vi.fn<ConversationImportRuntime["list"]>(async (input) =>
      input.backendKind === "codex" ? codexPage : claudePage,
    ),
    preview: vi.fn<ConversationImportRuntime["preview"]>(async () => ({
      matches: [billingPreview],
    })),
    importConversation: vi.fn<ConversationImportRuntime["importConversation"]>(async (input) =>
      imported(input),
    ),
    pickDirectory: vi.fn<ConversationImportRuntime["pickDirectory"]>(async () => "/repo/moved"),
    ...overrides,
  }) satisfies ConversationImportRuntime;

type PageProps = Partial<Parameters<typeof ConversationImportSettingsPage>[0]>;
const page = (
  runtime: ConversationImportRuntime,
  ledger: NativeConversationImportLedger,
  props: PageProps = {},
) => <ConversationImportSettingsPage open runtime={runtime} ledger={ledger} {...props} />;
const renderPage = async (
  runtime: ConversationImportRuntime,
  props: PageProps = {},
  ledger = createNativeConversationImportLedger(),
) => {
  const view = render(page(runtime, ledger, props));
  await settleAsyncRender();
  return { ...view, ledger };
};
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};
const referenceInput = () =>
  screen.getByRole("textbox", { name: "Conversation link or ID" }) as HTMLInputElement;
const paste = async (value: string) => {
  await act(async () => {
    fireEvent.paste(referenceInput());
    fireEvent.change(referenceInput(), { target: { value } });
    await Promise.resolve();
  });
};
const row = (title: string) => screen.findByRole("group", { name: title });
const footer = () => screen.getByRole("group", { name: "Import selection" });
const footerButton = (name: string) =>
  within(footer()).getByRole("button", { name }) as HTMLButtonElement;
const footerStatus = () => within(footer()).getByRole("status").textContent;
const chooseDestination = async (name: string) => {
  await openNodexMenu(footerButton("Import destination"));
  await click(await screen.findByRole("option", { name }));
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

it("imports a pasted Codex link into the active Project and opens the new chat", async () => {
  const runtime = makeRuntime();
  const onOpenThread = vi.fn();
  await renderPage(runtime, { onOpenThread, activeProjectId: "project-nodex" });
  await paste(`codex://threads/${BILLING}`);

  const billing = await row("Migrate billing");
  expect(runtime.preview).toHaveBeenCalledWith({ reference: `codex://threads/${BILLING}` });
  expect(
    within(billing).getByRole("checkbox", { name: "Migrate billing" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(referenceInput().value).toBe("");
  expect(footerButton("Import destination").textContent).toBe("Nodex");

  await click(footerButton("Import and open"));
  await waitFor(() => expect(onOpenThread).toHaveBeenCalledTimes(1));
  const [request] = vi.mocked(runtime.importConversation).mock.calls[0]!;
  expect(request).toEqual({
    requestId: expect.stringMatching(REQUEST_ID),
    acceptedAt: expect.any(Number),
    backendKind: "codex",
    nativeSessionId: BILLING,
    expectedHome: "/home/.codex",
    projectId: "project-nodex",
    cwd: "/repo/billing",
  });
  expect(onOpenThread).toHaveBeenCalledWith(`thread-${BILLING}`, {
    runtimeSessionId: `session-${request.requestId}`,
  });
});

it("browses every source newest first and batch-imports with one replacement per missing folder", async () => {
  const runtime = makeRuntime();
  const onOpenThread = vi.fn();
  await renderPage(runtime, { onOpenThread });
  await click(screen.getByRole("button", { name: "Browse" }));
  await row("Tidy logs");
  expect(runtime.list).toHaveBeenCalledWith({ backendKind: "codex" });
  expect(runtime.list).toHaveBeenCalledWith({ backendKind: "claude", instanceConfigId: "work" });
  expect(
    screen
      .getAllByText(/^(Migrate billing|Fix authentication|Tidy logs)$/u)
      .map((title) => title.textContent),
  ).toEqual(["Migrate billing", "Fix authentication", "Tidy logs"]);

  await click(within(footer()).getByRole("checkbox", { name: "Select all conversations" }));
  expect(footerStatus()).toBe("3 selected · 2 need a folder");
  expect(footerButton("Import 3").disabled).toBe(true);

  await click(within(await row("Migrate billing")).getByRole("button", { name: "Choose folder" }));
  await within(await row("Tidy logs")).findByRole("button", { name: "Change folder" });
  expect(within(await row("Tidy logs")).getByText("/repo/moved")).toBeTruthy();
  expect(runtime.pickDirectory).toHaveBeenCalledTimes(1);
  expect(footerStatus()).toBe("3 selected");

  await click(footerButton("Import 3"));
  await waitFor(() => expect(footerStatus()).toBe("Imported 3 conversations"));
  const requests = vi.mocked(runtime.importConversation).mock.calls.map(([input]) => input);
  expect(requests).toEqual([
    expect.objectContaining({ backendKind: "codex", nativeSessionId: BILLING, cwd: "/repo/moved" }),
    expect.objectContaining({
      backendKind: "claude",
      instanceConfigId: "work",
      nativeSessionId: AUTH,
      expectedHome: "/profiles/claude-work",
      cwd: "/repo/work",
    }),
    expect.objectContaining({ backendKind: "codex", nativeSessionId: LOGS, cwd: "/repo/moved" }),
  ]);
  expect(requests[0]).not.toHaveProperty("instanceConfigId");
  expect(onOpenThread).not.toHaveBeenCalled();
  for (const title of ["Migrate billing", "Fix authentication", "Tidy logs"])
    expect(within(await row(title)).getByRole("button", { name: "Open" })).toBeTruthy();
});

it("finishes an unknown outcome with its original request even after the destination changes", async () => {
  const importConversation = vi
    .fn<ConversationImportRuntime["importConversation"]>()
    .mockRejectedValueOnce(new Error("Agent Runtime is restarting."))
    .mockResolvedValueOnce({
      kind: "not_admitted",
      message: "This folder is no longer available. Refresh and choose another one.",
    })
    .mockImplementation(async (input) => imported(input));
  const onOpenThread = vi.fn();
  await renderPage(makeRuntime({ importConversation }), { onOpenThread });
  await paste(BILLING);
  await click(footerButton("Import and open"));

  const billing = await row("Migrate billing");
  expect((await within(billing).findByRole("alert")).textContent).toBe(
    "Agent Runtime is restarting.",
  );
  expect(within(billing).getByText("Import again to finish it in Projectless.")).toBeTruthy();

  await chooseDestination("Nodex");
  await click(footerButton("Import and open"));
  await waitFor(() => expect(importConversation).toHaveBeenCalledTimes(2));
  const [first, retry] = importConversation.mock.calls.map(([input]) => input);
  expect(retry).toEqual(first);
  expect(first!.projectId).toBeNull();

  // Proven unadmitted: nothing exists, so the current destination now applies to a new request.
  expect((await within(billing).findByRole("alert")).textContent).toBe(
    "This folder is no longer available. Refresh and choose another one.",
  );
  expect(within(billing).queryByText(/Import again to finish/u)).toBeNull();
  await click(footerButton("Import and open"));
  await waitFor(() => expect(onOpenThread).toHaveBeenCalledTimes(1));
  const fresh = importConversation.mock.calls[2]![0];
  expect(fresh.projectId).toBe("project-nodex");
  expect(fresh.requestId).not.toBe(first!.requestId);
});

it("keeps one submission per conversation when the page is left and reopened mid-import", async () => {
  const reply = deferred<NativeConversationImportOutcome>();
  const importConversation = vi.fn<ConversationImportRuntime["importConversation"]>(
    () => reply.promise,
  );
  const runtime = makeRuntime({
    importConversation,
    list: vi.fn(async (input) =>
      input.backendKind === "codex"
        ? { ...codexPage, entries: [{ ...codexPage.entries[0]!, cwdAvailable: true }] }
        : claudePage,
    ),
  });
  const first = await renderPage(runtime);
  await paste(BILLING);
  await row("Migrate billing");
  await click(footerButton("Import"));
  first.unmount();

  const second = await renderPage(runtime, { onOpenThread: vi.fn() }, first.ledger);
  await click(screen.getByRole("button", { name: "Browse" }));
  const billing = await row("Migrate billing");
  expect(within(billing).getByText("Importing…")).toBeTruthy();
  expect(
    (within(billing).getByRole("checkbox", { name: "Migrate billing" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  await act(async () => {
    reply.resolve({
      kind: "imported",
      sessionId: "copy-session",
      threadId: "copy-thread",
      projectId: null,
    });
    await Promise.resolve();
  });
  // The catalog was read before the copy existed; the settled copy is offered instead.
  expect(await within(billing).findByRole("button", { name: "Open" })).toBeTruthy();
  expect(importConversation).toHaveBeenCalledTimes(1);
  second.unmount();
});

it("keeps an unfinished import reachable after leaving the page, even if its source is gone", async () => {
  const importConversation = vi
    .fn<ConversationImportRuntime["importConversation"]>()
    .mockRejectedValueOnce(new Error("Agent Runtime is restarting."))
    .mockImplementation(async (input) => imported(input));
  const runtime = makeRuntime({ importConversation });
  const first = await renderPage(runtime);
  await paste(BILLING);
  await row("Migrate billing");
  await click(footerButton("Import"));
  await within(await row("Migrate billing")).findByRole("alert");
  first.unmount();

  const gone = makeRuntime({
    importConversation,
    list: vi.fn(async () => ({ nativeHome: "/home/.codex", entries: [], nextCursor: null })),
    profiles: async () => ({ instances: [] }),
  });
  await renderPage(gone, {}, first.ledger);
  await click(screen.getByRole("button", { name: "Browse" }));
  const billing = await row("Migrate billing");
  expect(within(billing).getByText("Import again to finish it in Projectless.")).toBeTruthy();
  await click(within(billing).getByRole("checkbox", { name: "Migrate billing" }));
  await click(footerButton("Import"));
  await waitFor(() => expect(importConversation).toHaveBeenCalledTimes(2));
  const [original, retry] = importConversation.mock.calls.map(([input]) => input);
  expect(retry).toEqual(original);
});

it("defaults to the active Project even when it is beyond the first page of Projects", async () => {
  const runtime = makeRuntime({
    projects: async () => ({ ...projectWindow, nextCursor: "more", hasMore: true }),
  });
  await renderPage(runtime, {
    activeProjectId: "project-101",
    projects: [{ id: "project-101", name: "Billing service" }],
  });
  await paste(BILLING);
  await row("Migrate billing");
  expect(footerButton("Import destination").textContent).toBe("Billing service");
  await click(footerButton("Import"));
  await waitFor(() =>
    expect(runtime.importConversation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-101" }),
    ),
  );
});

it("keeps the active destination and Claude sources when Projects fail to load", async () => {
  const projects = vi
    .fn<ConversationImportRuntime["projects"]>()
    .mockRejectedValueOnce(new Error("Core is restarting."))
    .mockResolvedValue(projectWindow);
  const runtime = makeRuntime({ projects });
  await renderPage(runtime, { activeProjectId: "project-elsewhere" });
  expect((await screen.findByRole("alert")).textContent).toBe("Projects: Core is restarting.");

  await click(screen.getByRole("button", { name: "Browse" }));
  await row("Fix authentication");
  await click(within(await row("Fix authentication")).getByRole("checkbox"));
  expect(footerButton("Import destination").textContent).toBe("Current Project");
  await click(footerButton("Import"));
  await waitFor(() =>
    expect(runtime.importConversation).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-elsewhere", instanceConfigId: "work" }),
    ),
  );

  await click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByText("Projects: Core is restarting.")).toBeNull());
  expect(projects).toHaveBeenCalledTimes(2);
});

it("adds Claude sources to a browse that started before profiles loaded", async () => {
  const profiles = deferred<ClaudeAgentSettings>();
  const runtime = makeRuntime({ profiles: () => profiles.promise });
  await renderPage(runtime);
  await click(screen.getByRole("button", { name: "Browse" }));
  await row("Migrate billing");
  expect(runtime.list).toHaveBeenCalledTimes(1);

  await act(async () => {
    profiles.resolve(workProfiles);
    await Promise.resolve();
  });
  await row("Fix authentication");
  expect(runtime.list).toHaveBeenLastCalledWith({
    backendKind: "claude",
    instanceConfigId: "work",
  });
  expect(runtime.list).toHaveBeenCalledTimes(2);
});

it("offers an existing copy instead of importing the same source again", async () => {
  const runtime = makeRuntime({
    preview: vi.fn(async () => ({
      matches: [
        { ...billingPreview, importedThreadId: "copy-thread", importedSessionId: "copy-session" },
      ],
    })),
  });
  const onOpenThread = vi.fn();
  await renderPage(runtime, { onOpenThread });
  await paste(BILLING);

  const billing = await row("Migrate billing");
  expect(screen.getByText("Already imported. Open the existing chat below.")).toBeTruthy();
  expect(within(billing).queryByRole("checkbox")).toBeNull();
  expect(footerStatus()).toBe("Select conversations to import");
  await click(within(billing).getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(onOpenThread).toHaveBeenCalledWith("copy-thread", { runtimeSessionId: "copy-session" }),
  );
  expect(runtime.importConversation).not.toHaveBeenCalled();
});

it("explains unusable references and keeps a failed lookup retryable", async () => {
  const preview = vi
    .fn<ConversationImportRuntime["preview"]>()
    .mockRejectedValueOnce(new Error("Native conversation lookup failed."))
    .mockResolvedValueOnce({ matches: [] })
    .mockResolvedValue({ matches: [billingPreview] });
  await renderPage(makeRuntime({ preview }));

  await paste("https://example.com/not-a-thread");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Paste a codex://threads link or a conversation ID.",
  );
  expect(preview).not.toHaveBeenCalled();

  await paste(BILLING);
  expect((await screen.findByRole("alert")).textContent).toBe("Native conversation lookup failed.");
  await click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No Codex or Claude Code conversation has this ID.")).toBeTruthy();
  expect(referenceInput().value).toBe(BILLING);

  await act(async () => {
    fireEvent.keyDown(referenceInput(), { key: "Enter" });
    await Promise.resolve();
  });
  await row("Migrate billing");
  expect(preview).toHaveBeenCalledTimes(3);
});

it("reports a source that cannot be read and retries just that source", async () => {
  const list = vi
    .fn<ConversationImportRuntime["list"]>()
    .mockImplementation(async (input) => (input.backendKind === "codex" ? codexPage : claudePage));
  list
    .mockImplementationOnce(async () => codexPage)
    .mockImplementationOnce(async () => {
      throw new Error("Claude Code is not signed in.");
    });
  await renderPage(makeRuntime({ list }));
  await click(screen.getByRole("button", { name: "Browse" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Claude Code: Claude Code is not signed in.",
  );
  expect(screen.queryByText("Fix authentication")).toBeNull();

  await click(screen.getByRole("button", { name: "Try again" }));
  await row("Fix authentication");
  expect(list).toHaveBeenLastCalledWith({ backendKind: "claude", instanceConfigId: "work" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reads past pages without importable conversations so more rows only append", async () => {
  const list = vi
    .fn<ConversationImportRuntime["list"]>()
    .mockImplementation(async (input) =>
      input.backendKind === "claude"
        ? claudePage
        : input.cursor === "older"
          ? { ...codexPage, entries: [codexPage.entries[1]!] }
          : { ...codexPage, entries: [], nextCursor: "older" },
    );
  await renderPage(makeRuntime({ list }));
  await click(screen.getByRole("button", { name: "Browse" }));
  await row("Tidy logs");
  expect(list).toHaveBeenCalledWith({ backendKind: "codex", cursor: "older" });
  expect(
    screen.getAllByText(/^(Fix authentication|Tidy logs)$/u).map((title) => title.textContent),
  ).toEqual(["Fix authentication", "Tidy logs"]);
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

it("finishes an import after Settings closes without taking the user to it", async () => {
  const reply = deferred<NativeConversationImportOutcome>();
  const runtime = makeRuntime({ importConversation: vi.fn(() => reply.promise) });
  const onOpenThread = vi.fn();
  const ledger = createNativeConversationImportLedger();
  const { rerender } = render(page(runtime, ledger, { onOpenThread }));
  await settleAsyncRender();
  await paste(BILLING);
  await row("Migrate billing");
  await click(footerButton("Import and open"));
  expect(referenceInput().readOnly).toBe(true);
  expect((screen.getByRole("button", { name: "Browse" }) as HTMLButtonElement).disabled).toBe(true);

  rerender(page(runtime, ledger, { onOpenThread, open: false }));
  await act(async () => {
    reply.resolve({
      kind: "imported",
      sessionId: "chat",
      threadId: "agent-thread",
      projectId: null,
    });
    await Promise.resolve();
  });
  rerender(page(runtime, ledger, { onOpenThread }));
  const open = await within(await row("Migrate billing")).findByRole("button", { name: "Open" });
  expect(onOpenThread).not.toHaveBeenCalled();
  expect(referenceInput().readOnly).toBe(false);
  await click(open);
  await waitFor(() =>
    expect(onOpenThread).toHaveBeenCalledWith("agent-thread", { runtimeSessionId: "chat" }),
  );
});
