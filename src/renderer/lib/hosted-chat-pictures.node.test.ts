import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { QueryClient } from "@tanstack/react-query";
import { projectAgentRuntimeItem } from "../features/local-conversation/agent-runtime-transcript-projection";
import { conversationImageScope } from "../features/local-conversation/view/conversation-markdown-source";
import { parseAgentRuntimeAttachmentSource } from "../../shared/agent-runtime-attachments";
import { readContentImage } from "./content-image/content-image-read";
import { resolveConversationMediaTarget } from "./content-image/media-target";
import { bindRendererSpace } from "./renderer-space";

beforeAll(() => {
  bindRendererSpace({
    spaceId: "team",
    kind: "team",
    memberId: "alice",
    deviceId: "desktop",
    name: "Crew",
    availability: "ready",
  });
});

const reply = (text: string) =>
  ({
    id: "reply",
    threadId: "root",
    runId: "run",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: "2026-11-08T09:00:00.000Z",
    updatedAt: "2026-11-08T09:00:00.000Z",
    completedAt: "2026-11-08T09:00:00.000Z",
    type: "assistant_message",
    messageId: "reply",
    text,
    streaming: false,
    attachments: [],
  }) as unknown as AgentTurnItem;

const scope = conversationImageScope(
  {
    projectId: null,
    cwd: "/srv/crew",
    workspaceRoot: null,
    sourceRoot: { hostId: "local", threadId: "root" },
    hostId: "local",
    threadId: "root",
    sourceIdentity: "root:reply",
    authority: {},
    nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 1 },
    isCurrent: () => true,
    isResourceCurrent: () => true,
  },
  {},
);

describe("a chat on its Space's host", () => {
  test("shows each picture a reply names from a host file as one the host reads", () => {
    const projected = projectAgentRuntimeItem(
      reply("![Luna](/srv/crew/luna-star.png) and ![Web](https://example.com/web.png)"),
    );
    if (projected?.type !== "agentMessage") throw new Error("A reply is a reply");
    expect(
      projected.importedImages?.map(({ sourcePath, name, source }) => ({
        sourcePath,
        name,
        source: source && parseAgentRuntimeAttachmentSource(source),
      })),
    ).toEqual([
      {
        sourcePath: "/srv/crew/luna-star.png",
        name: "luna-star.png",
        source: {
          sourceThreadId: "root",
          itemId: "reply",
          attachmentId: "reply-picture:/srv/crew/luna-star.png",
        },
      },
    ]);
  });

  test("never reads a path in its transcript from this computer", async () => {
    for (const path of ["/srv/crew/luna-star.png", "luna-star.png", "file:///srv/crew/a.png"])
      expect(resolveConversationMediaTarget(path, scope)).toEqual({ kind: "blocked" });
    // Pictures on the web still load from there.
    expect(resolveConversationMediaTarget("https://example.com/web.png", scope)).toEqual({
      kind: "url",
      url: "https://example.com/web.png",
    });
    await expect(
      readContentImage(new QueryClient(), "/srv/crew/luna-star.png", scope),
    ).rejects.toThrow("Image file is unavailable");
  });
});
