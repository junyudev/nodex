import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type {
  NativeConversationImportInput,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../shared/native-session-catalog";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import { make, type NativeSessionCatalogError } from "./NativeSessionCatalog";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { ApplicationSettings } from "../settings/ApplicationSettings";

const SESSION_ID = "019d0000-0000-7000-8000-000000000001";
const importInput = (
  home: string,
  cwd: string,
  patch: Partial<NativeConversationImportInput> = {},
): NativeConversationImportInput => ({
  backendKind: "codex",
  requestId: "019d0000-0000-7000-8000-000000000002",
  acceptedAt: 20_000,
  nativeSessionId: SESSION_ID,
  expectedHome: home,
  projectId: null,
  cwd,
  ...patch,
});
const temporaryRoot = Effect.acquireRelease(
  Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "nodex-native-catalog-")))),
  (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
);

const nativeThread = (cwd: string, patch: Partial<Thread> = {}): Thread =>
  ({
    id: SESSION_ID,
    name: "CLI conversation",
    preview: "Earlier task",
    cwd,
    ephemeral: false,
    parentThreadId: null,
    source: "cli",
    createdAt: 10,
    updatedAt: 20,
    turns: [],
    ...patch,
  }) as Thread;

const harness = (
  root: string,
  options: {
    readonly threads?: readonly Thread[];
    readonly readThread?: Thread;
    readonly readThreads?: Readonly<Record<string, Thread>>;
    readonly nextCursor?: string;
    readonly claudeProfiles?: readonly { id: string; home: string }[];
    readonly brokenClaudeProfile?: string;
    readonly codexReadFailure?: Error;
    readonly afterRead?: () => void;
    readonly claudePage?: NativeSessionCatalogPage;
  } = {},
) => {
  const home = join(root, "native-home");
  const cwd = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let activeHome = home;
  const requests: Array<{ method: string; params: unknown }> = [];
  const claudeLists: NativeSessionCatalogInput[] = [];
  const settings = {
    snapshot: () =>
      Effect.succeed({
        codexHome: { activeHomePath: activeHome },
        claudeAgents: {
          instances: (options.claudeProfiles ?? []).map((profile) => ({
            id: profile.id,
            enabled: true,
          })),
        },
      }),
  } as unknown as ApplicationSettings["Service"];
  const gateway = {
    requestLocal: (method: string, params: unknown) =>
      Effect.suspend((): Effect.Effect<unknown, Error> => {
        requests.push({ method, params });
        if (method === "thread/list")
          return Effect.succeed({
            data: options.threads ?? [nativeThread(cwd)],
            nextCursor: options.nextCursor ?? null,
          });
        if (method === "thread/read") {
          if (options.codexReadFailure) return Effect.fail(options.codexReadFailure);
          options.afterRead?.();
          const id = (params as { threadId: string }).threadId;
          return Effect.succeed({
            thread:
              options.readThreads?.[id] ??
              options.readThread ??
              options.threads?.find((thread) => thread.id === id) ??
              nativeThread(cwd),
          });
        }
        return Effect.die(new Error(`Unexpected native operation: ${method}`));
      }),
  } as unknown as CodexGateway["Service"];
  const claude = {
    nativeCatalog: (input: NativeSessionCatalogInput) =>
      Effect.sync(() => {
        claudeLists.push(input);
        return options.claudePage ?? { nativeHome: home, entries: [], nextCursor: null };
      }),
    nativeSessionInfo: (input: {
      instanceConfigId: string;
      nativeSessionId: string;
      expectedHome?: string;
    }) =>
      Effect.try(() => {
        if (input.instanceConfigId === options.brokenClaudeProfile)
          throw new Error("Claude profile is unavailable");
        const profile = options.claudeProfiles?.find(
          (profile) => profile.id === input.instanceConfigId,
        );
        if (!profile || input.nativeSessionId !== SESSION_ID) return null;
        if (input.expectedHome !== undefined && input.expectedHome !== profile.home)
          throw new Error("Changed home");
        return {
          sessionId: SESSION_ID,
          nativeHome: profile.home,
          cwd: join(root, "old-claude-workspace"),
          cwdAvailable: false,
          summary: "Claude conversation",
          lastModified: 25_000,
        };
      }),
  } as unknown as ClaudeNativeCatalog["Service"];
  return {
    home,
    cwd,
    requests,
    claudeLists,
    setActiveHome: (next: string) => {
      activeHome = next;
    },
    catalog: make.pipe(
      Effect.provideService(ClaudeNativeCatalog, claude),
      Effect.provideService(ApplicationSettings, settings),
      Effect.provideService(CodexGateway, gateway),
    ),
  };
};

