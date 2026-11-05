import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi, type Mock } from "vitest";
import {
  DEFAULT_INBOX_SETTINGS,
  LIBRARY_INBOX,
  projectInbox,
  type InboxSettings,
  type InboxSuggestionMode,
} from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";
import { NativePromptImages } from "../agent-backend/NativePromptImages";
import { LibraryModule } from "../library-application/LibraryModule";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { testLayer as configLayer } from "../app/MainConfig";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModuleResponseError } from "../core-client/core-client";
import { subscribeToBackendLogs, type BackendLogEntry } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication, InboxApplicationError } from "./InboxApplication";
import {
  captureInbox,
  inboxOverRealCore,
  suggestionHostLayer,
} from "./InboxApplication.test-support";
import { make } from "./InboxDispatcher";

type Runtime = AgentRuntimeApplication["Service"];
type Provider = Effect.Success<ReturnType<Runtime["catalog"]>>[number];
type Mode = InboxSuggestionMode | "paused";

const generationInput = (input: Parameters<Runtime["generateStructured"]>[0]) =>
  JSON.parse(input.prompt.split("JSON data:\n")[1]!) as {
    request: { request_id: string; generation: number };
    messages: { page_id: string }[];
  };

const harness = Effect.fn("InboxDispatcher.testHarness")(function* (mode: Mode) {
  const now = yield* Clock.currentTimeMillis;
  let current: InboxSettings = {
    ...DEFAULT_INBOX_SETTINGS,
    suggestions: mode === "paused" ? "automatic" : mode,
    // Small enough that a test fills every lane in a few lines.
    suggestionConcurrency: 3,
  };
  const suggestionAgent: Provider = {
    instanceId: "codex",
    displayName: "Codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(now).toISOString(),
    models: [
      { slug: "default", name: "Default", isDefault: true, isCustom: false, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
  };
  // Spending faster than the week and nearly gone: automatic advice yields.
  const tight: Provider["usageLimits"] = {
    checkedAt: new Date(now).toISOString(),
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 94,
        resetsAt: new Date(now + 130 * 3_600_000).toISOString(),
        windowDurationMins: 7 * 24 * 60,
      },
    ],
  };
  let providers: Provider[] = [
    { ...suggestionAgent, usageLimits: mode === "paused" ? tight : undefined },
  ];
  const catalog = vi.fn<Runtime["catalog"]>(() => Effect.sync(() => providers));
  const generated = vi.fn<Runtime["generateStructured"]>((input) => {
    const data = generationInput(input);
    return Effect.succeed({
      request_id: data.request.request_id,
      generation: data.request.generation,
      titles: [],
      suggestions: data.messages.map(({ page_id }) => ({
        page_ids: [page_id],
        kind: "note",
        action: "keep",
        project_id: null,
        session_id: null,
        prompt: null,
        chat_instance_id: null,
        chat_model: null,
        chat_effort: null,
        additions: [],
        summary: "Keep this reference",
        rationale: null,
      })),
    });
  });
  const { inbox, client, projectId } = yield* inboxOverRealCore(
    Effect.void,
    catalog,
    () => current,
  );
  // Source directories that exist on this machine; every other path is missing.
  const directories = new Set<string>();
  const dispatcher = yield* make.pipe(
    Effect.provideService(LibraryModule, {
      readFileBlob: () => Effect.die("Text-only suggestions must not read image files"),
    } as unknown as LibraryModule["Service"]),
    Effect.provideService(NativePromptImages, {
      validate: () => Effect.die("Text-only suggestions must not decode images"),
      fit: () => Effect.die("Text-only suggestions must not fit images"),
    } as unknown as NativePromptImages["Service"]),
    Effect.provideService(InboxApplication, inbox),
    Effect.provideService(ApplicationSettings, {
      snapshot: () => Effect.sync(() => ({ inbox: current })),
    } as unknown as ApplicationSettings["Service"]),
    Effect.provideService(AgentRuntimeApplication, {
      catalog,
      generateStructured: generated,
    } as unknown as Runtime),
    Effect.provide(suggestionHostLayer(directories)),
    Effect.provide(configLayer({ nodexHome: "/profiles/inbox" })),
  );
  const item = Effect.fn("InboxDispatcher.testItem")(function* (pageId: string) {
    const window = yield* inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" });
    const entry = window.items.find((candidate) => candidate.pageId === pageId);
    if (!entry) return assert.fail("Missing captured message");
    return entry;
  });
  const request = Effect.fn("InboxDispatcher.testRequest")(function* (pageId: string) {
    const entry = yield* item(pageId);
    return yield* inbox.requestSuggestion({
      requestId: createUuidV7(),
      mode: "auto",
      pageIds: [pageId],
      basis: [entry.basis],
    });
  });
  return {
    inbox,
    ...dispatcher,
    generated,
    catalog,
    item,
    request,
    projectId,
    client,
    directories,
    setMode: (suggestions: InboxSuggestionMode) => {
      current = { ...current, suggestions };
    },
    setConcurrency: (suggestionConcurrency: number) => {
      current = { ...current, suggestionConcurrency };
    },
    setTight: (paused: boolean) => {
      providers = [{ ...suggestionAgent, usageLimits: paused ? tight : undefined }];
    },
  };
});

