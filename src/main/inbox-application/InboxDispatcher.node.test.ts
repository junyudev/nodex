import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import {
  DEFAULT_INBOX_SETTINGS,
  LIBRARY_INBOX,
  type InboxSettings,
  type InboxSuggestionMode,
} from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";
import { NativePromptImages } from "../agent-backend/NativePromptImages";
import { LibraryModule } from "../library-application/LibraryModule";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { testLayer as configLayer } from "../app/MainConfig";
import { subscribeToBackendLogs, type BackendLogEntry } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { InboxApplication } from "./InboxApplication";
import { captureInbox, inboxOverRealCore } from "./InboxApplication.test-support";
import { make } from "./InboxDispatcher";

type Runtime = AgentRuntimeApplication["Service"];
type Provider = Effect.Success<ReturnType<Runtime["catalog"]>>[number];
type Mode = InboxSuggestionMode | "paused";

const harness = Effect.fn("InboxDispatcher.testHarness")(function* (mode: Mode) {
  const now = yield* Clock.currentTimeMillis;
  let current: InboxSettings = {
    ...DEFAULT_INBOX_SETTINGS,
    suggestions: mode === "paused" ? "automatic" : mode,
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
    const data = JSON.parse(input.prompt.split("JSON data:\n")[1]!) as {
      request: { request_id: string; generation: number };
      messages: { page_id: string }[];
    };
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
        delegates: [],
        plan: null,
        summary: "Keep this reference",
        rationale: null,
      })),
    });
  });
  const { inbox } = yield* inboxOverRealCore(Effect.void, catalog, () => current);
  const { drain } = yield* make.pipe(
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
    drain,
    generated,
    catalog,
    item,
    request,
    setMode: (suggestions: InboxSuggestionMode) => {
      current = { ...current, suggestions };
    },
    setTight: (paused: boolean) => {
      providers = [{ ...suggestionAgent, usageLimits: paused ? tight : undefined }];
    },
  };
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
