import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { CodexThreadOwnerServerRequest } from "../../shared/types";
import {
  make,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";

const checkpoint = (revision = 0, ownerEpoch = 1) => ({
  protocolVersion: 1 as const,
  ownerEpoch,
  revision,
});

const request = (id: string | number, callId = "call-1"): CodexThreadOwnerServerRequest =>
  ({
    id,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId,
      namespace: "test",
      tool: "test",
      arguments: {},
    },
  }) as CodexThreadOwnerServerRequest;

it("atomically retires ownership, subscriptions, deliveries, and views for a client generation", () => {
  const runtime = makeCodexRendererConversationRegistryState({ now: () => 100 });
  runtime.handleClientConnected("owner-a");
  assert.isNotNull(runtime.setOwner("thread-1", "owner-a"));
  assert.isTrue(runtime.setViewActive("thread-1", "owner-a", true).accepted);
  assert.isTrue(runtime.setPresented("thread-1", "owner-a", "surface-1", true).accepted);
  runtime.recordRequestDelivery("thread-1", request(7), "owner-a");

  const disposed = runtime.handleClientDisposed("owner-a");

  assert.deepEqual(disposed.ownerConversationIds, ["thread-1"]);
  assert.deepEqual(disposed.viewConversationIds, ["thread-1"]);
  assert.isNull(runtime.getOwnerClientId("thread-1"));
  assert.isTrue(runtime.hasDetachedOwner("thread-1"));
  assert.isFalse(runtime.hasActiveView("thread-1"));
  assert.isNull(runtime.resolvePresentedSurfaceClient("thread-1"));
  assert.isFalse(runtime.hasRequestDelivery("thread-1", request(7), "owner-a"));
  assert.isNull(runtime.setOwner("thread-1", "owner-a"));
  assert.isFalse(runtime.setViewActive("thread-1", "owner-a", true).accepted);
  assert.isFalse(runtime.setPresented("thread-1", "owner-a", "late-surface", true).accepted);
});

it("replaces owner generations, re-fences followers, and scopes delivery ids by scalar type", () => {
  const runtime = makeCodexRendererConversationRegistryState();
  for (const clientId of ["owner-a", "owner-b", "follower"]) {
    runtime.handleClientConnected(clientId);
  }
  runtime.setOwner("thread-1", "owner-a");
  const following = runtime.setFollowing("thread-1", "follower", true);
  assert.isNotNull(following);
  assert.isTrue(runtime.markSnapshotSent("thread-1", "follower", checkpoint()));
  assert.isTrue(
    runtime.acknowledgeSnapshotApplied({
      conversationId: "thread-1",
      clientId: "follower",
      ownerClientId: "owner-a",
      checkpoint: checkpoint(),
      currentCheckpoint: checkpoint(),
    })?.accepted,
  );
  runtime.recordRequestDelivery("thread-1", request(7), "owner-a");
  runtime.recordRequestDelivery("thread-1", request("7"), "owner-a");
  runtime.clearRequestDelivery("thread-1", 7);
  assert.isFalse(runtime.hasRequestDelivery("thread-1", request(7), "owner-a"));
  assert.isTrue(runtime.hasRequestDelivery("thread-1", request("7"), "owner-a"));

  const replaced = runtime.setOwner("thread-1", "owner-b");

  assert.strictEqual(replaced?.previousOwnerClientId, "owner-a");
  assert.strictEqual(replaced?.ownerEpoch, 2);
  assert.deepEqual(replaced?.snapshotClientIds, ["follower"]);
  assert.deepEqual(runtime.getFollowerClientIds("thread-1"), []);
  assert.deepEqual(runtime.getSnapshotClientIds("thread-1"), ["follower"]);
  assert.isFalse(runtime.hasRequestDelivery("thread-1", request("7"), "owner-a"));
});

it.effect("closes the whole renderer generation with its Main Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runtime = yield* make().pipe(Effect.provideService(Scope.Scope, scope));
    runtime.handleClientConnected("owner-a");
    runtime.setOwner("thread-1", "owner-a");
    runtime.setViewActive("thread-1", "owner-a", true);
    runtime.recordRequestDelivery("thread-1", request(7), "owner-a");

    yield* Scope.close(scope, Exit.void);

    assert.isNull(runtime.getOwnerClientId("thread-1"));
    assert.isFalse(runtime.hasActiveView("thread-1"));
    assert.isFalse(runtime.hasRequestDelivery("thread-1", request(7), "owner-a"));
    assert.isTrue(runtime.isClientDisposed("new-client"));
    assert.isNull(runtime.setOwner("thread-1", "new-client"));
    assert.isFalse(runtime.setViewActive("thread-1", "new-client", true).accepted);
  }),
);