const holdNextGeneration = Effect.fnUntraced(function* (
  generated: Mock<Runtime["generateStructured"]>,
) {
  const started = yield* Deferred.make<ReturnType<typeof generationInput>>();
  const resume = yield* Deferred.make<void, AgentRuntimeApplicationError>();
  const interrupted = yield* Deferred.make<void>();
  const generate = generated.getMockImplementation();
  if (!generate) return assert.fail("Missing generation implementation");
  generated.mockImplementationOnce((input) =>
    Deferred.succeed(started, generationInput(input)).pipe(
      Effect.andThen(Deferred.await(resume)),
      Effect.andThen(() => generate(input)),
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    ),
  );
  return { started, resume, interrupted };
});

it.effect.each(["automatic", "on_request", "paused", "off"] as const)(
  "handles captured messages and explicit advice under %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox, drain, generated, catalog, item, request } = yield* harness(mode);
        const { pageId } = yield* captureInbox(inbox, "Save these reference details");
        assert.strictEqual((yield* item(pageId)).suggestionState, "waiting");
        yield* drain;
        assert.strictEqual(generated.mock.calls.length, mode === "automatic" ? 1 : 0);
        assert.strictEqual(
          (yield* item(pageId)).suggestionState,
          mode === "automatic" ? "settled" : "none",
        );

        const requested = yield* request(pageId).pipe(Effect.result);
        if (mode === "off") {
          assert.strictEqual(requested._tag, "Failure");
          if (requested._tag === "Failure")
            assert.strictEqual(requested.failure.message, "Inbox suggestions are off");
          assert.deepEqual(yield* inbox.suggestionRequests(8), []);
        } else {
          assert.strictEqual(requested._tag, "Success");
        }
        yield* drain;
        assert.strictEqual(
          generated.mock.calls.length,
          mode === "automatic" ? 2 : mode === "off" ? 0 : 1,
        );
        if (mode !== "off")
          assert.deepEqual((yield* item(pageId)).proposal?.action, { type: "keep" });
        // Catalog reads never request provider discovery or refresh.
        assert.isTrue(catalog.mock.calls.every((args) => args.length === 0));
      }),
    ),
);

