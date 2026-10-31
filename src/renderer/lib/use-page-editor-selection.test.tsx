import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { usePageEditorSelection } from "./use-page-editor-selection";
import { registerPageEditorObservationParticipant } from "./page-editor-observation-registry";
import { createPageEditorSelectionObservation } from "./page-editor-selection";

test("selection observers follow late editor mount, replacement, and unmount by exact lease", async () => {
  const subject = renderHook(() => usePageEditorSelection("selection-test"));
  const participant = (id: string) => ({
    ...createPageEditorSelectionObservation({ read: () => [id], focused: () => true }),
    read: () => {
      throw new Error("Selection must not read content");
    },
    prepare: async () => {
      throw new Error("Selection must not prepare content");
    },
  });
  let first = () => {};
  let second = () => {};
  try {
    expect(subject.result.current).toEqual([]);
    await act(async () => {
      first = registerPageEditorObservationParticipant("selection-test", participant("a"));
    });
    expect(subject.result.current).toEqual(["a"]);
    await act(async () => {
      second = registerPageEditorObservationParticipant("selection-test", participant("b"));
      first();
    });
    expect(subject.result.current).toEqual(["b"]);
    await act(async () => {
      second();
    });
    expect(subject.result.current).toEqual([]);
  } finally {
    subject.unmount();
    second();
    first();
  }
});
