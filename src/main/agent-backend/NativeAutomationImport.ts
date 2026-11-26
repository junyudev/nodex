import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { v5 } from "uuid";
import { AutomationApplication } from "../../host/automation-application/AutomationApplication";
import { claudeAgent } from "../../shared/agents/claude";
import { agentProfilesFor } from "../../shared/agents/profiles";
import { areWorkspacePathsEquivalent } from "../../shared/codex-workspace-paths";
import type { FolderPlacement } from "../../shared/folder-placement";
import { nativeAutomationCreateDraft } from "../../shared/native-automation-draft";
import {
  CLAUDE_AUTOMATIONS,
  CODEX_AUTOMATIONS,
  nativeAutomationConversationIds,
  nativeAutomationConversationKey,
  type NativeAutomationBlocker,
  type NativeAutomationCandidate,
  type NativeAutomationCatalogResult,
  type NativeAutomationImportResult,
  type NativeAutomationImportRow,
  type NativeAutomationRun,
  type NativeAutomationSelection,
} from "../../shared/native-automation-import";
import type { NativeSessionSource } from "../../shared/native-session-catalog";
import type { Automation } from "../../shared/types";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../agent-runtime/AgentRuntimeApplication";
import { defaultClaudeNativeHistoryHome } from "../agent-runtime/AgentRuntimeNativeImportSources";
import { MainConfig } from "../app/MainConfig";
import { createOperationId } from "../core-runtime/operation-identity";
import { nativeSessionCwdAvailable } from "../platform/node/NativeSessionCatalogPaths";
import {
  claudeDesktopUserDataHomes,
  readClaudeNativeAutomations,
} from "../platform/node/native-automations/claude";
import { readCodexNativeAutomations } from "../platform/node/native-automations/codex";
import {
  folderPlacementPlaces,
  readFolderPlacements,
  resolveAndEnsureFolderProject,
} from "../project-application/FolderPlacement";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import { NativeSessionCatalog, prepareNativeSessionImport } from "./NativeSessionCatalog";

const RUN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_LIMIT = 20;
const HISTORY_CONCURRENCY = 4;
const stableId = (purpose: string, values: readonly string[]) =>
  v5(JSON.stringify([purpose, ...values]), v5.URL);
const sourceKey = (task: NativeAutomationCandidate) =>
  stableId("native-automation", [task.agent, task.sourceHome, task.sourceAutomationId]);
const historicalRunId = (task: NativeAutomationCandidate, nativeId: string) =>
  stableId("historical-automation-run", [sourceKey(task), nativeId.toLowerCase()]);
const taskTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

class NativeAutomationImportError extends Schema.TaggedError<NativeAutomationImportError>()(
  "NativeAutomationImportError",
  { message: Schema.String },
) {}

export class NativeAutomationImport extends Context.Service<
  NativeAutomationImport,
  {
    readonly catalog: Effect.Effect<NativeAutomationCatalogResult, unknown>;
    readonly importSelection: (
      selection: NativeAutomationSelection,
    ) => Effect.Effect<NativeAutomationImportResult>;
  }
>()("nodex/main/agent-backend/NativeAutomationImport") {}

type ProjectPlacement = Extract<FolderPlacement, { kind: "project" | "new-project" }>;
type ImportGroup = {
  readonly placement: FolderPlacement;
  readonly folders: readonly string[];
  readonly runs: readonly NativeAutomationRun[];
};
const isProjectPlacement = (placement: FolderPlacement): placement is ProjectPlacement =>
  placement.kind === "project" || placement.kind === "new-project";

export function recentNativeAutomationRuns(
  runs: readonly NativeAutomationRun[],
  now: number,
): readonly NativeAutomationRun[] {
  return runs
    .filter(
      ({ archived, updatedAt }) =>
        !archived && updatedAt >= now - RUN_WINDOW_MS && updatedAt <= now,
    )
    .toSorted(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        b.createdAt - a.createdAt ||
        a.nativeSessionId.localeCompare(b.nativeSessionId),
    )
    .slice(0, RUN_LIMIT);
}

