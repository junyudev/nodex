import { describe, expect, test } from "vite-plus/test";
import {
  materializePortableCanvasScene,
  type PortableCanvasScene,
} from "../../shared/block-documents";
import { CanvasSceneBinding } from "./canvas-scene-binding";
import type { CanvasSceneObservation, CanvasSceneProvider } from "./canvas-scene-provider";

const element = (version: number, overrides: Record<string, unknown> = {}) => ({
  id: "element-1",
  type: "rectangle",
  index: "a0",
  version,
  versionNonce: 10,
  isDeleted: false,
  ...overrides,
});

class StubSceneProvider {
  scene: PortableCanvasScene = materializePortableCanvasScene({
    elements: [element(1)],
    appState: { gridSize: 20, viewBackgroundColor: "#ffffff" },
  });
  readonly submissions: CanvasSceneObservation[] = [];
  flushCount = 0;
  submitGate: Promise<void> = Promise.resolve();

  getScene = (): PortableCanvasScene => this.scene;

  submit = async (observation: CanvasSceneObservation): Promise<void> => {
    this.submissions.push(observation);
    await this.submitGate;
  };

  enqueue = (observation: CanvasSceneObservation) => ({
    durable: Promise.resolve().then(() => {
      this.submissions.push(observation);
    }),
    committed: this.submitGate,
  });

  persistDurable = async (): Promise<void> => undefined;

  flushCommitted = async (): Promise<void> => {
    this.flushCount += 1;
  };

  flush = async (): Promise<void> => {
    this.flushCount += 1;
  };
}

const providerFor = (stub: StubSceneProvider): CanvasSceneProvider =>
  stub as unknown as CanvasSceneProvider;

