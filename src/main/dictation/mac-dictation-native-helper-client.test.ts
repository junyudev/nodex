import type { MacNativeHotkeySpec } from "../../shared/command-keybindings";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAC_DICTATION_HELPER_PROTOCOL_VERSION,
  MacDictationHelperRequestError,
  MacDictationNativeHelperClient,
} from "./mac-dictation-native-helper-client";

import { DictationNativeHelperRequestError } from "./dictation-native-helper-port";

const createGlobalShortcutStub = () => ({
  register: vi.fn((_accelerator: string, _callback: () => void) => true),
  unregister: vi.fn((_accelerator: string) => {}),
});

// A test must inject its own port; the real process-wide registration is never exercised.
vi.mock("electron", () => ({
  globalShortcut: {
    register: () => {
      throw new Error("Inject a shortcut stub in dictation helper tests");
    },
    unregister: () => {
      throw new Error("Inject a shortcut stub in dictation helper tests");
    },
  },
}));

const temporaryDirectories: string[] = [];

const createExecutable = async (source: string): Promise<string> => {
  const directory = await mkdtemp(
    join(process.env.NODEX_DICTATION_TEST_ARTIFACTS ?? tmpdir(), "nodex-dictation-helper-test-"),
  );
  temporaryDirectories.push(directory);
  const executable = join(directory, "helper");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
  await chmod(executable, 0o755);
  return executable;
};

const regularBinding = (
  registrationAccelerator = "Control+K",
  bindingId = "hold",
): MacNativeHotkeySpec => ({
  bindingId,
  mode: bindingId === "hold" ? "hold" : "toggle",
  registrationAccelerator,
  modifiers: registrationAccelerator.startsWith("Alt") ? ["option"] : ["control"],
  keyCode: 40,
  bareModifierKeyCodes: null,
});