it.effect.each(["off", "paused"] as const)(
  "stops automatic spending when the policy becomes %s during generation",
  (policy) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { inbox, drain, generated, item, request, setMode, setTight } =
          yield* harness("automatic");
        const started = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const generate = generated.getMockImplementation();
        if (!generate) return assert.fail("Missing generation implementation");
        generated.mockImplementationOnce((input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(resume);
            return yield* generate(input);
          }),
        );
        const first = yield* captureInbox(inbox, "The first message");
        const running = yield* drain.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        if (policy === "off") setMode("off");
        else setTight(true);
        const later = yield* captureInbox(inbox, "A message sent after the policy changes");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(running);

        assert.strictEqual(generated.mock.calls.length, 1);
        assert.strictEqual((yield* item(first.pageId)).suggestionState, "settled");
        assert.strictEqual((yield* item(later.pageId)).suggestionState, "none");
        assert.deepEqual(yield* inbox.suggestionRequests(8), []);
        if (policy === "off") {
          const refused = yield* request(later.pageId).pipe(Effect.result);
          assert.strictEqual(refused._tag, "Failure");
          return;
        }
        // A usage pause still admits the user's explicit choice.
        yield* request(later.pageId);
        yield* drain;
        assert.strictEqual(generated.mock.calls.length, 2);
        assert.strictEqual((yield* item(later.pageId)).suggestionState, "settled");
      }),
    ),
);

it.effect("rechecks Off after reading a request and before admitting generation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, drain, generated, item, setMode } = yield* harness("automatic");
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const suggestionRequests = inbox.suggestionRequests;
      const requests = vi.spyOn(inbox, "suggestionRequests").mockImplementationOnce((limit) =>
        suggestionRequests(limit).pipe(
          Effect.tap(() => Deferred.succeed(reading, undefined)),
          Effect.tap(() => Deferred.await(resume)),
        ),
      );
      yield* captureInbox(inbox, "A message awaiting admission");
      try {
        const running = yield* drain.pipe(Effect.forkScoped);
        yield* Deferred.await(reading);
        setMode("off");
        const later = yield* captureInbox(inbox, "A message sent while admission is waiting");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(running);
        assert.strictEqual(generated.mock.calls.length, 0);
        assert.strictEqual((yield* item(later.pageId)).suggestionState, "none");
      } finally {
        requests.mockRestore();
      }
    }),
  ),
);

it.effect("does not run a queued explicit request after suggestions are turned off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, drain, generated, item, request, setMode } = yield* harness("on_request");
      const { pageId } = yield* captureInbox(inbox, "A queued request");
      yield* drain;
      yield* request(pageId);
      const another = yield* captureInbox(inbox, "A later message");
      setMode("off");
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 0);
      assert.strictEqual((yield* item(another.pageId)).suggestionState, "none");
      assert.strictEqual((yield* inbox.suggestionRequests(8)).length, 1);
    }),
  ),
);

it.effect("resumes only for new sends and logs each usage transition once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: BackendLogEntry[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          subscribeToBackendLogs(
            (entry) => {
              if (entry.component === "inbox-dispatcher") logs.push(entry);
            },
            { level: "info" },
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const { inbox, drain, generated, item, setTight } = yield* harness("paused");
      const earlier = yield* captureInbox(inbox, "Earlier private message");
      yield* drain;
      yield* drain;
      setTight(false);
      yield* drain;
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 0);
      assert.strictEqual((yield* item(earlier.pageId)).suggestionState, "none");
      const later = yield* captureInbox(inbox, "Later private message");
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 1);
      assert.strictEqual((yield* item(later.pageId)).suggestionState, "settled");
      const transitions = logs.filter((entry) =>
        /automatic suggestions (paused|resumed)$/.test(entry.msg),
      );
      assert.deepEqual(
        transitions.map((entry) => [entry.level, entry.msg]),
        [
          ["info", "Inbox automatic suggestions paused"],
          ["info", "Inbox automatic suggestions resumed"],
        ],
      );
      assert.notInclude(JSON.stringify(logs), "private message");
    }),
  ),
);

it.effect("looks things up from a Project Inbox's source directory while it exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, drain, generated, projectId, directories } = yield* harness("automatic");
      const suggested = Effect.fn("InboxDispatcher.testSuggested")(function* (
        body: string,
        scope = projectInbox(projectId),
      ) {
        yield* captureInbox(inbox, body, scope);
        yield* drain;
        const call = generated.mock.calls.at(-1);
        if (!call) return assert.fail("No suggestion ran");
        const data = JSON.parse(call[0].prompt.split("JSON data:\n")[1]!) as {
          projects: { project_id: string; sources: string[] }[];
        };
        return { input: call[0], projects: data.projects };
      });

      const missing = yield* suggested("Which module owns the suggestion prompt?");
      const source = missing.projects.find((project) => project.project_id === projectId)
        ?.sources[0];
      if (!source) return assert.fail("The Project's source directory was not offered");
      assert.strictEqual(missing.input.cwd, "/profiles/inbox");
      assert.isTrue(missing.input.webSearch);

      directories.add(source);
      assert.strictEqual((yield* suggested("Where are routing rules tested?")).input.cwd, source);
      assert.strictEqual(
        (yield* suggested("Remember the venue", LIBRARY_INBOX)).input.cwd,
        "/profiles/inbox",
      );
    }),
  ),
);

