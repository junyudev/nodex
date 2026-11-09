import { expect, test } from "vitest";
import { isSpaceIpcChannel } from "./space-ipc-policy";

test("Space administration and content require a Space", () => {
  expect(isSpaceIpcChannel("space-admin:devices")).toBe(true);
  expect(isSpaceIpcChannel("space-admin:link-device")).toBe(true);
  expect(isSpaceIpcChannel("inbox:window")).toBe(true);
  expect(isSpaceIpcChannel("work:start")).toBe(true);
  expect(isSpaceIpcChannel("settings:inbox:get")).toBe(true);
});

test("chat rewrites stay on their Space and cannot fall through to the personal Runtime", () => {
  expect(isSpaceIpcChannel("agent-runtime:session:rewrite-message")).toBe(true);
});

test("window, keyboard, dictation and analytics run on this desktop in every Space", () => {
  for (const channel of [
    "electron-window:focus:get",
    "surface-history:bind",
    "codex-command-keymap-state",
    "set-codex-command-keybinding",
    "global-dictation:keyboard-layout:update",
    "codex:dictation:state:read",
    "product-analytics:record",
    "product-analytics:notice:read",
    "terminal-shells:list",
  ] as const)
    expect(isSpaceIpcChannel(channel), channel).toBe(false);
  // The desktop's own Agents and native chats still belong to the personal Space.
  for (const channel of [
    "codex:sidebar:sync",
    "codex:composer-skills:list",
    "agent-runtime:claude-usage:read",
    "thread-execution:location",
  ] as const)
    expect(isSpaceIpcChannel(channel), channel).toBe(true);
});
