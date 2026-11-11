import type { components } from "@nodex/core-protocol";
import type {
  NodexAgentDocumentHead,
  PreparedNodexAgentCreateDestination,
} from "../../shared/nodex-agent-tools";

type CoreDestination = components["schemas"]["LibraryAgentPageDestination"];
type CoreResolvedDestination = components["schemas"]["LibraryPageCopyDestination"];
type CoreDocumentHead = components["schemas"]["LibraryAgentDocumentHead"];
type CoreDocumentCommit = components["schemas"]["LibraryBlockTransferDocumentCommit"];
type CoreLocation = components["schemas"]["LibraryAgentPageLocation"];

type AgentSiblingAnchor =
  | { readonly kind: "start" | "end" }
  | { readonly kind: "before" | "after"; readonly blockId: string };

export type AgentPageDestination =
  | {
      readonly kind: "library";
      readonly at?: AgentSiblingAnchor;
    }
  | {
      readonly kind: "page";
      readonly pageId: string;
      readonly at?: AgentSiblingAnchor;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: string;
      readonly values?: readonly {
        readonly propertyId: string;
        readonly value: unknown;
      }[];
      readonly view?: {
        readonly viewId: string;
        readonly groupKey?: string | null;
        readonly at?: AgentSiblingAnchor;
      };
    };

export interface NativeAgentPageDestinationPreparation {
  readonly destination?: CoreResolvedDestination | null;
  readonly destination_document?: CoreDocumentHead | null;
  readonly destination_database_id?: string | null;
}

const siblingAnchor = (
  anchor: AgentSiblingAnchor | undefined,
): components["schemas"]["LibraryAgentSiblingAnchor"] | null => {
  if (!anchor) return null;
  if ("blockId" in anchor) {
    return { kind: anchor.kind, block_id: anchor.blockId };
  }
  return { kind: anchor.kind };
};

export const toCoreAgentPageDestination = (
  destination: AgentPageDestination,
  values: readonly { readonly propertyId: string; readonly value: unknown }[] = destination.kind ===
  "data_source"
    ? (destination.values ?? [])
    : [],
): CoreDestination => {
  if (destination.kind === "library") {
    return { kind: "library", at: siblingAnchor(destination.at) };
  }
  if (destination.kind === "page") {
    return {
      kind: "page",
      page_id: destination.pageId,
      at: siblingAnchor(destination.at),
    };
  }
  return {
    kind: "data_source",
    data_source_id: destination.dataSourceId,
    values: values.map((value) => ({
      property_id: value.propertyId,
      value: value.value,
    })),
    view_id: destination.view?.viewId ?? null,
    ...(destination.view?.groupKey !== undefined ? { group_key: destination.view.groupKey } : {}),
    at: siblingAnchor(destination.view?.at),
  };
};

export const preparedAgentPageDestination = (
  preparation: NativeAgentPageDestinationPreparation,
): PreparedNodexAgentCreateDestination => {
  const destination = preparation.destination;
  if (!destination) {
    throw new Error("Core Agent Page preparation omitted its destination");
  }
  if (destination.kind === "library") {
    return {
      kind: "library",
      ...(destination.before ? { beforeBlockId: destination.before.block_id } : {}),
    };
  }
  if (destination.kind === "page") {
    const target = preparation.destination_document;
    if (!target) {
      throw new Error("Core Agent Page preparation omitted its target Document");
    }
    return {
      kind: "document",
      documentId: target.document_id,
      generation: target.generation,
      expectedHeadSeq: target.expected_head_seq,
      ...(destination.before ? { beforeBlockId: destination.before.block_id } : {}),
    };
  }
  const databaseId = preparation.destination_database_id;
  if (!databaseId) {
    throw new Error("Core Agent Page preparation omitted its target Database");
  }
  return {
    kind: "data_source",
    dataSourceId: destination.data_source_id,
    schemaRevision: destination.expected_data_source_revision,
    ...(destination.view
      ? {
          view: {
            viewId: destination.view.view_id,
            viewRevision: destination.view.expected_view_revision,
            ...(destination.view.group_key !== undefined
              ? { groupKey: destination.view.group_key }
              : {}),
            ...(destination.view.before ? { beforePageId: destination.view.before.page_id } : {}),
          },
        }
      : {}),
  };
};

export const nativeAgentPageLocation = (value: CoreLocation) => {
  if (value.kind === "library") {
    return { kind: "library" as const, libraryId: value.library_id };
  }
  if (value.kind === "page") {
    return { kind: "page" as const, pageId: value.page_id };
  }
  return { kind: "data_source" as const, dataSourceId: value.data_source_id };
};

export const nativeAgentDocumentCommits = (commits: readonly CoreDocumentCommit[]) =>
  commits.map((commit) => ({
    documentId: commit.document_id,
    generation: commit.generation,
    baseHeadSeq: commit.base_head_seq,
    headSeq: commit.head_seq,
    updateId: commit.update_id,
    update: new Uint8Array(commit.update),
    stateVector: new Uint8Array(commit.state_vector),
  }));

export const nativeAgentDocumentHeads = (
  heads: readonly CoreDocumentHead[],
): readonly NodexAgentDocumentHead[] =>
  heads.map((head) => ({
    documentId: head.document_id,
    generation: head.generation,
    expectedHeadSeq: head.expected_head_seq,
  }));

export const hasExactNativeAgentDocumentHeads = (
  expected: readonly NodexAgentDocumentHead[],
  actual: readonly NodexAgentDocumentHead[],
): boolean =>
  expected.length === actual.length &&
  expected.every((head, index) => {
    const candidate = actual[index];
    return (
      candidate?.documentId === head.documentId &&
      candidate.generation === head.generation &&
      candidate.expectedHeadSeq === head.expectedHeadSeq
    );
  });
