import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { ChangelogFeed, ChangelogRelease } from "../../../shared/changelog-feed";
import { spaceStorageKeyFor } from "../../../shared/space-personal-state";
import {
  NodexDropdownContent,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexModalHost } from "@/lib/modal-registry";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import { rendererSpace } from "@/lib/renderer-space";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { installWindowApi } from "@/test/browser-globals";
import { openNodexMenu } from "@/test/dom";
import { WhatsNewMenuSection } from "./whats-new-menu-section";

const SEEN_KEY = spaceStorageKeyFor(rendererSpace(), "nodex:whats-new-seen:v1");

const release = (version: string, date: string, headline: string): ChangelogRelease => ({
  version,
  date,
  url: `https://nodex.jyu.app/changelog/#v${version}`,
  headline,
  sections: [
    {
      kind: "added",
      entries: [
        {
          lead: "Choose what this release brings.",
          detail: "**Settings > General** turns it off, and `nodex` follows.",
        },
      ],
    },
    { kind: "fixed", entries: [{ lead: "Something small works again.", detail: "" }] },
  ],
});

const FEED: ChangelogFeed = {
  schemaVersion: 1,
  url: "https://nodex.jyu.app/changelog/",
  releases: [
    release("0.5.12", "2026-11-24", "Plugin tools for Claude Code and ACP"),
    release("0.5.11", "2026-11-23", "Google Antigravity and a smaller Nodex"),
    release("0.5.10", "2026-11-18", "A search-first command palette"),
    release("0.5.9", "2026-11-18", "GPT-6.2 Ultrafast and sharper search"),
  ],
};

function renderWhatsNew(seen: string | null) {
  clearPersistedAtomStoreForTests();
  let revision = 1;
  const values: Record<string, unknown> = seen === null ? {} : { [SEEN_KEY]: seen };
  const listeners = new Set<(event: unknown) => void>();
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === "app:changelog:read") return FEED;
    if (channel === "shell:open-external-url") return true;
    if (channel === "persisted-atom:sync-request") return { revision, values: { ...values } };
    if (channel === "persisted-atom:update") {
      const mutation = args[0] as { key: string; value: unknown };
      revision += 1;
      values[mutation.key] = mutation.value;
      const event = { ...mutation, revision, originRendererId: "renderer-test" };
      for (const listener of listeners) listener(event);
      return event;
    }
    throw new Error(`Unexpected channel ${channel}`);
  });
  installWindowApi({
    invoke,
    on: (channel: string, listener: (event: unknown) => void) => {
      if (channel !== "persisted-atom:updated") return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithAppMaitai(
    <QueryClientProvider client={client}>
      <NodexDropdownRoot>
        <NodexDropdownTrigger>
          <button type="button">Help</button>
        </NodexDropdownTrigger>
        <NodexDropdownPortal>
          <NodexDropdownContent>
            <WhatsNewMenuSection openAfterClose={(open) => open()} />
          </NodexDropdownContent>
        </NodexDropdownPortal>
      </NodexDropdownRoot>
      <NodexModalHost />
    </QueryClientProvider>,
  );
  return {
    invoke,
    seen: () => values[SEEN_KEY] ?? null,
    open: async () => {
      await openNodexMenu(screen.getByRole("button", { name: "Help" }));
      return screen.findByRole("menuitem", { name: /Plugin tools for Claude Code/ });
    },
  };
}

const freshReleases = () =>
  screen
    .getAllByRole("menuitem")
    .filter((item) => item.querySelector("[data-fresh]") !== null)
    .map((item) => item.textContent);

async function choose(item: HTMLElement) {
  await act(async () => {
    fireEvent.click(item);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

afterEach(() => clearPersistedAtomStoreForTests());

describe("What's new", () => {
  test("lists the newest releases, marks the ones published since the last look, then remembers them", async () => {
    const view = renderWhatsNew("0.5.10");
    await view.open();

    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Plugin tools for Claude Code and ACPNov 24",
      "Google Antigravity and a smaller NodexNov 23",
      "A search-first command paletteNov 18",
      "Full changelog",
    ]);
    // Showing the releases counts as seeing them, while the marks stay for as long as the menu is open.
    await waitFor(() => expect(view.seen()).toBe("0.5.12"));
    expect(freshReleases()).toEqual([
      "Plugin tools for Claude Code and ACPNov 24",
      "Google Antigravity and a smaller NodexNov 23",
    ]);

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await view.open();
    expect(freshReleases()).toEqual([]);
  });

  test("the first look sets the baseline instead of marking every release new", async () => {
    const view = renderWhatsNew(null);
    await view.open();

    expect(freshReleases()).toEqual([]);
    await waitFor(() => expect(view.seen()).toBe("0.5.12"));
  });

  test("a release opens its notes in place, and the changelog opens on the website", async () => {
    const view = renderWhatsNew("0.5.12");
    await choose(await view.open());

    // The row's headline titles the notes, under the release's day and version.
    const notes = await screen.findByRole("dialog", {
      name: "Plugin tools for Claude Code and ACP",
    });
    expect(within(notes).getByText("November 24, 2026")).toBeDefined();
    expect(within(notes).getByText("v0.5.12")).toBeDefined();
    expect(
      within(notes)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Added", "Fixed"]);
    expect(within(notes).getByText("Settings > General").tagName).toBe("STRONG");
    expect(within(notes).getByText("nodex").tagName).toBe("CODE");

    await act(async () => {
      fireEvent.click(within(notes).getByRole("button", { name: "View in full changelog" }));
      await Promise.resolve();
    });
    expect(view.invoke).toHaveBeenCalledWith(
      "shell:open-external-url",
      "https://nodex.jyu.app/changelog/#v0.5.12",
    );

    await act(async () => {
      fireEvent.click(within(notes).getByRole("button", { name: "Close" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await view.open();
    await choose(screen.getByRole("menuitem", { name: "Full changelog" }));
    expect(view.invoke).toHaveBeenLastCalledWith(
      "shell:open-external-url",
      "https://nodex.jyu.app/changelog/",
    );
  });
});
