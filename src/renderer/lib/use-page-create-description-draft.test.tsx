import { Activity, StrictMode, useLayoutEffect } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { populateBlockDocumentBodyFromNfm } from "../../shared/block-documents/block-document-codec";
import {
  materializePageCreateDescription,
  type PageCreateDescriptionDraft,
} from "./page-create-draft";
import { usePageCreateDescriptionDraft } from "./use-page-create-description-draft";

test("recreates live draft Documents across view replay while preserving edits and resetting only on request", async () => {
  let current: PageCreateDescriptionDraft | null = null;
  const documents = new Set<PageCreateDescriptionDraft>();
  function Draft() {
    const { draft, reset } = usePageCreateDescriptionDraft("request-1", "Restored draft");
    useLayoutEffect(() => {
      current = draft;
      if (draft) documents.add(draft);
    }, [draft]);
    return draft ? <button onClick={reset}>Create another Page</button> : null;
  }
  const content = (mode: "visible" | "hidden") => (
    <StrictMode>
      <Activity mode={mode}>
        <Draft />
      </Activity>
    </StrictMode>
  );
  const view = render(content("visible"));
  const read = (): PageCreateDescriptionDraft => {
    if (!current) throw new Error("Draft is not mounted");
    return current;
  };
  const initial = read();
  expect(initial.document.isDestroyed).toBe(false);
  expect(materializePageCreateDescription(initial)).toBe("Restored draft");
  await act(async () => {
    populateBlockDocumentBodyFromNfm(initial.body, "Edited description\n\n- Keep this item");
    await Promise.resolve();
  });
  const edited = materializePageCreateDescription(initial);
  view.rerender(content("hidden"));
  expect(initial.document.isDestroyed).toBe(true);
  view.rerender(content("visible"));
  const resumed = read();
  expect(resumed.document).not.toBe(initial.document);
  expect(resumed.document.isDestroyed).toBe(false);
  expect(materializePageCreateDescription(resumed)).toBe(edited);

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Create another Page" }));
    await Promise.resolve();
  });
  expect(resumed.document.isDestroyed).toBe(true);
  expect(read().generation).toBe(1);
  expect(materializePageCreateDescription(read())).toBe("");
  view.unmount();
  expect([...documents].every(({ document }) => document.isDestroyed)).toBe(true);
});
