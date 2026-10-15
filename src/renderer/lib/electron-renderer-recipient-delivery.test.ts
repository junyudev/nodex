import { describe, expect, test, vi } from "vite-plus/test";

import type { RecipientDeliveryEnvelope } from "../../shared/recipient-delivery";
import type { ProjectionScope, ProjectionStreamMessage } from "../../shared/projection-stream";
import { createCoreLocalCommitFixture } from "../../main/core-client/testing/local-commit-fixture";
import {
  createElectronRendererTransport,
  initializeElectronRendererLocalCommitIngress,
  type ElectronRendererBridge,
} from "./electron-renderer-transport";

const scope: ProjectionScope = {
  kind: "project",
  libraryId: "library-1",
  projectId: "project-1",
};

const address = {
  kind: "project" as const,
  library_id: "library-1",
  project_id: "project-1",
};

const packet = (commitSeq: number) =>
  createCoreLocalCommitFixture({
    deliveryAddress: address,
    commitSeq,
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
        covered_commit_seq: commitSeq,
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

const envelope = (commitSeq: number): RecipientDeliveryEnvelope => ({
  version: 3,
  deliveryId: "a".repeat(64),
  recipientLeaseId: "c".repeat(64),
  deliveryAddress: address,
  payload: { kind: "packet", packet: packet(commitSeq) },
});

const harness = () => {
  let recipientListener: ((...args: unknown[]) => void) | null = null;
  const invoke = vi.fn(async () => true);
  const bridge = {
    invoke,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === "recipient-delivery:message") recipientListener = listener;
      return () => undefined;
    }),
  } as unknown as ElectronRendererBridge;
  initializeElectronRendererLocalCommitIngress(bridge);
  const transport = createElectronRendererTransport(bridge);
  return {
    invoke,
    transport,
    deliver(value: unknown) {
      if (!recipientListener) throw new Error("Recipient listener was not installed");
      recipientListener(value);
    },
  };
};

describe("Electron renderer recipient delivery", () => {
  test("ACKs only after a complete packet entered process-wide admission", async () => {
    const target = harness();
    const observed: ProjectionStreamMessage[] = [];
    const release = target.transport.subscribeProjectionStream(scope, (message) =>
      observed.push(message),
    );

    target.deliver(envelope(41));

    await vi.waitFor(() => {
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        kind: "effect",
        stream: { commitSeq: 41 },
      });
      expect(target.invoke).toHaveBeenCalledWith("recipient-delivery:admit", {
        version: 3,
        deliveryId: "a".repeat(64),
        outcome: "ack",
      });
    });
    release();
  });

  test("NACKs an envelope whose address diverges from the packet", async () => {
    const target = harness();
    const observed: ProjectionStreamMessage[] = [];
    const release = target.transport.subscribeProjectionStream(scope, (message) =>
      observed.push(message),
    );
    const divergent = {
      ...envelope(42),
      deliveryAddress: { ...address, project_id: "project-2" },
    } satisfies RecipientDeliveryEnvelope;

    target.deliver(divergent);

    await vi.waitFor(() => {
      expect(target.invoke).toHaveBeenCalledWith("recipient-delivery:admit", {
        version: 3,
        deliveryId: "a".repeat(64),
        outcome: "nack",
        reason: "invalid_message",
      });
    });
    expect(observed).toEqual([]);
    release();
  });
});
