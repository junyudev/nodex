import { providerCredentialBindingsOverlap } from "@t3tools/provider-core/server/auth";
import {
  AcpRegistrySearchInput,
  AcpRegistryPrepareInput,
  AcpRegistrySetProviderInput,
  AcpRegistryAcceptUrlAuthInput,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderAuthCompleteInput,
  ProviderAuthCancelInput,
  ProviderAuthState,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSetupError,
  CommandId,
  ThreadId,
  ProjectId,
  type AcpRegistryListProvidersResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { createHash } from "node:crypto";
import * as nodePath from "node:path";
import * as FileSystem from "effect/FileSystem";
import * as Equal from "effect/Equal";
import { AcpRegistryCatalog } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { AcpRegistryRuntimeCoordinator } from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderAuthService } from "../provider/ProviderAuthService.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { deriveThreadFromProviderThread } from "@t3tools/provider-core/server/IdAllocator";
import { ProviderPolicy } from "./ProviderConfiguration.ts";
import { AcpManagementError, acpFailure } from "./AcpFailures.ts";
import type { AgentAcpFailure, AgentAcpOperation } from "./AcpManagementContract.ts";

const request = <M extends string, S extends Schema.Constraint>(method: M, input: S) =>
  Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Target = {
  instanceId: ProviderInstanceId,
  cwd: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
};
const Owner = { ownerId: Id };
export const Request = Schema.Union([
  request("acp.activity", Schema.Struct({})),
  request("acp.registry.search", AcpRegistrySearchInput),
  request("acp.inspect", Schema.Struct({ instanceId: ProviderInstanceId })),
  request("acp.install.preview", AcpRegistryPrepareInput),
  request(
    "acp.install.start",
    Schema.Struct({
      ...AcpRegistryPrepareInput.fields,
      operationId: Id,
      distribution: Schema.optionalKey(Schema.Literals(["auto", "binary", "npx", "uvx"])),
    }),
  ),
  request("acp.registry.uninstall", AcpRegistryPrepareInput),
  request("acp.connection.start", Schema.Struct({ ...Target, operationId: Id })),
  request("acp.operation.read", Schema.Struct({ operationId: Id })),
  request("acp.operation.cancel", Schema.Struct({ operationId: Id })),
  request("acp.auth.read", Schema.Struct({ instanceId: ProviderInstanceId, ...Owner })),
  request("acp.auth.start", Schema.Struct({ ...ProviderAuthStartInput.fields, ...Owner })),
  request("acp.auth.respond", Schema.Struct({ ...ProviderAuthRespondInput.fields, ...Owner })),
  request("acp.auth.complete", Schema.Struct({ ...ProviderAuthCompleteInput.fields, ...Owner })),
  request("acp.auth.cancel", Schema.Struct({ ...ProviderAuthCancelInput.fields, ...Owner })),
  request("acp.auth.logout", Schema.Struct({ instanceId: ProviderInstanceId })),
  request("acp.urlAuth.accept", AcpRegistryAcceptUrlAuthInput),
  request(
    "acp.sessions.list",
    Schema.Struct({
      ...Target,
      cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    }),
  ),
  request(
    "acp.sessions.prepareImport",
    Schema.Struct({ ...Target, sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)) }),
  ),
  request(
    "acp.sessions.import",
    Schema.Struct({
      ...Target,
      commandId: CommandId,
      threadId: ThreadId,
      projectId: ProjectId,
      title: Schema.NonEmptyString,
      sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
      sourceFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      model: Schema.NonEmptyString,
    }),
  ),
  request(
    "acp.sessions.delete",
    Schema.Struct({ ...Target, sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)) }),
  ),
  request("acp.modelProviders.list", Schema.Struct(Target)),
  request(
    "acp.modelProviders.set",
    Schema.Struct({
      ...Target,
      providerId: AcpRegistrySetProviderInput.fields.providerId,
      apiType: AcpRegistrySetProviderInput.fields.apiType,
      baseUrl: AcpRegistrySetProviderInput.fields.baseUrl,
      headers: AcpRegistrySetProviderInput.fields.headers,
    }),
  ),
  request(
    "acp.modelProviders.disable",
    Schema.Struct({ ...Target, providerId: AcpRegistrySetProviderInput.fields.providerId }),
  ),
]);

