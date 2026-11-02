import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import {
  LinkOpeningProvider,
  WebLinkNavigationProvider,
  useLinkOpening,
  useWebLinkNavigation,
} from "./web-link-navigation";

it("retains the Workbench routing owner through nested file-link providers", async () => {
  const openLink = vi.fn(async () => true);
  function Actions() {
    const router = useLinkOpening();
    const navigation = useWebLinkNavigation();
    return (
      <>
        <button
          onClick={() => {
            void router?.openLink({
              url: "https://example.test",
              initiator: "markdown_link_click",
            });
          }}
        >
          Open
        </button>
        <button
          onClick={() => {
            void navigation?.openTab?.("https://example.test");
          }}
        >
          New tab
        </button>
        <button
          onClick={() => {
            void navigation?.openWindow?.("https://example.test");
          }}
        >
          New window
        </button>
      </>
    );
  }
  const view = render(
    <LinkOpeningProvider router={{ browserAvailable: true, openLink }}>
      <WebLinkNavigationProvider navigation={{ openTab: undefined, openWindow: undefined }}>
        <Actions />
      </WebLinkNavigationProvider>
    </LinkOpeningProvider>,
  );
  try {
    for (const label of ["Open", "New tab", "New window"])
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: label }));
        await Promise.resolve();
      });
    expect(openLink.mock.calls).toEqual([
      [{ url: "https://example.test", initiator: "markdown_link_click" }],
      [
        {
          url: "https://example.test",
          initiator: "link_context_menu",
          openTarget: "in-app-browser",
          disposition: "new-tab",
        },
      ],
      [
        {
          url: "https://example.test",
          initiator: "link_context_menu",
          openTarget: "in-app-browser",
          presentationIntent: "new-window",
        },
      ],
    ]);
  } finally {
    view.unmount();
  }
});
