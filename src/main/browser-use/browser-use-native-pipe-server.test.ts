import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";
import {
  makeBrowserUseNativePipeServer,
  type BrowserUseNativePipeRequestHandler,
  type BrowserUseNativePipeServerEvents,
} from "./browser-use-native-pipe-server";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "./native-pipe-framing";

const makeServer = (
  authorized: boolean,
  handler: BrowserUseNativePipeRequestHandler,
  events?: BrowserUseNativePipeServerEvents,
) =>
  Effect.acquireRelease(
    Effect.promise(() => {
      const temporaryRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
      return fs.mkdtemp(path.join(temporaryRoot, "nxbu-"));
    }),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  ).pipe(
    Effect.flatMap((nativePipeDirectory) =>
      makeBrowserUseNativePipeServer({
        events,
        handler,
        nativePipeDirectory,
        platform: process.platform,
        socketPeerAuthorizer: () => ({
          authorized,
          ...(!authorized ? { reason: "test-denied" } : {}),
        }),
      }),
    ),
  );

const connect = (pipePath: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });

const connectScoped = (pipePath: string) =>
  Effect.acquireRelease(
    Effect.promise(() => connect(pipePath)),
    (socket) => Effect.sync(() => socket.destroy()),
  );

const readOne = (socket: net.Socket): Promise<Record<string, unknown>> => {
  const decoder = new BrowserUseNativePipeFrameDecoder();
  return new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      try {
        const [message] = decoder.push(chunk);
        if (message) resolve(JSON.parse(message) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
};

it.effect("authorizes before reading and returns isolated JSON-RPC responses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const server = yield* makeServer(true, (request, context) => ({
        connectionId: context.connectionId,
        method: request.method,
      }));
      const [first, second] = yield* Effect.all(
        [connectScoped(server.pipePath), connectScoped(server.pipePath)],
        { concurrency: 2 },
      );
      const firstResponse = readOne(first);
      const secondResponse = readOne(second);
      first.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify({ jsonrpc: "2.0", id: "same-id", method: "ping" }),
        ),
      );
      second.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify({ jsonrpc: "2.0", id: "same-id", method: "getInfo" }),
        ),
      );

      const [firstMessage, secondMessage] = yield* Effect.promise(() =>
        Promise.all([firstResponse, secondResponse]),
      );
      expect(firstMessage.id).toBe("same-id");
      expect(secondMessage.id).toBe("same-id");
      expect((firstMessage.result as { method: string }).method).toBe("ping");
      expect((secondMessage.result as { method: string }).method).toBe("getInfo");
      expect((firstMessage.result as { connectionId: string }).connectionId).not.toBe(
        (secondMessage.result as { connectionId: string }).connectionId,
      );
    }),
  ),
);

it.effect("rejects unauthorized peers without dispatching a request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      let calls = 0;
      const server = yield* makeServer(false, () => {
        calls += 1;
      });
      const socket = yield* connectScoped(server.pipePath);
      socket.write(
        encodeBrowserUseNativePipeFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => socket.once("close", () => resolve())),
      );
      expect(calls).toBe(0);
    }),
  ),
);

it.effect("uses restrictive directory and socket permissions", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const server = yield* makeServer(true, () => "pong");
      const directoryMode =
        (yield* Effect.promise(() => fs.stat(path.dirname(server.pipePath)))).mode & 0o777;
      const socketMode = (yield* Effect.promise(() => fs.stat(server.pipePath))).mode & 0o777;
      expect(directoryMode).toBe(0o700);
      expect(socketMode).toBe(0o600);
    }),
  ),
);

it.effect("closes accepted sockets and removes the exact pipe with its Scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join("/tmp", "nxbu-release-"))),
        (ownedDirectory) =>
          Effect.promise(() => fs.rm(ownedDirectory, { recursive: true, force: true })),
      );
      const parentScope = yield* Scope.Scope;
      const serverScope = yield* Scope.fork(parentScope);
      const server = yield* makeBrowserUseNativePipeServer({
        handler: () => "pong",
        nativePipeDirectory: directory,
        platform: process.platform,
        socketPeerAuthorizer: () => ({ authorized: true }),
      }).pipe(Scope.provide(serverScope));
      const socket = yield* connectScoped(server.pipePath);
      const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

      yield* Scope.close(serverScope, Exit.void);
      yield* Effect.promise(() => socketClosed);

      const pipeEntry = yield* Effect.promise(() => fs.lstat(server.pipePath).catch(() => null));
      expect(pipeEntry).toBeNull();
      expect(socket.destroyed).toBe(true);
    }),
  ),
);

it.effect("reports bounded request lifecycle metadata without request parameters", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const started: unknown[] = [];
      const completed: unknown[] = [];
      const server = yield* makeServer(true, () => "ok", {
        onRequestCompleted: (event) => completed.push(event),
        onRequestStarted: (event) => started.push(event),
      });
      const socket = yield* connectScoped(server.pipePath);
      const response = readOne(socket);
      socket.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "executeCdp",
            params: {
              method: "Page.navigate",
              params: { url: "https://private.example/path" },
              tabId: 1,
            },
          }),
        ),
      );

      expect(yield* Effect.promise(() => response)).toMatchObject({ id: 1, result: "ok" });
      expect(started).toEqual([
        expect.objectContaining({ label: "executeCdp:Page.navigate", notification: false }),
      ]);
      expect(completed).toEqual([
        expect.objectContaining({
          label: "executeCdp:Page.navigate",
          notification: false,
          outcome: "success",
        }),
      ]);
      expect(JSON.stringify({ started, completed })).not.toContain("private.example");
    }),
  ),
);

it.effect("surfaces the actionable cause of a wrapped Browser request failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const server = yield* makeServer(true, () => {
        throw Object.assign(new Error(), {
          _tag: "BrowserUseSessionRuntimeError",
          cause: new Error("Timed out executing Browser Use CDP command Page.navigate"),
        });
      });
      const socket = yield* connectScoped(server.pipePath);
      const response = readOne(socket);
      socket.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "executeCdp" }),
        ),
      );

      expect(yield* Effect.promise(() => response)).toMatchObject({
        error: {
          code: 1,
          message: "Timed out executing Browser Use CDP command Page.navigate",
        },
        id: 1,
      });
    }),
  ),
);
