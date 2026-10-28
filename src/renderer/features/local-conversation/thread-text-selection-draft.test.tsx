import { useLayoutEffect } from "react";
import { act, render } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { useThreadTextSelectionDraft } from "./thread-text-selection-draft";

test.each(["create", "edit"] as const)(
  "transfers an unfinished %s annotation without confirming it or changing the source",
  async (mode) => {
    const store = createMaitaiStore();
    let controllers:
      | {
          source: ReturnType<typeof useThreadTextSelectionDraft>;
          destination: ReturnType<typeof useThreadTextSelectionDraft>;
        }
      | undefined;
    function Probe() {
      const source = useThreadTextSelectionDraft("local", "source");
      const destination = useThreadTextSelectionDraft("local", "destination");
      useLayoutEffect(() => {
        controllers = { source, destination };
      });
      return null;
    }
    const view = render(
      <MaitaiProvider store={store}>
        <Probe />
      </MaitaiProvider>,
    );
    const current = () => {
      if (!controllers) throw new Error("Expected mounted selection owners");
      return controllers;
    };
    try {
      await act(async () => {
        const { source } = current();
        source.addAnnotation({
          id: "annotation",
          text: "Selected reply",
          source: {
            threadId: "source",
            messageId: "reply",
            startOffset: 0,
            endOffset: 14,
            rangeText: "Selected reply",
          },
        });
        if (mode === "edit") {
          source.updateAnnotation("annotation", "Existing note");
          source.finishAnnotation();
          source.editAnnotation("annotation");
        }
        source.updateAnnotation("annotation", "  Unconfirmed note\n");
        // Capture reads the owner directly, including edits not yet committed to a React render.
        const snapshot = source.readSnapshot();
        expect(snapshot.annotationDraft).toBe("  Unconfirmed note\n");
        current().destination.restore(snapshot);
      });
      const captured = current().source.readSnapshot();
      expect(current().destination.readSnapshot()).toEqual(captured);
      expect(captured).toMatchObject({
        activeAnnotationId: "annotation",
        annotationMode: mode,
        annotationDraft: "  Unconfirmed note\n",
      });
      expect(captured.responseTextAnnotations[0]?.annotation).toBe(
        mode === "edit" ? "Existing note" : undefined,
      );
      expect(current().destination.draft).toMatchObject({ focusNonce: 0, submitNonce: 0 });
      await act(async () => current().destination.finishAnnotation());
      expect(current().destination.readSnapshot()).toMatchObject({
        activeAnnotationId: null,
        annotationDraft: "",
        responseTextAnnotations: [expect.objectContaining({ annotation: "Unconfirmed note" })],
      });
      expect(current().source.readSnapshot()).toEqual(captured);
    } finally {
      view.unmount();
      disposeMaitaiStore(store);
    }
  },
);