/** Partition a task after resolving physical folders, with one owner for each source run. */
export function groupNativeAutomation(
  task: NativeAutomationCandidate,
  placements: ReadonlyMap<string, FolderPlacement>,
  now: number,
): readonly ImportGroup[] {
  const folderGroups = new Map<
    string,
    { placement: FolderPlacement; folders: string[]; runs: NativeAutomationRun[] }
  >();
  for (const folder of new Set(task.folders)) {
    const placement = placements.get(folder) ?? { kind: "missing" };
    const key = isProjectPlacement(placement) ? placement.projectId : placement.kind;
    const group = folderGroups.get(key) ?? { placement, folders: [], runs: [] };
    group.folders.push(folder);
    folderGroups.set(key, group);
  }
  const groups = [...folderGroups.values()];
  if (!groups.length) return [{ placement: { kind: "missing" }, folders: [], runs: [] }];
  if (task.kind === "heartbeat") return groups;
  const fallback = groups.find(({ placement }) => isProjectPlacement(placement)) ?? groups[0];
  for (const run of recentNativeAutomationRuns(task.runs, now)) {
    const cwd = run.cwd;
    const runPlacement = cwd ? placements.get(cwd) : undefined;
    const matchingFolder =
      cwd &&
      groups.find(({ folders }) =>
        folders.some((folder) => areWorkspacePathsEquivalent(folder, cwd)),
      );
    const group =
      matchingFolder ||
      (runPlacement &&
        isProjectPlacement(runPlacement) &&
        folderGroups.get(runPlacement.projectId)) ||
      fallback;
    group?.runs.push(run);
  }
  return groups;
}

export function nativeAutomationImportBlocker(
  task: NativeAutomationCandidate,
  placement: FolderPlacement,
  folders: readonly string[],
): NativeAutomationBlocker | null {
  if (task.schedule.kind === "unsupported") return task.schedule.reason;
  if (task.agent === CLAUDE_AUTOMATIONS && !task.conversationSource.instanceConfigId)
    return "no-claude-profile";
  if (task.kind === "heartbeat" && !task.heartbeatTarget) return "missing-heartbeat";
  if (!isProjectPlacement(placement)) return "missing-folder";
  const { draft } = nativeAutomationCreateDraft(
    { ...task, folders },
    {
      projectId: placement.projectId,
      timezone: "UTC",
      ...(task.heartbeatTarget && { targetSessionId: task.heartbeatTarget.nativeSessionId }),
    },
  );
  return draft ? null : "unsupported-task";
}

const originMatches = (automation: Automation, task: NativeAutomationCandidate) =>
  automation.importOrigin?.agent === task.agent &&
  automation.importOrigin.sourceHome === task.sourceHome &&
  automation.importOrigin.sourceAutomationId === task.sourceAutomationId;

const fail = (message: string) => new NativeAutomationImportError({ message });

