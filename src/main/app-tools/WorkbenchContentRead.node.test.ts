import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type {
  WorkbenchAgentRequestBody,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import type {
  WorkbenchPrepareContentResult,
  WorkbenchPreparedPageContent,
  WorkbenchValidateContentResult,
} from "../../shared/nodex-app-tools/workbench-content";
import { FetchV6OutputSchema } from "../../shared/nodex-agent-tools/v6-schemas";
import { BlockIdSchema } from "../../shared/nodex-agent-tools/base-schemas";
import type {
  NativeNodexAgentFetchObservation,
  NativeNodexAgentFetchRequest,
} from "../core-client/native-nodex-agent-fetch";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { make, type WorkbenchContentReadInput } from "./WorkbenchContentRead";

const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread:actor",
  turnId: "turn:actor",
  rootThreadId: "thread:actor",
  actorProjectId: "project:actor",
  libraryId: "library:current",
  storeEpoch: "epoch:current",
  frozenAtMs: 1,
  readOnly: true,
  scope: "project",
  source: "project_turn",
};
const input: WorkbenchContentReadInput = {
  authority,
  callId: "call:exact",
  taskAccess: {
    kind: "consent",
    scope: "task",
    rootThreadId: authority.rootThreadId,
    actorProjectId: authority.actorProjectId,
    libraryId: authority.libraryId,
    storeEpoch: authority.storeEpoch,
    grants: [{ root: { kind: "page", pageId: "page:target" }, access: "read" }],
  },
  description: {
    status: "authorized",
    kind: "page",
    pageId: "page:target",
    title: "Described title",
    libraryId: authority.libraryId,
    displayedAccessContext: { kind: "library" },
  },
  live: {
    reference: {
      windowSessionId: "window:exact",
      rendererGeneration: "generation:exact",
      sceneOwner: { kind: "project", projectId: "project:displayed" },
    },
    tabId: "tab:exact",
    expectedPresentationRevision: 4,
  },
  isCurrent: Effect.succeed(true),
};
const prepared: WorkbenchPreparedPageContent = {
  status: "ready",
  token: "01980000-0000-7000-8000-000000000001",
  editorSurfaceId: "editor:exact",
  pageId: "page:target",
  documentId: "document:target",
  libraryId: authority.libraryId,
  accessContext: { kind: "library" },
  storeEpoch: authority.storeEpoch,
  generation: 2,
  expectedHeadSeq: 10,
  localEditRevision: 3,
  preparedAt: "2026-09-08T00:00:00.000Z",
  expiresAt: "2026-09-08T00:01:00.000Z",
};
const validation: WorkbenchValidateContentResult = {
  status: "synchronized",
  token: prepared.token,
  headSeq: 11,
  localEditRevision: 3,
  checkedAt: "2026-09-08T00:00:01.000Z",
};
const observation = (
  markdown = "- Canonical paragraph\n",
): Extract<NativeNodexAgentFetchObservation, { ok: true }> => ({
  ok: true,
  tool: "fetch",
  document: {
    documentId: prepared.documentId,
    ownerPageId: prepared.pageId,
    targetBlockId: prepared.pageId,
    storeEpoch: authority.storeEpoch,
    generation: 2,
    headSeq: 11,
    commitHead: 20,
  },
  validators: { title: `nxe1.${"a".repeat(43)}`, body: `nxe1.${"b".repeat(43)}` },
  output: FetchV6OutputSchema.parse({
    data: {
      resource: {
        id: prepared.pageId,
        type: "page",
        pageKey: null,
        title: { markdown: "Canonical title", etag: `nxe1.${"a".repeat(43)}` },
        lifecycle: "active",
        location: { kind: "library", libraryId: authority.libraryId },
      },
      content: {
        format: "markdown",
        markdown,
        contentHash: "a".repeat(64),
        etag: `nxe1.${"b".repeat(43)}`,
      },
    },
  }),
});

const setup = (
  options: {
    preparation?: WorkbenchPrepareContentResult;
    validation?: WorkbenchValidateContentResult;
    observation?: NativeNodexAgentFetchObservation;
    onRead?: () => void;
  } = {},
) =>
  Effect.gen(function* () {
    const reads: NativeNodexAgentFetchRequest[] = [];
    const requests: WorkbenchAgentRequestBody[] = [];
    const service = yield* make.pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile:current" } } as never),
      Effect.provideService(CoreModules, {
        query: { read: () => Effect.die("Unexpected View read") },
      } as never),
      Effect.provideService(NodexAgentApplication, {
        readPageObservation: (request: NativeNodexAgentFetchRequest) =>
          Effect.sync(() => {
            reads.push(request);
            options.onRead?.();
            return options.observation ?? observation();
          }),
      } as unknown as NodexAgentApplication["Service"]),
      Effect.provideService(WorkbenchAgentBridge, {
        request: (_reference: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
          Effect.sync(() => {
            requests.push(body);
            if (body.kind === "prepare_content")
              return { kind: body.kind, preparation: options.preparation ?? prepared };
            if (body.kind === "validate_content")
              return { kind: body.kind, validation: options.validation ?? validation };
            throw new Error("Unexpected renderer request");
          }),
      } as unknown as WorkbenchAgentBridge["Service"]),
    );
    return { service, reads, requests };
  });

