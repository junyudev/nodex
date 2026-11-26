import { expect, test } from "vite-plus/test";
import { readUnreleasedChangesWithMedia } from "../../src/shared/change-media";
import { formatReleaseCard } from "./card-markdown";

const version = "0.5.15";
const release = {
  version,
  headline: "Aerial view and tables",
  releaseUrl: "https://github.com/junyudev/nodex/releases/tag/v0.5.15",
};

test("groups changes and leads each kind with the entries that have media", () => {
  const light = `${"a".repeat(64)}.png`;
  const dark = `${"b".repeat(64)}.png`;
  const video = `${"c".repeat(64)}.mp4`;
  const missing = `${"d".repeat(64)}.png`;
  const mediaEntry =
    "See the **board** in [Nodex](https://nodex.jyu.app/?open=yes). Follow a chat.";
  const darkOnlyEntry = "Try `echo Ready? Wait` from Terminal. Then continue.";
  const mediaPath = "changes/added/2026-11-22-board.md";
  const changes = readUnreleasedChangesWithMedia([
    { path: "changes/security/2026-11-20-credentials.md", content: "Restrict credential access." },
    { path: "changes/fixed/2026-11-20-rows.md", content: "Keep rows consistent." },
    {
      path: "changes/changed/2026-11-20-folders.md",
      content: "Clarify **folder** names. Use paths.",
    },
    { path: "changes/added/2026-11-20-first.md", content: "Open old chats. Keep context." },
    {
      path: mediaPath,
      content: `---
media:
  - caption: The board
    light: ${light}
    dark: ${dark}
  - caption: Motion in dark mode
    dark: ${video}
  - caption: A missing shot
    light: ${missing}
---
${mediaEntry}`,
    },
    {
      path: "changes/added/2026-11-23-terminal.md",
      content: `---\nmedia:\n  - caption: Terminal recording\n    dark: ${video}\n---\n${darkOnlyEntry}`,
    },
    { path: "changes/added/2026-11-24-last.md", content: "Keep a **note**." },
    { path: "changes/deprecated/2026-11-20-flags.md", content: "Deprecate a flag." },
    { path: "changes/removed/2026-11-20-views.md", content: "Remove old views." },
  ]);
  const markdown = formatReleaseCard({
    ...release,
    changes,
    files: new Map([
      [light, { url: "nodex://files/file:light", missing: false }],
      [dark, { url: "nodex://files/file:dark", missing: false }],
      [video, { url: "nodex://files/file:video", missing: false }],
      [missing, { url: null, missing: true }],
    ]),
  });
  expect(markdown).toBe(`**Aerial view and tables**

[Release](${release.releaseUrl}) · [Changelog](https://nodex.jyu.app/changelog/#v0.5.15) · 9 项更新：4 新增 · 1 改进 · 1 弃用 · 1 移除 · 1 修复 · 1 安全

## 新增

### See the **board** in [Nodex](https://nodex.jyu.app/?open=yes).

${mediaEntry}

![The board|720](nodex://files/file:light)

:::toggle[暗色版]
  ![The board|720](nodex://files/file:dark)
:::

[Motion in dark mode](nodex://files/file:video)

### Try \`echo Ready? Wait\` from Terminal.

${darkOnlyEntry}

[Terminal recording](nodex://files/file:video)

- Open old chats. Keep context.
- Keep a **note**.

## 改进

- Clarify **folder** names. Use paths.

## 弃用

- Deprecate a flag.

## 移除

- Remove old views.

## 修复

- Keep rows consistent.

## 安全

- Restrict credential access.

## 素材缺口

- 新增：Open old chats. 没有截图
- 新增：Keep a **note**. 没有截图
- 改进：Clarify **folder** names. 没有截图
- ${mediaPath}：${missing} 不在本地媒体库
`);
});

test("omits empty kinds and the gaps section when no media is expected", () => {
  const changes = readUnreleasedChangesWithMedia([
    { path: "changes/fixed/2026-11-20-rows.md", content: "Keep rows consistent." },
  ]);
  expect(formatReleaseCard({ ...release, changes, files: new Map() })).toBe(
    `**Aerial view and tables**

[Release](${release.releaseUrl}) · [Changelog](https://nodex.jyu.app/changelog/#v0.5.15) · 1 项更新：1 修复

## 修复

- Keep rows consistent.
`,
  );
});