const createRegularExecutable = async (rejectGeneration?: number, releasedBeforeArm = false) =>
  await createExecutable(`
  const readline = require("node:readline");
  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
  let generation = 0, sequence = 0, bindings = [];
  const event = (type, binding) => send({ type, bindingId: binding.bindingId, mode: binding.mode, configurationGeneration: generation, sequence: ++sequence });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    const reply = (value) => send({ type: "response", id: request.id, ok: true, value });
    if (request.type === "replaceBindings") {
      if (request.generation === ${rejectGeneration ?? -1}) {
        send({ type: "response", id: request.id, ok: false, error: "input-monitoring-denied" });
        return;
      }
      generation = request.generation;
      bindings = request.bindings;
      reply({ applied: true, generation });
      return;
    }
    if (request.type === "armRegularRelease") {
      const binding = bindings.find((binding) => binding.bindingId === request.bindingId);
      if (!binding || request.generation !== generation) {
        send({ type: "response", id: request.id, ok: false, error: "invalid-hotkey" });
        return;
      }
      reply(true);
      if (${releasedBeforeArm}) event("released", binding);
      return;
    }
    if (request.type === "queryBuiltInMic") {
      reply(null);
      for (const binding of bindings) event("pressed", binding);
      return;
    }
    if (request.type === "captureBareModifier") {
      reply({ accelerator: "Fn" });
      for (const binding of bindings) event("released", binding);
    }
  });
`);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("MacDictationNativeHelperClient", () => {
  it.each([
    "Shift+Fn",
    "Ctrl+Command+Alt+Fn",
    "Ctrl+Alt",
    "LeftControl",
    "RightOption",
    "DoubleShift",
  ])("accepts the complete native capture %s", async (accelerator) => {
    const executable = await createExecutable(`
        const readline = require("node:readline");
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
        readline.createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          send({ type: "response", id: request.id, ok: true, value: { accelerator: ${JSON.stringify(accelerator)} } });
        });
      `);
    const client = new MacDictationNativeHelperClient(executable, {
      validateArchitecture: false,
      globalShortcut: createGlobalShortcutStub(),
    });
    try {
      await expect(client.captureBareModifier()).resolves.toBe(accelerator);
    } finally {
      client.dispose();
    }
  });

  it("acknowledges capture cancellation before a replacement capture", async () => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
      let capture = null, cancelled = false;
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.type === "captureBareModifier") {
          if (cancelled) send({ type: "response", id: request.id, ok: true, value: { accelerator: "DoubleOption" } });
          else capture = request.id;
        }
        if (request.type === "capabilities") send({ type: "response", id: request.id, ok: true, value: { inputMonitoring: true, accessibility: true } });
        if (request.type === "cancelCapture" && capture === request.requestId) {
          setTimeout(() => {
            cancelled = true;
            send({ type: "response", id: capture, ok: false, error: "aborted" });
            capture = null;
          }, 30);
        }
      });
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      validateArchitecture: false,
      globalShortcut: createGlobalShortcutStub(),
    });
    try {
      const controller = new AbortController();
      const captured = client.captureBareModifier(controller.signal);
      const rejected = expect(captured).rejects.toMatchObject({ name: "AbortError" });
      await client.capabilities();
      controller.abort();
      await rejected;
      await expect(client.captureBareModifier()).resolves.toBe("DoubleOption");
    } finally {
      client.dispose();
    }
  });

  it("does not start native capture for an already cancelled request", async () => {
    const client = new MacDictationNativeHelperClient("/missing/dictation-helper", {
      globalShortcut: createGlobalShortcutStub(),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.captureBareModifier(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    client.dispose();
  });

  it.each(["Fn+Shift", "Fn+Fn", "Ctrl", "Ctrl+K+Fn"])(
    "rejects noncanonical native capture %s",
    async (accelerator) => {
      const executable = await createExecutable(`
        const readline = require("node:readline");
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
        readline.createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          send({ type: "response", id: request.id, ok: true, value: { accelerator: ${JSON.stringify(accelerator)} } });
        });
      `);
      const client = new MacDictationNativeHelperClient(executable, {
        validateArchitecture: false,
        globalShortcut: createGlobalShortcutStub(),
      });
      try {
        await expect(client.captureBareModifier()).rejects.toMatchObject({
          code: "invalid-response",
        });
      } finally {
        client.dispose();
      }
    },
  );

  it("waits for the protocol handshake and validates responses", async () => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} }) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        const value = request.type === "capabilities"
          ? { inputMonitoring: true, accessibility: false }
          : request.type === "captureClipboardFingerprint"
            ? "a".repeat(64)
          : request.type === "queryBuiltInMic"
            ? "MacBook Pro Microphone"
            : request.type === "captureBareModifier"
              ? { accelerator: "Fn" }
              : request.type === "replaceBindings"
                ? { applied: true, generation: request.generation }
                : request.type === "safePaste" ? { pasted: true, clipboardRestoreMs: 712 } : { ok: true };
        process.stdout.write(JSON.stringify({ type: "response", id: request.id, ok: true, value }) + "\\n");
      });
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });

    await expect(client.capabilities()).resolves.toEqual({
      inputMonitoring: true,
      accessibility: false,
    });
    await expect(client.queryBuiltInMicrophoneName()).resolves.toBe("MacBook Pro Microphone");
    await expect(
      client.replaceBindings({
        generation: 1,
        bindings: [
          {
            bindingId: "hold",
            mode: "hold",
            modifiers: ["function"],
            registrationAccelerator: null,
            keyCode: null,
            bareModifierKeyCodes: [63],
          },
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(client.captureBareModifier()).resolves.toBe("Fn");
    await expect(
      client.safePaste("text", { pid: 1, bundleIdentifier: "test.app" }),
    ).resolves.toEqual({ clipboardRestoreMs: 712 });
    await expect(client.safePaste("text")).resolves.toEqual({ clipboardRestoreMs: 712 });
    await expect(client.captureClipboardFingerprint()).resolves.toBe("a".repeat(64));
    await expect(client.copy("hello")).resolves.toBeUndefined();
    await expect(client.setEscapeEnabled(true)).resolves.toBeUndefined();
    client.dispose();
  });

  it("rejects a helper that exits before its ready handshake", async () => {
    const executable = await createExecutable("process.exit(2);");
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });

    await expect(client.capabilities()).rejects.toThrow("before becoming ready");
    client.dispose();
  });

  it("starts a fresh process after a running helper crashes", async () => {
    const executable = await createExecutable(`
      const fs = require("node:fs");
      const readline = require("node:readline");
      const marker = __filename + ".started";
      const shouldCrash = !fs.existsSync(marker);
      if (shouldCrash) fs.writeFileSync(marker, "1");
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} }) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (shouldCrash) process.exit(7);
        process.stdout.write(JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          value: { applied: true, generation: request.generation },
        }) + "\\n");
      });
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });

    await expect(client.replaceBindings({ generation: 1, bindings: [] })).rejects.toThrow("exited");
    await expect(client.replaceBindings({ generation: 2, bindings: [] })).resolves.toBeUndefined();
    client.dispose();
  });

  it("preserves stable native rejection codes", async () => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} }) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          type: "response",
          id: request.id,
          ok: false,
          error: "invalid-hotkey",
        }) + "\\n");
      });
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });

    const failure = await client
      .replaceBindings({ generation: 1, bindings: [] })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MacDictationHelperRequestError);
    expect(failure).toBeInstanceOf(DictationNativeHelperRequestError);
    expect((failure as MacDictationHelperRequestError).code).toBe("invalid-hotkey");
    client.dispose();
  });

  it("uses Electron for regular presses and preserves their latch across replacement", async () => {
    const executable = await createRegularExecutable();
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut,
      validateArchitecture: false,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      const replacement = client.replaceBindings({ generation: 1, bindings: [regularBinding()] });
      await vi.waitFor(() => expect(globalShortcut.register).toHaveBeenCalledOnce());
      const callback = globalShortcut.register.mock.calls[0]![1];
      await replacement;
      callback();
      callback();
      await client.queryBuiltInMicrophoneName(); // fixture emits a duplicate native press
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "pressed", configurationGeneration: 1 }),
      );
      await client.replaceBindings({ generation: 2, bindings: [regularBinding()] });
      callback();
      expect(listener).toHaveBeenCalledOnce();
      expect(globalShortcut.register).toHaveBeenCalledExactlyOnceWith(
        "Control+K",
        expect.any(Function),
      );
      await client.captureBareModifier(); // fixture releases the required modifier
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "released", configurationGeneration: 2 }),
      );
      callback();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "pressed", configurationGeneration: 2 }),
      );
      await client.replaceBindings({ generation: 3, bindings: [] });
      callback();
      expect(listener).toHaveBeenCalledTimes(3);
      expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith("Control+K");
    } finally {
      client.dispose();
    }
  });

  it("rolls back staged OS registrations while preserving the prior generation and pressed state", async () => {
    const executable = await createRegularExecutable(2);
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut,
      validateArchitecture: false,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      await client.replaceBindings({ generation: 1, bindings: [regularBinding()] });
      const oldCallback = globalShortcut.register.mock.calls[0]![1];
      oldCallback();
      await expect(
        client.replaceBindings({ generation: 2, bindings: [regularBinding("Control+L")] }),
      ).rejects.toMatchObject({ code: "input-monitoring-denied" });
      expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith("Control+L");
      globalShortcut.register.mock.calls[1]![1]();
      oldCallback();
      expect(listener).toHaveBeenCalledOnce();
      await client.captureBareModifier();
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      oldCallback();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "pressed", configurationGeneration: 1 }),
      );
      globalShortcut.register.mockReturnValueOnce(true).mockReturnValueOnce(false);
      await expect(
        client.replaceBindings({
          generation: 3,
          bindings: [regularBinding("Control+J"), regularBinding("Alt+M", "toggle")],
        }),
      ).rejects.toMatchObject({ code: "hotkey-conflict" });
      expect(globalShortcut.unregister.mock.calls).toEqual([["Control+L"], ["Control+J"]]);
      oldCallback();
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      client.dispose();
    }
    expect(globalShortcut.unregister).toHaveBeenLastCalledWith("Control+K");
  });

  it("consumes the compiler accelerator directly and releases immediately when modifiers already went up", async () => {
    const executable = await createRegularExecutable(undefined, true);
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut,
      validateArchitecture: false,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      // The compiler supplied the physical US label for the logical key under this layout.
      await client.replaceBindings({ generation: 1, bindings: [regularBinding("Alt+Y")] });
      expect(globalShortcut.register).toHaveBeenCalledExactlyOnceWith(
        "Alt+Y",
        expect.any(Function),
      );
      globalShortcut.register.mock.calls[0]![1]();
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      expect(listener.mock.calls.map(([event]) => event.type)).toEqual(["pressed", "released"]);
    } finally {
      client.dispose();
    }
  });

  it("owns Escape without starting Swift or requiring Input Monitoring", async () => {
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient("/unavailable/dictation-helper", {
      globalShortcut,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      await client.setEscapeEnabled(false);
      expect(globalShortcut.unregister).not.toHaveBeenCalled();
      await client.setEscapeEnabled(true);
      await client.setEscapeEnabled(true);
      expect(globalShortcut.register).toHaveBeenCalledExactlyOnceWith(
        "Escape",
        expect.any(Function),
      );
      const callback = globalShortcut.register.mock.calls[0]![1];
      callback();
      expect(listener).toHaveBeenLastCalledWith({
        type: "escape",
        processGeneration: 0,
        sequence: 1,
      });
      await client.setEscapeEnabled(false);
      await client.setEscapeEnabled(false);
      expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
      callback();
      expect(listener).toHaveBeenCalledOnce();
      await client.setEscapeEnabled(true);
      callback();
      expect(listener).toHaveBeenCalledOnce();
      const replacement = globalShortcut.register.mock.calls[1]![1];
      replacement();
      expect(listener).toHaveBeenLastCalledWith({
        type: "escape",
        processGeneration: 0,
        sequence: 2,
      });
      client.dispose();
      client.dispose();
      replacement();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(globalShortcut.unregister.mock.calls).toEqual([["Escape"], ["Escape"]]);
      await expect(client.setEscapeEnabled(true)).rejects.toThrow("disposed");
      expect(globalShortcut.register).toHaveBeenCalledTimes(2);
    } finally {
      client.dispose();
    }
  });

  it("does not release another owner's Escape registration and can retry a conflict", async () => {
    const globalShortcut = createGlobalShortcutStub();
    globalShortcut.register.mockReturnValueOnce(false);
    const client = new MacDictationNativeHelperClient("/unavailable/dictation-helper", {
      globalShortcut,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      await expect(client.setEscapeEnabled(true)).rejects.toMatchObject({
        code: "hotkey-conflict",
      });
      globalShortcut.register.mock.calls[0]![1]();
      expect(listener).not.toHaveBeenCalled();
      await client.setEscapeEnabled(false);
      expect(globalShortcut.unregister).not.toHaveBeenCalled();
      await client.setEscapeEnabled(true);
      globalShortcut.register.mock.calls[1]![1]();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
    }
    expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith("Escape");
  });

  it("interleaves Electron Escape with native press/release without replacing bindings", async () => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
      let binding;
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.type === "replaceBindings") {
          binding = { bindingId: "hold", mode: "hold", configurationGeneration: request.generation };
          send({ type: "response", id: request.id, ok: true, value: { applied: true, generation: request.generation } });
          send({ type: "pressed", ...binding, sequence: 1 });
          // Obsolete native Escape frames cannot duplicate Electron's callback.
          send({ type: "escape", sequence: 100 });
          return;
        }
        if (request.type === "queryBuiltInMic" && binding) {
          send({ type: "response", id: request.id, ok: true, value: null });
          send({ type: "released", ...binding, sequence: 2 });
          send({ type: "cancelled", ...binding, sequence: 3 });
          return;
        }
        send({ type: "response", id: request.id, ok: false, error: "unexpected-native-request" });
      });
    `);
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient(executable, {
      validateArchitecture: false,
      globalShortcut,
    });
    const listener = vi.fn();
    client.subscribe(listener);
    try {
      await client.replaceBindings({ generation: 7, bindings: [] });
      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      await client.setEscapeEnabled(true);
      globalShortcut.register.mock.calls[0]![1]();
      await client.setEscapeEnabled(false);
      await client.queryBuiltInMicrophoneName();
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(4));
      expect(listener.mock.calls.map(([event]) => event)).toEqual([
        {
          type: "pressed",
          bindingId: "hold",
          mode: "hold",
          configurationGeneration: 7,
          processGeneration: 1,
          sequence: 1,
        },
        { type: "escape", processGeneration: 1, sequence: 2 },
        {
          type: "released",
          bindingId: "hold",
          mode: "hold",
          configurationGeneration: 7,
          processGeneration: 1,
          sequence: 3,
        },
        {
          type: "cancelled",
          bindingId: "hold",
          mode: "hold",
          configurationGeneration: 7,
          processGeneration: 1,
          sequence: 4,
        },
      ]);
    } finally {
      client.dispose();
    }
  });

  it("passes stop evidence and waits for native cancellation cleanup", async () => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      send({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} });
      let pasteId;
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.type === "safePaste") {
          if (request.clipboardFingerprint !== "a".repeat(64) || request.recordingStoppedAtMs !== 1234) {
            send({ type: "response", id: request.id, ok: false, error: "missing-evidence" });
            return;
          }
          pasteId = request.id;
          send({ type: "pressed", bindingId: "hold", mode: "hold", configurationGeneration: 1, sequence: 1 });
        }
        if (request.type === "cancelPaste" && request.requestId === pasteId) {
          setTimeout(() => send({ type: "response", id: pasteId, ok: false, error: "aborted" }), 50);
        }
      });
    `);
    const globalShortcut = createGlobalShortcutStub();
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut,
      validateArchitecture: false,
    });
    const controller = new AbortController();
    const received = vi.fn();
    client.subscribe((event) => {
      received(event);
      if (event.type === "escape") controller.abort();
    });
    try {
      await client.setEscapeEnabled(true);
      const pending = client.safePaste(
        "hello",
        { pid: 42, bundleIdentifier: "app" },
        {
          clipboardFingerprint: "a".repeat(64),
          recordingStoppedAtMs: 1234,
          signal: controller.signal,
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
      const cancelledAt = Date.now();
      globalShortcut.register.mock.calls[0]![1]();
      await rejection;
      expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(40);
    } finally {
      client.dispose();
    }
  });

  it.each([
    {
      pasted: false,
      clipboardRestoreMs: 0,
      failure: { text: "hello", copied: true, reason: "accessibility" },
    },
    {
      pasted: false,
      clipboardRestoreMs: 0,
      failure: { text: "hello", copied: false, reason: "clipboard-changed" },
    },
  ])("preserves native failure recovery metadata", async (value) => {
    const executable = await createExecutable(`
      const readline = require("node:readline");
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} }) + "\\n");
      readline.createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ type: "response", id: request.id, ok: true, value: ${JSON.stringify(value)} }) + "\\n");
      });
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });
    try {
      await expect(
        client.safePaste("hello", { pid: 42, bundleIdentifier: "app" }),
      ).resolves.toEqual({ clipboardRestoreMs: 0, failure: value.failure });
    } finally {
      client.dispose();
    }
  });

  it("rejects oversized requests before writing to the helper", async () => {
    const executable = await createExecutable(`
      process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: ${MAC_DICTATION_HELPER_PROTOCOL_VERSION} }) + "\\n");
      process.stdin.resume();
    `);
    const client = new MacDictationNativeHelperClient(executable, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });
    try {
      await expect(client.copy("x".repeat(65536))).rejects.toMatchObject({
        code: "message-too-large",
      });
    } finally {
      client.dispose();
    }
  });

  it("rejects a symlink before spawning it", async () => {
    const executable = await createExecutable("process.exit(0);");
    const link = `${executable}-link`;
    await symlink(executable, link);
    const client = new MacDictationNativeHelperClient(link, {
      globalShortcut: createGlobalShortcutStub(),
      validateArchitecture: false,
    });

    await expect(client.capabilities()).rejects.toThrow("not a regular executable");
  });
});