describe("CanvasSceneBinding", () => {
  test("rejects a pre-sync observation without stranding its waiter", async () => {
    const failures: Error[] = [];
    const provider = {
      getScene: () => null,
      submit: async () => undefined,
      flush: async () => undefined,
    } as unknown as CanvasSceneProvider;
    const binding = new CanvasSceneBinding({
      provider,
      onRemoteScene: () => undefined,
      onError: (error) => failures.push(error),
    });
    await expect(
      binding.submitLocalScene({
        elementsIncludingDeleted: [element(1)],
        appState: {},
        binaryFiles: {},
      }).committed,
    ).rejects.toThrow("initial sync");
    expect(failures).toHaveLength(1);
  });

  test("forwards including-deleted element candidates to scene-native sync", async () => {
    const provider = new StubSceneProvider();
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      onRemoteScene: () => undefined,
    });
    await binding.submitLocalScene({
      elementsIncludingDeleted: [
        element(2),
        element(1, { id: "deleted", isDeleted: true, index: "a1" }),
      ],
      appState: provider.scene.appState,
      binaryFiles: {},
    }).committed;
    expect(provider.submissions).toHaveLength(1);
    expect(
      provider.submissions[0]?.elementCandidates.some(
        (candidate) => candidate.id === "deleted" && candidate.isDeleted === true,
      ),
    ).toBe(true);
  });

  test("submits one candidate for one edit in a 10,000 element scene", async () => {
    const provider = new StubSceneProvider();
    const initial: Array<Record<string, unknown>> = Array.from({ length: 10_000 }, (_, index) =>
      element(1, {
        id: `element-${index}`,
        index: `a${index.toString().padStart(5, "0")}`,
        x: index,
      }),
    );
    provider.scene = materializePortableCanvasScene({ elements: initial });
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      onRemoteScene: () => undefined,
    });
    const changed = [...initial];
    changed[4_321] = {
      ...changed[4_321]!,
      version: 2,
      x: 50_000,
    };

    await binding.submitLocalScene({
      elementsIncludingDeleted: changed,
      appState: provider.scene.appState,
      binaryFiles: {},
    }).committed;

    expect(provider.submissions).toHaveLength(1);
    expect(provider.submissions[0]?.elementCandidates).toEqual([
      expect.objectContaining({
        id: "element-4321",
        version: 2,
        x: 50_000,
      }),
    ]);
  });

  test("coalesces observations while an image upload is pending", async () => {
    const provider = new StubSceneProvider();
    let releaseUpload = (): void => undefined;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      assetDependencies: {
        materializeImage: async () => {
          await uploadGate;
          return {
            source: "nodex://files/image.png",
            fileVersion: 1,
            defaultName: "image.png",
            mimeType: "image/png",
          };
        },
      },
      onRemoteScene: () => undefined,
    });
    const binaryFiles = {
      image: {
        id: "image",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
        created: 1,
      },
    };
    const first = binding.submitLocalScene({
      elementsIncludingDeleted: [element(2, { type: "image", fileId: "image" })],
      appState: provider.scene.appState,
      binaryFiles,
    });
    await Promise.resolve();
    const second = binding.submitLocalScene({
      elementsIncludingDeleted: [element(3, { type: "image", fileId: "image", x: 40 })],
      appState: provider.scene.appState,
      binaryFiles,
    });
    releaseUpload();
    await Promise.all([first.committed, second.committed]);
    expect(provider.submissions).toHaveLength(1);
    expect(provider.submissions[0]?.elementCandidates[0]?.version).toBe(3);
    expect(provider.submissions[0]?.fileAdditions?.image?.source).toBe("nodex://files/image.png");
  });

  test("reuses a staged image while its first durable mutation awaits Core ACK", async () => {
    const provider = new StubSceneProvider();
    let releaseCommit = (): void => undefined;
    provider.submitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let materializations = 0;
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      assetDependencies: {
        materializeImage: async () => {
          materializations += 1;
          return {
            source: "nodex://files/canvas-content.png",
            fileVersion: 1,
            defaultName: "image.png",
            mimeType: "image/png",
          };
        },
      },
      onRemoteScene: () => undefined,
    });
    const binaryFiles = {
      image: {
        id: "image",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AA==",
        created: 1,
      },
    };

    const first = binding.submitLocalScene({
      elementsIncludingDeleted: [element(2, { type: "image", fileId: "image" })],
      appState: provider.scene.appState,
      binaryFiles,
    });
    await first.durable;
    const second = binding.submitLocalScene({
      elementsIncludingDeleted: [element(3, { type: "image", fileId: "image", x: 40 })],
      appState: provider.scene.appState,
      binaryFiles,
    });
    await second.durable;

    expect(materializations).toBe(1);
    expect(provider.submissions).toHaveLength(2);
    expect(provider.submissions[0]?.fileAdditions).toEqual(provider.submissions[1]?.fileAdditions);

    releaseCommit();
    await Promise.all([first.committed, second.committed]);
  });

  test("retains a failed image candidate for an explicit durable retry", async () => {
    const provider = new StubSceneProvider();
    let uploadAttempts = 0;
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      assetDependencies: {
        materializeImage: async () => {
          uploadAttempts += 1;
          if (uploadAttempts === 1) throw new Error("upload failed");
          return {
            source: "nodex://files/image.png",
            fileVersion: 1,
            defaultName: "image.png",
            mimeType: "image/png",
          };
        },
      },
      onRemoteScene: () => undefined,
    });
    const submission = binding.submitLocalScene({
      elementsIncludingDeleted: [element(2, { type: "image", fileId: "image" })],
      appState: provider.scene.appState,
      binaryFiles: {
        image: {
          id: "image",
          mimeType: "image/png",
          dataURL: "data:image/png;base64,AA==",
          created: 1,
        },
      },
    });

    await expect(submission.durable).rejects.toThrow("upload failed");
    await expect(submission.committed).rejects.toThrow("upload failed");
    await binding.persistDurable();

    expect(uploadAttempts).toBe(2);
    expect(provider.submissions).toHaveLength(1);
    expect(provider.submissions[0]?.elementCandidates[0]).toMatchObject({
      id: "element-1",
      version: 2,
      type: "image",
    });
  });

  test("presents non-conflicting pending app-state intent over a remote scene", async () => {
    const provider = new StubSceneProvider();
    let releaseSubmit = (): void => undefined;
    provider.submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let presented: PortableCanvasScene | null = null;
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      onRemoteScene: (scene) => {
        presented = scene;
      },
    });
    const submission = binding.submitLocalScene({
      elementsIncludingDeleted: [element(2)],
      appState: { gridSize: 30, viewBackgroundColor: "#ffffff" },
      binaryFiles: {},
    });
    await Promise.resolve();
    binding.presentRemoteScene(
      materializePortableCanvasScene({
        elements: [element(1)],
        appState: { gridSize: 20, viewBackgroundColor: "#101010" },
      }),
    );
    expect((presented as PortableCanvasScene | null)?.appState.gridSize).toBe(30);
    expect((presented as PortableCanvasScene | null)?.appState.viewBackgroundColor).toBe("#101010");
    releaseSubmit();
    await submission.committed;
  });

  test("flush waits for upload/submission work before flushing the provider", async () => {
    const provider = new StubSceneProvider();
    let releaseSubmit = (): void => undefined;
    provider.submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const binding = new CanvasSceneBinding({
      provider: providerFor(provider),
      onRemoteScene: () => undefined,
    });
    const submission = binding.submitLocalScene({
      elementsIncludingDeleted: [element(2)],
      appState: provider.scene.appState,
      binaryFiles: {},
    });
    let flushed = false;
    const flushing = binding.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    releaseSubmit();
    await Promise.all([submission.committed, flushing]);
    expect(provider.flushCount).toBe(1);
  });
});
