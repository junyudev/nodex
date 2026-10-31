import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vite-plus/test";
import { buildAgentRuntimeAttachmentSource } from "../../../../shared/agent-runtime-attachments";
import { readContentImage, resolveConversationMediaTarget } from "@/lib/content-image";
import {
  conversationImageScope,
  type ConversationMarkdownSource,
} from "./conversation-markdown-source";

const source: ConversationMarkdownSource = {
  projectId: null,
  hostId: "remote",
  threadId: "thread",
  cwd: "/workspace",
  workspaceRoot: "/workspace",
  sourceIdentity: "item",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 1 },
  sourceRoot: { hostId: "remote", threadId: "thread" },
  isCurrent: () => true,
  isResourceCurrent: () => true,
};

describe("conversation image scope", () => {
  test.each([
    { name: "a native source without its connection", executionSource: undefined },
    {
      name: "a Runtime source whose execution source retired",
      executionSource: { identity: "runtime-source", isCurrent: () => false },
    },
  ])(
    "blocks reads for $name even while the resident owner is current",
    async ({ executionSource }) => {
      const resolveRuntimeAttachment = vi.fn(async () => "/managed/image.png");
      const scope = conversationImageScope(
        { ...source, nativeConnection: undefined, executionSource },
        {
          resolveRuntimeAttachment,
        },
      );
      const client = new QueryClient();
      try {
        expect(scope.isResourceCurrent()).toBe(false);
        expect(resolveConversationMediaTarget("/workspace/image.png", scope)).toEqual({
          kind: "blocked",
        });
        await expect(
          readContentImage(
            client,
            buildAgentRuntimeAttachmentSource({
              sourceThreadId: "source",
              itemId: "item",
              attachmentId: "attachment",
            }),
            scope,
          ),
        ).rejects.toThrow("The image's source has moved on");
        expect(resolveRuntimeAttachment).not.toHaveBeenCalled();
        expect(client.getQueryCache().getAll()).toHaveLength(0);
      } finally {
        client.clear();
      }
    },
  );

  test("retains physical connection identity across presentation changes and changes it for a replacement at the same epoch and generation", () => {
    const original = conversationImageScope(source, {});
    const sameConnection = conversationImageScope({ ...source, cwd: "/other" }, {});
    const replacement = conversationImageScope(
      { ...source, nativeConnection: { ...source.nativeConnection! } },
      {},
    );
    expect(sameConnection.sourceIdentity).toBe(original.sourceIdentity);
    expect(replacement.sourceIdentity).not.toBe(original.sourceIdentity);
  });
});