const failure = (
  message: string,
  reason: AgentAcpFailure["reason"] = "invalid_request",
  affectedThreadIds?: ReadonlyArray<string>,
) =>
  Effect.fail(
    new AcpManagementError({
      reason,
      message,
      ...(affectedThreadIds ? { affectedThreadIds } : {}),
    }),
  );
const encodeAuth = Schema.encodeEffect(Schema.toCodecJson(ProviderAuthState));

/** Volatile, bounded operations own their fibers. Their records contain no executable environment or credentials. */
export const makeOperations = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const lane = yield* Semaphore.make(1);
  const records = yield* Ref.make(
    new Map<string, { key: string; state: AgentAcpOperation; fiber?: Fiber.Fiber<void> }>(),
  );
  const read = Effect.fn("AcpOperations.read")(function* (id: string) {
    const record = (yield* Ref.get(records)).get(id);
    if (!record)
      return yield* failure(
        "This ACP operation has expired. Start a new operation.",
        "operation_expired",
      );
    return record.state;
  });
  const change = (id: string, patch: Partial<AgentAcpOperation>) =>
    Ref.update(records, (all) => {
      const record = all.get(id);
      if (!record || record.state.phase !== "running") return all;
      return new Map(all).set(id, { ...record, state: { ...record.state, ...patch } });
    });
  return {
    read,
    withInactiveInstallation: <A, E, R>(agentId: string, task: Effect.Effect<A, E, R>) =>
      lane.withPermit(
        Effect.gen(function* () {
          const active = [...(yield* Ref.get(records)).values()].some(
            ({ state }) =>
              state.phase === "running" && state.kind === "install" && state.agentId === agentId,
          );
          if (active)
            return yield* failure(
              "Wait for this Agent installation to finish before uninstalling.",
              "busy",
            );
          return yield* task;
        }),
      ),
    active: Ref.get(records).pipe(
      Effect.map(
        (records) =>
          [...records.values()].filter((record) => record.state.phase === "running").length,
      ),
    ),
    progress: (id: string, progress: NonNullable<AgentAcpOperation["progress"]>) =>
      change(id, { progress }),
    start: <E, R>(
      state: AgentAcpOperation,
      key: string,
      task: Effect.Effect<AgentAcpOperation["result"], E, R>,
    ) =>
      lane.withPermit(
        Effect.gen(function* () {
          const all = yield* Ref.get(records);
          const previous = all.get(state.operationId);
          if (previous) {
            if (previous.key !== key)
              return yield* failure("This operation ID belongs to another ACP request.");
            return previous.state;
          }
          const running = [...all.values()].filter((record) => record.state.phase === "running");
          const shared = running.find((record) => record.key === key);
          if (shared) return shared.state;
          if (running.length >= 8)
            return yield* failure("Too many ACP operations are running. Wait or cancel one.");
          const next = new Map(all);
          while (next.size >= 64) {
            const expired = [...next].find(([, record]) => record.state.phase !== "running");
            if (!expired) break;
            next.delete(expired[0]);
          }
          next.set(state.operationId, { key, state });
          yield* Ref.set(records, next);
          const fiber = yield* task.pipe(
            Effect.tap((result) => change(state.operationId, { phase: "succeeded", result })),
            Effect.catchCause((cause) =>
              change(
                state.operationId,
                Cause.hasInterruptsOnly(cause)
                  ? { phase: "cancelled" }
                  : {
                      phase: "failed",
                      error: acpFailure(Cause.squash(cause)),
                    },
              ),
            ),
            Effect.onInterrupt(() => change(state.operationId, { phase: "cancelled" })),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
          yield* Ref.update(records, (current) => {
            const record = current.get(state.operationId)!;
            return new Map(current).set(state.operationId, { ...record, fiber });
          });
          return yield* read(state.operationId);
        }),
      ),
    cancel: Effect.fn("AcpOperations.cancel")(function* (id: string) {
      const record = (yield* Ref.get(records)).get(id);
      if (!record) return yield* failure("This ACP operation has expired.", "operation_expired");
      if (record.state.phase === "running" && record.fiber) yield* Fiber.interrupt(record.fiber);
      return yield* read(id);
    }),
  };
});

