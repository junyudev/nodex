import { act, fireEvent, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../../../test/browser-globals";
import { createLocalConversationSearchSource } from "./local-conversation-search-source";
import { MarkdownRenderer } from "./shared/markdown/markdown-renderer";
import { fixture, key, skill, deferred } from "./conversation-markdown-targets.test-fixtures";
import {
  ConversationMarkdownItemSourceProvider,
  useConversationMarkdownSource,
  type ConversationMarkdownSource,
} from "./conversation-markdown-source";

const menu = vi.hoisted(() => ({
  show: vi.fn<() => Promise<string | null>>(),
  copy: vi.fn(async (_text: string) => true),
}));
vi.mock("@/lib/native-context-menu", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/native-context-menu")>()),
  showNativeContextMenu: menu.show,
}));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: menu.copy }));
const invoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => null);
async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}
function SourceProbe({
  observe,
}: {
  readonly observe: (source: ConversationMarkdownSource | null) => void;
}) {
  const source = useConversationMarkdownSource();
  useLayoutEffect(() => observe(source), [observe, source]);
  return null;
}

describe("ordinary message targets keep their mounted source", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockRejectedValue(new Error("Unsupported fixture request"));
    menu.show.mockReset();
    menu.copy.mockClear();
    installWindowApi({ invoke, on: () => () => {} });
  });
  test("shared resource reads outlive one consumer but not their physical or resident source", async () => {
    const native = fixture("[Read](/tmp/read.ts)");
    const captured: ConversationMarkdownSource[] = [];
    const view = native.mount(
      [],
      <ConversationMarkdownItemSourceProvider
        source={{ kind: "item", entityKey: key.entityKey, itemId: key.itemId }}
      >
        <SourceProbe
          observe={(source) => {
            if (source) captured.push(source);
          }}
        />
      </ConversationMarkdownItemSourceProvider>,
    );
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      const source = captured.at(-1)!;
      expect(source.authority).toBe(native.owner);
      expect(source.isCurrent()).toBe(true);
      expect(source.isResourceCurrent()).toBe(true);
      view.unmount();
      expect(source.isCurrent()).toBe(false);
      expect(source.isResourceCurrent()).toBe(true);
      native.connect(2);
      expect(source.isResourceCurrent()).toBe(false);
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("a source stays current while the stage replaces its presentation context", async () => {
    const native = fixture("[Read](/tmp/read.ts)");
    const captured: ConversationMarkdownSource[] = [];
    const probe = (
      <SourceProbe
        observe={(source) => {
          if (source) captured.push(source);
        }}
      />
    );
    const view = native.mount([], probe);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      const source = captured.at(-1)!;
      // A new navigation callback or Skill list re-renders the stage without retiring its source,
      // so an image opened from the earlier render still presents.
      await act(async () => {
        view.rerender(native.rows([skill], probe, async () => {}));
        await Promise.resolve();
      });
      expect(captured.at(-1)).not.toBe(source);
      expect(source.isCurrent()).toBe(true);
      await act(async () => {
        native.connect(2);
        await Promise.resolve();
      });
      expect(source.isCurrent()).toBe(false);
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("the native ordinary body sends a decoded typed path to its source host once", async () => {
    const native = fixture("[Read](/tmp/a%252520b.ts#L19C2)", "remote-ssh-discovered:win");
    const readTurn = vi.spyOn(native.owner, "readTurn");
    const view = native.mount([]);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      const button = await view.findByRole("button", { name: "Read (line 19, column 2)" });
      await click(button);
      expect(native.opened).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          hostId: "remote-ssh-discovered:win",
          path: "/tmp/a%20b.ts",
          cwd: "/source",
          workspaceRoot: "/source-root",
          location: { line: 19, column: 2 },
        }),
      );
      expect(native.owner.readItem(key.entityKey, key.itemId)).toEqual(native.item);
      expect(readTurn).not.toHaveBeenCalled();
      expect(invoke.mock.calls.some(([channel]) => /turn.*start|queue.*start/u.test(channel))).toBe(
        false,
      );
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test.each(["local", "ssh:source"])(
    "relative file contents and native actions use the same captured directory on %s",
    async (hostId) => {
      const native = fixture("`@src/a%20b.ts:7`", hostId);
      invoke.mockImplementation(async (channel) => {
        if (channel === "read-file") return { contents: `${hostId} contents` };
        if (channel === "shell:open-file-link") return true;
        if (channel === "shell:file-link-openers:list-available") return ["vscode", "fileManager"];
        throw new Error(`Unsupported fixture request ${channel}`);
      });
      const view = native.mount([]);
      try {
        await act(async () => {
          native.connect();
          await Promise.resolve();
        });
        const button = await view.findByRole("button", { name: "a%20b.ts (line 7)" });
        await click(button);
        menu.show.mockResolvedValue("file-reference:copy-contents");
        await act(async () => {
          fireEvent.contextMenu(button);
          await Promise.resolve();
        });
        await waitFor(() => expect(menu.copy).toHaveBeenCalledWith(`${hostId} contents`));
        expect(invoke).toHaveBeenCalledWith("read-file", {
          hostId,
          path: "/source/src/a%20b.ts",
          maxBytes: 2 * 1024 * 1024,
        });
        expect(native.opened).toHaveBeenCalledWith(
          expect.objectContaining({ hostId, path: "/source/src/a%20b.ts" }),
        );
        menu.show.mockResolvedValue("file-reference:copy-path");
        await act(async () => {
          fireEvent.contextMenu(button);
          await Promise.resolve();
        });
        await waitFor(() => expect(menu.copy).toHaveBeenCalledWith("/source/src/a%20b.ts"));
        menu.show.mockResolvedValue("file-reference:open-with:vscode");
        await act(async () => {
          fireEvent.contextMenu(button);
          await Promise.resolve();
        });
        await act(async () => {
          fireEvent.click(button, { altKey: true });
          await Promise.resolve();
        });
        menu.show.mockResolvedValue("file-reference:reveal");
        await act(async () => {
          fireEvent.contextMenu(button);
          await Promise.resolve();
        });
        const nativeOpens = invoke.mock.calls.filter(
          ([channel]) => channel === "shell:open-file-link",
        );
        expect(nativeOpens).toEqual(
          hostId === "local"
            ? [
                ["shell:open-file-link", { path: "/source/src/a%20b.ts", line: 7 }, "vscode"],
                ["shell:open-file-link", { path: "/source/src/a%20b.ts", line: 7 }, "vscode"],
                ["shell:open-file-link", { path: "/source/src/a%20b.ts", line: 7 }, "fileManager"],
              ]
            : [],
        );
      } finally {
        view.unmount();
        native.dispose();
      }
    },
  );
  test.each(["inline", "voice"] as const)(
    "%s uses its real native item source and releases its held action",
    async (family) => {
      const native = fixture("[Read](/tmp/a%252520b.ts)", "local", family);
      const readTurn = vi.spyOn(native.owner, "readTurn");
      const view = native.mount([]);
      const choice = deferred<string | null>();
      menu.show.mockReturnValue(choice.promise);
      try {
        await act(async () => {
          native.connect();
          await Promise.resolve();
        });
        const button = await view.findByRole("button", { name: "Read" });
        await click(button);
        expect(native.opened).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path: "/tmp/a%20b.ts", hostId: "local" }),
        );
        native.opened.mockClear();
        await act(async () => {
          fireEvent.contextMenu(button);
          await Promise.resolve();
        });
        await act(async () => {
          if (family === "inline")
            native.owner.applyEvent({
              type: "changes",
              changes: [{ type: "item", key: { ...key, hostId: "local" }, value: null }],
            });
          else view.unmount();
          await Promise.resolve();
        });
        await act(async () => {
          choice.resolve("file-reference:open");
          await Promise.resolve();
        });
        expect(native.opened).not.toHaveBeenCalled();
        expect(readTurn).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        native.dispose();
      }
    },
  );
  test("a pending menu and file read cannot publish after item or connection retirement", async () => {
    const native = fixture("[Read](/tmp/read.ts)");
    const view = native.mount([]);
    const choice = deferred<string | null>();
    menu.show.mockReturnValue(choice.promise);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      const button = await view.findByRole("button", { name: "Read" });
      await act(async () => {
        fireEvent.contextMenu(button);
        await Promise.resolve();
      });
      view.unmount();
      await act(async () => {
        choice.resolve("file-reference:open");
        await Promise.resolve();
      });
      expect(native.opened).not.toHaveBeenCalled();
      const reopened = native.mount([]);
      try {
        const read = deferred<unknown>();
        invoke.mockImplementation(async (channel) => {
          if (channel === "read-file") return read.promise;
          throw new Error("Unsupported fixture request");
        });
        menu.show.mockResolvedValue("file-reference:copy-contents");
        const readButton = await reopened.findByRole("button", { name: "Read" });
        await act(async () => {
          fireEvent.contextMenu(readButton);
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(invoke).toHaveBeenCalledWith("read-file", {
            hostId: "local",
            path: "/tmp/read.ts",
            maxBytes: 2 * 1024 * 1024,
          }),
        );
        await act(async () => {
          native.connect(2);
          read.resolve({ contents: "retired" });
          await Promise.resolve();
        });
        expect(menu.copy).not.toHaveBeenCalled();
      } finally {
        reopened.unmount();
      }
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("catalog ambiguity retires the old Skill action without changing its authored search source", async () => {
    const native = fixture("$review and [$review](/skills/review/SKILL.md)");
    const view = native.mount([skill]);
    const choice = deferred<string | null>();
    menu.show.mockReturnValue(choice.promise);
    const search = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => native.project().entries,
      readOwner: () => native.owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      const controls = await view.findAllByRole("button", { name: "Review code" });
      await act(async () => {
        fireEvent.contextMenu(controls[0]!);
        await Promise.resolve();
      });
      view.rerender(native.rows([skill, { ...skill, path: "/other/SKILL.md" }]));
      await act(async () => {
        choice.resolve("file-reference:open");
        await Promise.resolve();
      });
      expect(native.opened).not.toHaveBeenCalled();
      expect(view.getAllByRole("button", { name: "Review code" })).toHaveLength(1);
      expect(native.owner.readItem(key.entityKey, key.itemId)).toEqual(native.item);
      expect(search.findMatches("$review").length).toBeGreaterThan(0);
      expect(search.findMatches("Review code")).toHaveLength(0);
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("a thread target carries its explicit host and captured root, then withdraws on source loss", async () => {
    const native = fixture("[Other](thread://same?hostId=ssh%3Amac)", "ssh:source");
    const view = native.mount([]);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      await click(await view.findByRole("button", { name: "Other" }));
      const [thread, context] = native.onOpenThread.mock.calls[0]!;
      expect(thread).toBe("same");
      expect(context).toEqual(
        expect.objectContaining({
          hostId: "ssh:mac",
          sourceRoot: { hostId: "ssh:source", threadId: "thread" },
        }),
      );
      expect(context?.isSourceCurrent?.()).toBe(true);
      await act(async () => {
        native.connect(1, "disconnected");
        await Promise.resolve();
      });
      expect(context?.isSourceCurrent?.()).toBe(false);
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("inline native code and citations retain their stage, while a link disables nested decorations", async () => {
    const native = fixture(
      "`@src/a%20b.ts:7` 【F:src/c%2520d.ts†L0-L4】 [\u0024review #abcdef](https://example.com) **PR** #123456 #abcdef",
    );
    const view = native.mount([skill]);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      await click(await view.findByRole("button", { name: "a%20b.ts (line 7)" }));
      await click(await view.findByRole("button", { name: "c%20d.ts (line 4)" }));
      expect(native.opened.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ path: "/source/src/a%20b.ts", location: { line: 7 } }),
        expect.objectContaining({ path: "/source/src/c%20d.ts" }),
      ]);
      const external = view.getByRole("link", { name: "$review #abcdef" });
      expect(external.querySelector("button,[data-hex-color-swatch]")).toBeNull();
      expect(view.container.querySelectorAll('[data-hex-color-swatch="#abcdef"]')).toHaveLength(1);
      expect(view.container.querySelector('[data-hex-color-swatch="#123456"]')).toBeNull();
    } finally {
      view.unmount();
      native.dispose();
    }
  });
  test("remote Skill definitions and itemless conversation fragments remain literal", async () => {
    const native = fixture("$review", "ssh:source");
    const view = native.mount([skill]);
    try {
      await act(async () => {
        native.connect();
        await Promise.resolve();
      });
      expect(await view.findByText("Review code")).toBeTruthy();
      expect(view.container.querySelector("[data-file-reference]")).toBeNull();
      view.rerender(
        native.rows([], <MarkdownRenderer dialect="conversation" content="[Read](/tmp/file.ts)" />),
      );
      expect(await view.findByText("Read")).toBeTruthy();
      expect(view.container.querySelector("[data-file-reference]")).toBeNull();
    } finally {
      view.unmount();
      native.dispose();
    }
  });
});
