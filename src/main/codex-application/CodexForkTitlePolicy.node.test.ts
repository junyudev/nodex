import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import {
  CODEX_FORK_TITLE_CATALOG_DEADLINE,
  CODEX_FORK_TITLE_MAX_PAGES,
  make,
} from "./CodexForkTitlePolicy";

const source = {
  threadId: "thread-source",
  projectId: "project-a",
  forkedFromId: null,
  threadName: "Plan work",
  canonical: { turns: [] } as unknown as CodexCanonicalConversationState,
};

const taskWindow = (
  items: readonly {
    readonly session: Record<string, never>;
    readonly thread: {
      readonly thread_id: string;
      readonly forked_from_id: string | null;
      readonly thread_name: string | null;
    };
  }[],
  nextCursor: string | null,
) =>
  ({
    value: {
      kind: "task_window",
      tasks: {
        items,
        next_cursor: nextCursor,
        authority: { projection_revision: 1 },
      },
    },
  }) as unknown as ProjectWorkspaceReadSnapshot;

const task = (threadId: string, title: string | null, forkedFromId: string | null = null) => ({
  session: {},
  thread: {
    thread_id: threadId,
    forked_from_id: forkedFromId,
    thread_name: title,
  },
});

const policy = (
  read: (request: {
    readonly kind: string;
    readonly window?: { readonly after: string | null };
  }) => Effect.Effect<ProjectWorkspaceReadSnapshot>,
) =>
  make.pipe(
    Effect.provideService(
      CoreModules,
      CoreModules.of({ workspace: { read } } as unknown as CoreModuleClients),
    ),
  );

it.effect("derives a sibling suffix from a complete bounded catalog", () =>
  Effect.gen(function* () {
    const runtime = yield* policy(() =>
      Effect.succeed(
        taskWindow(
          [
            task("thread-source", "Plan work"),
            task("thread-child", "Plan work (2)", "thread-source"),
          ],
          null,
        ),
      ),
    );
    const result = yield* runtime.derive(source);

    assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: "Plan work (3)" });
  }),
);

it.effect("stops at the catalog page budget and does not block a fork for a cosmetic title", () =>
  Effect.gen(function* () {
    let calls = 0;
    const runtime = yield* policy(() =>
      Effect.sync(() => {
        calls += 1;
        return taskWindow([task(`thread-${calls}`, "Plan work")], `cursor-${calls}`);
      }),
    );
    const result = yield* runtime.derive(source);

    assert.strictEqual(calls, CODEX_FORK_TITLE_MAX_PAGES);
    assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: null });
  }),
);

it.effect("drops only the child title when a single catalog page exceeds its byte budget", () =>
  Effect.gen(function* () {
    let calls = 0;
    const runtime = yield* policy(() =>
      Effect.sync(() => {
        calls += 1;
        return taskWindow([task("thread-large", "x".repeat(3 * 1024 * 1024))], null);
      }),
    );
    const result = yield* runtime.derive(source);

    assert.strictEqual(calls, 1);
    assert.deepEqual(result, { sourceTitle: "Plan work", childTitle: null });
  }),
);

it.effect("keeps the local source title when the complete catalog misses its 250 ms budget", () =>
  Effect.gen(function* () {
    const runtime = yield* policy(() => Effect.never);
    const pending = yield* Effect.forkChild(runtime.derive(source));

    yield* TestClock.adjust(CODEX_FORK_TITLE_CATALOG_DEADLINE);

    assert.deepEqual(yield* Fiber.join(pending), { sourceTitle: "Plan work", childTitle: null });
  }),
);
