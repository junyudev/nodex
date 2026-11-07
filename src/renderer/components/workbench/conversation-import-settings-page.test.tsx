import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
  NativeConversationImportPreview,
  NativeConversationImportPreviewResult,
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
    pathContext: async () => ({ homeDirectory: "/home/me", separator: "/" }),
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
const searchInput = () =>
  screen.getByRole("textbox", {
    name: "Search conversations or paste a link or ID",
  }) as HTMLInputElement;
const type = async (value: string) => {
  await act(async () => {
    fireEvent.change(searchInput(), { target: { value } });
    await Promise.resolve();
  });
};
/** Titles in the order the list shows them. */
const listedTitles = () =>
  screen
    .getAllByRole("group")
    .map((element) => element.getAttribute("aria-labelledby"))
    .flatMap((id) => (id ? [document.getElementById(id)?.textContent ?? ""] : []));
const chooseFilter = async (filter: string, name: string | RegExp) => {
  await openNodexMenu(screen.getByRole("button", { name: `Filter by ${filter}` }));
  await click(await screen.findByRole(filter === "folder" ? "option" : "menuitem", { name }));
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
  await type(`codex://threads/${BILLING}`);

  const billing = await row("Migrate billing");
  expect(runtime.preview).toHaveBeenCalledWith({ reference: `codex://threads/${BILLING}` });
  expect(
    within(billing).getByRole("checkbox", { name: "Migrate billing" }).getAttribute("aria-checked"),
  ).toBe("true");
  // A link names one conversation, so the list shows just that one.
  expect(listedTitles()).toEqual(["Migrate billing"]);
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
  await type(BILLING);
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
  await type(BILLING);
  await row("Migrate billing");
  await click(footerButton("Import"));
  first.unmount();

  const second = await renderPage(runtime, { onOpenThread: vi.fn() }, first.ledger);
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
  await type(BILLING);
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
  await type(BILLING);
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
  await type(BILLING);

  const billing = await row("Migrate billing");
  expect(within(billing).queryByRole("checkbox")).toBeNull();
  expect(footerStatus()).toBe("1 conversation");
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

  // Anything that isn't a link or an ID is simply searched for.
  await type("https://example.com/not-a-thread");
  expect(await screen.findByText("No conversations match.")).toBeTruthy();
  expect(preview).not.toHaveBeenCalled();

  await type(BILLING);
  expect((await screen.findByRole("alert")).textContent).toBe("Native conversation lookup failed.");
  await click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No Codex or Claude Code conversation has this ID.")).toBeTruthy();
  expect(searchInput().value).toBe(BILLING);

  await act(async () => {
    fireEvent.keyDown(searchInput(), { key: "Enter" });
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
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Claude Code: Claude Code is not signed in.",
  );
  expect(screen.queryByText("Fix authentication")).toBeNull();

  await click(screen.getByRole("button", { name: "Try again" }));
  await row("Fix authentication");
  expect(list).toHaveBeenLastCalledWith({ backendKind: "claude", instanceConfigId: "work" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reads a whole history unprompted, past pages without importable conversations", async () => {
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
  await row("Tidy logs");
  expect(list).toHaveBeenCalledWith({ backendKind: "codex", cursor: "older" });
  expect(
    screen.getAllByText(/^(Fix authentication|Tidy logs)$/u).map((title) => title.textContent),
  ).toEqual(["Fix authentication", "Tidy logs"]);
});

it("finishes an import after Settings closes without taking the user to it", async () => {
  const reply = deferred<NativeConversationImportOutcome>();
  let copied = false;
  const runtime = makeRuntime({
    importConversation: vi.fn(() => reply.promise),
    // Coming back reads the source again, which by then knows about the copy.
    list: vi.fn(async (input) =>
      input.backendKind === "claude" || !copied
        ? input.backendKind === "codex"
          ? codexPage
          : claudePage
        : {
            ...codexPage,
            entries: codexPage.entries.map((listed) => ({
              ...listed,
              importedThreadId: "agent-thread",
              importedSessionId: "chat",
            })),
          },
    ),
  });
  const onOpenThread = vi.fn();
  const ledger = createNativeConversationImportLedger();
  const { rerender } = render(page(runtime, ledger, { onOpenThread }));
  await settleAsyncRender();
  await type(BILLING);
  await row("Migrate billing");
  await click(footerButton("Import and open"));
  expect(
    (screen.getByRole("button", { name: "Refresh conversations" }) as HTMLButtonElement).disabled,
  ).toBe(true);

  rerender(page(runtime, ledger, { onOpenThread, open: false }));
  copied = true;
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
  expect(
    (screen.getByRole("button", { name: "Refresh conversations" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  await click(open);
  await waitFor(() =>
    expect(onOpenThread).toHaveBeenCalledWith("agent-thread", { runtimeSessionId: "chat" }),
  );
});

const entry = (id: string, title: string, cwd: string, updatedAt: number) => ({
  nativeSessionId: id,
  title,
  cwd,
  updatedAt,
});
const SESSION = (index: number) => `0199a7c4-5b7e-7d10-9a3e-${String(index).padStart(12, "0")}`;
const codexOnly = { profiles: async () => ({ instances: [] }) };

it("finds a conversation on any page by title or folder, in any case", async () => {
  const list = vi.fn<ConversationImportRuntime["list"]>(async (input) =>
    input.cursor
      ? {
          nativeHome: "/home/.codex",
          entries: [entry(SESSION(2), "Rewrite the Billing docs", "/repo/landing", 1_000)],
          nextCursor: null,
        }
      : {
          nativeHome: "/home/.codex",
          entries: [entry(SESSION(1), "Tidy logs", "/repo/nodex", 2_000)],
          nextCursor: "older",
        },
  );
  await renderPage(makeRuntime({ ...codexOnly, list }));
  await row("Rewrite the Billing docs");

  await type("billing DOCS");
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite the Billing docs"]));
  expect(footerStatus()).toBe("1 of 2 conversations");

  await type("landing");
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite the Billing docs"]));

  await type("nothing like this");
  expect(await screen.findByText("No conversations match.")).toBeTruthy();
  await click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(listedTitles()).toEqual(["Tidy logs", "Rewrite the Billing docs"]));
  expect(searchInput().value).toBe("");
});

it("narrows by Agent, folder and status, counting what each choice would show", async () => {
  const list = vi.fn<ConversationImportRuntime["list"]>(async (input) =>
    input.backendKind === "codex"
      ? {
          nativeHome: "/home/.codex",
          entries: [
            entry(SESSION(1), "Tidy logs", "/home/me/repo/nodex", 3_000),
            {
              ...entry(SESSION(2), "Rewrite docs", "/home/me/repo/landing", 2_000),
              importedThreadId: "copy-thread",
              importedSessionId: "copy-session",
            },
          ],
          nextCursor: null,
        }
      : {
          nativeHome: "/profiles/claude-work",
          entries: [entry(SESSION(3), "Fix authentication", "/home/me/repo/nodex", 1_000)],
          nextCursor: null,
        },
  );
  await renderPage(makeRuntime({ list }), { onOpenThread: vi.fn() });
  await row("Fix authentication");

  await chooseFilter("agent", /^Claude Code/u);
  await waitFor(() => expect(listedTitles()).toEqual(["Fix authentication"]));
  expect(footerStatus()).toBe("1 of 3 conversations");
  expect(screen.getByRole("button", { name: "Filter by agent" }).textContent).toBe("Claude Code");

  await chooseFilter("agent", /^All agents/u);
  await openNodexMenu(screen.getByRole("button", { name: "Filter by folder" }));
  // Home-relative, fullest folder first, each with its count.
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "All folders3",
    "~/repo/nodex2",
    "~/repo/landing1",
  ]);
  await click(screen.getByRole("option", { name: /^~\/repo\/nodex/u }));
  await waitFor(() => expect(listedTitles()).toEqual(["Tidy logs", "Fix authentication"]));
  expect(screen.getByRole("button", { name: "Filter by folder" }).textContent).toBe("nodex");

  await chooseFilter("folder", /^All folders/u);
  await chooseFilter("status", /^Imported/u);
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite docs"]));
  await chooseFilter("status", /^Not imported/u);
  await waitFor(() => expect(listedTitles()).toEqual(["Tidy logs", "Fix authentication"]));
});

it("keeps a selection across searches, and shows what it holds before importing", async () => {
  const runtime = makeRuntime({
    ...codexOnly,
    list: vi.fn(async () => ({
      nativeHome: "/home/.codex",
      entries: [
        entry(SESSION(1), "Tidy logs", "/repo/nodex", 2_000),
        entry(SESSION(2), "Rewrite docs", "/repo/landing", 1_000),
      ],
      nextCursor: null,
    })),
  });
  await renderPage(runtime);
  await click(within(await row("Tidy logs")).getByRole("checkbox"));

  await type("docs");
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite docs"]));
  expect(footerStatus()).toBe("1 selected · 1 not shown");
  await click(within(await row("Rewrite docs")).getByRole("checkbox"));
  expect(footerStatus()).toBe("2 selected · 1 not shown");

  await click(within(footer()).getByRole("button", { name: /2 selected/u }));
  await waitFor(() => expect(listedTitles()).toEqual(["Tidy logs", "Rewrite docs"]));
  expect(searchInput().value).toBe("");
  expect(footerStatus()).toBe("2 selected");

  await click(footerButton("Import 2"));
  await waitFor(() => expect(footerStatus()).toBe("Imported 2 conversations"));
  expect(runtime.importConversation).toHaveBeenCalledTimes(2);
  // Nothing is left to show as selected, so the whole list returns.
  await waitFor(() => expect(listedTitles()).toEqual(["Tidy logs", "Rewrite docs"]));
});

it("selects only what the filters show, and tells when that is part of the list", async () => {
  await renderPage(
    makeRuntime({
      ...codexOnly,
      list: vi.fn(async () => ({
        nativeHome: "/home/.codex",
        entries: [
          entry(SESSION(1), "Tidy logs", "/repo/nodex", 2_000),
          entry(SESSION(2), "Rewrite docs", "/repo/landing", 1_000),
        ],
        nextCursor: null,
      })),
    }),
  );
  await row("Tidy logs");
  const selectAll = () =>
    within(footer()).getByRole("checkbox", { name: "Select all conversations" });

  await click(within(await row("Tidy logs")).getByRole("checkbox"));
  expect(selectAll().getAttribute("aria-checked")).toBe("mixed");

  await type("docs");
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite docs"]));
  expect(selectAll().getAttribute("aria-checked")).toBe("false");
  await click(selectAll());
  expect(selectAll().getAttribute("aria-checked")).toBe("true");
  expect(footerStatus()).toBe("2 selected · 1 not shown");

  await click(footerButton("Clear"));
  expect(footerStatus()).toBe("1 of 2 conversations");
});

it("mounts a long list in steps while selecting all of it", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  try {
    await renderPage(
      makeRuntime({
        ...codexOnly,
        list: vi.fn(async () => ({
          nativeHome: "/home/.codex",
          entries: Array.from({ length: 150 }, (_, index) =>
            entry(SESSION(index), `Conversation ${index}`, "/repo/nodex", 10_000 - index),
          ),
          nextCursor: null,
        })),
      }),
    );
    await row("Conversation 0");
    expect(listedTitles()).toHaveLength(100);
    expect(footerStatus()).toBe("150 conversations");

    await click(within(footer()).getByRole("checkbox", { name: "Select all conversations" }));
    expect(footerStatus()).toBe("150 selected");
    expect(footerButton("Import 150")).toBeTruthy();

    await act(async () => {
      observers.at(-1)!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(listedTitles()).toHaveLength(150));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps the list while refreshing, then replaces it whole", async () => {
  const reread = deferred<NativeSessionCatalogPage>();
  const list = vi
    .fn<ConversationImportRuntime["list"]>()
    .mockResolvedValueOnce({
      nativeHome: "/home/.codex",
      entries: [entry(SESSION(1), "Tidy logs", "/repo/nodex", 2_000)],
      nextCursor: null,
    })
    .mockImplementationOnce(() => reread.promise);
  await renderPage(makeRuntime({ ...codexOnly, list }));
  await row("Tidy logs");

  await click(screen.getByRole("button", { name: "Refresh conversations" }));
  expect(listedTitles()).toEqual(["Tidy logs"]);

  await act(async () => {
    reread.resolve({
      nativeHome: "/home/.codex",
      entries: [entry(SESSION(2), "Rewrite docs", "/repo/landing", 3_000)],
      nextCursor: null,
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite docs"]));
});

it("shows what a failing source already gave, resuming it without holding back the others", async () => {
  const list = vi.fn<ConversationImportRuntime["list"]>(async (input) => {
    if (input.backendKind === "claude") return claudePage;
    if (!input.cursor)
      return {
        nativeHome: "/home/.codex",
        entries: [entry(SESSION(1), "Recent work", "/repo/nodex", 5_000)],
        nextCursor: "older",
      };
    if (list.mock.calls.filter(([call]) => call.cursor === "older").length === 1)
      throw new Error("Codex is restarting.");
    return {
      nativeHome: "/home/.codex",
      entries: [entry(SESSION(2), "Older work", "/repo/nodex", 500)],
      nextCursor: null,
    };
  });
  await renderPage(makeRuntime({ list }));
  // Older than anything Codex has given so far, yet Codex no longer bounds the list.
  await row("Fix authentication");
  expect((await screen.findByRole("alert")).textContent).toBe("Codex: Codex is restarting.");
  expect(listedTitles()).toEqual(["Recent work", "Fix authentication"]);

  await click(screen.getByRole("button", { name: "Try again" }));
  await row("Older work");
  expect(list).toHaveBeenLastCalledWith({ backendKind: "codex", cursor: "older" });
  expect(listedTitles()).toEqual(["Recent work", "Fix authentication", "Older work"]);
});

it("finishes a lookup that outlives leaving the page", async () => {
  const pending = deferred<NativeConversationImportPreviewResult>();
  const preview = vi.fn<ConversationImportRuntime["preview"]>(() => pending.promise);
  const runtime = makeRuntime({ ...codexOnly, preview });
  const ledger = createNativeConversationImportLedger();
  const { rerender } = render(page(runtime, ledger));
  await settleAsyncRender();
  await type(BILLING);
  rerender(page(runtime, ledger, { open: false }));
  await act(async () => {
    pending.resolve({ matches: [billingPreview] });
    await Promise.resolve();
  });

  rerender(page(runtime, ledger));
  await row("Migrate billing");
  expect(preview).toHaveBeenCalledTimes(1);
  expect(listedTitles()).toEqual(["Migrate billing"]);
});

it("keeps an unfinished import in view whatever is being searched", async () => {
  const importConversation = vi
    .fn<ConversationImportRuntime["importConversation"]>()
    .mockRejectedValue(new Error("Agent Runtime is restarting."));
  await renderPage(
    makeRuntime({
      ...codexOnly,
      importConversation,
      list: vi.fn(async () => ({
        nativeHome: "/home/.codex",
        entries: [
          entry(SESSION(1), "Tidy logs", "/repo/nodex", 2_000),
          entry(SESSION(2), "Rewrite docs", "/repo/landing", 1_000),
        ],
        nextCursor: null,
      })),
    }),
  );
  await click(within(await row("Rewrite docs")).getByRole("checkbox"));
  await click(footerButton("Import"));
  await within(await row("Rewrite docs")).findByRole("alert");

  await type("tidy");
  await waitFor(() => expect(listedTitles()).toEqual(["Rewrite docs", "Tidy logs"]));
});