it.effect("pages persistent Codex roots without loading history or starting a runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const cwd = join(root, "workspace");
      const fixture = harness(root, {
        threads: [
          nativeThread(cwd),
          nativeThread(cwd, { id: "child", parentThreadId: SESSION_ID }),
          nativeThread(cwd, { id: "review", source: { subAgent: "review" } }),
          nativeThread(cwd, { id: "temporary", ephemeral: true }),
          nativeThread(cwd, { id: "runtime-chat", threadSource: "agent_runtime" }),
          nativeThread(cwd, {
            id: "runtime-import",
            threadSource: "agent_runtime:019d0000-0000-7000-8000-000000000002",
          }),
          nativeThread(join(root, "missing"), { id: "missing-workspace" }),
        ],
        nextCursor: "next-native-page",
      });
      const catalog = yield* fixture.catalog;
      const page = yield* catalog.list({ backendKind: "codex", cursor: "native-page" });
      assert.deepEqual(page, {
        nativeHome: fixture.home,
        entries: [
          {
            nativeSessionId: SESSION_ID,
            title: "CLI conversation",
            cwd,
            cwdAvailable: true,
            updatedAt: 20_000,
          },
          {
            nativeSessionId: "missing-workspace",
            title: "CLI conversation",
            cwd: join(root, "missing"),
            cwdAvailable: false,
            updatedAt: 20_000,
          },
        ],
        nextCursor: "next-native-page",
      });
      assert.equal(fixture.requests.filter(({ method }) => method === "thread/read").length, 7);
      assert.deepEqual(fixture.requests[0]?.params, {
        cursor: "native-page",
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
      });
    }),
  ),
);

it.effect("offers only roots verified by the same metadata read used for preview", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const cwd = join(root, "workspace");
      const fixture = harness(root, {
        threads: [
          nativeThread(cwd, { id: "runtime" }),
          nativeThread(cwd, { id: "child" }),
          nativeThread(cwd, { id: "temporary" }),
          nativeThread(cwd, { name: "Stale title", parentThreadId: "stale-parent" }),
        ],
        readThreads: {
          runtime: nativeThread(cwd, { id: "runtime", threadSource: "agent_runtime" }),
          child: nativeThread(cwd, { id: "child", parentThreadId: SESSION_ID }),
          temporary: nativeThread(cwd, { id: "temporary", ephemeral: true }),
          [SESSION_ID]: nativeThread(join(root, "unavailable"), { name: "Verified title" }),
        },
        nextCursor: "older-candidates",
      });
      const catalog = yield* fixture.catalog;
      const page = yield* catalog.list({ backendKind: "codex" });
      const preview = yield* catalog.previewImport({ reference: SESSION_ID });
      assert.deepEqual(page.entries, [
        {
          nativeSessionId: SESSION_ID,
          title: "Verified title",
          cwd: join(root, "unavailable"),
          cwdAvailable: false,
          updatedAt: 20_000,
        },
      ]);
      assert.equal(page.nextCursor, "older-candidates");
      assert.equal(preview.matches[0]?.title, page.entries[0]?.title);
      assert.isTrue(
        fixture.requests.every(
          ({ method, params }) =>
            method === "thread/list" ||
            (method === "thread/read" &&
              (params as { includeTurns: boolean }).includeTurns === false),
        ),
      );
    }),
  ),
);

it.effect.each(["identity", "home", "unavailable"] as const)(
  "does not publish a catalog with unverified %s",
  (failureKind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const otherHome = join(root, "other-home");
        mkdirSync(otherHome);
        const fixture = harness(root, {
          ...(failureKind === "identity"
            ? { readThread: nativeThread(root, { id: "another-id" }) }
            : {}),
          ...(failureKind === "unavailable"
            ? { codexReadFailure: new Error("Native transport unavailable") }
            : {}),
          ...(failureKind === "home" ? { afterRead: () => fixture.setActiveHome(otherHome) } : {}),
        });
        const catalog = yield* fixture.catalog;
        const failure = yield* catalog.list({ backendKind: "codex" }).pipe(Effect.flip);
        assert.isNotEmpty(failure.message);
      }),
    ),
);

it.effect.each(["owned", "deleted"] as const)(
  "preserves pagination when the only candidate is %s",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const fixture = harness(root, {
          nextCursor: "older-native-page",
          ...(kind === "owned"
            ? { readThread: nativeThread(root, { threadSource: "agent_runtime" }) }
            : {
                codexReadFailure: new CodexRuntimeError({
                  message: "Source deleted",
                  operation: "request",
                  reason: "request",
                  retryable: false,
                  method: "thread/read",
                  cause: new CodexAppServerRequestError({
                    method: "thread/read",
                    operation: "receive-response",
                    code: -32600,
                    errorMessage: `no rollout found for thread id ${SESSION_ID}`,
                  }),
                }),
              }),
        });
        const catalog = yield* fixture.catalog;
        assert.deepEqual(yield* catalog.list({ backendKind: "codex" }), {
          nativeHome: fixture.home,
          entries: [],
          nextCursor: "older-native-page",
        });
      }),
    ),
);

