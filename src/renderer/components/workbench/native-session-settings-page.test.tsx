import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type {
  CodexThreadImportPreview,
  NativeSessionCatalogPage,
} from "../../../shared/native-session-catalog";
import type { ProjectWindow } from "../../../shared/types";
import { openNodexMenu, render } from "../../test/dom";
import {
  NativeSessionSettingsPage,
  type NativeSessionSettingsRuntime,
} from "./native-session-settings-page";

const NATIVE_ID = "0199a7c4-5b7e-7d10-9a3e-2f4b6c8d0e12";
const claudePage: NativeSessionCatalogPage = {
  nativeHome: "/profiles/claude-work",
  entries: [
    {
      nativeSessionId: "native-uuid",
      title: "Fix authentication",
      cwd: "/repo/work",
      updatedAt: 1,
    },
  ],
  nextCursor: "older-cursor",
};
const codexPage: NativeSessionCatalogPage = {
  nativeHome: "/home/.codex",
  entries: [
    {
      nativeSessionId: NATIVE_ID,
      title: "Migrate billing",
      cwd: "/repo/gone",
      cwdAvailable: false,
      updatedAt: 1,
    },
  ],
  nextCursor: null,
};
const preview: CodexThreadImportPreview = {
  nativeSessionId: NATIVE_ID,
  nativeHome: "/home/.codex",
  title: "Migrate billing",
  cwd: "/repo/billing",
  cwdAvailable: true,
  updatedAt: 1,
};
const projectWindow: ProjectWindow = {
  items: [{ id: "project-nodex", name: "Nodex" } as ProjectWindow["items"][number]],
  nextCursor: null,
  hasMore: false,
  storeEpoch: "epoch",
  projectionRevision: 1,
};
const makeRuntime = (): NativeSessionSettingsRuntime => ({
  profiles: async () => ({
    instances: [{ ...defaultClaudeInstance(), id: "work", displayName: "Work" }],
  }),
  projects: async () => projectWindow,
  list: vi.fn().mockResolvedValue(claudePage),
  attach: vi.fn().mockResolvedValue({
    threadId: "nodex-thread",
    sessionId: "nodex-chat",
    alreadyAttached: false,
  }),
  previewCodexImport: vi.fn().mockResolvedValue(preview),
  importCodex: vi.fn().mockImplementation(async (input: { requestId: string }) => ({
    sessionId: input.requestId,
    threadId: "agent-thread",
    projectId: null,
  })),
  pickDirectory: vi.fn().mockResolvedValue("/repo/replacement"),
});
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};
const paste = async (value: string) => {
  const input = await screen.findByRole("textbox", { name: "Codex conversation link or ID" });
  await act(async () => {
    fireEvent.paste(input);
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
};
const importForm = async (title: string) => screen.findByRole("group", { name: title });

it("imports a pasted Codex link into the active Project and opens the new chat", async () => {
  const runtime = makeRuntime();
  const onOpenThread = vi.fn();
  render(
    <NativeSessionSettingsPage
      open
      runtime={runtime}
      activeProjectId="project-nodex"
      onOpenThread={onOpenThread}
    />,
  );
  await paste(`codex://threads/${NATIVE_ID}`);
  const form = await importForm("Migrate billing");
  expect(runtime.previewCodexImport).toHaveBeenCalledWith({
    reference: `codex://threads/${NATIVE_ID}`,
  });
  await waitFor(() =>
    expect(within(form).getByRole("button", { name: "Import destination" }).textContent).toBe(
      "Nodex",
    ),
  );
  await click(within(form).getByRole("button", { name: "Import and open" }));
  await waitFor(() => expect(onOpenThread).toHaveBeenCalledTimes(1));
  const [request] = vi.mocked(runtime.importCodex).mock.calls[0]!;
  expect(request).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    acceptedAt: expect.any(Number),
    nativeSessionId: NATIVE_ID,
    expectedHome: "/home/.codex",
    projectId: "project-nodex",
    cwd: "/repo/billing",
  });
  expect(onOpenThread).toHaveBeenCalledWith("agent-thread", {
    runtimeSessionId: request.requestId,
  });
});

