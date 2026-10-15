import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { make, type WorkbenchContentSurface } from "./WorkbenchContentRouting";

const authority: NodexAgentTurnContext = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project:caller",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};
const page: WorkbenchContentSurface = {
  id: "surface",
  kind: "page_stage",
  titleSnapshot: "Stale",
  config: {
    routingContext: { kind: "project", projectId: "project:other" },
    pageId: "page:target",
  },
};
const setup = (read: CoreModules["Service"]["library"]["read"]) =>
  make.pipe(
    Effect.provideService(CoreModules, { library: { read } } as never),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
  );
it.effect(
  "reads a cross-Project surface using exact Profile execution and canonical metadata",
  () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const owner = yield* setup((read, _options, projectId) => {
        requests.push({ read, projectId });
        return Effect.succeed({
          value: {
            kind: "agent_surface_description",
            value: {
              status: "available",
              kind: "page",
              page_id: "page:target",
              title: "Current",
              library_id: "library",
              displayed_routing_context: page.config.routingContext,
            },
          },
        } as never);
      });
      assert.deepEqual(yield* owner.describe({ authority, callId: "call", surface: page }), {
        status: "available",
        kind: "page",
        pageId: "page:target",
        title: "Current",
        libraryId: "library",
        displayedRoutingContext: page.config.routingContext,
      });
      assert.deepEqual(requests, [
        {
          projectId: "project:caller",
          read: {
            kind: "agent_surface_description",
            target: { kind: "page", page_id: "page:target" },
            displayed_routing_context: page.config.routingContext,
            authorization: {
              call_id: "call",
              provenance: {
                profile_id: "profile",
                authority: {
                  thread_id: "thread",
                  turn_id: "turn",
                  root_thread_id: "thread",
                  actor_project_id: "project:caller",
                  library_id: "library",
                  store_epoch: "epoch",
                },
              },
            },
          },
        },
      ]);
    }),
);
it.effect("missing surfaces and disconnected Core return structural unavailability", () =>
  Effect.gen(function* () {
    for (const read of [
      () =>
        Effect.succeed({
          value: { kind: "agent_surface_description", value: { status: "unavailable" } },
        } as never),
      () => Effect.fail(new Error("Core disconnected")),
    ] as unknown as CoreModules["Service"]["library"]["read"][]) {
      const owner = yield* setup(read);
      assert.deepEqual(yield* owner.describe({ authority, callId: "call", surface: page }), {
        status: "unavailable",
      });
    }
  }),
);