it.effect("admits later triggers into three lanes and batches waiting messages on refill", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, trigger, drain, generated, item } = yield* harness("automatic");
      const active = yield* Effect.forEach([1, 2, 3], (index) =>
        Effect.gen(function* () {
          const gate = yield* holdNextGeneration(generated);
          const { pageId } = yield* captureInbox(inbox, `Message ${index}`);
          yield* trigger;
          const input = yield* Deferred.await(gate.started);
          assert.deepEqual(
            input.messages.map(({ page_id }) => page_id),
            [pageId],
          );
          // Repeated triggers find the same requests pending in Core.
          yield* trigger;
          yield* trigger;
          assert.strictEqual(generated.mock.calls.length, index);
          return { ...gate, pageId, requestId: input.request.request_id };
        }),
      );
      assert.strictEqual(new Set(active.map(({ requestId }) => requestId)).size, 3);
      assert.deepEqual(
        yield* Effect.forEach(active, ({ pageId }) =>
          item(pageId).pipe(Effect.map((entry) => entry.suggestionState)),
        ),
        ["pending", "pending", "pending"],
      );

      const overflow = yield* Effect.forEach([4, 5, 6], (index) =>
        Effect.gen(function* () {
          const { pageId } = yield* captureInbox(inbox, `Overflow message ${index}`);
          yield* trigger;
          assert.strictEqual((yield* item(pageId)).suggestionState, "waiting");
          return pageId;
        }),
      );
      assert.strictEqual(generated.mock.calls.length, 3);

      const refill = yield* holdNextGeneration(generated);
      yield* Deferred.succeed(active[0]!.resume, undefined);
      const input = yield* Deferred.await(refill.started);
      assert.deepEqual(
        input.messages.map(({ page_id }) => page_id),
        overflow,
      );
      assert.strictEqual((yield* item(active[0]!.pageId)).suggestionState, "settled");
      assert.strictEqual(generated.mock.calls.length, 4);

      yield* Effect.forEach([...active.slice(1), refill], ({ resume }) =>
        Deferred.succeed(resume, undefined),
      );
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 4);
      assert.deepEqual(yield* inbox.suggestionRequests(8), []);
    }),
  ),
);

it.effect("reads the limit at each admission: raising admits, lowering stops nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, trigger, drain, generated, item, setConcurrency } =
        yield* harness("automatic");
      setConcurrency(1);
      const firstGate = yield* holdNextGeneration(generated);
      const first = yield* captureInbox(inbox, "Runs first");
      yield* trigger;
      yield* Deferred.await(firstGate.started);
      const second = yield* captureInbox(inbox, "Waits for a place");
      yield* trigger;
      assert.strictEqual((yield* item(second.pageId)).suggestionState, "waiting");

      setConcurrency(2);
      const secondGate = yield* holdNextGeneration(generated);
      yield* trigger;
      yield* Deferred.await(secondGate.started);
      assert.strictEqual(generated.mock.calls.length, 2);

      // Both keep running under the lower limit; a freed place is not refilled while still over it.
      setConcurrency(1);
      const third = yield* captureInbox(inbox, "Waits under the lower limit");
      yield* trigger;
      yield* Deferred.succeed(firstGate.resume, undefined);
      yield* item(first.pageId).pipe(
        Effect.repeat({ until: (entry) => entry.suggestionState === "settled" }),
      );
      assert.strictEqual((yield* item(third.pageId)).suggestionState, "waiting");
      assert.isFalse(yield* Deferred.isDone(secondGate.interrupted));
      assert.strictEqual(generated.mock.calls.length, 2);

      yield* Deferred.succeed(secondGate.resume, undefined);
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 3);
      assert.strictEqual((yield* item(third.pageId)).suggestionState, "settled");
    }),
  ),
);

