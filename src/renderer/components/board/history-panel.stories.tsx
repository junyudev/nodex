import type { Meta, StoryObj } from "@storybook/react-vite";

import type { DocumentVersionDetail } from "../../../shared/block-documents/document-history";
import type { PageHistoryEntry } from "../../../shared/page-history";
import {
  HistoryCurrentRevisionPreview,
  HistoryRevisionPreview,
  HistoryTimelineDetails,
} from "./history-panel";

const HASH = "a".repeat(64);

const revisionEntry: Extract<PageHistoryEntry, { kind: "document_version" }> = {
  id: "document-version:version-1",
  kind: "document_version",
  libraryId: "library-1",
  pageId: "card-1",
  documentId: "document-1",
  occurredAt: "2026-07-12T09:10:00.000Z",
  display: {
    category: "content",
    title: "Edited Page",
    detail: "Automatic revision after editing stopped.",
    actorLabel: "This window",
  },
  evidence: { status: "verified" },
  recovery: {
    kind: "restore_document_version",
    documentId: "document-1",
    versionId: "version-1",
  },
  versionMetadata: {
    versionId: "version-1",
    generation: 1,
    baseHeadSeq: 17,
    schemaKey: "nodex.page",
    schemaVersion: 1,
    cause: "automatic_edit",
    label: null,
    revisionKind: "automatic",
    sourceMutationId: null,
    sourceChangeSeq: null,
    pinned: false,
    checkpointHash: HASH,
    byteLength: 640,
  },
};

const revisionDetail: DocumentVersionDetail = {
  summary: {
    ...revisionEntry.versionMetadata,
    documentId: revisionEntry.documentId,
    projectId: "project-1",
    actor: { kind: "renderer" },
    fileSnapshotStatus: "exact",
    checkpointMetadata: {
      format: "block_tree_snapshot_v2",
    },
    materializationHash: HASH,
    materializationKind: "page",
    title: "Plan the document history model",
    preview: "Keep revisions semantic, compact, and restorable.",
    blockCount: 2,
    createdAt: revisionEntry.occurredAt,
  },
  materialization: {
    kind: "page",
    schemaVersion: 1,
    title: "Plan the document history model",
    richTitle: [
      {
        type: "text",
        text: "Plan the document history model",
        styles: {},
      },
    ],
    blockTree: [],
    nfm: "Keep revisions semantic, compact, and restorable.\n\n## Acceptance\n\n- Preview exact content\n- Restore as a forward change",
    plainText: "Keep revisions semantic, compact, and restorable.",
    preview: "Keep revisions semantic, compact, and restorable.",
    references: [],
    assetRefs: [],
  },
};

const mutationEntry: Extract<PageHistoryEntry, { kind: "block_mutation" }> = {
  id: "change-log:42",
  kind: "block_mutation",
  libraryId: "library-1",
  pageId: "card-1",
  documentId: "document-1",
  occurredAt: "2026-07-12T08:30:00.000Z",
  display: {
    category: "property",
    title: "Changed Page properties",
    detail: "Updated status and priority in the primary Database.",
    actorLabel: "This window",
  },
  evidence: { status: "verified" },
  recovery: { kind: "unavailable", reason: "no_inverse_contract" },
  changeSeq: 42,
  mutationId: "mutation-42",
  mutationKind: "database_mutation",
  affectedBlockCount: 1,
  fieldIntentCount: 2,
};

const incompleteRelocationEntry: Extract<PageHistoryEntry, { kind: "block_relocation" }> = {
  id: "change-log:41",
  kind: "block_relocation",
  libraryId: "library-1",
  pageId: "card-1",
  documentId: "document-1",
  occurredAt: "2026-07-12T08:00:00.000Z",
  display: {
    category: "location",
    title: "Moved blocks into Page",
    detail: "The durable event survived, but its relocation ledger is unavailable.",
    actorLabel: null,
  },
  evidence: { status: "unavailable", reason: "missing_ledger" },
  recovery: { kind: "unavailable", reason: "insufficient_evidence" },
  changeSeq: 41,
  relocationId: null,
  direction: "into_page",
  movedBlockCount: 3,
};

const meta = {
  title: "Board/Page History Evidence",
  component: HistoryTimelineDetails,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[42rem] max-w-[calc(100vw-2rem)] bg-token-main-surface-primary p-5">
        <Story />
      </div>
    ),
  ],
  args: { entry: mutationEntry },
} satisfies Meta<typeof HistoryTimelineDetails>;

export default meta;

type Story = StoryObj<typeof meta>;

export const VerifiedMutation: Story = {};

export const IncompleteRelocation: Story = {
  args: { entry: incompleteRelocationEntry },
};

export const CurrentCardRevision: Story = {
  render: () => (
    <HistoryCurrentRevisionPreview
      projectId="project-1"
      pageId="card-1"
      title="Plan the document history model"
      nfm="Keep revisions semantic, compact, and restorable.\n\n## Acceptance\n\n- Preview exact content\n- Restore as a forward change"
      projectWorkspacePath="/workspace/project-1"
    />
  ),
};

export const RestorableAutomaticRevision: Story = {
  render: () => (
    <HistoryRevisionPreview
      projectId="project-1"
      entry={revisionEntry}
      detail={revisionDetail}
      loading={false}
      error={null}
      projectWorkspacePath="/workspace/project-1"
    />
  ),
};
