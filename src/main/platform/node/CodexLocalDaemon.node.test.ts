import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { WebSocketServer } from "ws";
import { openCodexLocalDaemon, canUseCodexLocalDaemon } from "./CodexLocalDaemon";
import { nodeLive } from "./CodexSessionTransport";
import { live as sessionLive } from "../../codex-runtime/CodexAppServerSession";
import { CodexEndpoint, live as endpointLive } from "../../codex-runtime/CodexEndpoint";
import { live as eventHubLive } from "../../codex-runtime/CodexEventHub";
import { live as schedulerLive } from "../../codex-runtime/CodexRequestScheduler";
import {
  CodexApplicationRequestInbox,
  make as makeInbox,
} from "../../codex-runtime/CodexApplicationRequestInbox";
import {
  isSupportedCodexAppServerVersion,
  parseCodexCliVersion,
} from "../../../shared/codex-app-server-version";

it.live(
  "a physical Unix WebSocket reconnect rejects old requests and reinitializes the stable Endpoint",
  () =>
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync("/tmp/nodex-daemon-")),
        (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
      );
      mkdirSync(join(home, "app-server-control"));
      const command = join(home, "codex");
      writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' '{\"appServerVersion\":\"0.153.4\"}'\n", {
        mode: 0o755,
      });
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (server) =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
          }),
      );
      const peers = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocketServer({ server })),
        (peers) =>
          Effect.sync(() => {
            for (const peer of peers.clients) peer.terminate();
            peers.close();
          }),
      );
      let connections = 0;
      const methods: string[] = [];
      const pendingObserved = yield* Deferred.make<void>();
      peers.on("connection", (peer) => {
        const generation = ++connections;
        peer.on("message", (data) => {
          const request = JSON.parse(String(data)) as { id?: string; method: string };
          methods.push(request.method);
          if (request.method === "test/pending") {
            Deferred.doneUnsafe(pendingObserved, Effect.void);
            return;
          }
          if (request.id === undefined) return;
          const result =
            request.method === "initialize"
              ? {
                  codexHome: home,
                  platformFamily: "unix",
                  platformOs: "macos",
                  userAgent: "physical-daemon",
                }
              : { connected: true, generation };
          peer.send(JSON.stringify({ id: request.id, result }));
        });
      });
      yield* Effect.callback<void>((resume) => {
        server.once("error", (error) => resume(Effect.die(error)));
        server.listen(join(home, "app-server-control", "app-server-control.sock"), () =>
          resume(Effect.void),
        );
      });
      const endpointScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(endpointScope, Exit.void));
      const context = yield* Layer.buildWithScope(
        endpointLive({
          hostId: "local",
          retryBase: "5 millis",
          retryCap: "5 millis",
          jitter: false,
          sessionLayer: (generation) =>
            sessionLive({
              hostId: "local",
              generation,
              command,
              args: ["app-server"],
              localDaemon: { codexHome: home, platform: "darwin", configOverrides: [] },
              env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
              forceTermination: "1 second",
              initializeTimeout: "5 seconds",
              expectedCodexHome: home,
              initializeParams: {
                clientInfo: { name: "nodex", title: "Nodex", version: "test" },
                capabilities: { experimentalApi: true },
              },
            }),
        }).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              nodeLive,
              eventHubLive,
              schedulerLive,
              Layer.effect(CodexApplicationRequestInbox, makeInbox),
            ),
          ),
        ),
        endpointScope,
      );
      const endpoint = Context.get(context, CodexEndpoint);
      const first = yield* endpoint.session.pipe(Effect.timeout("5 seconds"));
      expect(first.transportKind).toBe("websocket");
      expect(yield* first.client.raw.request("test/native", {})).toEqual({
        connected: true,
        generation: 1,
      });
      const source = (yield* SubscriptionRef.get(endpoint.state)).source;
      const pending = yield* first.client.raw
        .request("test/pending", {})
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(pendingObserved).pipe(Effect.timeout("5 seconds"));
      yield* Effect.sync(() => {
        for (const peer of peers.clients) peer.terminate();
      });
      expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
      yield* SubscriptionRef.changes(endpoint.state).pipe(
        Stream.filter((state) => state.kind === "ready" && state.generation > first.generation),
        Stream.runHead,
        Effect.timeout("5 seconds"),
      );
      const second = yield* endpoint.session;
      expect(second.generation).toBe(first.generation + 1);
      expect(second.transportKind).toBe("websocket");
      expect((yield* SubscriptionRef.get(endpoint.state)).source).toEqual(source);
      expect(yield* second.client.raw.request("test/native", {})).toEqual({
        connected: true,
        generation: 2,
      });
      expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
      expect(methods.filter((method) => method === "initialized")).toHaveLength(2);
      yield* Scope.close(endpointScope, Exit.void);
      expect((yield* SubscriptionRef.get(endpoint.state)).kind).toBe("stopped");
      expect(connections).toBe(2);
    }),
);

it.effect(
  "local daemon eligibility honors overrides and probe failures fall back without opening a socket",
  () =>
    Effect.gen(function* () {
      const config = { codexHome: "/unused", platform: "darwin", configOverrides: [] };
      expect(canUseCodexLocalDaemon(config, {})).toBe(false);
      expect(canUseCodexLocalDaemon(config, { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" })).toBe(true);
      expect(
        canUseCodexLocalDaemon(
          { ...config, configOverrides: ["-c", "model=x"] },
          { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
        ),
      ).toBe(false);
      expect(
        canUseCodexLocalDaemon(config, {
          CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1",
          CODEX_APP_SERVER_FORCE_CLI: "1",
        }),
      ).toBe(false);
      const result = yield* openCodexLocalDaemon({
        config,
        command: "codex",
        env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
        hostId: "local",
        generation: 1,
        probe: () => Effect.succeed({ appServerVersion: "0.140.9" }),
      });
      expect(result).toBeUndefined();
      expect(parseCodexCliVersion("codex-cli 0.141.0-alpha.1\n")).toBe("0.141.0-alpha.1");
      expect(isSupportedCodexAppServerVersion("0.141.0-alpha.1")).toBe(false);
      expect(isSupportedCodexAppServerVersion("0.0.0")).toBe(true);
    }),
);
