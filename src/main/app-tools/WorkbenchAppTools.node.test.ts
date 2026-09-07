import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type {
  PresentationAnchor,
  WorkbenchObservedTab,
} from "../../shared/nodex-app-tools/workbench";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { WorkbenchObservation, type WorkbenchObservationRecord } from "./WorkbenchObservation";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { make } from "./WorkbenchAppTools";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  readOnly: false,
  scope: "project",
  source: "project_turn",
};
const tab: WorkbenchObservedTab = {
  tabId: "page:secret",
  panelId: "right",
  groupId: "group",
  protected: false,
  persisted: true,
  preview: false,
  selected: true,
  visible: true,
  auxiliary: null,
  surface: {
    id: "page:secret",
    kind: "page_stage",
    titleSnapshot: "Renderer secret",
    config: { pageId: "page-A", accessContext: { kind: "library" } },
  },
};
const anchor: PresentationAnchor = {
  windowSessionId: "window",
  rendererGeneration: "generation",
  sceneOwner: { kind: "project", projectId: "project" },
  presentationRevision: 1,
  focusedTarget: null,
  selectedTabs: [tab],
  capturedAt: "2026-09-08T00:00:00.000Z",
};
const record: WorkbenchObservationRecord = {
  observationId: "00000000-0000-4000-8000-000000000001",
  capturedAt: anchor.capturedAt,
  expiresAt: "2026-09-08T00:01:00.000Z",
  reference: {
    windowSessionId: anchor.windowSessionId,
    rendererGeneration: anchor.rendererGeneration,
    sceneOwner: anchor.sceneOwner!,
  },
  observation: {
    sceneOwner: anchor.sceneOwner!,
    selectedSceneOwner: anchor.sceneOwner,
    presentationRevision: 1,
    mounted: true,
    focusedTarget: null,
    tabs: [tab],
    groups: [],
    panels: [],
    splits: [],
  },
};
const input: AppToolInvocation = {
  name: "get_session_context",
  arguments: {},
  caller: {
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    hostId: "local",
    generation: 1,
    isActive: () => true,
  },
};

const setup = (
  options: {
    restricted?: boolean;
    changed?: boolean;
    withdraw?: () => void;
    anchor?: PresentationAnchor;
  } = {},
) =>
  make.pipe(
    Effect.provideService(TerminalSessions, {} as never),
    Effect.provideService(GitWorkerRuntime, {} as never),
    Effect.provideService(NodexAgentApplication, {} as never),
    Effect.provideService(CoreModules, {} as never),
    Effect.provideService(CodexTurnAuthority, {
      capture: () => Effect.succeed(authority),
    } as never),
    Effect.provideService(CodexTurnPresentation, { read: () => options.anchor ?? anchor } as never),
    Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
    Effect.provideService(ProjectWorkspace, {
      getThread: () =>
        Effect.succeed({ sessionId: "session", projectId: "project", cwd: "/project" }),
    } as never),
    Effect.provideService(WorkbenchAgentBridge, {} as never),
    Effect.provideService(NodexAppToolAuthority, {
      bind: () => Effect.succeed({ authority }),
    } as never),
    Effect.provideService(WorkbenchObservation, {
      capture: () =>
        Effect.succeed(
          options.changed
            ? {
                ...record,
                observation: {
                  ...record.observation,
                  presentationRevision: 2,
                  tabs: [
                    {
                      ...tab,
                      surface: {
                        ...tab.surface!,
                        kind: "page_stage",
                        config: { pageId: "page-B", accessContext: { kind: "library" } },
                      },
                    },
                  ],
                },
              }
            : record,
        ),
      resolve: () => Effect.succeed(record),
    } as never),
    Effect.provideService(WorkbenchContentAccess, {
      describe: (request: { surface: { config: { pageId: string } } }) =>
        Effect.sync(() => {
          options.withdraw?.();
          return options.restricted
            ? { status: "restricted", reason: "consent_required" }
            : {
                status: "authorized",
                kind: "page",
                pageId: request.surface.config.pageId,
                libraryId: "library",
                title: "Canonical title",
                displayedAccessContext: { kind: "library" },
              };
        }),
    } as never),
  );

it.effect("redacts restricted content identities and renderer titles from tab observations", () =>
  Effect.gen(function* () {
    const execute = yield* setup({ restricted: true });
    const result = yield* execute(input);
    assert.strictEqual(result.isError, undefined);
    const json = JSON.stringify(result);
    assert.strictEqual(json.includes("page:secret"), false);
    assert.strictEqual(json.includes("page-A"), false);
    assert.strictEqual(json.includes("Renderer secret"), false);
    assert.strictEqual(json.includes("consent_required"), true);
  }),
);

it.effect(
  "keeps the submitted Page after the same tab changes targets and removes its actionable handle",
  () =>
    Effect.gen(function* () {
      const execute = yield* setup({ changed: true });
      const result = yield* execute(input);
      const presentation = result.structuredContent!.presentation as {
        selectedTabs: Record<string, unknown>[];
        changedSinceSubmission: boolean;
      };
      assert.strictEqual(presentation.changedSinceSubmission, true);
      assert.strictEqual(presentation.selectedTabs[0]!.pageId, "page-A");
      assert.strictEqual(presentation.selectedTabs[0]!.tabId, null);
      assert.strictEqual(presentation.selectedTabs[0]!.targetState, "changed");
    }),
);

it.effect("withdraws an authorized result when the caller ends during content resolution", () =>
  Effect.gen(function* () {
    let active = true;
    const execute = yield* setup({
      withdraw: () => {
        active = false;
      },
    });
    const result = yield* execute({
      ...input,
      caller: { ...input.caller, isActive: () => active },
    });
    assert.deepStrictEqual(result.structuredContent, { error: { code: "authority_unavailable" } });
  }),
);

it.effect("does not resolve an unhydrated submitted default against a later default View", () =>
  Effect.gen(function* () {
    const execute = yield* setup({
      anchor: {
        ...anchor,
        selectedTabs: [
          {
            ...tab,
            surface: {
              id: "view",
              kind: "db_view",
              titleSnapshot: "Default",
              config: {
                accessContext: { kind: "project", projectId: "project" },
                target: { kind: "project-default" },
              },
            },
          },
        ],
      },
    });
    const result = yield* execute(input);
    const presentation = result.structuredContent!.presentation as {
      selectedTabs: Record<string, unknown>[];
    };
    assert.strictEqual(presentation.selectedTabs[0]!.status, "restricted");
    assert.strictEqual(presentation.selectedTabs[0]!.reason, "unavailable");
    assert.strictEqual(Object.hasOwn(presentation.selectedTabs[0]!, "viewId"), false);
  }),
);