it.effect("refills after a generation failure while a hanging lane is still active", () =>
  Effect.gen(function* () {
    const hangingInterrupted = yield* Effect.scoped(
      Effect.gen(function* () {
        const { inbox, trigger, generated, item } = yield* harness("automatic");
        const hanging = yield* holdNextGeneration(generated);
        const first = yield* captureInbox(inbox, "This generation will hang");
        yield* trigger;
        yield* Deferred.await(hanging.started);

        const failing = yield* holdNextGeneration(generated);
        const second = yield* captureInbox(inbox, "This generation will fail");
        yield* trigger;
        yield* Deferred.await(failing.started);

        const refill = yield* holdNextGeneration(generated);
        const third = yield* captureInbox(inbox, "This generation can still settle");
        yield* Deferred.fail(
          failing.resume,
          new AgentRuntimeApplicationError({
            operation: "structured-generation",
            message: "The Agent could not generate a suggestion",
          }),
        );
        const input = yield* Deferred.await(refill.started);
        assert.deepEqual(
          input.messages.map(({ page_id }) => page_id),
          [third.pageId],
        );
        assert.strictEqual((yield* item(second.pageId)).suggestionState, "failed");

        const settled = yield* Deferred.make<void>();
        const settle = inbox.settleSuggestion;
        vi.spyOn(inbox, "settleSuggestion").mockImplementationOnce((settlement) =>
          settle(settlement).pipe(Effect.tap(() => Deferred.succeed(settled, undefined))),
        );
        yield* Deferred.succeed(refill.resume, undefined);
        yield* Deferred.await(settled);
        assert.strictEqual((yield* item(third.pageId)).suggestionState, "settled");
        assert.strictEqual((yield* item(first.pageId)).suggestionState, "pending");
        return hanging.interrupted;
      }),
    );
    assert.isTrue(yield* Deferred.isDone(hangingInterrupted));
  }),
);

it.effect("retries an unsettled request only after an ordinary trigger", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, trigger, drain, generated, item } = yield* harness("automatic");
      const warning = yield* Deferred.make<BackendLogEntry>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          subscribeToBackendLogs(
            (entry) => {
              if (
                entry.component === "inbox-dispatcher" &&
                entry.msg === "Inbox suggestion pass could not settle"
              ) {
                Deferred.doneUnsafe(warning, Effect.succeed(entry));
              }
            },
            { level: "warn" },
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const failing = yield* holdNextGeneration(generated);
      const first = yield* captureInbox(inbox, "First private message");
      yield* trigger;
      const initial = yield* Deferred.await(failing.started);

      const sibling = yield* holdNextGeneration(generated);
      yield* captureInbox(inbox, "Sibling message");
      const running = yield* drain.pipe(Effect.forkScoped);
      yield* Deferred.await(sibling.started);
      // Wait for the drain's admission pass before adding the message that must wait for refill.
      yield* trigger;

      const refill = yield* holdNextGeneration(generated);
      const third = yield* captureInbox(inbox, "This message should be next");
      vi.spyOn(inbox, "settleSuggestion").mockImplementationOnce(() =>
        Effect.fail(
          new InboxApplicationError({
            operation: "settle-suggestion",
            message: "Cannot settle First private message",
            cause: coreRuntimeError({
              operation: "workspace.apply",
              reason: "transport-loss",
              retryable: true,
            }),
          }),
        ),
      );
      yield* Deferred.succeed(failing.resume, undefined);
      assert.notInclude(JSON.stringify(yield* Deferred.await(warning)), "First private message");
      assert.strictEqual((yield* item(first.pageId)).suggestionState, "pending");
      assert.strictEqual(generated.mock.calls.length, 2);

      yield* Deferred.succeed(sibling.resume, undefined);
      const input = yield* Deferred.await(refill.started);
      assert.deepEqual(
        input.messages.map(({ page_id }) => page_id),
        [third.pageId],
      );
      assert.strictEqual(generated.mock.calls.length, 3);

      yield* Deferred.succeed(refill.resume, undefined);
      yield* Fiber.join(running);
      assert.strictEqual(generated.mock.calls.length, 3);
      assert.strictEqual((yield* item(first.pageId)).suggestionState, "pending");

      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 4);
      const retry = generated.mock.calls[3]!;
      assert.deepEqual(generationInput(retry[0]).request, initial.request);
      assert.strictEqual((yield* item(first.pageId)).suggestionState, "settled");
    }),
  ),
);

