import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import type * as Compat from "effect-acp/compat";
import * as Queue from "effect/Queue";
import * as AcpClient from "effect-acp/client";
import { makeInMemoryStdio } from "../../vendor/effect-acp/src/_internal/stdio.ts";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";

const peer = Effect.gen(function* () {
  const { stdio, input, output } = yield* makeInMemoryStdio();
  const client = yield* AcpClient.make(stdio);
  const respond = (result: unknown) =>
    Effect.gen(function* () {
      const request = JSON.parse(yield* Queue.take(output)) as { id: string; method: string };
      yield* Queue.offer(
        input,
        new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"),
      );
      return request.method;
    });
  return {
    client,
    respond,
    notify: (params: unknown) =>
      Queue.offer(
        input,
        new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n",
        ),
      ),
  };
});

it.effect(
  "identifies the negotiated wire generation from response shape, including numeric v1 version 2",
  () =>
    Effect.gen(function* () {
      for (const generation of [1, 2] as const) {
        const { client, respond } = yield* peer;
        assert.equal(yield* client.protocolGeneration, undefined);
        const initialized = yield* client.agent
          .initialize({ protocolVersion: 2 })
          .pipe(Effect.forkScoped);
        yield* respond(
          generation === 1
            ? {
                protocolVersion: 2,
                agentCapabilities: {},
                agentInfo: { name: "legacy", version: "1" },
              }
            : { protocolVersion: 2, capabilities: {}, info: { name: "native", version: "2" } },
        );
        assert.equal((yield* Fiber.join(initialized)).protocolVersion, 2);
        assert.equal(yield* client.protocolGeneration, generation);
        const auth = yield* client.agent
          .authenticate({ methodId: "login" })
          .pipe(Effect.forkScoped);
        assert.equal(yield* respond({}), generation === 1 ? "authenticate" : "auth/login");
        yield* Fiber.join(auth);
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "filters malformed known v2 configuration without crashing model selection or losing valid options",
  () =>
    Effect.gen(function* () {
      const { client, respond } = yield* peer;
      const initialized = yield* client.agent
        .initialize({ protocolVersion: 2 })
        .pipe(Effect.forkScoped);
      yield* respond({
        protocolVersion: 2,
        capabilities: {},
        info: { name: "native", version: "2" },
      });
      yield* Fiber.join(initialized);
      const created = yield* client.agent
        .createSession({ cwd: process.cwd(), mcpServers: [] })
        .pipe(Effect.forkScoped);
      yield* respond({
        sessionId: "config-session",
        configOptions: [
          { configId: "future", name: "Future type", type: "future-kind", arbitrary: true },
          {
            configId: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "fast",
            options: [{ value: "fast", name: "Fast" }],
          },
          { configId: "auto", name: "Auto", type: "boolean", currentValue: true },
        ],
      });
      const session = yield* Fiber.join(created);
      assert.equal(findModelConfigOption(session.configOptions)?.id, "model");
      assert.deepEqual(
        session.configOptions?.map((option) => option.id),
        ["model", "auto"],
      );
      assert.deepEqual(
        acpProviderOptionDescriptors({
          configOptions: session.configOptions,
          modeState: undefined,
        }),
        [{ id: "auto", label: "Auto", type: "boolean", currentValue: true }],
      );
      // A whole legacy-shaped response can pass the negotiated RPC's open union.
      // It must not become a v2 option with an undefined id.
      const malformed = yield* client.agent
        .createSession({ cwd: process.cwd(), mcpServers: [] })
        .pipe(Effect.forkScoped);
      yield* respond({
        sessionId: "legacy-config-session",
        configOptions: [
          {
            id: "missing-config-id",
            name: "Broken",
            type: "select",
            category: "model",
            currentValue: "a",
            options: [],
          },
        ],
      });
      assert.deepEqual((yield* Fiber.join(malformed)).configOptions, []);
      const configured = yield* client.agent
        .setSessionConfigOption({
          sessionId: session.sessionId,
          configId: "auto",
          type: "boolean",
          value: false,
        })
        .pipe(Effect.forkScoped);
      assert.equal(yield* respond({ configOptions: [] }), "session/set_config_option");
      yield* Fiber.join(configured);
    }).pipe(Effect.scoped),
);

it.effect("preserves native idle failure details through the wire normalization boundary", () =>
  Effect.gen(function* () {
    const { client, respond, notify } = yield* peer;
    const initialized = yield* client.agent
      .initialize({ protocolVersion: 2 })
      .pipe(Effect.forkScoped);
    yield* respond({
      protocolVersion: 2,
      capabilities: {},
      info: { name: "native", version: "2" },
    });
    yield* Fiber.join(initialized);
    const received = yield* Deferred.make<Compat.SessionNotification>();
    yield* client.handleSessionUpdate((notification) =>
      Deferred.succeed(received, notification).pipe(Effect.asVoid),
    );
    yield* notify({
      sessionId: "native-work",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: { code: -32603, message: "Native failure" },
      },
    });
    const result = yield* Deferred.await(received);
    assert.deepEqual(result.update, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32603, message: "Native failure" },
    });
  }).pipe(Effect.scoped),
);
