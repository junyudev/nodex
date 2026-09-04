import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { renderWithMaitai } from "../../../../test/thread-maitai";
import { TestQueryProvider } from "../../../../test/query";
import { GeneratedImageGallery } from "./generated-image-gallery";
import { getGeneratedImageAnimationClockSubscriberCount } from "../../../user-attachment-image-editor/view/generated-image-animation-clock";
import { ConversationImageAssetProvider } from "../conversation-image-asset-context";
import {
  registerUserAttachmentImagePreviewOpener,
  type OpenUserAttachmentImagePreviewOptions,
} from "@/features/user-attachment-image-editor";
import { installMotionPreferenceForTest } from "@/test/browser-globals";

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

class ControlledIntersectionObserver implements IntersectionObserver {
  static instances: ControlledIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  private target: Element | null = null;

  constructor(private readonly callback: IntersectionObserverCallback) {
    ControlledIntersectionObserver.instances.push(this);
  }

  disconnect() {
    this.target = null;
  }

  observe(target: Element) {
    this.target = target;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element) {
    if (this.target === target) this.target = null;
  }

  emit(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback(
      [
        {
          isIntersecting,
          target: this.target,
        } as IntersectionObserverEntry,
      ],
      this,
    );
  }
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: visibilityState,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  ControlledIntersectionObserver.instances = [];
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: originalIntersectionObserver,
  });
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    Reflect.deleteProperty(document, "visibilityState");
  }
  expect(getGeneratedImageAnimationClockSubscriberCount()).toBe(0);
});

describe("GeneratedImageGallery pending scheduling", () => {
  test("subscribes only visible intersecting cells and pauses with the document", async () => {
    const restoreMotionPreference = installMotionPreferenceForTest(false);
    ControlledIntersectionObserver.instances = [];
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: ControlledIntersectionObserver,
    });
    setDocumentVisibility("visible");
    const measurement = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 74,
      height: 74,
      left: 0,
      right: 320,
      top: 0,
      width: 320,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const context = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const view = renderWithMaitai(<GeneratedImageGallery images={[]} pendingImageCount={6} />);

    try {
      await waitFor(() => {
        expect(ControlledIntersectionObserver.instances).toHaveLength(6);
      });
      expect(getGeneratedImageAnimationClockSubscriberCount()).toBe(0);

      await act(async () => {
        for (const observer of ControlledIntersectionObserver.instances) {
          observer.emit(true);
        }
        await Promise.resolve();
      });

      expect(
        view.container.querySelectorAll(
          '[data-generated-image-dot-field="true"][data-animate="true"]',
        ),
      ).toHaveLength(4);
      expect(getGeneratedImageAnimationClockSubscriberCount()).toBe(4);

      await act(async () => {
        setDocumentVisibility("hidden");
        await Promise.resolve();
      });

      expect(
        view.container.querySelectorAll(
          '[data-generated-image-dot-field="true"][data-animate="true"]',
        ),
      ).toHaveLength(0);
      expect(getGeneratedImageAnimationClockSubscriberCount()).toBe(0);
    } finally {
      view.unmount();
      measurement.mockRestore();
      getContext.mockRestore();
      restoreMotionPreference();
    }
  });

  test("keeps gallery clicks in the lightbox while Edit and Canvas open the right editor", async () => {
    const opened: OpenUserAttachmentImagePreviewOptions[] = [];
    const unregister = registerUserAttachmentImagePreviewOpener(async (options) => {
      opened.push(options);
      return true;
    });
    const src = "data:image/png;base64,aW1hZ2U=";
    const view = renderWithMaitai(
      <TestQueryProvider>
        <ConversationImageAssetProvider
          composerTarget={{
            channelId: "ThreadScope:task-1::root",
            placement: "root",
          }}
          conversationId="task-1"
          hostId="local"
        >
          <GeneratedImageGallery
            images={[
              { id: "generated-1", src },
              { id: "generated-2", src },
            ]}
            pendingImageCount={0}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );

    try {
      fireEvent.click(
        view.getByRole("button", {
          name: "Generated image 1",
        }),
      );
      expect(opened).toEqual([]);
      expect(
        await view.findByRole("dialog", {
          name: "Image preview",
        }),
      ).not.toBeNull();

      fireEvent.click(
        view.getByRole("button", {
          name: "Edit image",
        }),
      );
      await waitFor(() =>
        expect(opened.at(-1)).toMatchObject({
          composerTarget: {
            channelId: "ThreadScope:task-1::root",
            placement: "root",
          },
          entrypoint: "lightbox_edit_button",
          initialView: "single",
          openInEditor: true,
          threadId: "task-1",
        }),
      );

      fireEvent.click(
        view
          .getAllByRole("button", {
            name: "Open Canvas view",
          })
          .at(-1)!,
      );
      await waitFor(() =>
        expect(opened.at(-1)).toMatchObject({
          entrypoint: "canvas_button",
          initialImageId: "generated-2",
          initialView: "playground",
          openInEditor: true,
        }),
      );
    } finally {
      view.unmount();
      unregister();
    }
  });
});