it.effect("previews a local thread link even when its original workspace is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const cwd = join(root, "missing-workspace");
      const fixture = harness(root, { readThread: nativeThread(cwd) });
      const alias = join(root, "native-alias");
      symlinkSync(fixture.home, alias, "dir");
      fixture.setActiveHome(alias);
      const catalog = yield* fixture.catalog;
      const preview = yield* catalog.previewImport({
        reference: `codex://threads/${SESSION_ID.toUpperCase()}?hostId=local`,
      });
      assert.deepEqual(preview.matches, [
        {
          backendKind: "codex",
          nativeSessionId: SESSION_ID,
          nativeHome: fixture.home,
          title: "CLI conversation",
          cwd,
          cwdAvailable: false,
          updatedAt: 20_000,
        },
      ]);
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
    }),
  ),
);

it.effect("rejects remote and malformed import references before reading native history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      for (const reference of [
        `codex://threads/${SESSION_ID}?hostId=remote-ssh:work`,
        `codex://threads/${SESSION_ID}?hostId=local&hostId=remote`,
        `https://example.com/threads/${SESSION_ID}`,
        "codex://threads/not-a-thread",
      ]) {
        const failure = yield* catalog.previewImport({ reference }).pipe(Effect.flip);
        assert.equal(failure.message, "Enter a local conversation link or ID.");
      }
      assert.equal(fixture.requests.length, 0);
    }),
  ),
);

it.effect("prepares a missing-workspace import with an explicit existing replacement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const sourceCwd = join(root, "missing-workspace");
      const fixture = harness(root, {
        readThread: nativeThread(sourceCwd, { model: "gpt-5.4" }),
      });
      const catalog = yield* fixture.catalog;
      const source = yield* catalog.prepareImport(importInput(fixture.home, fixture.cwd));
      assert.deepEqual(source, {
        backendKind: "codex",
        nativeSessionId: SESSION_ID,
        nativeHome: fixture.home,
        title: "CLI conversation",
        cwd: sourceCwd,
        cwdAvailable: false,
        updatedAt: 20_000,
        model: "gpt-5.4",
      });
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
    }),
  ),
);

it.effect("requires a real replacement directory before preparing an import", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const file = join(root, "workspace-file");
      writeFileSync(file, "not a directory");
      const catalog = yield* fixture.catalog;
      for (const cwd of ["", "relative-workspace", join(root, "missing"), file]) {
        const failure = yield* catalog
          .prepareImport(importInput(fixture.home, cwd))
          .pipe(Effect.flip);
        assert.equal(
          failure.message,
          "This folder is no longer available. Refresh and choose another one.",
        );
        assert.equal(failure.admissionRejected, true);
      }
      assert.equal(fixture.requests.length, 0);
    }),
  ),
);

it.effect("rejects a stale import home before reading the source conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      const catalog = yield* fixture.catalog;
      const failure = yield* catalog
        .prepareImport(importInput(join(root, "previous-home"), fixture.cwd))
        .pipe(Effect.flip);
      assert.equal(failure.message, "The Codex home changed. Refresh or paste the link again.");
      assert.equal(fixture.requests.length, 0);
    }),
  ),
);

it.effect.each(["preview", "prepare"] as const)(
  "rejects an account change during import %s metadata lookup",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const otherHome = join(root, "other-home");
        mkdirSync(otherHome);
        const fixture = harness(root, { afterRead: () => fixture.setActiveHome(otherHome) });
        const catalog = yield* fixture.catalog;
        const inspection: Effect.Effect<unknown, NativeSessionCatalogError> =
          operation === "preview"
            ? catalog.previewImport({ reference: SESSION_ID })
            : catalog.prepareImport(importInput(fixture.home, fixture.cwd));
        const failure = yield* inspection.pipe(Effect.flip);
        assert.equal(failure.message, "The Codex home changed. Refresh or paste the link again.");
        assert.deepEqual(fixture.requests, [
          { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
        ]);
      }),
    ),
);

