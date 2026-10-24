import * as Context from "effect/Context";
import { isAgentRuntimeCodexThreadSource } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Thread } from "@nodex/codex-app-server-protocol/v2/Thread";
import type {
  CodexThreadImportInput,
  CodexThreadImportPreview,
  CodexThreadImportPreviewInput,
  NativeSessionAttachInput,
  NativeSessionAttachResult,
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
import { AgentBackendApplication } from "./AgentBackendApplication";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  canonicalNativeSessionHome,
  nativeSessionCwdAvailable,
} from "../platform/node/NativeSessionCatalogPaths";

export class NativeSessionCatalogError extends Schema.TaggedError<NativeSessionCatalogError>()(
  "NativeSessionCatalogError",
  { operation: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

export class NativeSessionCatalog extends Context.Service<
  NativeSessionCatalog,
  {
    readonly list: (
      input: NativeSessionCatalogInput,
    ) => Effect.Effect<NativeSessionCatalogPage, NativeSessionCatalogError>;
    readonly attach: (
      input: NativeSessionAttachInput,
    ) => Effect.Effect<NativeSessionAttachResult, NativeSessionCatalogError>;
    readonly previewCodexImport: (
      input: CodexThreadImportPreviewInput,
    ) => Effect.Effect<CodexThreadImportPreview, NativeSessionCatalogError>;
    readonly prepareCodexImport: (
      input: CodexThreadImportInput,
    ) => Effect.Effect<
      CodexThreadImportPreview & { readonly model: string | null },
      NativeSessionCatalogError
    >;
  }
>()("nodex/main/agent-backend/NativeSessionCatalog") {}

const fail = (operation: string, cause: unknown) =>
  new NativeSessionCatalogError({
    operation,
    message:
      cause instanceof Error && cause.message
        ? cause.message
        : "Native conversation operation failed.",
    cause,
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

/** Discovers native metadata and admits exact identities; it never runs or forks a conversation. */
export const make = Effect.gen(function* () {
  const agents = yield* AgentBackendApplication;
  const gateway = yield* CodexGateway;
  const settings = yield* ApplicationSettings;
  const workspace = yield* ProjectWorkspace;
  const nativeHome = Effect.fn("NativeSessionCatalog.nativeHome")(function* () {
    const snapshot = yield* settings.snapshot();
    return yield* Effect.tryPromise({
      try: () => canonicalNativeSessionHome(snapshot.codexHome.activeHomePath),
      catch: (cause) => fail("home.read", cause),
    });
  });

  const listCodex = Effect.fn("NativeSessionCatalog.listCodex")(function* (
    input: NativeSessionCatalogInput,
  ) {
    if (input.instanceConfigId)
      return yield* fail("catalog.instance", new Error("Codex uses the active native account."));
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
        new Error("Native conversation catalog exceeds its bound."),
      );
    const entries: NativeSessionCatalogEntry[] = [];
    for (const metadata of response.data) {
      const thread = projectCodexGatewayThreadReadThread(metadata);
      if (!isImportableRoot(thread)) continue;
      const available = yield* Effect.tryPromise({
        try: () => nativeSessionCwdAvailable(thread.cwd),
        catch: (cause) => fail("catalog.cwd", cause),
      });
      entries.push({
        nativeSessionId: thread.id,
        title: nativeSessionCatalogTitle(thread.name?.trim() || thread.preview),
        cwd: thread.cwd,
        cwdAvailable: available,
        updatedAt: milliseconds(thread.updatedAt),
      });
    }
    const bindings = yield* workspace.readNativeSessionBindings({
      backendKind: "codex",
      nativeHome: home,
      nativeSessionIds: entries.map((entry) => entry.nativeSessionId),
    });
    const attached = new Map(bindings.map((binding) => [binding.nativeSessionId, binding]));
    return {
      nativeHome: home,
      entries: entries.map((entry) => {
        const binding = attached.get(entry.nativeSessionId);
        if (!binding) return entry;
        return {
          ...entry,
          attachedThreadId: binding.threadId,
          ...(binding.sessionId ? { attachedSessionId: binding.sessionId } : {}),
        };
      }),
      nextCursor: response.nextCursor ?? null,
    };
  });

  const inspectCodexImport = Effect.fn("NativeSessionCatalog.inspectCodexImport")(function* (
    reference: string,
    expectedHome?: string,
  ) {
    const nativeSessionId = parseCodexThreadImportReference(reference);
    if (!nativeSessionId)
      return yield* fail("import.reference", new Error("Enter a local Codex thread link or ID."));
    const home = yield* nativeHome();
    if (expectedHome !== undefined && expectedHome !== home)
      return yield* fail(
        "import.home",
        new Error("The Codex account changed. Look up the conversation again."),
      );
    const response = yield* gateway.requestLocal(
      "thread/read",
      { threadId: nativeSessionId, includeTurns: false },
      { priority: "interactive", source: "native_session_import", timeoutMs: 15_000 },
    );
    const thread = projectCodexGatewayThreadReadThread(response.thread);
    if (thread.id !== nativeSessionId || !isImportableRoot(thread))
      return yield* fail(
        "import.identity",
        new Error("Subagent and Nodex-run Codex conversations cannot be imported."),
      );
    if ((yield* nativeHome()) !== home)
      return yield* fail(
        "import.home",
        new Error("The Codex account changed. Look up the conversation again."),
      );
    const cwdAvailable = yield* Effect.tryPromise({
      try: () => nativeSessionCwdAvailable(thread.cwd),
      catch: (cause) => fail("import.cwd", cause),
    });
    return {
      nativeSessionId,
      nativeHome: home,
      title: nativeSessionCatalogTitle(thread.name?.trim() || thread.preview),
      cwd: thread.cwd,
      cwdAvailable,
      updatedAt: milliseconds(thread.updatedAt),
      model: thread.model ?? null,
    };
  });

  const attachCodex = Effect.fn("NativeSessionCatalog.attachCodex")(function* (
    input: NativeSessionAttachInput,
  ) {
    if (input.instanceConfigId)
      return yield* fail("attach.instance", new Error("Codex uses the active native account."));
    const home = yield* nativeHome();
    if (home !== input.expectedHome)
      return yield* fail(
        "attach.home",
        new Error("The native account changed. Reload conversations."),
      );
    const response = yield* gateway.requestLocal(
      "thread/read",
      { threadId: input.nativeSessionId, includeTurns: false },
      { priority: "interactive", source: "native_session_attach", timeoutMs: 15_000 },
    );
    const thread = projectCodexGatewayThreadReadThread(response.thread);
    if (thread.id !== input.nativeSessionId || !isImportableRoot(thread))
      return yield* fail(
        "attach.identity",
        new Error("This native conversation cannot be connected."),
      );
    const available = yield* Effect.tryPromise({
      try: () => nativeSessionCwdAvailable(thread.cwd),
      catch: (cause) => fail("attach.cwd", cause),
    });
    if (!available)
      return yield* fail("attach.cwd", new Error("The conversation workspace is unavailable."));
    if ((yield* nativeHome()) !== home)
      return yield* fail(
        "attach.home",
        new Error("The native account changed. Reload conversations."),
      );
    return yield* workspace.attachNativeSession({
      backendKind: "codex",
      nativeSessionId: thread.id,
      nativeHome: home,
      projectId: input.projectId,
      title: nativeSessionCatalogTitle(thread.name?.trim() || thread.preview),
      cwd: thread.cwd,
      createdAt: milliseconds(thread.createdAt),
      updatedAt: milliseconds(thread.updatedAt),
    });
  });

  return NativeSessionCatalog.of({
    previewCodexImport: (input) =>
      inspectCodexImport(input.reference).pipe(
        Effect.map(({ model: _model, ...preview }) => preview),
        Effect.mapError((cause) => fail("import.preview", cause)),
      ),
    prepareCodexImport: Effect.fn("NativeSessionCatalog.prepareCodexImport")(
      function* (input: CodexThreadImportInput) {
        const available = yield* Effect.tryPromise({
          try: () => nativeSessionCwdAvailable(input.cwd),
          catch: (cause) => fail("import.cwd", cause),
        });
        if (!available)
          return yield* fail(
            "import.cwd",
            new Error("Choose an existing working directory for the imported chat."),
          );
        return yield* inspectCodexImport(input.nativeSessionId, input.expectedHome);
      },
      Effect.mapError((cause) => fail("import.prepare", cause)),
    ),
    list: Effect.fn("NativeSessionCatalog.list")(
      function* (input: NativeSessionCatalogInput) {
        if (input.backendKind === "claude") return yield* agents.listClaudeNativeSessions(input);
        return yield* listCodex(input);
      },
      Effect.mapError((cause) => fail("catalog.list", cause)),
    ),
    attach: Effect.fn("NativeSessionCatalog.attach")(
      function* (input: NativeSessionAttachInput) {
        if (input.backendKind === "claude") return yield* agents.attachClaudeNativeSession(input);
        return yield* attachCodex(input);
      },
      Effect.mapError((cause) => fail("catalog.attach", cause)),
    ),
  });
});

export const live = Layer.effect(NativeSessionCatalog, make);
