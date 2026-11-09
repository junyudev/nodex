import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { components } from "@nodex/core-protocol";
import { ManagedChatFacts } from "./ManagedChatFacts";
import { make } from "./CoordinatorMonitor";
import {
  MANAGED_CHAT_STALL_MS,
  type ManagedChatFacts as Facts,
  unavailableManagedChatFacts,
} from "./managed-chat-observation";
const working: Facts = {
  state: "working",
  runId: "run:1",
  runStartedAt: 0,
  terminalStatus: null,
  pendingRequests: [],
};
        }),
        ...working,
      yield* monitor.sweep;
      yield* monitor.sweep;
      yield* monitor.sweep;
      yield* monitor.sweep;
      assert.deepEqual(
      );
);
  Effect.gen(function* () {
    };
    yield* monitor.sweep;
  }),
);
);
