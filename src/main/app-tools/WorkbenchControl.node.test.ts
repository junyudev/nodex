import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { WorkbenchCommandEnvelope } from "../../shared/nodex-app-tools/workbench-commands";
import { workbenchControlSchemas } from "../../shared/nodex-app-tools/workbench-control-schemas";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { WorkbenchObservation, type WorkbenchObservationRecord } from "./WorkbenchObservation";
import { workbenchObservationHandle } from "./workbench-observation-page";
import { make } from "./WorkbenchControl";

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
const observationId = "00000000-0000-4000-8000-000000000001";
const record: WorkbenchObservationRecord = {
  observationId,
  capturedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2026-09-08T00:01:00.000Z",
  reference: {
    windowSessionId: "window",
    rendererGeneration: "generation",
    sceneOwner: { kind: "pages" },
  },
  observation: {
    sceneOwner: { kind: "pages" },
    selectedSceneOwner: { kind: "pages" },
    presentationRevision: 7,
    mounted: true,
    focusedTarget: null,
    panels: [],
    splits: [],
    groups: [
      {
        groupId: "raw-group",
        panelId: "right",
        tabIds: ["raw-page-id"],
        selectedTabId: "raw-page-id",
        focused: true,
        visible: true,
      },
    ],
    tabs: [
      {
        tabId: "raw-page-id",
        panelId: "right",
        groupId: "raw-group",
        protected: false,
        persisted: true,
        preview: false,
        selected: true,
        visible: true,
        auxiliary: null,
        surface: {
          id: "raw-page-id",
          titleSnapshot: "Page",
          kind: "page_stage",
          config: { pageId: "page", accessContext: { kind: "library" } },
        },
      },
    ],
  },
};
const context = {
  invocation: {
    name: "close_tab",
    arguments: {
      observationId,
      tabId: workbenchObservationHandle(observationId, "tab", "raw-page-id"),
      operationId: "retry",
    },
    caller: {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      hostId: "local",
      generation: 1,
      isActive: () => true,
    },
  },
  principal: {
    profileId: "profile",
    authorityFingerprint: "authority",
    hostId: "local",
    backendGeneration: 1,
  },
  authority,
  isCurrent: Effect.succeed(true),
};
const setup = (requests: WorkbenchCommandEnvelope[], snapshot = record) =>
  make.pipe(
    Effect.provideService(WorkbenchObservation, {
      forCommand: () => Effect.succeed(snapshot),
    } as never),
    Effect.provideService(WorkbenchAgentBridge, {
      request: (_reference: unknown, request: { envelope: WorkbenchCommandEnvelope }) =>
        Effect.sync(() => {
          requests.push(request.envelope);
          return {
            kind: "command",
            receipt: {
              operationId: request.envelope.operationId,
              sceneOwner: record.reference.sceneOwner,
              applied: true,
              persisted: true,
              presentationRevision: 8,
              layoutRevision: 3,
              tabId: "raw-page-id",
              groupId: "raw-group",
              error: null,
            },
          };
        }),
    } as never),
    Effect.provideService(WorkbenchContentAccess, {
      describe: () =>
        Effect.succeed({
          status: "authorized",
          kind: "page",
          pageId: "page",
          title: "Page",
          libraryId: "library",
          displayedAccessContext: { kind: "library" },
        }),
    } as never),
    Effect.provideService(ProjectWorkspace, {} as never),
  );

it.effect(
  "translates opaque handles and preserves the original revision and operation on exact retries",
  () =>
    Effect.gen(function* () {
      const requests: WorkbenchCommandEnvelope[] = [];
      const execute = yield* setup(requests);
      const first = yield* execute(context);
      const second = yield* execute(context);
      assert.deepStrictEqual(requests[0], {
        operationId: "retry",
        sceneOwner: { kind: "pages" },
        expectedPresentationRevision: 7,
        command: { kind: "close_tab", tabId: "raw-page-id" },
      });
      assert.deepStrictEqual(requests[1], requests[0]);
      assert.deepStrictEqual(second, first);
      assert.strictEqual(first.structuredContent!.refreshRequired, true);
      assert.strictEqual(Object.hasOwn(first.structuredContent!, "tabId"), false);
    }),
);

it.effect(
  "rejects raw handles, read-only turns and withdrawn authority before renderer dispatch",
  () =>
    Effect.gen(function* () {
      const requests: WorkbenchCommandEnvelope[] = [];
      const execute = yield* setup(requests);
      const invalid = yield* execute({
        ...context,
        invocation: {
          ...context.invocation,
          arguments: { ...context.invocation.arguments, tabId: "raw-page-id" },
        },
      });
      assert.strictEqual(invalid.isError, true);
      const readOnly = yield* execute({ ...context, authority: { ...authority, readOnly: true } });
      assert.deepStrictEqual(readOnly.structuredContent, { error: { code: "read_only_turn" } });
      const withdrawn = yield* execute({ ...context, isCurrent: Effect.succeed(false) });
      assert.deepStrictEqual(withdrawn.structuredContent, {
        error: { code: "authority_unavailable" },
      });
      assert.strictEqual(requests.length, 0);
      const otherProject = yield* setup(requests, {
        ...record,
        reference: { ...record.reference, sceneOwner: { kind: "project", projectId: "other" } },
      });
      assert.deepStrictEqual((yield* otherProject(context)).structuredContent, {
        error: { code: "access_denied" },
      });
      assert.strictEqual(requests.length, 0);
    }),
);

it("accepts semantic open targets while rejecting runtime identity and arbitrary descriptor injection", () => {
  const input = {
    observationId,
    panelId: "right",
    groupId: "group",
    target: { kind: "browser", url: "https://example.com" },
  };
  assert.strictEqual(workbenchControlSchemas.open_tab.safeParse(input).success, true);
  assert.strictEqual(
    workbenchControlSchemas.open_tab.safeParse({
      ...input,
      target: { ...input.target, browserStorageId: "other" },
    }).success,
    false,
  );
  assert.strictEqual(
    workbenchControlSchemas.open_tab.safeParse({
      ...input,
      target: { kind: "browser", url: "javascript:alert(1)" },
    }).success,
    false,
  );
});
