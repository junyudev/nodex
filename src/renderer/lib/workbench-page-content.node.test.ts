import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createDefaultWorkbenchLayoutSnapshot } from "../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
} from "../../shared/workbench-scene";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
} from "../../shared/block-documents/page-document";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "./maitai/maitai-store";
import { getWorkbenchWindowOwner } from "./workbench-window-owner";
import { DocumentWaitError } from "./document-wait";
import { createWorkbenchPageContent } from "./workbench-page-content";
import { workbenchPageEditorKey } from "./workbench-page-editor-key";
import {
  registerPageEditorObservationParticipant,
  resolvePageEditorObservationParticipant,
  type PageEditorObservationParticipant,
} from "./page-editor-observation-registry";
import type { BlockDocumentSurfaceStatus } from "./block-document-surface-runtime";
import { WorkbenchPrepareContentResultSchema } from "../../shared/nodex-app-tools/workbench-content";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function fixture(sceneOwner: WorkbenchSceneOwner = { kind: "pages" }) {
  const store = createMaitaiStore();
  disposers.push(() => disposeMaitaiStore(store));
  const accessContext =
    sceneOwner.kind === "pages"
      ? { kind: "library" as const }
      : { kind: "project" as const, projectId: "project-a" };
  const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(sceneOwner), {
    panelId: "right",
    surface: {
      id: "page-tab",
      kind: "page_stage",
      titleSnapshot: "Page",
      state: null,
      stateKey: 0,
      config: { accessContext, pageId: "page-a" },
    },
  });
  const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
    ...createDefaultWorkbenchLayoutSnapshot(),
    scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
  });
  owner.initialize();
  let status = {
    structuralWaitStartedAt: null,
    phase: "ready",
    ready: true,
    reloadRequired: false,
    descriptor: {
      documentId: "document-a",
      libraryId: "library-a",
      accessContext,
      ownerBlockId: "page-a",
      ownerType: "page",
      ownerLifecycle: "active",
      readiness: "ready",
      storeEpoch: "epoch-a",
      generation: 1,
      headSeq: 5,
      schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      sync: { kind: "yjs", stateVector: new Uint8Array() },
    },
    provider: {
      phase: "synced",
      documentId: "document-a",
      clientSessionId: "shared-document-provider",
      connected: true,
      storeEpoch: "epoch-a",
      generation: 1,
      headSeq: 5,
      pendingUpdateCount: 0,
      checkpoint: { phase: "ready", failureCount: 0, localVersion: 2 },
    },
  } as BlockDocumentSurfaceStatus;
  let mounted = true;
  let transientInput = false;
  const participant = {
    read: () => ({ mounted, transientInput, status }),
    prepare: vi.fn<PageEditorObservationParticipant["prepare"]>(async () => ({
      documentId: "document-a",
      storeEpoch: "epoch-a",
      generation: 1,
      expectedHeadSeq: 5,
    })),
  } satisfies PageEditorObservationParticipant;
  const key = workbenchPageEditorKey(sceneOwner, "page-tab");
  let currentParticipant: PageEditorObservationParticipant | null = participant;
  let time = Date.parse("2026-09-08T00:00:00Z");
  const content = createWorkbenchPageContent(owner, {
    resolve: (editorKey) => (editorKey === key ? currentParticipant : null),
    now: () => time,
  });
  disposers.push(content.dispose);
  const controller = new AbortController();
  const request = () => ({
    kind: "prepare_content" as const,
    sceneOwner,
    tabId: "page-tab",
    expectedPresentationRevision: owner.read().presentationRevision,
  });
  return {
    owner,
    sceneOwner,
    scene,
    participant,
    key,
    content,
    controller,
    request,
    prepare: () => content.prepare(request(), controller.signal, () => true),
    status: () => status,
    patchStatus: (update: Partial<BlockDocumentSurfaceStatus>) => {
      status = { ...status, ...update };
    },
    unmount: () => {
      mounted = false;
    },
    setTransient: (value: boolean) => {
      transientInput = value;
    },
    replaceParticipant: (value: PageEditorObservationParticipant | null) => {
      currentParticipant = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("Workbench Page content barrier", () => {
  test("uses the exact PageTab participant and detects new typing even when that edit has already saved", async () => {
    const first = fixture({ kind: "session", sessionId: "first-session" });
    const second = fixture({ kind: "session", sessionId: "second-session" });
    const prepared = await first.prepare();
    expect(WorkbenchPrepareContentResultSchema.safeParse(prepared).success).toBe(true);
    expect(prepared).toMatchObject({
      status: "ready",
      editorSurfaceId: first.key,
      pageId: "page-a",
      documentId: "document-a",
      expectedHeadSeq: 5,
      localEditRevision: 2,
    });
    expect(second.participant.prepare).not.toHaveBeenCalled();
    if (prepared.status !== "ready") throw new Error("Expected a prepared Page");
    first.patchStatus({
      provider: {
        ...first.status().provider,
        headSeq: 6,
        checkpoint: { ...first.status().provider.checkpoint, localVersion: 3 },
      },
    });
    expect(first.content.validate(prepared.token, () => true)).toEqual({
      status: "pending_local_edits",
    });
    const next = await first.prepare();
    if (next.status !== "ready") throw new Error("Expected a prepared Page");
    expect(next.expectedHeadSeq).toBe(6);
    first.patchStatus({ provider: { ...first.status().provider, headSeq: 7 } });
    expect(first.content.validate(next.token, () => true)).toMatchObject({
      status: "synchronized",
      headSeq: 7,
      localEditRevision: 3,
    });
  });

  test("reports pending input and bounded flush timeouts without replacing the editor or dropping its edits", async () => {
    const subject = fixture();
    subject.setTransient(true);
    expect(await subject.prepare()).toEqual({ status: "pending_local_edits" });
    expect(subject.participant.prepare).not.toHaveBeenCalled();
    subject.setTransient(false);
    subject.participant.prepare.mockRejectedValueOnce(new DocumentWaitError("timeout"));
    expect(await subject.prepare()).toEqual({ status: "pending_local_edits" });
    expect(subject.status().provider.checkpoint.localVersion).toBe(2);
    subject.participant.prepare.mockImplementationOnce(async (options) => {
      expect(options.signal).toBe(subject.controller.signal);
      subject.controller.abort();
      throw new DocumentWaitError("cancelled");
    });
    expect(await subject.prepare()).toEqual({ status: "cancelled" });
  });

  test.each(["generation", "participant", "presentation"] as const)(
    "rejects a changed %s after asynchronous preparation",
    async (change) => {
      const subject = fixture();
      const save = deferred<Awaited<ReturnType<PageEditorObservationParticipant["prepare"]>>>();
      subject.participant.prepare.mockReturnValueOnce(save.promise);
      const pending = subject.prepare();
      if (change === "generation")
        subject.patchStatus({ provider: { ...subject.status().provider, generation: 2 } });
      if (change === "participant") subject.replaceParticipant({ ...subject.participant });
      if (change === "presentation") subject.owner.selectPages();
      save.resolve({
        documentId: "document-a",
        storeEpoch: "epoch-a",
        generation: 1,
        expectedHeadSeq: 5,
      });
      expect(await pending).toEqual({
        status: change === "presentation" ? "stale_presentation" : "surface_unavailable",
      });
    },
  );

  test("revalidates exact target, mounted lifetime, expiry, and single-use token", async () => {
    const subject = fixture();
    const prepare = async () => {
      const result = await subject.prepare();
      if (result.status !== "ready") throw new Error("Expected ready");
      return result;
    };
    const first = await prepare();
    subject.owner.setScene(
      subject.sceneOwner,
      updateWorkbenchSceneSurface(subject.scene, "page-tab", {
        config: { accessContext: { kind: "library" }, pageId: "page-other" },
      }),
    );
    expect(subject.content.validate(first.token, () => true)).toEqual({
      status: "surface_unavailable",
    });
    subject.owner.setScene(subject.sceneOwner, subject.scene);
    const second = await prepare();
    subject.advance(30_001);
    expect(subject.content.validate(second.token, () => true)).toEqual({ status: "expired" });
    const third = await prepare();
    expect(subject.content.validate(third.token, () => true).status).toBe("synchronized");
    expect(subject.content.validate(third.token, () => true)).toEqual({ status: "expired" });
    const fourth = await prepare();
    subject.unmount();
    expect(subject.content.validate(fourth.token, () => true)).toEqual({
      status: "surface_unavailable",
    });
  });

  test("old participant cleanup cannot unregister its replacement", () => {
    const subject = fixture();
    const releaseFirst = registerPageEditorObservationParticipant(subject.key, subject.participant);
    const first = resolvePageEditorObservationParticipant(subject.key);
    const releaseSecond = registerPageEditorObservationParticipant(
      subject.key,
      subject.participant,
    );
    const replacement = resolvePageEditorObservationParticipant(subject.key);
    expect(replacement).not.toBe(first);
    disposers.push(releaseFirst, releaseSecond);
    releaseFirst();
    expect(resolvePageEditorObservationParticipant(subject.key)).toBe(replacement);
    releaseSecond();
    expect(resolvePageEditorObservationParticipant(subject.key)).toBeNull();
  });
});
