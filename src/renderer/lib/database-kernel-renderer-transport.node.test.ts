import { RECIPIENT_DELIVERY_VERSION } from "../../shared/recipient-delivery";
import { describe, expect, test, vi } from "vite-plus/test";
import { createCoreLocalCommitFixture } from "../../main/core-client/testing/local-commit-fixture";
import {
  createElectronRendererTransport,
  initializeElectronRendererLocalCommitIngress,
} from "./electron-renderer-transport";

describe("Database event renderer IPC", () => {
  test("subscribes and filters the scoped projection contract", async () => {
    const recipient = {
      listener: null as ((...args: unknown[]) => void) | null,
    };
    const invocations: Array<{ channel: string; args: unknown[] }> = [];
    const bridge = {
      invoke: async (channel: string, ...args: unknown[]) => {
        invocations.push({ channel, args });
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (channel === "recipient-delivery:message") recipient.listener = listener;
        return () => {
          recipient.listener = null;
        };
      },
    };
    initializeElectronRendererLocalCommitIngress(bridge as never);
    const transport = createElectronRendererTransport(bridge as never);
    const scope = {
      kind: "project" as const,
      libraryId: "library-1",
      projectId: "project-1",
    };
    const messages: unknown[] = [];
    const release = transport.subscribeProjectionStream(scope, (message) => messages.push(message));
    await Promise.resolve();
    const address = {
      kind: "project" as const,
      library_id: "library-1",
      project_id: "project-1",
    };
    const packet = createCoreLocalCommitFixture({
      deliveryAddress: address,
      commitSeq: 73,
      projectionEffects: [
        {
          scope: {
            schema_version: 1,
            canonical_key: "page:project-1:page-1",
            scope: {
              kind: "page",
              project_id: "project-1",
              page_id: "page-1",
            },
          },
          base_revision: 0,
          result_revision: 1,
          covered_commit_seq: 73,
          patch: {
            kind: "page_changed",
            project_id: "project-1",
            page_id: "page-1",
          },
          requires_read_at_least: false,
          effect_hash: "b".repeat(64),
        },
      ],
    });
    recipient.listener?.({
      version: RECIPIENT_DELIVERY_VERSION,
      deliveryId: "a".repeat(64),
      recipientLeaseId: "c".repeat(64),
      deliveryAddress: address,
      payload: { kind: "packet", packet },
    });
    await vi.waitFor(() =>
      expect(messages).toEqual([
        expect.objectContaining({
          kind: "effect",
          stream: expect.objectContaining({ commitSeq: 73 }),
        }),
      ]),
    );

    release();
    await Promise.resolve();
    expect(invocations).toEqual([
      { channel: "local-commit-audience:subscribe", args: [address] },
      {
        channel: "recipient-delivery:admit",
        args: [
          {
            version: RECIPIENT_DELIVERY_VERSION,
            deliveryId: "a".repeat(64),
            outcome: "ack",
          },
        ],
      },
      { channel: "local-commit-audience:unsubscribe", args: [address] },
    ]);
  });
});