it.effect.each([
  { parentThreadId: "parent" },
  { source: { subAgent: "compact" } },
  { ephemeral: true },
  { threadSource: "agent_runtime" },
  { threadSource: "agent_runtime:019d0000-0000-7000-8000-000000000002" },
  { id: "019d0000-0000-7000-8000-000000000003" },
] satisfies Partial<Thread>[])("rejects ineligible Codex import sources %#", (patch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root, {
        readThread: nativeThread(join(root, "workspace"), patch),
      });
      const catalog = yield* fixture.catalog;
      const previewFailure = yield* catalog
        .previewImport({ reference: SESSION_ID })
        .pipe(Effect.flip);
      const prepareFailure = yield* catalog
        .prepareImport(importInput(fixture.home, fixture.cwd))
        .pipe(Effect.flip);
      assert.equal(
        previewFailure.message,
        patch.id
          ? "Codex returned a different conversation. Refresh and try again."
          : "This is a subagent conversation or one Nodex runs itself, so it can’t be imported.",
      );
      assert.equal(prepareFailure.message, previewFailure.message);
      assert.deepEqual(fixture.requests, [
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
        { method: "thread/read", params: { threadId: SESSION_ID, includeTurns: false } },
      ]);
    }),
  ),
);

it.effect("keeps ambiguous native IDs separate by Agent and physical home", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root, {
        claudeProfiles: [
          { id: "personal", home: "/claude/personal" },
          { id: "alias", home: "/claude/personal" },
          { id: "work", home: "/claude/work" },
        ],
      });
      const catalog = yield* fixture.catalog;
      const result = yield* catalog.previewImport({ reference: SESSION_ID });
      assert.deepEqual(
        result.matches.map((match) => [
          match.backendKind,
          match.instanceConfigId,
          match.nativeHome,
        ]),
        [
          ["codex", undefined, fixture.home],
          ["claude", "personal", "/claude/personal"],
          ["claude", "work", "/claude/work"],
        ],
      );
      const selected = yield* catalog.previewImport({
        reference: SESSION_ID,
        backendKind: "claude",
        instanceConfigId: "work",
      });
      assert.equal(selected.matches.length, 1);
      assert.equal(selected.matches[0]?.instanceConfigId, "work");
      assert.equal(selected.matches[0]?.cwdAvailable, false);
      const source = yield* catalog.prepareImport(
        importInput("/claude/work", fixture.cwd, {
          backendKind: "claude",
          instanceConfigId: "work",
        }),
      );
      assert.equal(source.cwd, join(root, "old-claude-workspace"));
      assert.equal(source.cwdAvailable, false);
      assert.equal(source.model, null);
    }),
  ),
);

it.effect("a Codex link never guesses a Claude source with the same ID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root, {
        claudeProfiles: [{ id: "personal", home: "/claude/personal" }],
      });
      const catalog = yield* fixture.catalog;
      const result = yield* catalog.previewImport({ reference: `CODEX://threads/${SESSION_ID}` });
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.backendKind, "codex");
      const rejected = yield* catalog
        .previewImport({ reference: `CODEX://threads/${SESSION_ID}`, backendKind: "claude" })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
    }),
  ),
);

it.effect(
  "automatic lookup keeps available sources usable while explicit source failures remain visible",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const fixture = harness(root, {
          codexReadFailure: new Error("Codex unavailable"),
          brokenClaudeProfile: "broken",
          claudeProfiles: [
            { id: "broken", home: "/claude/broken" },
            { id: "personal", home: "/claude/personal" },
          ],
        });
        const catalog = yield* fixture.catalog;
        const result = yield* catalog.previewImport({ reference: SESSION_ID });
        assert.equal(result.matches.length, 1);
        assert.equal(result.matches[0]?.instanceConfigId, "personal");
        assert.equal(
          (yield* catalog
            .previewImport({ reference: SESSION_ID, backendKind: "codex" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* catalog
            .previewImport({
              reference: SESSION_ID,
              backendKind: "claude",
              instanceConfigId: "broken",
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* catalog
            .previewImport({
              reference: `codex://threads/${SESSION_ID}`,
              instanceConfigId: "personal",
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        const empty = yield* harness(root, { codexReadFailure: new Error("Codex unavailable") })
          .catalog;
        assert.equal(
          (yield* empty.previewImport({ reference: SESSION_ID }).pipe(Effect.result))._tag,
          "Failure",
        );
      }),
    ),
);

it.effect("classifies a removed native history home as a validation refusal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const root = yield* temporaryRoot;
      const fixture = harness(root);
      fixture.setActiveHome(join(root, "removed-source-home"));
      const catalog = yield* fixture.catalog;
      const refusal = yield* catalog
        .prepareImport(importInput(fixture.home, fixture.cwd))
        .pipe(Effect.flip);
      assert.equal(refusal.admissionRejected, true);
      assert.equal(fixture.requests.length, 0);
    }),
  ),
);
