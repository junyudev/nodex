import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { render } from "../../test/dom";
import { ContentSearchProvider, useContentSearch } from "./content-search-context";
import { ContentSearchSurface } from "./content-search-surface";

function Search() {
  const search = useContentSearch();
  return (
    <>
      <button onClick={() => search.requestOpen()}>Open search</button>
      <ContentSearchSurface />
    </>
  );
}

test("an open search yields to a dialog and returns after its overlay leaves", async () => {
  const view = render(
    <ContentSearchProvider>
      <Search />
    </ContentSearchProvider>,
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Open search" }));
  });
  expect(await view.findByPlaceholderText("Search chat…")).toBeTruthy();
  const overlay = document.createElement("div");
  overlay.dataset.slot = "codex-dialog-overlay";
  try {
    await act(async () => {
      document.body.append(overlay);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByPlaceholderText("Search chat…")).toBeNull());
    await act(async () => {
      overlay.remove();
      await Promise.resolve();
    });
    expect(await view.findByPlaceholderText("Search chat…")).toBeTruthy();
  } finally {
    overlay.remove();
    view.unmount();
  }
});
