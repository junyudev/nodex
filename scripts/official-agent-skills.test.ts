import { cp, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  generateOfficialAgentSkills,
  OFFICIAL_SKILL_FILES,
  renderMarkdownReference,
  verifyOfficialAgentSkills,
} from "./official-agent-skills";
import { NODEX_MARKDOWN_AGENT_GUIDE } from "../src/shared/nodex-markdown/agent-guide";
import { readMarkdown } from "../src/shared/nodex-markdown";
import { writeMarkdown } from "../src/shared/nodex-markdown";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nodex-official-skills-"));
  await cp(join(REPOSITORY_ROOT, "agent-skills"), join(root, "agent-skills"), { recursive: true });
  await cp(join(REPOSITORY_ROOT, "LICENSE"), join(root, "LICENSE"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "nodex", version: "1.2.3" }, null, 2)}\n`,
  );
  await mkdir(join(root, ".generated"));
  return root;
}

describe("official Agent Skills artifact", () => {
  test("generates the exact public tree reproducibly", async () => {
    const root = await makeFixture();
    const options = {
      repositoryRoot: root,
      sourceRepository: "NodexApp/nodex",
      sourceRef: "v1.2.3",
    } as const;

    const first = await generateOfficialAgentSkills(options);
    const firstManifest = await readFile(
      join(root, ".generated", "official-agent-skills", "release-manifest.json"),
      "utf8",
    );
    const second = await generateOfficialAgentSkills(options);
    const secondManifest = await readFile(
      join(root, ".generated", "official-agent-skills", "release-manifest.json"),
      "utf8",
    );

    expect(second).toEqual(first);
    expect(secondManifest).toBe(firstManifest);
    expect(first.skills).toEqual([
      expect.objectContaining({
        name: "nodex",
        path: "skills/nodex",
        fileCount: OFFICIAL_SKILL_FILES.length,
      }),
    ]);
    await expect(verifyOfficialAgentSkills(options)).resolves.toEqual(first);
  });

  test("rejects unknown files and symlinks from the authoring tree", async () => {
    const unknownRoot = await makeFixture();
    await writeFile(join(unknownRoot, "agent-skills", "nodex", "README.md"), "not publishable\n");
    await expect(
      generateOfficialAgentSkills({
        repositoryRoot: unknownRoot,
      }),
    ).rejects.toThrow("unknown file");

    const symlinkRoot = await makeFixture();
    const reference = join(
      symlinkRoot,
      "agent-skills",
      "nodex",
      "references",
      "troubleshooting.md",
    );
    await writeFile(join(symlinkRoot, "outside.md"), "outside\n");
    await import("node:fs/promises").then(({ rm }) => rm(reference));
    await symlink(join(symlinkRoot, "outside.md"), reference);
    await expect(
      generateOfficialAgentSkills({
        repositoryRoot: symlinkRoot,
      }),
    ).rejects.toThrow("symlink");
  });

  test("renders production Nodex Markdown examples through the real codec", () => {
    expect(renderMarkdownReference()).toContain(
      `revision: \`${NODEX_MARKDOWN_AGENT_GUIDE.specificationVersion}\``,
    );
    for (const example of NODEX_MARKDOWN_AGENT_GUIDE.examples) {
      expect(writeMarkdown(readMarkdown(example))).toBe(example);
    }
  });
});
