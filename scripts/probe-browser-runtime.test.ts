import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vite-plus/test";

import {
  buildBrowserProbeNodeReplServer,
  classifyComputerUseProbeResponse,
  cleanupBrowserRuntime,
} from "./probe-browser-runtime";

describe("Browser runtime probe cleanup", () => {
  test("attempts every teardown operation and preserves the first failure", async () => {
    const events: string[] = [];

    await expect(
      cleanupBrowserRuntime({
        closeForeignAccessHost: async () => {
          events.push("close-foreign-host");
        },
        closeNativePipeServer: async () => {
          events.push("close-pipe");
          throw new Error("pipe close failed");
        },
        removeStateHome: () => {
          events.push("remove-profile");
        },
        stopComputerUseRuntime: async () => {
          events.push("stop-computer-use");
        },
        stopClient: async () => {
          events.push("stop-client");
          throw new Error("client stop failed");
        },
      }),
    ).rejects.toThrow("client stop failed");

    expect(events).toEqual([
      "stop-client",
      "stop-computer-use",
      "close-pipe",
      "close-foreign-host",
      "remove-profile",
    ]);
  });
});

describe("classifyComputerUseProbeResponse", () => {
  test("accepts a real list_apps response", () => {
    expect(
      classifyComputerUseProbeResponse('tool output\n__NODEX_CUA_PROBE__{"appCount":12}', false),
    ).toEqual({ appCount: 12, status: "available" });
  });

  test("treats the native locked-session guard as successful policy conformance", () => {
    expect(
      classifyComputerUseProbeResponse(
        "The Mac is locked and automatic unlock could not unlock it.",
        true,
      ),
    ).toEqual({ reason: "mac-locked", status: "unavailable" });
  });
});

describe("Browser runtime probe backend isolation", () => {
  test.skipIf(process.platform === "win32")(
    "keeps backend discovery on the owned socket after the closed launcher runs",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-probe-backend-"));
      const ownedPath = path.join(root, "owned.sock");
      const foreignPath = path.join(root, "foreign.sock");
      let ownedConnections = 0;
      let foreignConnections = 0;
      const owned = net.createServer((socket) => {
        ownedConnections += 1;
        socket.end("owned\n");
      });
      const foreign = net.createServer((socket) => {
        foreignConnections += 1;
        socket.end("foreign\n");
      });
      const listen = (server: net.Server, socketPath: string) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
      const close = (server: net.Server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close((error) => (error ? reject(error) : resolve()));
        });
      try {
        await Promise.all([listen(owned, ownedPath), listen(foreign, foreignPath)]);
        // The recording codex executes the Browser service's discovery contract inside this
        // private fixture directory. Missing launcher declarations would contact both peers.
        fs.writeFileSync(
          path.join(root, "sandbox"),
          `const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const configured = process.env.BROWSER_USE_BACKEND_PATHS;
const backends = configured == null
  ? fs.readdirSync(process.env.FIXTURE_BROWSER_DIRECTORY)
      .filter((name) => name.endsWith(".sock"))
      .map((name) => path.join(process.env.FIXTURE_BROWSER_DIRECTORY, name))
  : configured.split(path.delimiter).filter(Boolean);
Promise.all(backends.map((backend) => new Promise((resolve, reject) => {
  const socket = net.createConnection(backend);
  socket.once("error", reject);
  socket.on("data", () => {});
  socket.once("close", resolve);
}))).then(() => {
  process.stdout.write(JSON.stringify({ backends }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
`,
        );
        const definition = buildBrowserProbeNodeReplServer(
          { env: { CODEX_HOME: path.join(root, "home"), BROWSER_USE_AVAILABLE_BACKENDS: "iab" } },
          { codexCli: process.execPath, node: process.execPath, nodeRepl: "/fixture/node_repl" },
          ownedPath,
        );
        const result = await promisify(execFile)(definition.command, definition.args, {
          cwd: root,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            FIXTURE_BROWSER_DIRECTORY: root,
            BROWSER_USE_BACKEND_PATHS: foreignPath,
            ...definition.env,
          },
        });
        expect(ownedConnections).toBe(1);
        expect(foreignConnections).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ backends: [ownedPath] });
      } finally {
        await Promise.all([close(owned), close(foreign)]);
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  test("rejects malformed environments before constructing the probe launcher", () => {
    for (const definition of [null, { env: [] }, { env: { CODEX_HOME: 42 } }]) {
      expect(() =>
        buildBrowserProbeNodeReplServer(
          definition,
          { codexCli: "/fixture/codex", node: "/fixture/node", nodeRepl: "/fixture/node_repl" },
          "/fixture/owned.sock",
        ),
      ).toThrow(/Node REPL environment/u);
    }
  });
});