it("retries an unchanged import with the same request and starts a new request after a change", async () => {
  const runtime = makeRuntime();
  const importCodex = vi
    .fn<NativeSessionSettingsRuntime["importCodex"]>()
    .mockRejectedValueOnce(new Error("Agent Runtime is restarting."))
    .mockRejectedValueOnce(new Error("Agent Runtime is restarting."))
    .mockResolvedValue({ sessionId: "chat", threadId: "agent-thread", projectId: null });
  render(
    <NativeSessionSettingsPage open runtime={{ ...runtime, importCodex }} onOpenThread={vi.fn()} />,
  );
  await paste(NATIVE_ID);
  const form = await importForm("Migrate billing");
  await click(within(form).getByRole("button", { name: "Import and open" }));
  expect((await within(form).findByRole("alert")).textContent).toBe("Agent Runtime is restarting.");
  await click(within(form).getByRole("button", { name: "Import and open" }));
  await waitFor(() => expect(importCodex).toHaveBeenCalledTimes(2));
  const [first, retry] = importCodex.mock.calls.map(([input]) => input);
  expect(retry).toEqual(first);

  await openNodexMenu(within(form).getByRole("button", { name: "Import destination" }));
  await click(await screen.findByRole("option", { name: "Nodex" }));
  await click(within(form).getByRole("button", { name: "Import and open" }));
  await waitFor(() => expect(importCodex).toHaveBeenCalledTimes(3));
  const changed = importCodex.mock.calls[2]![0];
  expect(changed.projectId).toBe("project-nodex");
  expect(changed.requestId).not.toBe(first!.requestId);
});

it("requires a replacement for a missing working directory before importing a browsed conversation", async () => {
  const runtime = makeRuntime();
  const list = vi.fn<NativeSessionSettingsRuntime["list"]>().mockResolvedValue(codexPage);
  render(<NativeSessionSettingsPage open runtime={{ ...runtime, list }} onOpenThread={vi.fn()} />);
  await click(screen.getAllByRole("button", { name: "Browse" })[0]!);
  expect(list).toHaveBeenCalledWith({ backendKind: "codex" });
  await click(await screen.findByRole("button", { name: "Import Migrate billing" }));
  const form = await importForm("Migrate billing");
  const submit = within(form).getByRole("button", { name: "Import and open" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(within(form).getByText("Folder not found. Choose a replacement to import.")).toBeTruthy();

  await click(within(form).getByRole("button", { name: "Choose folder" }));
  await within(form).findByRole("button", { name: "Change working directory" });
  expect(submit.disabled).toBe(false);
  await click(submit);
  await waitFor(() =>
    expect(runtime.importCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeSessionId: NATIVE_ID,
        expectedHome: "/home/.codex",
        projectId: null,
        cwd: "/repo/replacement",
      }),
    ),
  );
});

it("explains an unusable paste and keeps a failed lookup retryable", async () => {
  const runtime = makeRuntime();
  const previewCodexImport = vi
    .fn<NativeSessionSettingsRuntime["previewCodexImport"]>()
    .mockRejectedValueOnce(new Error("This Codex conversation cannot be imported."))
    .mockResolvedValue(preview);
  render(<NativeSessionSettingsPage open runtime={{ ...runtime, previewCodexImport }} />);
  await paste("https://example.com/not-a-thread");
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Paste a codex://threads link or a conversation ID.",
  );
  expect(previewCodexImport).not.toHaveBeenCalled();

  await paste(NATIVE_ID);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "This Codex conversation cannot be imported.",
  );
  await click(screen.getByRole("button", { name: "Try again" }));
  await importForm("Migrate billing");
  expect(previewCodexImport).toHaveBeenCalledTimes(2);

  await click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Migrate billing" })).toBeNull();
  expect(
    (screen.getByRole("textbox", { name: "Codex conversation link or ID" }) as HTMLInputElement)
      .value,
  ).toBe("");
});