const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const settings = yield* ApplicationSettings;
  const claude = yield* ClaudeNativeCatalog;
  const runtime = yield* AgentRuntimeApplication;
  const catalog = yield* NativeSessionCatalog;
  const projects = yield* ProjectWorkspace;
  const automation = yield* AutomationApplication;
  const importLane = yield* Semaphore.make(1);
  const places = folderPlacementPlaces(config);

  const readCandidates = Effect.fn("NativeAutomationImport.readCandidates")(function* () {
    const snapshot = yield* settings.snapshot();
    const desktopHomes =
      config.isolatedRunId && !config.environment.CLAUDE_USER_DATA_DIR
        ? []
        : claudeDesktopUserDataHomes(config);
    const configuredClaudeHome = defaultClaudeNativeHistoryHome(config);
    const codex = yield* readCodexNativeAutomations({
      codexHome: snapshot.codexHome.activeHomePath,
    });
    const results = desktopHomes.length
      ? yield* Effect.forEach(
          desktopHomes,
          (userDataHome) =>
            readClaudeNativeAutomations({
              userDataHome,
              nativeHome: configuredClaudeHome,
            }),
          { concurrency: HISTORY_CONCURRENCY },
        )
      : [];
    const distinct = new Map(
      [codex, ...results].flatMap(({ candidates }) =>
        candidates.map((candidate) => [sourceKey(candidate), candidate] as const),
      ),
    );
    const enabledProfiles = agentProfilesFor(snapshot.agentProfiles, claudeAgent.driver).filter(
      ({ enabled }) => enabled,
    );
    const profiles = results.some(({ candidates }) => candidates.length > 0)
      ? yield* Effect.forEach(
          enabledProfiles,
          ({ id }) =>
            claude.nativeHome(id).pipe(
              Effect.map((home) => ({ id, home })),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: HISTORY_CONCURRENCY },
        )
      : [];
    return yield* Effect.forEach(
      [...distinct.values()],
      (task) =>
        Effect.gen(function* () {
          if (task.agent === CLAUDE_AUTOMATIONS) {
            const history = task.conversationSource;
            const defaultProfile = profiles.find((profile) => profile?.home === history.nativeHome);
            // Desktop can launch Claude Code with its own configuration directory. A task's
            // linked transcripts (or their import receipts) identify which enabled profile reads it.
            const samples = task.runs.filter(({ archived }) => !archived).slice(0, 3);
            const observed = samples.length
              ? (yield* Effect.forEach(
                  profiles.filter((profile) => profile !== null),
                  (profile) =>
                    Effect.gen(function* () {
                      for (const sample of samples) {
                        const info = yield* claude
                          .nativeSessionInfo({
                            instanceConfigId: profile.id,
                            expectedHome: profile.home,
                            nativeSessionId: sample.nativeSessionId,
                          })
                          .pipe(Effect.orElseSucceed(() => null));
                        if (info) return profile;
                      }
                      const copies = yield* runtime
                        .findNativeImports({
                          backendKind: CLAUDE_AUTOMATIONS,
                          sourceHome: profile.home,
                          nativeThreadIds: samples.map(({ nativeSessionId }) => nativeSessionId),
                        })
                        .pipe(Effect.orElseSucceed(() => []));
                      return copies.length ? profile : null;
                    }),
                  { concurrency: HISTORY_CONCURRENCY },
                )).filter((profile) => profile !== null)
              : [];
            const home =
              samples.length === 0
                ? defaultProfile
                : new Set(observed.map((profile) => profile.home)).size === 1
                  ? observed[0]
                  : observed.find((profile) => profile.home === history.nativeHome);
            return home
              ? {
                  ...task,
                  conversationSource: {
                    ...history,
                    instanceConfigId: home.id,
                    nativeHome: home.home,
                  },
                }
              : task;
          }
          if (task.kind !== "heartbeat" || !task.heartbeatTarget) return task;
          const preview = yield* catalog
            .previewImport({
              reference: task.heartbeatTarget.nativeSessionId,
              backendKind: CODEX_AUTOMATIONS,
            })
            .pipe(Effect.orElseSucceed(() => ({ matches: [] })));
          const located = preview.matches.find(
            ({ nativeHome }) => nativeHome === task.conversationSource.nativeHome,
          );
          if (located?.cwd) return { ...task, folders: [located.cwd] };
          return { ...task, heartbeatTarget: undefined };
        }),
      { concurrency: HISTORY_CONCURRENCY },
    );
  });

  const readPlacements = Effect.fn("NativeAutomationImport.readPlacements")(function* (
    candidates: readonly NativeAutomationCandidate[],
  ) {
    const folders = [
      ...new Set(
        candidates.flatMap((task) => [
          ...task.folders,
          ...task.runs.flatMap(({ cwd }) => (cwd ? [cwd] : [])),
        ]),
      ),
    ];
    const placements = yield* readFolderPlacements(projects, places, folders, true);
    return new Map(
      folders.map((folder, index) => [folder, placements[index] ?? { kind: "missing" }]),
    );
  });

  const matchingAutomation = (
    definitions: readonly Automation[],
    task: NativeAutomationCandidate,
    placement: FolderPlacement,
  ) =>
    isProjectPlacement(placement)
      ? definitions.find(
          (definition) =>
            originMatches(definition, task) &&
            definition.scope.kind === "project" &&
            definition.scope.projectId === placement.projectId,
        )
      : undefined;

  const statusFor = Effect.fn("NativeAutomationImport.status")(function* (
    task: NativeAutomationCandidate,
    group: ImportGroup,
    existing: Automation | undefined,
  ): Effect.fn.Return<NativeAutomationImportRow["status"], unknown> {
    if (existing?.status === "DELETED")
      return { kind: "unavailable", reason: "deleted-automation" };
    if (existing && isProjectPlacement(group.placement)) {
      const runs = yield* Effect.forEach(
        group.runs,
        ({ nativeSessionId }) => automation.runs.get(historicalRunId(task, nativeSessionId)),
        { concurrency: HISTORY_CONCURRENCY },
      );
      if (runs.every((run) => run !== null)) return { kind: "imported", automationId: existing.id };
    }
    const reason = nativeAutomationImportBlocker(task, group.placement, group.folders);
    return reason ? { kind: "unavailable", reason } : { kind: "ready" };
  });

  const readCatalog = Effect.gen(function* () {
    const candidates = yield* readCandidates();
    if (!candidates.length) return { rows: [], cronConversationKeys: [] };
    const now = yield* Clock.currentTimeMillis;
    const placements = yield* readPlacements(candidates);
    const definitions = yield* automation.automations.list();
    const rows = yield* Effect.forEach(
      candidates.flatMap((task) =>
        groupNativeAutomation(task, placements, now).map((group) => ({ task, group })),
      ),
      ({ task, group }) =>
        Effect.gen(function* () {
          const { folders, placement, runs } = group;
          const key = sourceKey(task);
          const status = yield* statusFor(
            task,
            group,
            matchingAutomation(definitions, task, placement),
          );
          return {
            id: stableId("automation-import-row", [key, ...folders]),
            selection: { sourceKey: key, folders },
            agent: task.agent,
            kind: task.kind,
            name: task.name,
            schedule: task.schedule,
            placement,
            runCount: runs.length,
            status,
          } satisfies NativeAutomationImportRow;
        }),
      { concurrency: HISTORY_CONCURRENCY },
    );
    const cronConversationKeys = [...nativeAutomationConversationIds(candidates)].flatMap(
      ([agent, byHome]) =>
        [...byHome].flatMap(([home, ids]) =>
          [...ids].map((id) => nativeAutomationConversationKey(agent, home, id)),
        ),
    );
    return { rows, cronConversationKeys };
  });

  const copyChat = Effect.fn("NativeAutomationImport.copyChat")(function* (input: {
    task: NativeAutomationCandidate;
    nativeSessionId: string;
    projectId: string;
    cwd: string;
    now: number;
    runId?: string;
  }) {
    const { task, projectId, cwd, now, runId } = input;
    const nativeSessionId = input.nativeSessionId.toLowerCase();
    const source = task.conversationSource;
    const identity: NativeSessionSource | null =
      source.backendKind === CODEX_AUTOMATIONS
        ? { backendKind: source.backendKind }
        : source.instanceConfigId
          ? { backendKind: source.backendKind, instanceConfigId: source.instanceConfigId }
          : null;
    if (!identity) return yield* fail("Enable the Claude profile that uses this history folder.");
    const copies = yield* runtime.findNativeImports({
      backendKind: identity.backendKind,
      sourceHome: source.nativeHome,
      nativeThreadIds: [nativeSessionId],
    });
    for (const copy of copies) {
      const session = yield* projects.getProjectSession(copy.importedSessionId);
      if (!session || session.archived) continue;
      if (session.projectId !== projectId)
        yield* runtime.moveSession({
          operationId: createOperationId("automation-import.move-chat"),
          sessionId: session.id,
          projectId,
        });
      return { sessionId: session.id, title: session.displayTitle };
    }
    const requestId = stableId("automation-conversation-import", [
      identity.backendKind,
      identity.instanceConfigId ?? "",
      source.nativeHome,
      nativeSessionId,
      cwd,
      runId ?? "heartbeat",
    ]);
    const request = {
      ...identity,
      nativeSessionId,
      requestId,
      cwd,
      expectedHome: source.nativeHome,
      acceptedAt: now,
    };
    const imported = yield* runtime.submitNativeImport(
      request,
      prepareNativeSessionImport(catalog, request),
      Effect.succeed(projectId),
      runId,
    );
    if (imported.kind === "not_admitted") return yield* fail(imported.message);
    const session = yield* projects.getProjectSession(imported.sessionId);
    return { sessionId: imported.sessionId, title: session?.displayTitle };
  });

  const importGroup = Effect.fn("NativeAutomationImport.importGroup")(function* (
    task: NativeAutomationCandidate,
    group: ImportGroup,
    now: number,
    existing?: Automation,
  ) {
    if (existing?.status === "DELETED") return yield* fail("This Automation was deleted.");
    const folder = group.folders[0];
    if (!folder) return yield* fail("The working folder is unavailable.");
    const destination = yield* resolveAndEnsureFolderProject({
      projects,
      places,
      folder,
      explicit: true,
    });
    if (destination.kind !== "project")
      return yield* fail("The working folder has no active Project.");
    const { projectId } = destination;
    const target =
      task.kind === "heartbeat" && task.heartbeatTarget && !existing
        ? yield* copyChat({
            task,
            nativeSessionId: task.heartbeatTarget.nativeSessionId,
            projectId,
            cwd: folder,
            now,
          })
        : null;
    const { draft } = nativeAutomationCreateDraft(
      { ...task, folders: group.folders },
      {
        projectId,
        timezone: taskTimezone(),
        targetSessionId: target?.sessionId,
      },
    );
    const definition =
      existing ??
      (draft
        ? yield* automation.automations.importDefinition(draft)
        : yield* fail("Nodex can’t import this task."));
    if (definition.status === "DELETED") return yield* fail("This Automation was deleted.");
    const results = yield* Effect.forEach(group.runs, (run) =>
      Effect.gen(function* () {
        const runId = historicalRunId(task, run.nativeSessionId);
        if (yield* automation.runs.get(runId)) return;
        const sourceCwd = run.cwd;
        const cwd =
          sourceCwd && (yield* Effect.promise(() => nativeSessionCwdAvailable(sourceCwd)))
            ? sourceCwd
            : folder;
        const copy = yield* copyChat({
          task,
          nativeSessionId: run.nativeSessionId,
          projectId,
          cwd,
          now,
          runId,
        });
        yield* automation.runs.recordHistorical({
          run_id: runId,
          automation_id: definition.id,
          session_id: copy.sessionId,
          session_title: run.title ?? copy.title,
          source_cwd: run.cwd ?? cwd,
          created_at_ms: run.createdAt,
          updated_at_ms: run.updatedAt,
        });
      }).pipe(Effect.result),
    );
    const firstFailure = results.find((result) => result._tag === "Failure");
    if (firstFailure) return yield* firstFailure.failure;
    return definition.id;
  });

  const importSelection = Effect.fn("NativeAutomationImport.importSelection")(function* (
    selection: NativeAutomationSelection,
  ) {
    const task = (yield* readCandidates()).find(
      (candidate) => sourceKey(candidate) === selection.sourceKey,
    );
    if (!task) return yield* fail("This task is no longer available. Refresh and try again.");
    const now = yield* Clock.currentTimeMillis;
    const placements = yield* readPlacements([task]);
    const groups = groupNativeAutomation(task, placements, now).filter(({ folders }) =>
      folders.some((folder) => selection.folders.includes(folder)),
    );
    if (!groups.length) return yield* fail("The working folder changed. Refresh and try again.");
    const definitions = yield* automation.automations.list();
    return yield* Effect.forEach(groups, (group) =>
      Effect.gen(function* () {
        const existing = matchingAutomation(definitions, task, group.placement);
        const state = yield* statusFor(task, group, existing);
        if (state.kind === "imported") return state.automationId;
        if (state.kind === "unavailable")
          return yield* fail("This task is unavailable. Refresh to see why.");
        return yield* importGroup(task, group, now, existing);
      }),
    );
  });

  return NativeAutomationImport.of({
    catalog: readCatalog,
    importSelection: (selection) =>
      importLane.withPermit(importSelection(selection)).pipe(
        Effect.map((automationIds) => ({ kind: "imported" as const, automationIds })),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: "failed" as const,
            message:
              cause instanceof NativeAutomationImportError ||
              Schema.is(AgentRuntimeApplicationError)(cause)
                ? cause.message
                : "Couldn’t finish importing this Automation. Try again to continue.",
          }),
        ),
      ),
  });
});

export const live = Layer.effect(NativeAutomationImport, make);
