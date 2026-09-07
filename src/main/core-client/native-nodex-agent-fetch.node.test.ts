import { describe, expect, it } from "vitest";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { BlockIdSchema } from "../../shared/nodex-agent-tools/base-schemas";
import type { NativeNodexAgentCore } from "./native-nodex-agent-core";
import {
  readNativeFetch,
  readNativeFetchObservation,
  type NativeNodexAgentFetchRequest,
} from "./native-nodex-agent-fetch";
import { FakeCoreClient } from "./testing/fake-core-client";

const pageId = "01980000-0000-7000-8000-000000000001";
const documentId = "01980000-0000-7000-8000-000000000002";
const etag = `nxe1.${"a".repeat(43)}`;
const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "thread:actor",
  turnId: "turn:actor",
  rootThreadId: "thread:actor",
  actorProjectId: "project:actor",
  libraryId: "library:current",
  storeEpoch: "epoch:current",
  scope: "project",
  source: "project_turn",
  frozenAtMs: 1,
  readOnly: true,
};
const request: NativeNodexAgentFetchRequest = {
  tool: "fetch",
  projectId: authority.actorProjectId,
  authority,
  callId: "call:exact",
  input: {
    id: BlockIdSchema.parse(pageId),
    format: "markdown",
    includeDataSource: false,
    prepareFor: [{ kind: "title" }, { kind: "body" }],
  },
};

const fixture = (snapshotEpoch = authority.storeEpoch) => {
  const client = new FakeCoreClient();
  client.enqueueRead({
    contract_version: 52,
    store_epoch: authority.storeEpoch,
    commit_head: 8,
    authorization: null,
    value: {
      kind: "agent_block_target",
      value: {
        block_id: pageId,
        block_type: "page",
        lifecycle: "active",
        owner_page_id: pageId,
        document_id: documentId,
        document_generation: 2,
        owner_page: {
          page: {
            title: "Old detail title",
            parent: { kind: "library", libraryId: authority.libraryId },
          },
          data_source_context: { kind: "standalone" },
          intrinsic_properties: [],
        },
      },
    },
  } as never);
  client.enqueueDocumentRead({
    contract_version: 14,
    store_epoch: snapshotEpoch,
    commit_head: 12,
    authorization: null,
    value: {
      kind: "agent_semantic_snapshot",
      snapshot: {
        document_id: documentId,
        owner_block_id: pageId,
        target_block_id: pageId,
        generation: 2,
        head_seq: 11,
        rich_title: [{ type: "text", text: "Current title", styles: {} }],
        nested_markdown: "- Current paragraph\n",
        plain_text: "Current paragraph",
        blocks: [],
        title_etag: etag,
        body_etag: etag,
        has_more: false,
        next_cursor: null,
      },
    },
  } as never);
  const projects: string[] = [];
  const runtime = {
    identity: { profileId: "profile:current" },
    rootClient: client,
    clientForProject: (projectId: string) => {
      projects.push(projectId);
      return client;
    },
  } as unknown as NativeNodexAgentCore;
  return { runtime, client, projects };
};

describe("canonical Page observations", () => {
  it("retains the title/body validators and fence from the same semantic snapshot", async () => {
    const { runtime, client, projects } = fixture();
    const controller = new AbortController();
    const result = await readNativeFetchObservation(request, runtime, controller.signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document).toEqual({
      documentId,
      ownerPageId: pageId,
      targetBlockId: pageId,
      storeEpoch: authority.storeEpoch,
      generation: 2,
      headSeq: 11,
      commitHead: 12,
    });
    expect(result.validators).toEqual({ title: etag, body: etag });
    expect(result.output.data.resource.title).toEqual({ markdown: "Current title", etag });
    expect(result.output.data.content).toMatchObject({
      format: "markdown",
      markdown: "- Current paragraph\n",
      etag,
    });
    expect(projects).toEqual([authority.actorProjectId]);
    expect(client.documentReads[0]?.read).toMatchObject({
      kind: "agent_semantic_snapshot",
      document_id: documentId,
      target_block_id: pageId,
      prepare_title: true,
      prepare_body: true,
      authorization: { call_id: "call:exact" },
    });
    expect(client.documentReadOptions[0]?.signal).toBe(controller.signal);
  });

  it("keeps ordinary fetch output unchanged and rejects a different Store epoch", async () => {
    const observed = await readNativeFetchObservation(request, fixture().runtime);
    const fetched = await readNativeFetch(request, fixture().runtime);
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(fetched).toEqual({ ok: true, tool: "fetch", output: observed.output });
    const summary = await readNativeFetchObservation(
      { ...request, input: { ...request.input, format: "summary", prepareFor: undefined } },
      fixture().runtime,
    );
    expect(summary.ok && summary.validators).toEqual({ title: etag, body: etag });
    expect((await readNativeFetchObservation(request, fixture("epoch:other").runtime)).ok).toBe(
      false,
    );
  });
});

it("reads projectless content through the unbound client with exact Library provenance", async () => {
  const { runtime, client, projects } = fixture();
  const projectless: FrozenNodexAgentTurnAuthority = {
    ...authority,
    scope: "library",
    source: "builtin_full_access",
    actorProjectId: null,
  };
  const observed = await readNativeFetchObservation(
    { ...request, projectId: null, authority: projectless },
    runtime,
  );
  expect(observed.ok).toBe(true);
  expect(projects).toEqual([]);
  expect(client.documentReads[0]?.read).toMatchObject({
    authorization: { provenance: { authority: { actor_project_id: null, scope: "library" } } },
  });
});