it.effect("releases waiting messages and admits no more work when turned off at capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, trigger, drain, generated, item, request, setMode } =
        yield* harness("automatic");
      const active = yield* Effect.forEach([1, 2, 3], (index) =>
        Effect.gen(function* () {
          const gate = yield* holdNextGeneration(generated);
          yield* captureInbox(inbox, `Active message ${index}`);
          yield* trigger;
          yield* Deferred.await(gate.started);
          return gate;
        }),
      );
      const queued = yield* captureInbox(inbox, "A queued explicit request");
      yield* request(queued.pageId);
      const waiting = yield* captureInbox(inbox, "A waiting message");
      setMode("off");
      yield* trigger;
      assert.strictEqual((yield* item(waiting.pageId)).suggestionState, "none");
      assert.strictEqual(generated.mock.calls.length, 3);

      yield* Effect.forEach(active, ({ resume }) => Deferred.succeed(resume, undefined));
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 3);
      assert.strictEqual((yield* item(queued.pageId)).suggestionState, "pending");
      assert.strictEqual((yield* inbox.suggestionRequests(8)).length, 1);
    }),
  ),
);

it.effect.each(["stop", "archive", "request again"] as const)(
  "interrupts stale generation and refills without a new trigger after %s",
  (change) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, inbox, trigger, reconcile, drain, generated, item, request } =
          yield* harness("automatic");
        const read = vi.spyOn(inbox, "pendingSuggestionRequestIds");
        yield* reconcile;
        assert.strictEqual(read.mock.calls.length, 0);

        const active = yield* Effect.forEach([1, 2, 3], (index) =>
          Effect.gen(function* () {
            const gate = yield* holdNextGeneration(generated);
            const { pageId } = yield* captureInbox(inbox, `Active message ${index}`);
            yield* trigger;
            const { request } = yield* Deferred.await(gate.started);
            return { ...gate, pageId, requestId: request.request_id };
          }),
        );
        const stopped = active[0]!;
        const waiting = yield* captureInbox(inbox, "A message waiting for capacity");
        const refill = yield* holdNextGeneration(generated);
        if (change === "stop") {
          yield* inbox.stopSuggestion({ pageId: stopped.pageId });
        } else if (change === "request again") {
          yield* request(stopped.pageId);
        } else {
          yield* Effect.promise(async () => {
            const { value } = await client.libraryRead({
              kind: "page_lifecycle_preflight",
              page_id: stopped.pageId,
            });
            if (value.kind !== "page_lifecycle_preflight" || !value.value.page)
              return assert.fail("Missing Page lifecycle preflight");
            await client.libraryApply({
              operationId: createUuidV7(),
              intent: {
                kind: "apply_page_lifecycle",
                mutation: {
                  kind: "archive_page",
                  page_id: stopped.pageId,
                  expected_metadata_revision: value.value.page.metadata_revision,
                },
              },
            });
          });
        }

        yield* reconcile;
        const input = yield* Deferred.await(refill.started);
        assert.isTrue(yield* Deferred.isDone(stopped.interrupted));
        assert.isFalse(yield* Deferred.isDone(active[1]!.interrupted));
        assert.isFalse(yield* Deferred.isDone(active[2]!.interrupted));
        assert.notStrictEqual(input.request.request_id, stopped.requestId);
        assert.deepEqual(
          input.messages.map(({ page_id }) => page_id),
          [change === "request again" ? stopped.pageId : waiting.pageId],
        );
        assert.strictEqual(generated.mock.calls.length, 4);

        yield* Effect.forEach([...active.slice(1), refill], ({ resume }) =>
          Deferred.succeed(resume, undefined),
        );
        yield* drain;
        assert.strictEqual((yield* item(waiting.pageId)).suggestionState, "settled");
        assert.strictEqual(generated.mock.calls.length, change === "request again" ? 5 : 4);
      }),
    ),
);

