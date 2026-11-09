import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import type { components } from "@nodex/core-protocol";
import {
  GitHubSourceAdapter,
  SourceReadError,
  type PollInput,
  type PollResult,
  type Position,
  type Source,
} from "./GitHubSourceAdapter";
import { make, sourceBackoff } from "./SourceSupervisor";
type Model = components["schemas"];
const repository = { id: "10", name: "alice/repo", enabled: true };
function harness(
  now: number,
  poll: (input: PollInput) => Effect.Effect<PollResult, SourceReadError>,
) {
  const source: Source = {
    id: "source",
    library_id: "library",
    kind: "github",
    revision: 1,
    enabled: true,
    enabled_at_ms: now - 10000,
    config: {
      host: "github.com",
      account_id: "1",
      account_login: "alice",
      credential_ref: "gh:github.com:alice",
      repositories: [repository],
      discovery: { assigned: true, review_requests: true, mentions: true },
    },
  };
  let position: Position = {
    source_id: source.id,
    partition: "repo:10",
    revision: 4,
    baseline: true,
    cursor: {
      baseline_at_ms: now - 10000,
      watermark_ms: now - 5000,
      validators: { etag: "old" },
      continuation: null,
    },
    next_poll_at_ms: 0,
    consecutive_failures: 0,
  };
  const commands: Model["SourceCommand"][] = [];
  const inputs: PollInput[] = [];
  const core = {
    workspace: {
        Effect.sync(() => {
          if (request.kind === "page_workspace_window")
            return { value: { kind: "page_workspace_window", workspaces: [] } };
          if (request.kind !== "sources") throw new Error("Unexpected read");
          const read = request.read;
          let value: Model["SourceReadValue"];
          switch (read.kind) {
            case "sources":
              value = { kind: "sources", sources: [source] };
              break;
            case "positions":
              value = { kind: "positions", positions: [position] };
              break;
            case "threads":
              value = {
                kind: "threads",
                threads: [
                  {
                    id: "github:github.com:10:7",
                    host: "github.com",
                    repository_id: "10",
                    repository: "alice/repo",
                    number: 7,
                    kind: "pull_request",
                    url: "https://github.com/alice/repo/pull/7",
                    title: "Work",
                    state: "open",
                    observation_revision: 4,
                    observations: { "check:1": { fingerprint: "failure", revision: 2 } },
                  },
                ],
              };
              break;
            case "event_automation_watching":
              value = { kind: "event_automation_watching", enabled: false };
              break;
            case "known_pull_requests":
              value = { kind: "known_pull_requests", pull_requests: [] };
              break;
            case "open_problems":
              value = { kind: "open_problems", problems: [] };
              break;
            default:
              throw new Error("Unexpected Source read");
          }
          return { value: { kind: "sources", value } };
        }),
      apply: ({ intent }: { intent: Model["ProjectWorkspaceIntent"] }) =>
        Effect.sync(() => {
          if (intent.kind !== "source") throw new Error("Unexpected intent");
          const command = intent.command;
          commands.push(command);
          if (command.kind === "claim_source_partition")
            position = {
              ...position,
              lease_token: command.lease_token,
              lease_expires_at_ms: now + 120000,
            };
          if (command.kind === "ingest_source_batch")
            position = {
              ...position,
              cursor: command.next_position,
              revision: position.revision + 1,
              next_poll_at_ms: command.next_poll_at_ms,
            };
          if (command.kind === "record_source_failure")
            position = {
              ...position,
              consecutive_failures: position.consecutive_failures + 1,
              next_poll_at_ms: command.retry_at_ms,
            };
          return {};
        }),
    },
  } as unknown as CoreModules["Service"];
  const adapter = GitHubSourceAdapter.of({
    poll: (input) => {
      inputs.push(input);
      return poll(input);
    },
    verify: () => Effect.succeed({ login: "alice", id: "1" }),
    repository: () => Effect.succeed(repository),
    verifyThread: () => Effect.fail(new SourceReadError({ reason: "unused" })),
  });
  const service = make.pipe(
    Effect.provideService(CoreModules, core),
    Effect.provideService(GitHubSourceAdapter, adapter),
    Effect.provideService(
      CodexGitProbe,
      CodexGitProbe.of({
        readPath: () => Effect.succeed(null),
        isNonGitWorkspace: () => Effect.succeed(true),
        isNonGitWorkspaceOnHost: () => Effect.succeed(true),
      }),
    ),
  );
  return {
    service,
    commands,
    inputs,
    position: () => position,
    due: () => {
      position = { ...position, next_poll_at_ms: 0 };
    },
  };
}
const result = (input: PollInput): PollResult => ({
  threads: [],
  triggers: [],
  cursor: { ...input.position.cursor, watermark_ms: input.nowMs },
  delayMs: 180000,
  quarantine: [],
});
describe("Source supervisor", () => {
  it.effect("resumes saved positions after restart and honors the server polling floor", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const f = harness(now, (input) => Effect.succeed(result(input)));
      const first = yield* f.service;
      yield* first.sweep;
      expect(f.inputs[0]?.position.revision).toBe(4);
      expect(f.inputs[0]?.known[0]?.observations["check:1"]?.revision).toBe(2);
      expect(f.position().revision).toBe(5);
      expect(f.position().next_poll_at_ms).toBe(now + 180000);
      const restarted = yield* f.service;
      yield* restarted.sweep;
      expect(f.inputs).toHaveLength(1);
      f.due();
      yield* restarted.sweep;
      expect(f.inputs[1]?.position.revision).toBe(5);
      expect(f.inputs[1]?.position.cursor.watermark_ms).toBe(now);
    }),
  );
  it.effect(
    "records credential failures without advancing and retains consecutive attempts across restart",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const f = harness(now, () => Effect.fail(new SourceReadError({ reason: "credential" })));
        for (let i = 0; i < 3; i++) {
          const service = yield* f.service;
          f.due();
          yield* service.sweep;
        }
        expect(f.commands.filter((c) => c.kind === "record_source_failure")).toHaveLength(3);
        expect(f.position().consecutive_failures).toBe(3);
        expect(f.position().revision).toBe(4);
        expect(f.commands.some((c) => c.kind === "ingest_source_batch")).toBe(false);
        expect(f.position().next_poll_at_ms).toBeGreaterThanOrEqual(now + 240000);
      }),
  );
  it.effect(
    "interrupts an outstanding network read on shutdown without advancing its position",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let aborted = false;
        const now = yield* Clock.currentTimeMillis;
        const f = harness(now, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: (signal) =>
                  // @effect-diagnostics-next-line newPromise:off -- Models the network AbortSignal boundary while the test clock owns the supervisor.
                  new Promise<PollResult>(() => {
                    signal.addEventListener(
                      "abort",
                      () => {
                        aborted = true;
                      },
                      { once: true },
                    );
                  }),
                catch: () => new SourceReadError({ reason: "aborted" }),
              }),
            ),
          ),
        );
        const supervisor = yield* f.service;
        const fiber = yield* Effect.forkChild(supervisor.sweep);
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        expect(aborted).toBe(true);
        expect(f.position().revision).toBe(4);
        expect(
          f.commands.some(
            (c) => c.kind === "record_source_failure" || c.kind === "ingest_source_batch",
          ),
        ).toBe(false);
      }),
  );
  it.effect("lets a person disable a Source while a network read is outstanding", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<PollResult>();
      const now = yield* Clock.currentTimeMillis;
      const f = harness(now, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(pending))),
      );
      const service = yield* f.service;
      const polling = yield* Effect.forkChild(service.sweep);
      yield* Deferred.await(started);
      yield* service.update({
        sourceId: "source",
        expectedRevision: 1,
        enabled: false,
        repositories: [{ id: "10", enabled: true }],
        discovery: { assigned: true, review_requests: true, mentions: true },
      });
      expect(
        f.commands.some((command) => command.kind === "configure_source" && !command.enabled),
      ).toBe(true);
      yield* Fiber.interrupt(polling);
    }),
  );
  it.effect("retains rate-limit retry deadlines on failed reads", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const f = harness(now, () =>
        Effect.fail(new SourceReadError({ reason: "github_read", retryAtMs: now + 600000 })),
      );
      const service = yield* f.service;
      yield* service.sweep;
      expect(f.position().next_poll_at_ms).toBe(now + 600000);
      expect(sourceBackoff(1, 0)).toBe(60000);
    }),
  );
});
