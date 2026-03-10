import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client";
import { subscribeToBackendLogs } from "../logging/logger";

function makeMockServerScript(): { scriptPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-client-"));
  const scriptPath = path.join(dir, "mock-server.mjs");

  fs.writeFileSync(
    scriptPath,
    [
      "import readline from 'node:readline';",
      "const rl = readline.createInterface({ input: process.stdin });",
      "let pendingTriggerId = null;",
      "function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }",
      "rl.on('line', (line) => {",
      "  if (!line.trim()) return;",
      "  const msg = JSON.parse(line);",
      "  if (msg.method === 'initialize') { send({ id: msg.id, result: { ok: true } }); return; }",
      "  if (msg.method === 'initialized') { return; }",
      "  if (msg.method === 'echo') {",
      "    const delay = Number(msg.params?.delay ?? 0);",
      "    setTimeout(() => send({ id: msg.id, result: { value: msg.params?.value } }), delay);",
      "    return;",
      "  }",
      "  if (msg.method === 'triggerApproval') {",
      "    pendingTriggerId = msg.id;",
      "    send({",
      "      id: 9001,",
      "      method: 'item/commandExecution/requestApproval',",
      "      params: {",
      "        threadId: 'thr_test',",
      "        turnId: 'turn_test',",
      "        itemId: 'item_test',",
      "        command: 'echo hi',",
      "        cwd: '/tmp',",
      "      },",
      "    });",
      "    return;",
      "  }",
      "  if (msg.id === 9001) {",
      "    if (pendingTriggerId !== null) send({ id: pendingTriggerId, result: { approved: msg.result?.decision ?? null } });",
      "    pendingTriggerId = null;",
      "    return;",
      "  }",
      "  if (Object.prototype.hasOwnProperty.call(msg, 'id')) {",
      "    send({ id: msg.id, result: {} });",
      "  }",
      "});",
    ].join("\n"),
    "utf8",
  );

  return {
    scriptPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeBinaryShim(binaryName: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-codex-shim-"));
  const shimPath = path.join(dir, binaryName);
  const escapedExecPath = JSON.stringify(process.execPath);

  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env bash\nexec ${escapedExecPath} "$@"\n`,
    "utf8",
  );
  fs.chmodSync(shimPath, 0o755);

  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("codex-app-server-client", () => {
  test("initializes, correlates concurrent requests, and handles server requests", async () => {
    const mock = makeMockServerScript();
    const client = new CodexAppServerClient({
      binaryPath: process.execPath,
      args: [mock.scriptPath],
      clientInfo: {
        name: "test-client",
        title: "Test Client",
        version: "0.0.1",
      },
    });

    try {
      client.setServerRequestHandler(async (request) => {
        if (request.method === "item/commandExecution/requestApproval") {
          return { decision: "accept" };
        }
        return {};
      });

      await client.start();

      const [first, second] = await Promise.all([
        client.request<{ value: string }>("echo", { value: "first", delay: 40 }),
        client.request<{ value: string }>("echo", { value: "second", delay: 5 }),
      ]);

      expect(first.value).toBe("first");
      expect(second.value).toBe("second");

      const approval = await client.request<{ approved: string }>("triggerApproval", {});
      expect(approval.approved).toBe("accept");
    } finally {
      await client.stop();
      mock.cleanup();
    }
  });

  test("reports missing binary state", async () => {
    const client = new CodexAppServerClient({
      binaryPath: "__missing_codex_binary_for_test__",
    });

    try {
      let threw = false;
      try {
        await client.start();
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (client.getState().status === "missingBinary") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(client.getState().status).toBe("missingBinary");
    } finally {
      await client.stop();
    }
  });

  test("resolves binaries from additional search paths when PATH is restricted", async () => {
    const mock = makeMockServerScript();
    const binaryName = "codex-test-shim";
    const shim = makeBinaryShim(binaryName);
    const client = new CodexAppServerClient({
      binaryPath: binaryName,
      args: [mock.scriptPath],
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      additionalSearchPaths: [shim.dir],
    });

    try {
      await client.start();
      expect(client.getState().status).toBe("connected");
    } finally {
      await client.stop();
      mock.cleanup();
      shim.cleanup();
    }
  });

  test("emits structured logs for RPC requests", async () => {
    const mock = makeMockServerScript();
    const captured: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeToBackendLogs((entry) => {
      captured.push(entry);
    });
    const client = new CodexAppServerClient({
      binaryPath: process.execPath,
      args: [mock.scriptPath],
      clientInfo: {
        name: "test-client",
        title: "Test Client",
        version: "0.0.1",
      },
    });

    try {
      await client.start();
      await client.request<{ value: string }>("echo", { value: "log-me" });

      const hasSendLog = captured.some((entry) => {
        return entry.msg === "Sending Codex RPC request" && entry.method === "echo";
      });
      const hasResponseLog = captured.some((entry) => {
        return entry.msg === "Codex RPC request completed" && entry.method === "echo";
      });

      expect(hasSendLog).toBeTrue();
      expect(hasResponseLog).toBeTrue();
    } finally {
      unsubscribe();
      await client.stop();
      mock.cleanup();
    }
  });
});