it("keeps a running import's source in place and stays put once Settings closes", async () => {
  const runtime = makeRuntime();
  let finish!: (result: Awaited<ReturnType<NativeSessionSettingsRuntime["importCodex"]>>) => void;
  const importCodex = vi.fn<NativeSessionSettingsRuntime["importCodex"]>(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const onOpenThread = vi.fn();
  const page = (open: boolean) => (
    <NativeSessionSettingsPage
      open={open}
      runtime={{ ...runtime, importCodex }}
      onOpenThread={onOpenThread}
    />
  );
  const { rerender } = render(page(true));
  await paste(NATIVE_ID);
  const form = await importForm("Migrate billing");
  await click(within(form).getByRole("button", { name: "Import and open" }));
  const input = screen.getByRole("textbox", {
    name: "Codex conversation link or ID",
  }) as HTMLInputElement;
  expect(input.readOnly).toBe(true);
  expect((screen.getAllByRole("button", { name: "Browse" })[0] as HTMLButtonElement).disabled).toBe(
    true,
  );

  rerender(page(false));
  await act(async () => {
    finish({ sessionId: "chat", threadId: "agent-thread", projectId: null });
    await Promise.resolve();
  });
  rerender(page(true));
  const openChat = (await within(form).findByRole("button", {
    name: "Open chat",
  })) as HTMLButtonElement;
  expect(onOpenThread).not.toHaveBeenCalled();
  expect(input.readOnly).toBe(false);
  await click(openChat);
  await waitFor(() =>
    expect(onOpenThread).toHaveBeenCalledWith("agent-thread", { runtimeSessionId: "chat" }),
  );
});

it("settles an import when there is no chat to open", async () => {
  const runtime = makeRuntime();
  render(<NativeSessionSettingsPage open runtime={runtime} />);
  await paste(NATIVE_ID);
  const form = await importForm("Migrate billing");
  await click(within(form).getByRole("button", { name: "Import and open" }));
  expect(
    ((await within(form).findByRole("button", { name: "Close" })) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(within(form).queryByText("Importing…")).toBeNull();
});

it("connects the selected native Claude identity and marks the chat as attached", async () => {
  const runtime = makeRuntime();
  render(<NativeSessionSettingsPage open runtime={runtime} />);
  const claude = await screen.findByRole("region", { name: "Connect Claude Code" });
  await click(within(claude).getByRole("button", { name: "Browse" }));
  const connect = await screen.findByRole("button", { name: "Connect Fix authentication" });
  expect(runtime.list).toHaveBeenCalledWith({ backendKind: "claude", instanceConfigId: "work" });
  await click(connect);
  await waitFor(() =>
    expect(runtime.attach).toHaveBeenCalledWith({
      backendKind: "claude",
      instanceConfigId: "work",
      nativeSessionId: "native-uuid",
      expectedHome: "/profiles/claude-work",
      projectId: null,
    }),
  );
  expect(
    (
      (await screen.findByRole("button", {
        name: "Connected Fix authentication",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("pages Claude conversations and keeps a failed connection retryable", async () => {
  const runtime = makeRuntime();
  const list = vi
    .fn<NativeSessionSettingsRuntime["list"]>()
    .mockResolvedValueOnce(claudePage)
    .mockResolvedValueOnce({ ...claudePage, nextCursor: null });
  const attach = vi
    .fn<NativeSessionSettingsRuntime["attach"]>()
    .mockRejectedValue(new Error("Claude configuration changed. Browse conversations again."));
  render(<NativeSessionSettingsPage open runtime={{ ...runtime, list, attach }} />);
  const claude = await screen.findByRole("region", { name: "Connect Claude Code" });
  await click(within(claude).getByRole("button", { name: "Browse" }));
  await screen.findByRole("button", { name: "Connect Fix authentication" });
  await click(within(claude).getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith({
      backendKind: "claude",
      instanceConfigId: "work",
      cursor: "older-cursor",
    }),
  );
  await click(await screen.findByRole("button", { name: "Connect Fix authentication" }));
  expect((await within(claude).findByRole("alert")).textContent).toBe(
    "Claude configuration changed. Browse conversations again.",
  );
  expect(
    (screen.getByRole("button", { name: "Connect Fix authentication" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
