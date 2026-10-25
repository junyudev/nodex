import * as Context from "effect/Context";
import { isAgentRuntimeCodexThreadSource } from "@nodex/agent-runtime/contracts";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type {
  NativeConversationImportInput,
  NativeConversationImportPreview,
  NativeConversationImportPreviewInput,
  NativeConversationImportPreviewResult,
  NativeSessionCatalogEntry,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../shared/native-session-catalog";
import { parseCodexThreadImportReference } from "../../shared/codex-thread-import-reference";
import { nativeSessionCatalogTitle } from "../../shared/native-session-catalog";
import {
  extractCodexThreadSubagentMetadata,
  hasCodexSubagentSource,
} from "../../shared/codex-subagent-metadata";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  canonicalNativeSessionHome,
  nativeSessionCwdAvailable,
} from "../platform/node/NativeSessionCatalogPaths";

export class NativeSessionCatalogError extends Schema.TaggedError<NativeSessionCatalogError>()(
  "NativeSessionCatalogError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
    admissionRejected: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

type PreparedImport = NativeConversationImportPreview & { readonly model: string | null };
export class NativeSessionCatalog extends Context.Service<
  NativeSessionCatalog,
  {
    readonly list: (
      input: NativeSessionCatalogInput,
    ) => Effect.Effect<NativeSessionCatalogPage, NativeSessionCatalogError>;
    readonly previewImport: (
      input: NativeConversationImportPreviewInput,
    ) => Effect.Effect<NativeConversationImportPreviewResult, NativeSessionCatalogError>;
    readonly prepareImport: (
      input: NativeConversationImportInput,
    ) => Effect.Effect<PreparedImport, NativeSessionCatalogError>;
  }
>()("nodex/main/agent-backend/NativeSessionCatalog") {}

const fail = (operation: string, cause: unknown, admissionRejected = false) =>
  new NativeSessionCatalogError({
    operation,
    message:
      cause instanceof Error && cause.message
        ? cause.message
        : "Couldn’t read the conversation history.",
    cause,
    ...(admissionRejected ||
    (Schema.is(NativeSessionCatalogError)(cause) && cause.admissionRejected)
      ? { admissionRejected: true as const }
      : {}),
  });
/** A user's own persistent root conversation; Runtime chats already have a Nodex Session. */
const isImportableRoot = (thread: Thread): boolean => {
  const metadata = extractCodexThreadSubagentMetadata(thread);
  return (
    !thread.ephemeral &&
    !isAgentRuntimeCodexThreadSource(thread.threadSource) &&
    !metadata.parentThreadId &&
    !metadata.hasAnySubagentSource &&
    !hasCodexSubagentSource(thread.source)
  );
};
const milliseconds = (seconds: number): number =>
  Number.isFinite(seconds) && seconds >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(seconds * 1000))
    : 0;

/** Only a native response for this exact read may establish that another source has no match. */
const missingCodexThread = (error: unknown, nativeSessionId: string): boolean => {
  if (!Schema.is(CodexRuntimeError)(error) || error.reason !== "request") return false;
  if (!Schema.is(CodexAppServerRequestError)(error.cause)) return false;
  const response = error.cause;
  return (
    error.method === "thread/read" &&
    response.method === "thread/read" &&
    response.operation === "receive-response" &&
    response.code === -32600 &&
    [
      `thread not loaded: ${nativeSessionId}`,
      `thread not found: ${nativeSessionId}`,
      `no rollout found for thread id ${nativeSessionId}`,
    ].includes(response.message)
  );
};

