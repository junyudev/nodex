import { describe, expect, test, vi } from "vite-plus/test";
import type { OwnedDocumentDescriptor } from "../../../shared/block-documents";
import type { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { EditorSurfaceLease } from "@/lib/document-session-registry";
import { PageEditorSessionObservation } from "./page-editor-session-owner";

const createLease = (connect = Promise.resolve()) => ({
  claimView: vi.fn(() => 7),
  connect: vi.fn(() => connect),
  releaseView: vi.fn(() => true),
  runtime: {} as BlockDocumentSurfaceRuntime,
});
const descriptor = {} as OwnedDocumentDescriptor;

describe("editor session observation", () => {
  test("publishes a view lease, reads the latest retention policy, and clears its runtime handle", () => {
    const observation = new PageEditorSessionObservation();
    const lease = createLease();
    const registry = {
      acquire: vi.fn(() => lease as unknown as EditorSurfaceLease),
      dispose: vi.fn(async () => {}),
    };
    const runtimeRef = { current: null as BlockDocumentSurfaceRuntime | null };
    let retain = false;
    const listener = vi.fn();
    const unsubscribe = observation.subscribe(listener);
    const detach = observation.attach({
      registry,
      sessionKey: "tab",
      descriptor,
      createRuntime: () => lease.runtime,
      runtimeRef,
      retainModel: () => retain,
    });
    expect(observation.getSnapshot().session).toBe(lease);
    expect(runtimeRef.current).toBe(lease.runtime);
    expect(listener).toHaveBeenCalled();
    retain = true;
    detach();
    expect(lease.releaseView).toHaveBeenCalledWith(7, { persist: true });
    expect(runtimeRef.current).toBeNull();
    expect(registry.dispose).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("disposes previews and ignores a retired connection failure after a replayed attachment", async () => {
    let reject!: (error: Error) => void;
    const retired = createLease(
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
    );
    const active = createLease();
    const registry = {
      acquire: vi.fn().mockReturnValueOnce(retired).mockReturnValueOnce(active),
      dispose: vi.fn(async () => {}),
    };
    const observation = new PageEditorSessionObservation();
    const input = {
      registry,
      sessionKey: "preview",
      descriptor,
      createRuntime: () => active.runtime,
      retainModel: () => false,
    };
    const detach = observation.attach(input);
    detach();
    const detachActive = observation.attach(input);
    reject(new Error("retired connection"));
    await Promise.resolve();
    expect(observation.getSnapshot()).toEqual({ session: active, startupError: null });
    expect(registry.dispose).toHaveBeenCalledWith("preview", retired);
    detachActive();
    expect(registry.dispose).toHaveBeenCalledWith("preview", active);
  });
});
