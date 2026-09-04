import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, type ReactNode } from "react";

import type { PageHistoryEntry } from "../../../shared/page-history";
import { HistoryPanel } from "./history-panel";

const HASH = "a".repeat(64);
const timestamp = (minutesAgo: number): string =>
  new Date(Date.now() - minutesAgo * 60_000).toISOString();

const revision = (
  id: string,
  minutesAgo: number,
  title: string,
  cause: "automatic_edit" | "manual_checkpoint",
): Extract<PageHistoryEntry, { kind: "document_version" }> => ({
  id: `document-version:${id}`,
  kind: "document_version",
  libraryId: "library-story",
  pageId: "page-story",
  documentId: "document-story",
  occurredAt: timestamp(minutesAgo),
  display: {
    category: "content",
    title,
    detail:
      cause === "automatic_edit"
        ? "Automatic revision after editing stopped."
        : "Named checkpoint saved from Page history.",
    actorLabel: "This window",
  },
  evidence: { status: "verified" },
  recovery: {
    kind: "restore_document_version",
    documentId: "document-story",
    versionId: id,
  },
  versionMetadata: {
    versionId: id,
    generation: 1,
    baseHeadSeq: 17,
    schemaKey: "nodex.page",
    schemaVersion: 1,
    cause,
    label: cause === "manual_checkpoint" ? "Ready for review" : null,
    revisionKind: cause === "manual_checkpoint" ? "manual" : "automatic",
    sourceMutationId: null,
    sourceChangeSeq: null,
    pinned: cause === "manual_checkpoint",
    checkpointHash: HASH,
    byteLength: 640,
  },
});

const entries: readonly PageHistoryEntry[] = [
  revision("version-3", 12, "Edited Page", "automatic_edit"),
  revision("version-2", 48, "Ready for review", "manual_checkpoint"),
  revision("version-1", 96, "Edited Page", "automatic_edit"),
];

const storyApi = {
  invoke: async (channel: string): Promise<unknown> => {
    if (channel === "pages:history:list") {
      return { ok: true, value: { entries, nextCursor: null } };
    }
    throw new Error(`Unexpected Storybook IPC channel: ${channel}`);
  },
  on: () => () => undefined,
} satisfies NonNullable<Window["api"]>;

function HistoryApiBoundary({ children }: { readonly children: ReactNode }) {
  useLayoutEffect(() => {
    const previousApi = window.api;
    window.api = storyApi;
    return () => {
      window.api = previousApi;
    };
  }, []);

  return children;
}

const withHistoryApi: Decorator = (Story) => (
  <HistoryApiBoundary>
    <Story />
  </HistoryApiBoundary>
);

const meta = {
  title: "Board/Page History Dialog",
  component: HistoryPanel,
  decorators: [withHistoryApi],
  parameters: { layout: "fullscreen" },
  args: {
    fileAuthority: null,
    projectId: "project-story",
    pageId: "page-story",
    pageTitle: "Design a coherent resource model",
    pageNfm:
      "Nodex treats Pages as native documents and files as exact-format resources.\n\n## Principles\n\n- Keep ownership simple\n- Preserve exact formats\n- Make Agent output easy to inspect",
    projectWorkspacePath: "/workspace/nodex",
    open: true,
    onClose: () => undefined,
  },
} satisfies Meta<typeof HistoryPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RevisionTimeline: Story = {};
