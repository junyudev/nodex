import { expect, test, vi } from "vite-plus/test";
import { createCoreLocalCommitFixture } from "../../main/core-client/testing/local-commit-fixture";
import {
  subscribeElectronRendererLocalCommitAtoms,
  type ElectronRendererBridge,
} from "./electron-renderer-transport";
import { rendererLocalCommitIngress } from "./local-commit-ingress";

test("scoped atom observers share a live audience, recover after reset, and release independently", async () => {
  const invoke = vi.fn(async () => undefined);
  const bridge = { invoke, on: () => () => {} } as unknown as ElectronRendererBridge;
  const scope = { kind: "library" as const, libraryId: "library-atom-observers" };
  const address = { kind: "library" as const, library_id: scope.libraryId };
  const first = vi.fn();
  const second = vi.fn();
  const reset = vi.fn();
  const releaseFirst = subscribeElectronRendererLocalCommitAtoms(bridge, scope, first, reset);
  const releaseSecond = subscribeElectronRendererLocalCommitAtoms(bridge, scope, second, reset);
  const packet = (commitSeq: number, libraryId = scope.libraryId) =>
    createCoreLocalCommitFixture({
      commitSeq,
      storeEpoch: "epoch-atom-observers",
      authorizationScope: { kind: "library", library_id: libraryId },
      payload: {
        module: "owned_document",
        library_id: libraryId,
        canvas_id: null,
        event: { kind: "recovery_changed", document_id: "document-draft", detached: false },
      },
    });
  try {
    expect(invoke.mock.calls).toEqual([["local-commit-audience:subscribe", address]]);
    await rendererLocalCommitIngress.admitPacket(packet(1, "another-library"));
    expect(first).not.toHaveBeenCalled();
    await rendererLocalCommitIngress.admitPacket(packet(2));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    releaseFirst();
    await rendererLocalCommitIngress.admitPacket(packet(3));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    rendererLocalCommitIngress.admitAddressReset({
      reset_id: "c".repeat(64),
      recipient_lease_id: "d".repeat(64),
      delivery_address: address,
      authorization_scope: address,
      store_epoch: "epoch-atom-observers",
      required_commit_seq: 3,
      reason: "ack_timeout",
    });
    expect(reset).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    releaseFirst();
    releaseSecond();
  }
  expect(invoke).toHaveBeenLastCalledWith("local-commit-audience:unsubscribe", address);
});
