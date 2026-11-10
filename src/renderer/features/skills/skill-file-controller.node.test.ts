import { afterEach, expect, test, vi } from "vite-plus/test";
import type { SkillSaveResult } from "../../../shared/skill-inventory";
import { createSkillFileController } from "./skill-file-controller";
import { flushSkillFiles, mountSkillFile } from "./skill-file-lifecycle";
import { skillDocument } from "./skill-test-fixtures";

function setup() {
  let revision = 1;
  const write = vi.fn(
    async ({ markdown }: { baseRevision: string; markdown: string }): Promise<SkillSaveResult> => ({
      status: "ok",
      value: { ...skillDocument, markdown, revision: String(++revision) },
    }),
  );
  return { write, controller: createSkillFileController(skillDocument, write) };
}

afterEach(() => vi.useRealTimers());

test("follows disk changes while clean, including a change that needs Source", () => {
  const { controller, write } = setup();
  try {
    const document = {
      ...skillDocument,
      revision: "external",
      markdown: "<aside>Raw HTML</aside>\n",
    };
    controller.observeDisk(document);
    expect(controller.getSnapshot()).toMatchObject({
      document,
      sourceText: document.markdown,
      mode: "source",
      conflict: null,
    });
    expect(write).not.toHaveBeenCalled();
  } finally {
    controller.dispose();
  }
});

test.each(["mine", "disk"] as const)(
  "keeps the dirty source on conflict and can use %s",
  async (resolution) => {
    const { controller, write } = setup();
    try {
      await controller.setMode("source");
      const mine = skillDocument.markdown + "My edit.\n";
      const disk = {
        ...skillDocument,
        revision: "external",
        markdown: skillDocument.markdown + "External edit.\n",
      };
      controller.setSourceText(mine);
      controller.observeDisk(disk);
      expect(controller.getSnapshot()).toMatchObject({ sourceText: mine, conflict: disk });
      expect(await controller.flush()).toBe(false);
      expect(write).not.toHaveBeenCalled();
      await controller.resolveConflict(resolution);
      expect(controller.getSnapshot()).toMatchObject({
        conflict: null,
        sourceText: resolution === "mine" ? mine : disk.markdown,
      });
      if (resolution === "mine") {
        expect(write).toHaveBeenCalledExactlyOnceWith({
          baseRevision: disk.revision,
          markdown: mine,
        });
      } else {
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      controller.dispose();
    }
  },
);

test("debounces Source and serializes a second write against the first receipt", async () => {
  vi.useFakeTimers();
  const { controller, write } = setup();
  let resolveFirst!: (result: SkillSaveResult) => void;
  write.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  try {
    await controller.setMode("source");
    const first = skillDocument.markdown + "First.\n";
    const second = first + "Second.\n";
    controller.setSourceText(first);
    await vi.advanceTimersByTimeAsync(599);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledExactlyOnceWith({ baseRevision: "1", markdown: first });
    controller.setSourceText(second);
    const flush = controller.flush();
    expect(write).toHaveBeenCalledTimes(1);
    resolveFirst({
      status: "ok",
      value: { ...skillDocument, revision: "first-save", markdown: first },
    });
    expect(await flush).toBe(true);
    expect(write).toHaveBeenLastCalledWith({ baseRevision: "first-save", markdown: second });
    expect(controller.getSnapshot()).toMatchObject({
      document: { markdown: second },
      sourceText: second,
      conflict: null,
    });
  } finally {
    controller.dispose();
  }
});

test("patches frontmatter and retains the receipt while the disk watch catches up", async () => {
  const { controller, write } = setup();
  try {
    const markdown = skillDocument.markdown.replace("Review a release.", '"Inspect the build."');
    await expect(
      controller.patchFrontmatter({ description: "Inspect the build." }),
    ).resolves.toEqual({ ok: true });
    expect(write).toHaveBeenCalledExactlyOnceWith({ baseRevision: "1", markdown });
    expect(controller.getSnapshot().document.markdown).toBe(markdown);
    expect(
      controller.getSnapshot().session.getSnapshot().source.frontmatter.description.value,
    ).toBe("Inspect the build.");
  } finally {
    controller.dispose();
  }
});

test("flushes an unmounted page before releasing its controller", async () => {
  const { controller, write } = setup();
  const unmount = mountSkillFile(controller, "surface:inspect");
  await controller.setMode("source");
  const markdown = skillDocument.markdown + "Saved on close.\n";
  controller.setSourceText(markdown);
  unmount();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledExactlyOnceWith({ baseRevision: "1", markdown }),
  );
  await expect(flushSkillFiles()).resolves.toBe(true);
});

test("can return to Rich after replacing unsupported Source with Markdown", async () => {
  const { controller } = setup();
  try {
    controller.observeDisk({
      ...skillDocument,
      revision: "external",
      markdown: "<aside>Raw HTML</aside>",
    });
    expect(controller.getSnapshot().mode).toBe("source");
    controller.setSourceText(skillDocument.markdown);
    await controller.setMode("rich");
    expect(controller.getSnapshot().mode).toBe("rich");
    expect(controller.getSnapshot().session.getSnapshot().source.text).toBe(skillDocument.markdown);
  } finally {
    controller.dispose();
  }
});

test("keeps my edits after a revision conflict returned by the writer before the watcher", async () => {
  const { controller, write } = setup();
  const external = {
    ...skillDocument,
    revision: "outside",
    markdown: skillDocument.markdown + "External.\n",
  };
  write.mockResolvedValueOnce({ status: "conflict", document: external });
  try {
    await controller.setMode("source");
    const markdown = skillDocument.markdown + "Keep this.\n";
    controller.setSourceText(markdown);
    expect(await controller.flush()).toBe(false);
    await controller.resolveConflict("mine");
    expect(controller.getSnapshot()).toMatchObject({
      document: { markdown },
      sourceText: markdown,
      conflict: null,
    });
  } finally {
    controller.dispose();
  }
});
