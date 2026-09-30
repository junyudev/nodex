import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type { NativeSessionCatalogPage } from "../../../shared/native-session-catalog";
import { openNodexMenu, render } from "../../test/dom";
import {
  NativeSessionSettingsPage,
  type NativeSessionSettingsRuntime,
} from "./native-session-settings-page";

const nativePage: NativeSessionCatalogPage = {
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
const makeRuntime = (): NativeSessionSettingsRuntime => ({
  profiles: async () => ({
    instances: [{ ...defaultClaudeInstance(), id: "work", displayName: "Work" }],
  }),
  projects: async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    storeEpoch: "epoch",
    projectionRevision: 1,
  }),
  list: vi.fn().mockResolvedValue(nativePage),
  attach: vi.fn().mockResolvedValue({
    threadId: "nodex-thread",
    sessionId: "nodex-chat",
    alreadyAttached: false,
  }),
});
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};
const chooseClaude = async () => {
  await openNodexMenu(screen.getByRole("button", { name: "Conversation agent" }));
  await click(await screen.findByRole("option", { name: "Claude Code · Work" }));
};

it("connects the selected native Claude identity and marks the chat as attached", async () => {
  const runtime = makeRuntime();
  render(<NativeSessionSettingsPage open runtime={runtime} />);
  await chooseClaude();
  await click(screen.getByRole("button", { name: "Browse" }));
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

it("uses provider pagination and discards the old catalog when selecting another provider", async () => {
  const runtime = makeRuntime();
  const list = vi
    .fn<NativeSessionSettingsRuntime["list"]>()
    .mockResolvedValueOnce(nativePage)
    .mockResolvedValueOnce({ ...nativePage, entries: [], nextCursor: null });
  render(<NativeSessionSettingsPage open runtime={{ ...runtime, list }} />);
  await click(screen.getByRole("button", { name: "Browse" }));
  await screen.findByRole("button", { name: "Connect Fix authentication" });
  await click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("No conversations found.");
  expect(list).toHaveBeenLastCalledWith({ backendKind: "codex", cursor: "older-cursor" });
  await chooseClaude();
  expect(screen.queryByText("No conversations found.")).toBeNull();
  await click(screen.getByRole("button", { name: "Browse" }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith({ backendKind: "claude", instanceConfigId: "work" }),
  );
});

it("keeps a failed connection retryable and displays the native identity error", async () => {
  const runtime = makeRuntime();
  const attach = vi
    .fn<NativeSessionSettingsRuntime["attach"]>()
    .mockRejectedValue(new Error("Claude configuration changed. Browse conversations again."));
  render(<NativeSessionSettingsPage open runtime={{ ...runtime, attach }} />);
  await click(screen.getByRole("button", { name: "Browse" }));
  await click(await screen.findByRole("button", { name: "Connect Fix authentication" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Claude configuration changed. Browse conversations again.",
  );
  expect(
    (screen.getByRole("button", { name: "Connect Fix authentication" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