// Compile the production Swift functions with an isolated entrypoint. No global pasteboard,
// application focus, Accessibility requests, or event taps are used by this harness.
it.skipIf(process.platform !== "darwin")(
  "native clipboard and hotkey contracts",
  async () => {
    const artifactRoot = process.env.NODEX_DICTATION_TEST_ARTIFACTS ?? tmpdir();
    const directory = await mkdtemp(join(artifactRoot, "nodex-native-contract-"));
    temporaryDirectories.push(directory);
    const source = await readFile(
      join(process.cwd(), "resources/macos/nodex-dictation-helper.swift"),
      "utf8",
    );
    const harness = join(directory, "native-harness.swift");
    const executable = join(directory, "native-harness");
    const moduleCache = join(artifactRoot, "dictation-swift-module-cache");
    await mkdir(moduleCache, { recursive: true });
    await writeFile(harness, source + "\n" + NATIVE_CONTRACT_TESTS);
    const execute = promisify(execFile);
    await execute(
      "xcrun",
      [
        "swiftc",
        "-D",
        "DICTATION_HELPER_TESTS",
        "-parse-as-library",
        "-module-cache-path",
        moduleCache,
        harness,
        "-o",
        executable,
      ],
      { timeout: 120_000 },
    );
    const result = await execute(executable, [], { timeout: 20_000 });
    expect(result.stdout).toMatch(/native assertions passed: \d+/);
  },
  150_000,
);