/** Reject destructive credential changes before invoking the Agent or closing an existing chat. */
export const validateProviderMutation = (
  providers: AcpRegistryListProvidersResult["providers"],
  input: { readonly providerId: string; readonly apiType?: string },
  disable: boolean,
) => {
  const provider = providers.find((candidate) => candidate.providerId === input.providerId);
  if (!provider) return failure("The Agent no longer advertises this model service.");
  if (disable && provider.required)
    return failure("The Agent requires this model service and cannot disable it.");
  if (!disable && (input.apiType === undefined || !provider.supported.includes(input.apiType)))
    return failure("The Agent does not support this API type for the model service.");
  return Effect.void;
};

export const make = Effect.fn("AcpManagement.make")(function* (
  withWriter: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Error, R>,
) {
  const catalog = yield* AcpRegistryCatalog;
  const registry = yield* ProviderInstanceRegistry;
  const auth = yield* ProviderAuthService;
  const sessions = yield* ProviderSessionManagerV2;
  const coordinator = yield* AcpRegistryRuntimeCoordinator;
  const policy = yield* ProviderPolicy;
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* OrchestratorV2;
  const hostEnvironment = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const operations = yield* makeOperations;
  const mutation = yield* Semaphore.make(1);

  const instance = Effect.fn("AcpManagement.instance")(function* (id: ProviderInstanceId) {
    const current = (yield* policy.current)[id];
    const desired = (yield* policy.desired)[id];
    if (!desired || desired.enabled === false)
      return yield* failure("This ACP configuration is disabled or removed.", "disabled");
    if (!Equal.equals(current, desired))
      return yield* failure(
        "This ACP configuration is waiting for active work to finish.",
        "configuration_pending",
      );
    const value = yield* registry.getInstance(id);
    if (value?.driverKind !== "acpRegistry" || !value.acpSessionManagement)
      return yield* failure("The ACP instance is no longer available.");
    return { ...value, acpSessionManagement: value.acpSessionManagement };
  });
  const configuration = Effect.fn("AcpManagement.configuration")(function* (
    id: ProviderInstanceId,
    passive = false,
  ) {
    if (!passive) yield* instance(id);
    const entry = (yield* passive ? policy.desired : policy.current)[id];
    if (entry?.driver !== "acpRegistry")
      return yield* failure("The ACP instance is no longer configured.");
    const settings = yield* Schema.decodeUnknownEffect(AcpRegistrySettings)(entry.config);
    const environment = yield* mergeProviderInstanceEnvironment(
      entry.environment,
      settings.inheritEnvironment === false ? {} : hostEnvironment,
    );
    return { entry, settings, environment };
  });
  const withCurrent = <A, E, R>(captured: ProviderInstance, task: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* registry.subscribeChanges;
        const replaced = Stream.fromSubscription(changes).pipe(
          Stream.filterEffect(() =>
            registry
              .getInstance(captured.instanceId)
              .pipe(Effect.map((current) => current !== captured)),
          ),
          Stream.runHead,
          Effect.andThen(
            failure("The ACP configuration changed. Retry against the current instance."),
          ),
        );
        return yield* Effect.raceFirst(task, replaced);
      }),
    );
  const relatedInstances = (selected: ProviderInstance) =>
    registry.listInstances.pipe(
      Effect.map((instances) => {
        const binding = selected.auth?.credentialBinding;
        return instances.filter(
          (candidate) =>
            candidate.instanceId === selected.instanceId ||
            providerCredentialBindingsOverlap(candidate.auth?.credentialBinding, binding),
        );
      }),
    );
  const activityForInstances = Effect.fn("AcpManagement.activityForInstances")(function* (
    ids: ReadonlyArray<ProviderInstanceId>,
  ) {
    const live = yield* sessions.busyThreads;
    const queued = yield* sql<{
      provider_instance_id: string;
      thread_id: string;
    }>`SELECT DISTINCT r.provider_instance_id, json_extract(t.payload_json, '$.lineage.rootThreadId') AS thread_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id WHERE r.provider_instance_id IN ${sql.in(ids)} AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')`;
    const nativeThreads = ids.flatMap((id) => [...(live.get(id) ?? [])]);
    const nativeRoots =
      nativeThreads.length === 0
        ? []
        : yield* sql<{
            thread_id: string;
          }>`SELECT DISTINCT json_extract(payload_json, '$.lineage.rootThreadId') AS thread_id FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in(nativeThreads)}`;
    return {
      busy: queued.length > 0 || ids.some((id) => live.has(id)),
      threadIds: [...new Set([...queued, ...nativeRoots].map((row) => row.thread_id))],
    };
  });
  const assertIdle = Effect.fn("AcpManagement.assertIdle")(function* (
    selected: ProviderInstance,
    checkCredentials = true,
  ) {
    const related = yield* relatedInstances(selected);
    const activity = yield* activityForInstances(related.map((candidate) => candidate.instanceId));
    if (activity.busy)
      return yield* failure(
        "This sign-in is in use by active or queued chats. Stop their work before changing it.",
        "busy",
        activity.threadIds,
      );
    for (const candidate of related) {
      if (
        checkCredentials &&
        candidate.auth?.isChangingCredentials &&
        (yield* candidate.auth.isChangingCredentials)
      )
        return yield* failure(
          "Another operation is changing this sign-in. Finish or cancel it first.",
          "busy",
        );
    }
  });
  const withIdle = <A, E, R>(
    id: ProviderInstanceId,
    use: (value: AwaitedInstance) => Effect.Effect<A, E, R>,
  ) =>
    mutation.withPermit(
      Effect.gen(function* () {
        const selected = yield* instance(id);
        yield* assertIdle(selected);
        return yield* use(selected);
      }),
    );
  type AwaitedInstance = Effect.Success<ReturnType<typeof instance>>;
  const idleBeforeMutation = (selected: ProviderInstance) =>
    Effect.gen(function* () {
      yield* instance(selected.instanceId);
      yield* assertIdle(selected, false);
      for (const peer of yield* relatedInstances(selected)) {
        yield* sessions.closeInstance(peer.instanceId);
        if (peer.instanceId !== selected.instanceId) yield* peer.auth?.invalidate ?? Effect.void;
      }
    }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId: selected.instanceId,
            operation: "configure",
            detail: "Active or queued chats are using this sign-in. Stop their work first.",
          }),
      ),
    );
  const mutateAgentSettings = <E>(selected: ProviderInstance, update: Effect.Effect<void, E>) => {
    if (!selected.auth?.adoptCredentials)
      return failure("This Agent cannot coordinate credential changes.");
    return selected.auth.adoptCredentials(
      update.pipe(
        Effect.mapError(
          () =>
            new ProviderSetupError({
              instanceId: selected.instanceId,
              operation: "configure",
              detail: "The Agent rejected this model service configuration.",
            }),
        ),
      ),
      idleBeforeMutation(selected),
    );
  };
  const readAuth = Effect.fn("AcpManagement.readAuth")(function* (input: {
    instanceId: ProviderInstanceId;
    ownerId: string;
  }) {
    yield* instance(input.instanceId);
    const state = yield* auth.subscribe(input, input.ownerId).pipe(Stream.runHead);
    if (Option.isNone(state)) return yield* failure("The Agent sign-in state is unavailable.");
    return yield* encodeAuth(state.value);
  });

  const importIdentity = (
    instanceId: ProviderInstanceId,
    sessionId: string,
    sourceFingerprint: string,
  ) =>
    deriveThreadFromProviderThread({
      driver: ProviderDriverKind.make("acpRegistry"),
      providerInstanceId: instanceId,
      nativeThreadId: `${sourceFingerprint}:${sessionId}`,
    });
  const fingerprint = (
    settings: AcpRegistrySettings,
    instanceId: ProviderInstanceId,
    environment: NodeJS.ProcessEnv,
  ) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          instanceId,
          settings.agentIdentity ?? settings.agentId,
          settings.nativeStorageScope ?? [
            environment.HOME,
            environment.USERPROFILE,
            environment.XDG_CONFIG_HOME,
            environment.CLAUDE_CONFIG_DIR,
          ],
        ]),
      )
      .digest("hex");
  const prepareImport = Effect.fn("AcpManagement.prepareImport")(function* (input: {
    instanceId: ProviderInstanceId;
    cwd: string;
    sessionId: string;
  }) {
    const selected = yield* instance(input.instanceId);
    const config = yield* configuration(input.instanceId);
    const sourceFingerprint = fingerprint(config.settings, input.instanceId, config.environment);
    const threadId = importIdentity(input.instanceId, input.sessionId, sourceFingerprint);
    const existing = yield* orchestrator.getThreadShell(threadId);
    const snapshot = yield* selected.snapshot.getSnapshot;
    const canLoad = snapshot.nativeSessions?.canLoad === true;
    const canResume = snapshot.nativeSessions?.canResume === true;
    if (!canLoad && !canResume)
      return yield* failure(
        "Connect this Agent and verify it supports loading or resuming native sessions before importing.",
      );
    if (existing !== null)
      return {
        threadId,
        sourceFingerprint,
        title: existing.title,
        cwd: existing.worktreePath ?? input.cwd,
        canLoad,
        canResume,
        imported: true,
      };
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const listed = yield* selected.acpSessionManagement.listSessions({
        cwd: input.cwd,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const source = listed.sessions.find((session) => session.sessionId === input.sessionId);
      if (source) {
        if (!nodePath.isAbsolute(source.cwd))
          return yield* failure("The Agent returned a relative native session directory.");
        const info = yield* fileSystem
          .stat(source.cwd)
          .pipe(
            Effect.mapError(
              () => new Error("The original native session directory is no longer available."),
            ),
          );
        if (info.type !== "Directory")
          return yield* failure("The original native session directory is not a folder.");
        return {
          threadId,
          sourceFingerprint,
          title: source.title ?? "Imported ACP session",
          cwd: source.cwd,
          canLoad: listed.canLoad,
          canResume: listed.canResume,
          imported: false,
        };
      }
      if (listed.nextCursor === null)
        return yield* failure("The native session is no longer available.");
      if (seen.has(listed.nextCursor))
        return yield* failure("The Agent returned a repeated session cursor.");
      seen.add(listed.nextCursor);
      cursor = listed.nextCursor;
    }
    return yield* failure("The Agent session listing exceeded its page budget.");
  });

  const execute = Effect.fn("AcpManagement.execute")(function* (request: typeof Request.Type) {
    switch (request.method) {
      case "acp.activity": {
        const changing = yield* Effect.forEach(
          yield* registry.listInstances,
          (entry) => entry.auth?.isChangingCredentials ?? Effect.succeed(false),
        );
        return {
          activeOperations: yield* operations.active,
          activeAuthentication: changing.filter(Boolean).length,
        };
      }
      case "acp.registry.search":
        return yield* catalog.search(request.input);
      case "acp.inspect": {
        const config = yield* configuration(request.input.instanceId, true);
        return yield* catalog.inspect(config.settings, config.environment);
      }
      case "acp.install.preview":
        return yield* catalog.preview(request.input);
      case "acp.install.start":
        return yield* operations.start(
          {
            operationId: request.input.operationId,
            kind: "install",
            phase: "running",
            instanceId: null,
            agentId: request.input.agentId,
            result: null,
            error: null,
          },
          `install:${request.input.agentId}:${request.input.distribution ?? "auto"}:${request.input.expectedInstallationId ?? "unreviewed"}`,
          withWriter(
            catalog.prepare(request.input, (progress) =>
              operations.progress(request.input.operationId, progress),
            ),
          ),
        );
      case "acp.operation.read":
        return yield* operations.read(request.input.operationId);
      case "acp.operation.cancel":
        return yield* operations.cancel(request.input.operationId);
      case "acp.registry.uninstall": {
        const referenced = new Set<ProviderInstanceId>();
        for (const snapshot of yield* Effect.all([policy.current, policy.desired])) {
          for (const [id, config] of Object.entries(snapshot)) {
            if (config.driver !== "acpRegistry") continue;
            const settings = yield* Schema.decodeUnknownEffect(AcpRegistrySettings)(config.config);
            if (settings.source === "registry" && settings.agentId === request.input.agentId)
              referenced.add(ProviderInstanceId.make(id));
          }
        }
        if (referenced.size > 0)
          return yield* failure(
            "Remove Agent instances using this installation before uninstalling it.",
            "busy",
            (yield* activityForInstances([...referenced])).threadIds,
          );
        return yield* operations.withInactiveInstallation(
          request.input.agentId,
          catalog.uninstallManagedBinary(request.input),
        );
      }
      case "acp.connection.start": {
        const selected = yield* registry.getInstance(request.input.instanceId);
        if (!selected?.acpSessionManagement?.connect)
          return yield* failure("The ACP instance cannot be connected.");
        const config = yield* configuration(request.input.instanceId);
        return yield* operations.start(
          {
            operationId: request.input.operationId,
            kind: "connect",
            phase: "running",
            instanceId: request.input.instanceId,
            agentId: null,
            result: null,
            error: null,
          },
          `connect:${request.input.instanceId}:${request.input.cwd}:${createHash("sha256").update(JSON.stringify(config.entry)).digest("hex")}`,
          withWriter(
            withCurrent(selected, selected.acpSessionManagement.connect(request.input.cwd)),
          ),
        );
      }
      case "acp.auth.read":
        return yield* readAuth(request.input);
      case "acp.auth.start":
        return yield* withIdle(request.input.instanceId, (selected) =>
          selected
            .auth!.start(
              request.input.ownerId,
              idleBeforeMutation(selected),
              request.input.methodId,
              request.input.returnUrl,
              request.input.callbackMode,
            )
            .pipe(Effect.flatMap(encodeAuth)),
        );
      case "acp.auth.respond":
        return yield* auth
          .respond(request.input, request.input.ownerId)
          .pipe(Effect.flatMap(encodeAuth));
      case "acp.auth.complete":
        return yield* auth
          .complete(request.input, request.input.ownerId)
          .pipe(Effect.flatMap(encodeAuth));
      case "acp.auth.cancel":
        return yield* auth
          .cancel(request.input, request.input.ownerId)
          .pipe(Effect.flatMap(encodeAuth));
      case "acp.auth.logout":
        return yield* withIdle(request.input.instanceId, (selected) =>
          selected.auth!.logout(idleBeforeMutation(selected)).pipe(Effect.flatMap(encodeAuth)),
        );
      case "acp.urlAuth.accept":
        return { accepted: yield* coordinator.acceptUrlAuthentication(request.input) };
      case "acp.sessions.list": {
        const selected = yield* instance(request.input.instanceId);
        const result = yield* selected.acpSessionManagement.listSessions(request.input);
        if (result.nextCursor !== null && result.nextCursor === request.input.cursor)
          return yield* failure("The Agent returned a repeated session cursor.");
        const config = yield* configuration(request.input.instanceId);
        const sourceFingerprint = fingerprint(
          config.settings,
          request.input.instanceId,
          config.environment,
        );
        const mapped = yield* Effect.forEach(
          result.sessions,
          (session) =>
            Effect.gen(function* () {
              const threadId = importIdentity(
                request.input.instanceId,
                session.sessionId,
                sourceFingerprint,
              );
              const shell = yield* orchestrator.getThreadShell(threadId);
              return { ...session, importedThreadId: shell === null ? null : threadId };
            }),
          { concurrency: 8 },
        );
        return { ...result, sessions: mapped };
      }
      case "acp.sessions.prepareImport":
        return yield* prepareImport(request.input);
      case "acp.sessions.import":
        return yield* coordinator.withSessionMutation(
          Effect.gen(function* () {
            const input = request.input;
            const config = yield* configuration(input.instanceId);
            if (
              input.sourceFingerprint !==
              fingerprint(config.settings, input.instanceId, config.environment)
            )
              return yield* failure(
                "The Agent configuration changed since this import was prepared.",
              );
            const threadId = importIdentity(
              input.instanceId,
              input.sessionId,
              input.sourceFingerprint,
            );
            if (threadId !== input.threadId)
              return yield* failure("The import destination does not match this native session.");
            const existing = yield* orchestrator.getThreadShell(threadId);
            if (existing !== null) {
              if (existing.projectId !== input.projectId)
                return yield* failure(
                  "This native session is already imported into another Project.",
                );
              return { threadId };
            }
            const prepared = yield* prepareImport(input);
            if (prepared.cwd !== input.cwd)
              return yield* failure(
                "The native session directory changed. Prepare the import again.",
              );
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: input.commandId,
              threadId,
              projectId: input.projectId,
              title: input.title,
              modelSelection: { instanceId: input.instanceId, model: input.model },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: input.cwd,
              importedNativeThread: {
                ref: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  nativeId: input.sessionId,
                  strength: "strong",
                },
                metadata: {
                  itemIdentityVersion: 2,
                  title: input.title,
                  nativeImport: { canLoad: prepared.canLoad, canResume: prepared.canResume },
                },
              },
              createdBy: "user",
              creationSource: "web",
            });
            return { threadId };
          }),
        );
      case "acp.sessions.delete":
        return yield* withIdle(request.input.instanceId, (selected) =>
          coordinator.withSessionMutation(
            Effect.gen(function* () {
              const mapped = yield* sql<{
                thread_id: string;
              }>`SELECT json_extract(t.payload_json, '$.lineage.rootThreadId') AS thread_id FROM orchestration_v2_projection_provider_threads p JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id WHERE p.provider_instance_id = ${request.input.instanceId} AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ${request.input.sessionId} AND t.deleted_at IS NULL`;
              if (mapped.length > 0)
                return yield* failure(
                  "Remove the imported Nodex chat before deleting this native session.",
                  "busy",
                  [...new Set(mapped.map((row) => row.thread_id))],
                );
              yield* selected.acpSessionManagement.deleteSession(request.input);
              return { deleted: true as const };
            }),
          ),
        );
      case "acp.modelProviders.list":
        return yield* (yield* instance(
          request.input.instanceId,
        )).acpSessionManagement.listProviders(request.input.cwd);
      case "acp.modelProviders.set":
        return yield* withIdle(request.input.instanceId, (selected) =>
          Effect.gen(function* () {
            const management = selected.acpSessionManagement;
            yield* validateProviderMutation(
              (yield* management.listProviders(request.input.cwd)).providers,
              request.input,
              false,
            );
            const url = yield* Effect.try(() => new URL(request.input.baseUrl));
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
              return yield* failure(
                "Use an HTTP or HTTPS model service URL without embedded credentials.",
              );
            yield* mutateAgentSettings(selected, management.setProvider(request.input));
            yield* selected.snapshot.refresh;
            return yield* management.listProviders(request.input.cwd);
          }),
        );
      case "acp.modelProviders.disable":
        return yield* withIdle(request.input.instanceId, (selected) =>
          Effect.gen(function* () {
            const management = selected.acpSessionManagement;
            yield* validateProviderMutation(
              (yield* management.listProviders(request.input.cwd)).providers,
              request.input,
              true,
            );
            yield* mutateAgentSettings(selected, management.disableProvider(request.input));
            yield* selected.snapshot.refresh;
            return yield* management.listProviders(request.input.cwd);
          }),
        );
    }
  });
  return { execute };
});
