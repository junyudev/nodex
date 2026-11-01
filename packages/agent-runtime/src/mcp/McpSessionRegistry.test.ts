import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { __testing } from "./McpSessionRegistry.ts";

it.effect("retains the host-registered tool inventory with a provider credential", () =>
  Effect.gen(function* () {
    const registry = yield* __testing.make({ registeredToolNames: ["read_page", "delegate_task"] });
    const credential = yield* registry.issue({
      threadId: ThreadId.make("thread"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    assert.deepEqual(credential.config.registeredToolNames, ["read_page", "delegate_task"]);
  }).pipe(
    Effect.provideService(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    Effect.provideService(ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
    }),
    Effect.provide(NodeServices.layer),
  ),
);