it.effect("records a Core validation refusal as failed advice and waits for explicit Retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, drain, generated, item, request } = yield* harness("automatic");
      const { pageId } = yield* captureInbox(inbox, "Advice Core will reject");
      const settle = inbox.settleSuggestion;
      // Exercise Core's real validation, beyond the generator output check.
      vi.spyOn(inbox, "settleSuggestion").mockImplementationOnce((input) =>
        settle({ ...input, suggestions: [] }),
      );
      yield* drain;
      const failed = yield* item(pageId);
      assert.strictEqual(failed.suggestionState, "failed");
      assert.strictEqual(
        failed.suggestionError,
        "The Agent returned a suggestion Nodex couldn’t save. Try again.",
      );
      assert.deepEqual(yield* inbox.suggestionRequests(8), []);

      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 1);
      yield* request(pageId);
      yield* drain;
      assert.strictEqual(generated.mock.calls.length, 2);
      assert.strictEqual((yield* item(pageId)).suggestionState, "settled");
    }),
  ),
);

it.effect.each([
  ["invalid_input", "The Agent returned a suggestion Nodex couldn’t save. Try again."],
  ["not_found", "The message or suggestion destination is no longer available."],
  ["conflict", "The message or suggestion destination changed. Suggest again."],
  ["revision_conflict", "The message or suggestion destination changed. Suggest again."],
] as const)("explains %s settlement refusals without exposing Core diagnostics", ([code, reason]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, client } = yield* inboxOverRealCore();
      const { pageId } = yield* captureInbox(inbox, "A message whose advice cannot be saved");
      yield* inbox.prepareSuggestions(8, true);
      const [request] = yield* inbox.suggestionRequests(8);
      if (!request) return assert.fail("Missing suggestion request");
      vi.spyOn(client, "workspaceApply").mockRejectedValueOnce(
        new CoreModuleResponseError({
          code,
          message: "document operation InvalidOperation: internal diagnostic",
          retryable: false,
          recovery: { kind: "none" },
        }),
      );

      yield* inbox.settleSuggestion({
        request_id: request.request_id,
        generation: request.generation,
        titles: [],
        suggestions: [],
        produced_by: null,
        error: null,
      });
      const { items } = yield* inbox.window({ scope: LIBRARY_INBOX, filter: "inbox" });
      const failed = items.find((entry) => entry.pageId === pageId);
      assert.strictEqual(failed?.suggestionState, "failed");
      assert.strictEqual(failed?.suggestionError, reason);
      assert.deepEqual(yield* inbox.suggestionRequests(8), []);
    }),
  ),
);

it.effect("drops a replaced settlement quietly when the result wins the invalidation race", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { inbox, drain, generated, item } = yield* harness("automatic");
      const warnings: BackendLogEntry[] = [];
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          subscribeToBackendLogs(
            (entry) => {
              if (entry.component === "inbox-dispatcher") warnings.push(entry);
            },
            { level: "warn" },
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      const gate = yield* holdNextGeneration(generated);
      const { pageId } = yield* captureInbox(inbox, "Stop before a late result arrives");
      const running = yield* drain.pipe(Effect.forkScoped);
      yield* Deferred.await(gate.started);
      yield* inbox.stopSuggestion({ pageId });
      yield* Deferred.succeed(gate.resume, undefined);
      yield* Fiber.join(running);

      assert.strictEqual(generated.mock.calls.length, 1);
      assert.strictEqual((yield* item(pageId)).suggestionState, "none");
      assert.deepEqual(warnings, []);
    }),
  ),
);