it.effect(
  "reads the exact authorized Page and returns one synchronized snapshot with its validators",
  () =>
    Effect.gen(function* () {
      const { service, reads, requests } = yield* setup();
      const result = yield* service.read(input);
      assert.equal(result.status, "ready");
      if (result.status !== "ready" || result.kind !== "page") return;
      assert.equal(result.readiness, "synchronized");
      assert.deepEqual(result.output, observation().output);
      assert.deepEqual(result.validators, observation().validators);
      assert.deepEqual(result.document, observation().document);
      assert.equal(result.synchronization?.editorSurfaceId, prepared.editorSurfaceId);
      assert.deepEqual(reads[0], {
        tool: "fetch",
        projectId: authority.actorProjectId,
        authority,
        callId: input.callId,
        resourceAccess: input.taskAccess,
        input: {
          id: BlockIdSchema.parse(prepared.pageId),
          format: "markdown",
          includeDataSource: false,
        },
      });
      assert.deepEqual(requests, [
        {
          kind: "prepare_content",
          sceneOwner: input.live!.reference.sceneOwner,
          tabId: input.live!.tabId,
          expectedPresentationRevision: 4,
        },
        { kind: "validate_content", token: prepared.token },
      ]);
    }),
);

it.effect(
  "keeps stable target reads canonical and rejects restricted descriptions before a body read",
  () =>
    Effect.gen(function* () {
      const { service, reads, requests } = yield* setup();
      const result = yield* service.read({ ...input, live: undefined });
      assert.equal(result.status === "ready" && result.readiness, "canonical");
      assert.equal(requests.length, 0);
      assert.deepEqual(
        yield* service.read({
          ...input,
          description: { status: "restricted", reason: "access_denied" },
        }),
        { status: "access_denied" },
      );
      assert.equal(reads.length, 1);
    }),
);

it.effect(
  "does not fall back to Core content when the live editor is pending or targets another surface",
  () =>
    Effect.gen(function* () {
      for (const preparation of [
        { status: "pending_local_edits" as const },
        { ...prepared, pageId: "page:other" },
        {
          ...prepared,
          accessContext: { kind: "project" as const, projectId: authority.actorProjectId },
        },
        { ...prepared, storeEpoch: "epoch:old" },
      ]) {
        const { service, reads } = yield* setup({ preparation });
        const result = yield* service.read(input);
        assert.equal(
          result.status,
          preparation.status === "ready" ? "stale_presentation" : "pending_local_edits",
        );
        assert.equal(reads.length, 0);
      }
    }),
);

it.effect(
  "rejects generation changes, advanced remote heads, new local edits and expired editor tokens",
  () =>
    Effect.gen(function* () {
      const cases = [
        {
          observation: { ...observation(), document: { ...observation().document, generation: 3 } },
        },
        { observation: { ...observation(), document: { ...observation().document, headSeq: 9 } } },
        { validation: { ...validation, headSeq: 12 } },
        { validation: { ...validation, localEditRevision: 4 } },
        { validation: { ...validation, token: "01980000-0000-7000-8000-000000000002" } },
        { validation: { status: "expired" as const } },
      ];
      for (const item of cases) {
        const { service } = yield* setup(item);
        assert.deepEqual(yield* service.read(input), { status: "stale_presentation" });
      }
    }),
);

it.effect(
  "discards withdrawn calls and rejects an oversized Markdown result without partial output",
  () =>
    Effect.gen(function* () {
      let current = true;
      const cancelled = yield* setup({
        onRead: () => {
          current = false;
        },
      });
      assert.deepEqual(
        yield* cancelled.service.read({ ...input, isCurrent: Effect.sync(() => current) }),
        { status: "cancelled" },
      );
      assert.equal(cancelled.requests.length, 1);
      const oversized = yield* setup({ observation: observation("字".repeat(22_000)) });
      assert.deepEqual(yield* oversized.service.read(input), { status: "result_too_large" });
      assert.equal(oversized.requests.length, 1);
    }),
);
