import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { claudeProfile } from "../../../shared/agents/profile.test-fixtures";
import type {
  NativeConversationImportInput,
  NativeConversationImportOutcome,
  NativeConversationImportPreview,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ProjectWindow } from "../../../shared/types";
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
type Profiles = Awaited<ReturnType<ConversationImportRuntime["profiles"]>>;
const NO_PROFILES: Profiles = { instances: [] };
/** Reads each Agent's profiles from its own fixture; Agents not named have none. */
const profilesOf =
  (byDriver: {
    readonly claudeAgent?: () => Promise<Profiles>;
    readonly antigravity?: () => Promise<Profiles>;
  }) =>
  async (driver: Parameters<ConversationImportRuntime["profiles"]>[0]) =>
    (await byDriver[driver]?.()) ?? NO_PROFILES;
const workProfiles: Profiles = {
  instances: [{ ...claudeProfile(), id: "work", displayName: "Work" }],
};
const imported = (input: NativeConversationImportInput): NativeConversationImportOutcome => ({
  kind: "imported",
  sessionId: `session-${input.requestId}`,
  threadId: `thread-${input.nativeSessionId}`,
  projectId: input.projectId,
});

const makeRuntime = (overrides: Partial<ConversationImportRuntime> = {}) =>
  ({
    profiles: profilesOf({ claudeAgent: async () => workProfiles }),
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
const codexOnly = { profiles: profilesOf({}) };

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