/** Discovers exact native identities without running, resuming or adopting their conversations. */
export const make = Effect.gen(function* () {
  const claude = yield* ClaudeNativeCatalog;
  const gateway = yield* CodexGateway;
  const settings = yield* ApplicationSettings;
  const nativeHome = Effect.fn("NativeSessionCatalog.nativeHome")(function* () {
    const snapshot = yield* settings.snapshot();
    return yield* Effect.tryPromise({
      try: () => canonicalNativeSessionHome(snapshot.codexHome.activeHomePath),
      catch: (cause) =>
        fail(
          "home.read",
          cause,
          cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ENOTDIR"),
        ),
    });
  });
  const requireClaudeProfile = Effect.fn("NativeSessionCatalog.requireClaudeProfile")(function* (
    instanceConfigId: string | undefined,
  ) {
    const snapshot = yield* settings.snapshot();
    const profile = snapshot.claudeAgents.instances.find(
      (instance) => instance.id === instanceConfigId && instance.enabled,
    );
    if (!profile)
      return yield* fail(
        "import.profile",
        new Error(
          "This Claude Code profile is no longer available. Turn it on in Agent settings, then refresh.",
        ),
        true,
      );
    return profile.id;
  });
  // The list index can omit or lag ownership metadata. Read the exact native identity
  // without loading history; discovery, preview and admission use the same evidence.
  const readCodexThread = Effect.fn("NativeSessionCatalog.readCodexThread")(function* (
    nativeSessionId: string,
  ) {
    const response = yield* gateway
      .requestLocal(
        "thread/read",
        { threadId: nativeSessionId, includeTurns: false },
        { priority: "interactive", source: "native_session_import", timeoutMs: 15_000 },
      )
      .pipe(
        Effect.catchIf(
          (cause) => missingCodexThread(cause, nativeSessionId),
          () => Effect.succeed(null),
        ),
      );
    if (!response) return null;
    const thread = projectCodexGatewayThreadReadThread(response.thread);
    if (thread.id !== nativeSessionId)
      return yield* fail(
        "import.identity",
        new Error("Codex returned a different conversation. Refresh and try again."),
        true,
      );
    return thread;
  });
  const listCodex = Effect.fn("NativeSessionCatalog.listCodex")(function* (
    input: NativeSessionCatalogInput,
  ) {
    if (input.instanceConfigId)
      return yield* fail(
        "catalog.instance",
        new Error("Codex uses the active native account."),
        true,
      );
    const home = yield* nativeHome();
    const response = yield* gateway.requestLocal(
      "thread/list",
      {
        cursor: input.cursor ?? null,
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        archived: false,
      },
      { priority: "interactive", source: "native_session_catalog", timeoutMs: 15_000 },
    );
    if (response.data.length > 50)
      return yield* fail(
        "catalog.bound",
        new Error("Codex returned an unexpected conversation list. Refresh to try again."),
        true,
      );
    const inspected = yield* Effect.forEach(
      response.data,
      (metadata) =>
        Effect.gen(function* () {
          const thread = yield* readCodexThread(metadata.id);
          if (!thread || !isImportableRoot(thread)) return null;
          const cwdAvailable = yield* Effect.tryPromise({
            try: () => nativeSessionCwdAvailable(thread.cwd),
            catch: (cause) => fail("catalog.cwd", cause),
          });
          return {
            nativeSessionId: thread.id,
            title: nativeSessionCatalogTitle(thread.name?.trim() || thread.preview),
            cwd: thread.cwd,
            cwdAvailable,
            updatedAt: milliseconds(thread.updatedAt),
          } satisfies NativeSessionCatalogEntry;
        }),
      { concurrency: 4 },
    );
    const entries = inspected.filter((entry) => entry !== null);
    if ((yield* nativeHome()) !== home)
      return yield* fail(
        "catalog.home",
        new Error("The Codex home changed while loading. Refresh to see its conversations."),
        true,
      );
    return { nativeHome: home, entries, nextCursor: response.nextCursor ?? null };
  });
  const inspectCodex = Effect.fn("NativeSessionCatalog.inspectCodex")(function* (
    nativeSessionId: string,
    expectedHome?: string,
  ): Effect.fn.Return<PreparedImport | null, unknown> {
    const home = yield* nativeHome();
    if (expectedHome !== undefined && expectedHome !== home)
      return yield* fail(
        "import.home",
        new Error("The Codex home changed. Refresh or paste the link again."),
        true,
      );
    const thread = yield* readCodexThread(nativeSessionId);
    if (!thread) return null;
    if (!isImportableRoot(thread))
      return yield* fail(
        "import.identity",
        new Error(
          "This is a subagent conversation or one Nodex runs itself, so it can’t be imported.",
        ),
        true,
      );
    if ((yield* nativeHome()) !== home)
      return yield* fail(
        "import.home",
        new Error("The Codex home changed. Refresh or paste the link again."),
        true,
      );
    const cwdAvailable = yield* Effect.tryPromise({
      try: () => nativeSessionCwdAvailable(thread.cwd),
      catch: (cause) => fail("import.cwd", cause),
    });
    return {
      backendKind: "codex",
      nativeSessionId,
      nativeHome: home,
      title: nativeSessionCatalogTitle(thread.name?.trim() || thread.preview),
      cwd: thread.cwd,
      cwdAvailable,
      updatedAt: milliseconds(thread.updatedAt),
      model: thread.model ?? null,
    };
  });
  const inspectClaude = Effect.fn("NativeSessionCatalog.inspectClaude")(function* (
    nativeSessionId: string,
    instanceConfigId: string,
    expectedHome?: string,
  ): Effect.fn.Return<PreparedImport | null, unknown> {
    yield* requireClaudeProfile(instanceConfigId);
    const info = yield* claude
      .nativeSessionInfo({
        nativeSessionId,
        instanceConfigId,
        ...(expectedHome === undefined ? {} : { expectedHome }),
      })
      .pipe(
        Effect.mapError((cause) =>
          cause.reason === "resource-not-found" ? fail("import.source", cause, true) : cause,
        ),
      );
    if (!info) return null;
    return {
      backendKind: "claude",
      instanceConfigId,
      nativeSessionId,
      nativeHome: info.nativeHome,
      title: nativeSessionCatalogTitle(info.customTitle || info.summary, "Claude conversation"),
      cwd: info.cwd,
      cwdAvailable: info.cwdAvailable,
      updatedAt: info.lastModified,
      model: null,
    };
  });
  return NativeSessionCatalog.of({
    previewImport: Effect.fn("NativeSessionCatalog.previewImport")(
      function* (input) {
        const id = parseCodexThreadImportReference(input.reference);
        if (!id)
          return yield* fail(
            "import.reference",
            new Error("Enter a local conversation link or ID."),
            true,
          );
        const fromLink = URL.parse(input.reference.trim())?.protocol === "codex:";
        if (fromLink && input.backendKind === "claude")
          return yield* fail("import.reference", new Error("This link belongs to Codex."), true);
        if (input.instanceConfigId && (fromLink || input.backendKind === "codex"))
          return yield* fail(
            "import.profile",
            new Error("Codex uses the active native account."),
            true,
          );
        const backend = fromLink ? "codex" : input.backendKind;
        const candidates: PreparedImport[] = [];
        const failures: unknown[] = [];
        const automatic = backend === undefined && !input.instanceConfigId;
        const discover = (read: Effect.Effect<PreparedImport | null, unknown>) =>
          automatic
            ? read.pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    failures.push(cause);
                    return null;
                  }),
                ),
              )
            : read;
        if (backend !== "claude" && !input.instanceConfigId) {
          const candidate = yield* discover(inspectCodex(id));
          if (candidate) candidates.push(candidate);
        }
        if (backend !== "codex") {
          const profiles = input.instanceConfigId
            ? [yield* requireClaudeProfile(input.instanceConfigId)]
            : (yield* settings.snapshot()).claudeAgents.instances
                .filter((profile) => profile.enabled)
                .map((profile) => profile.id);
          for (const profile of profiles) {
            const candidate = yield* discover(inspectClaude(id, profile));
            if (
              candidate &&
              !candidates.some(
                (existing) =>
                  existing.backendKind === "claude" && existing.nativeHome === candidate.nativeHome,
              )
            )
              candidates.push(candidate);
          }
        }
        if (candidates.length === 0 && failures.length > 0) return yield* Effect.fail(failures[0]);
        return { matches: candidates.map(({ model: _model, ...preview }) => preview) };
      },
      Effect.mapError((cause) => fail("import.preview", cause)),
    ),
    prepareImport: Effect.fn("NativeSessionCatalog.prepareImport")(
      function* (input) {
        const available = yield* Effect.tryPromise({
          try: () => nativeSessionCwdAvailable(input.cwd),
          catch: (cause) => fail("import.cwd", cause),
        });
        if (!available)
          return yield* fail(
            "import.cwd",
            new Error("This folder is no longer available. Refresh and choose another one."),
            true,
          );
        const id = parseCodexThreadImportReference(input.nativeSessionId);
        if (!id)
          return yield* fail(
            "import.reference",
            new Error("The source conversation identity is invalid."),
            true,
          );
        if (input.backendKind === "codex" && input.instanceConfigId)
          return yield* fail(
            "import.profile",
            new Error("Codex uses the active native account."),
            true,
          );
        const source =
          input.backendKind === "codex"
            ? yield* inspectCodex(id, input.expectedHome)
            : yield* inspectClaude(
                id,
                yield* requireClaudeProfile(input.instanceConfigId),
                input.expectedHome,
              );
        if (!source)
          return yield* fail(
            "import.source",
            new Error("The original conversation is no longer available."),
            true,
          );
        return source;
      },
      Effect.mapError((cause) => fail("import.prepare", cause)),
    ),
    list: Effect.fn("NativeSessionCatalog.list")(
      function* (input) {
        if (input.backendKind === "codex") return yield* listCodex(input);
        const instanceConfigId = yield* requireClaudeProfile(input.instanceConfigId);
        return yield* claude.nativeCatalog({
          instanceConfigId,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
      },
      Effect.mapError((cause) => fail("catalog.list", cause)),
    ),
  });
});
export const live = Layer.effect(NativeSessionCatalog, make);