const NATIVE_CONTRACT_TESTS = String.raw`@main
private enum NativeTests {
    static var assertions = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
        assertions += 1
    }
    static func pump(until done: () -> Bool, timeout: Double = 2) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.005)) }
        check(done(), "async transaction did not complete")
    }
    static func main() {
        keyboard()
        menu()
        clipboard()
        print("native assertions passed: \(assertions)")
    }
    static func keyboard() {
        let timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { _ in }
        HelperState.shared.captureTimer = timer
        HelperState.shared.captureRequestId = "capture-current"
        handle(["id": "cancel-old", "type": "cancelCapture", "requestId": "capture-old"])
        check(HelperState.shared.captureRequestId == "capture-current" && timer.isValid, "old cancellation cannot cancel a new capture")
        handle(["id": "cancel-current", "type": "cancelCapture", "requestId": "capture-current"])
        check(HelperState.shared.captureRequestId == nil && HelperState.shared.captureTimer == nil && !timer.isValid, "matching cancellation clears native capture timer immediately")
        var capture = ModifierCapture()
        check(capture.transition(type: .flagsChanged, flags: .maskSecondaryFn) == nil, "Fn down waits for chord")
        check(capture.transition(type: .flagsChanged, flags: [.maskShift, .maskSecondaryFn]) == nil, "Fn first gathers Shift")
        check(capture.transition(type: .flagsChanged, flags: .maskSecondaryFn) == "Shift+Fn", "first modifier release captures full chord")
        capture = ModifierCapture()
        check(capture.transition(type: .flagsChanged, flags: .maskShift) == nil, "Shift first waits")
        check(capture.transition(type: .flagsChanged, flags: [.maskShift, .maskSecondaryFn]) == nil, "Shift first gathers Fn")
        check(capture.transition(type: .flagsChanged, flags: .maskShift) == "Shift+Fn", "Fn release captures full chord")
        capture = ModifierCapture(flags: [.maskCommand, .maskControl, .maskAlternate, .maskSecondaryFn])
        check(capture.transition(type: .flagsChanged, flags: []) == "Ctrl+Command+Alt+Fn", "capture canonical family order")
        capture = ModifierCapture(flags: .maskSecondaryFn)
        check(capture.transition(type: .keyDown, flags: .maskSecondaryFn) == nil, "regular key cancels capture gesture")
        check(capture.transition(type: .flagsChanged, flags: []) == nil, "cancelled capture cannot become Fn")
        check(capture.transition(type: .flagsChanged, flags: .maskSecondaryFn) == nil, "fresh capture begins")
        check(capture.transition(type: .flagsChanged, flags: []) == "Fn", "single Fn on release")
        for (keys, flags, name): (Set<CGKeyCode>, CGEventFlags, String) in [
            ([58], .maskAlternate, "LeftOption"), ([61], .maskAlternate, "RightOption"),
            ([55], .maskCommand, "LeftCommand"), ([54], .maskCommand, "RightCommand"),
            ([59], .maskControl, "LeftControl"), ([58, 61], .maskAlternate, "DoubleOption"),
            ([54, 55], .maskCommand, "DoubleCommand"), ([56, 60], .maskShift, "DoubleShift"),
        ] {
            capture = ModifierCapture()
            check(capture.transition(type: .flagsChanged, flags: flags, keys: keys) == nil, "named modifier waits for release")
            let remaining = Set(keys.dropFirst())
            check(capture.transition(type: .flagsChanged, flags: remaining.isEmpty ? [] : flags, keys: remaining) == name, "named physical release preserves sides")
        }
        for key: CGKeyCode in [56, 60, 62] {
            capture = ModifierCapture(flags: key == 62 ? .maskControl : .maskShift, keys: [key])
            check(capture.transition(type: .flagsChanged, flags: []) == nil, "unsupported single modifier is not captured")
        }
        var fn = Hotkey(id: "hold", mode: "hold", configurationGeneration: 1, modifiers: .maskSecondaryFn,
                        keyCode: nil, bareModifierKeyCodes: [63], pressed: false)
        func step(_ type: CGEventType, _ key: CGKeyCode, _ flags: CGEventFlags,
                  _ down: Set<CGKeyCode>, other: Bool = false) -> String? {
            transitionHotkey(&fn, type: type, keyCode: key, flags: flags, repeated: false,
                             hasOtherKey: other, keyDown: down.contains)
        }
        check(step(.flagsChanged, 63, .maskSecondaryFn, [63]) == "pressed", "Fn down")
        check(step(.keyDown, 0, .maskSecondaryFn, [63], other: true) == "cancelled", "Fn key chord cancels")
        check(step(.keyUp, 0, .maskSecondaryFn, [63]) == nil, "chord key up is not a tap")
        check(step(.flagsChanged, 63, [], []) == nil, "cancelled Fn up is not a release")
        check(step(.flagsChanged, 63, .maskSecondaryFn, [63]) == "pressed", "fresh Fn rearms")
        check(step(.flagsChanged, 55, [.maskSecondaryFn, .maskCommand], [63]) == "cancelled", "modifier chord cancels")
        check(step(.flagsChanged, 55, .maskSecondaryFn, [63]) == nil, "removing extra modifier does not rearm")
        check(step(.flagsChanged, 63, [], []) == nil, "chord finishes silently")
        check(step(.flagsChanged, 63, [.maskSecondaryFn, .maskShift], [63]) == nil, "preexisting modifier prevents activation")
        check(step(.flagsChanged, 56, .maskSecondaryFn, [63]) == nil, "no activation when chord shrinks")
        check(step(.flagsChanged, 63, [], []) == nil, "chord clears")
        check(step(.flagsChanged, 63, .maskSecondaryFn, [63]) == "pressed", "bare starts")
        check(step(.flagsChanged, 63, [], []) == "released", "bare finishes")
        check(step(.flagsChanged, 63, .maskSecondaryFn, [63], other: true) == nil, "held regular key prevents bare activation")
        _ = step(.flagsChanged, 63, [], [])
        var leftOption = Hotkey(id: "left", mode: "hold", configurationGeneration: 1, modifiers: .maskAlternate,
                                keyCode: nil, bareModifierKeyCodes: [58], pressed: false)
        check(transitionHotkey(&leftOption, type: .flagsChanged, keyCode: 58, flags: .maskAlternate,
                               repeated: false, hasOtherKey: false, keyDown: { $0 == 58 }) == "pressed", "left option")
        check(transitionHotkey(&leftOption, type: .flagsChanged, keyCode: 61, flags: .maskAlternate,
                               repeated: false, hasOtherKey: false, keyDown: { [58, 61].contains($0) }) == "cancelled", "opposite side modifier cancels")
        var regular = Hotkey(id: "regular", mode: "hold", configurationGeneration: 1, modifiers: [.maskControl, .maskShift],
                             keyCode: 0, bareModifierKeyCodes: nil, pressed: false)
        func key(_ type: CGEventType, _ key: CGKeyCode, _ flags: CGEventFlags, repeated: Bool = false) -> String? {
            transitionHotkey(&regular, type: type, keyCode: key, flags: flags, repeated: repeated,
                             hasOtherKey: false, keyDown: { _ in false })
        }
        check(key(.keyDown, 0, [.maskControl, .maskShift]) == nil, "native regular key never starts")
        check(key(.keyDown, 0, [.maskControl, .maskShift], repeated: true) == nil, "native repeat never starts")
        regular.pressed = true // Electron's armRegularRelease request owns activation.
        check(key(.keyUp, 0, [.maskControl, .maskShift]) == nil && regular.pressed, "K up does not release regular gesture")
        check(key(.flagsChanged, 58, [.maskControl, .maskShift, .maskAlternate]) == nil, "extra modifier does not end regular gesture")
        check(key(.flagsChanged, 56, .maskControl) == "released", "required modifier release")
        check(key(.flagsChanged, 59, []) == nil, "release emitted once")
        regular.pressed = true
        check(key(.flagsChanged, 0, []) == "released", "arm detects modifier release during IPC")
        let old = Hotkey(id: "hold", mode: "hold", configurationGeneration: 1, modifiers: .maskSecondaryFn,
                         keyCode: nil, bareModifierKeyCodes: [63], pressed: true, suppressed: true)
        let new = Hotkey(id: "hold", mode: "hold", configurationGeneration: 2, modifiers: .maskSecondaryFn,
                         keyCode: nil, bareModifierKeyCodes: [63], pressed: false)
        let preserved = preservingHotkeyState(["hold": new], previous: ["hold": old])["hold"]!
        check(preserved.pressed && preserved.suppressed && preserved.configurationGeneration == 2, "replacement preserves pressed state with new generation")
        for families: CGEventFlags in [[.maskControl, .maskAlternate], [.maskShift, .maskSecondaryFn], [.maskCommand, .maskControl, .maskAlternate]] {
            var family = Hotkey(id: "family", mode: "hold", configurationGeneration: 1, modifiers: families,
                                keyCode: nil, bareModifierKeyCodes: nil, pressed: false)
            func familyStep(_ type: CGEventType, _ flags: CGEventFlags, other: Bool = false) -> String? {
                transitionHotkey(&family, type: type, keyCode: 62, flags: flags, repeated: false,
                                 hasOtherKey: other, keyDown: { _ in true })
            }
            check(familyStep(.flagsChanged, families) == "pressed", "family combo permits either modifier side")
            check(familyStep(.flagsChanged, families) == nil, "opposite side in same family is allowed")
            check(familyStep(.keyDown, families, other: true) == "cancelled", "family chord cancellation")
            check(familyStep(.keyUp, families) == nil, "family remains suppressed")
            check(familyStep(.flagsChanged, []) == nil, "family resets on release")
            check(familyStep(.flagsChanged, families) == "pressed", "family rearm")
            check(familyStep(.flagsChanged, []) == "released", "family release")
            check(familyStep(.flagsChanged, families) == "pressed", "family starts before extra family")
            check(familyStep(.flagsChanged, relevantFlags) == "cancelled", "extra family cancels")
            let names = ["control", "command", "option", "shift", "function"].filter { parseModifiers([$0])!.intersection(families).rawValue != 0 }
            let parsed = parseBindings([["bindingId": "family", "mode": "hold", "modifiers": names,
                                         "keyCode": NSNull(), "bareModifierKeyCodes": NSNull()]], generation: 1)
            check(parsed?["family"]?.modifiers == families, "family nil/nil protocol parses")
        }
        var combo = Hotkey(id: "combo", mode: "toggle", configurationGeneration: 1, modifiers: [.maskControl, .maskShift],
                           keyCode: nil, bareModifierKeyCodes: [59, 56], pressed: false)
        check(transitionHotkey(&combo, type: .flagsChanged, keyCode: 56, flags: [.maskControl, .maskShift],
                               repeated: false, hasOtherKey: false, keyDown: { [59, 56].contains($0) }) == "pressed", "bare combo")
        check(transitionHotkey(&combo, type: .flagsChanged, keyCode: 59, flags: .maskShift,
                               repeated: false, hasOtherKey: false, keyDown: { $0 == 56 }) == "released", "any bare combo key release")
    }
    static func menu() {
        struct Node {
            var title: String? = nil
            var identifier: String? = nil
            var enabled = true
            var character: String? = nil
            var modifiers: Int? = nil
            var children: [Int] = []
        }
        func find(_ nodes: [Node], localized: String = "粘贴", continuing: Bool = true) -> Int? {
            findPasteCommand(root: 0, localizedTitle: localized, attributes: { id in
                let node = nodes[id]
                return (id == 0 ? "AXMenuBar" : "AXMenuItem", node.enabled, node.identifier, node.title, node.character, node.modifiers)
            }, children: { id, _ in nodes[id].children }, shouldContinue: { continuing })
        }
        check(find([Node(children: [1]), Node(title: "粘贴")]) == 1, "localized Paste")
        check(find([Node(children: [1]), Node(identifier: "app.menu_paste:")]) == 1, "semantic identifier")
        check(find([Node(children: [1]), Node(identifier: "pasteAndMatchStyle")]) == nil, "no partial identifier match")
        check(find([Node(children: [1]), Node(title: "Paste", enabled: false)]) == nil, "disabled command")
        check(find([Node(children: [1]), Node(character: "V", modifiers: 0)]) == 1, "unique Cmd V fallback")
        check(find([Node(children: [1, 2]), Node(character: "v", modifiers: 0), Node(character: "v", modifiers: 0)]) == nil, "ambiguous shortcut")
        check(find([Node(children: [1, 2]), Node(character: "v", modifiers: 0), Node(title: "Paste")]) == 2, "explicit title wins")
        check(find([Node(children: [1]), Node(character: "v", modifiers: 1)]) == nil, "shift cmd V is not Paste")
        check(find([Node(children: [1]), Node(title: "Paste")], continuing: false) == nil, "cancel menu search")
        var chain = [Node](repeating: Node(), count: 1001)
        for index in 0..<1000 { chain[index].children = [index + 1] }
        chain[1000].title = "Paste"
        check(find(chain) == nil, "menu is bounded at 1000")
        chain[999].title = "Paste"
        check(find(chain) == 999, "1000th node remains eligible")
    }
    static func clipboard() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let custom = NSPasteboard.PasteboardType("app.nodex.test.binary")
        func seed() -> PasteboardSnapshot {
            board.clearContents()
            let first = NSPasteboardItem()
            first.setString("original", forType: .string)
            first.setString("<b>original</b>", forType: .html)
            first.setData(Data([0, 255, 4, 0]), forType: custom)
            let second = NSPasteboardItem()
            second.setData(Data([9, 8, 7]), forType: custom)
            board.writeObjects([first, second])
            return snapshotPasteboard(board)!
        }
        var response: Result<[String: Any], PasteFailure>?
        var dispatches = 0
        func transaction(trusted: Bool = true, succeed: Bool = true) -> PasteTransaction {
            response = nil
            return PasteTransaction(text: "dictated ", pasteboard: board, trusted: { trusted }, dispatch: { _, done in
                dispatches += 1
                done(succeed)
            }, completion: { response = $0 })
        }
        func failureReason() -> String? {
            guard case .success(let value) = response else { return nil }
            return (value["failure"] as? [String: Any])?["reason"] as? String
        }
        func copied() -> Bool? {
            guard case .success(let value) = response else { return nil }
            return (value["failure"] as? [String: Any])?["copied"] as? Bool
        }
        let original = seed()
        check(original.items.count == 2 && original.items[0][custom] == Data([0, 255, 4, 0]), "snapshot preserves items and binary formats")
        restorePasteboard(original, to: board)
        check(snapshotPasteboard(board)?.fingerprint == original.fingerprint, "all format restore")
        let reversed = PasteboardSnapshot(items: original.items.reversed())
        check(reversed.fingerprint != original.fingerprint, "fingerprint retains item boundaries")
        let denied = transaction(trusted: false)
        denied.start(expectedFingerprint: original.fingerprint, recordingStoppedAtMs: nil)
        check(failureReason() == "accessibility" && copied() == true, "denied Accessibility still copies")
        check(board.string(forType: .string) == "dictated ", "denial retains text")
        _ = seed()
        let changed = transaction()
        changed.start(expectedFingerprint: String(repeating: "0", count: 64), recordingStoppedAtMs: nil)
        check(failureReason() == "clipboard-changed" && copied() == false, "stop fingerprint fences mutation")
        check(snapshotPasteboard(board)?.fingerprint == original.fingerprint, "stale stop does not overwrite clipboard")
        let failed = transaction(succeed: false)
        failed.start(expectedFingerprint: nil, recordingStoppedAtMs: 0)
        pump(until: { response != nil })
        check(failureReason() == "paste" && copied() == true, "dispatch failure retains manual recovery")
        check(board.string(forType: .string) == "dictated ", "failed dispatch keeps copy")
        _ = seed()
        let beforeDispatch = dispatches
        let delayChanged = transaction()
        delayChanged.start(expectedFingerprint: nil, recordingStoppedAtMs: nil)
        board.clearContents()
        board.setString("user copy", forType: .string)
        pump(until: { response != nil })
        check(failureReason() == "clipboard-changed" && dispatches == beforeDispatch, "clipboard recheck before dispatch")
        check(board.string(forType: .string) == "user copy", "changed clipboard wins")
        _ = seed()
        let cancelled = transaction()
        cancelled.start(expectedFingerprint: nil, recordingStoppedAtMs: nil)
        cancelled.cancel()
        check(snapshotPasteboard(board)?.fingerprint == original.fingerprint, "pre-dispatch cancel restores")
        if case .failure = response { check(true, "abort response") } else { check(false, "expected abort") }
        _ = seed()
        var dispatchTime: Date?
        response = nil
        let success = PasteTransaction(text: "dictated ", pasteboard: board, trusted: { true }, dispatch: { _, done in
            dispatchTime = Date()
            done(true)
        }, completion: { response = $0 })
        let started = Date()
        success.start(expectedFingerprint: original.fingerprint, recordingStoppedAtMs: 0)
        pump(until: { dispatchTime != nil })
        check(dispatchTime!.timeIntervalSince(started) < 0.1, "old recording stop skips 150 ms delay")
        check(board.string(forType: .string) == "dictated ", "copy remains through grace")
        pump(until: { response != nil })
        check(Date().timeIntervalSince(dispatchTime!) >= 0.69, "paste consumption grace")
        check(snapshotPasteboard(board)?.fingerprint == original.fingerprint, "success restores all formats")
        _ = seed()
        response = nil
        var finishDispatch: ((Bool) -> Void)?
        let duringDispatch = PasteTransaction(text: "dictated ", pasteboard: board, trusted: { true }, dispatch: { _, done in
            finishDispatch = done
        }, completion: { response = $0 })
        duringDispatch.start(expectedFingerprint: nil, recordingStoppedAtMs: 0)
        pump(until: { finishDispatch != nil })
        duringDispatch.cancel()
        check(response == nil && board.string(forType: .string) == "dictated ", "dispatch cancellation waits")
        let abortedAt = Date()
        finishDispatch!(false)
        pump(until: { response != nil })
        check(Date().timeIntervalSince(abortedAt) >= 0.69, "abort after dispatch keeps grace")
        check(snapshotPasteboard(board)?.fingerprint == original.fingerprint, "dispatch abort restores")
        _ = seed()
        let userDuringGrace = transaction()
        userDuringGrace.start(expectedFingerprint: nil, recordingStoppedAtMs: 0)
        let count = dispatches
        pump(until: { dispatches > count })
        board.clearContents()
        board.setString("new user data", forType: .string)
        pump(until: { response != nil })
        check(board.string(forType: .string) == "new user data", "user copy during grace is preserved")
    }
}
`;
