import { fromMarkdown } from "mdast-util-from-markdown";
import type { ChangeMediaItem, UnreleasedChange } from "../../src/shared/change-media";
import { CHANGELOG_SECTION_KINDS, type ChangelogSectionKind } from "../../src/shared/changelog";

const kindNames = {
  added: "新增",
  changed: "改进",
  deprecated: "弃用",
  removed: "移除",
  fixed: "修复",
  security: "安全",
} as const satisfies Record<ChangelogSectionKind, string>;

export interface CardMediaFile {
  readonly url: string | null;
  readonly missing: boolean;
}

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

function firstSentence(entry: string): string {
  // Code and link URLs can contain punctuation that is not part of the prose.
  const mask = entry.split("");
  const visit = (node: InlineNode): void => {
    if (node.type === "inlineCode" || node.type === "link" || node.type === "image") {
      if (node.position) mask.fill("X", node.position.start.offset, node.position.end.offset);
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  const [paragraph] = fromMarkdown(entry).children;
  if (paragraph?.type === "paragraph") paragraph.children.forEach(visit);
  const first = sentences.segment(mask.join(""))[Symbol.iterator]().next().value?.segment;
  const end = first?.trimEnd().length ?? entry.length;
  const closing = /^[*_~]+/u.exec(entry.slice(end))?.[0] ?? "";
  return entry.slice(0, end + closing.length);
}

type InlineNode = Extract<
  ReturnType<typeof fromMarkdown>["children"][number],
  { type: "paragraph" }
>["children"][number];

function renderMediaItem(
  { caption, light, dark }: ChangeMediaItem,
  files: ReadonlyMap<string, CardMediaFile>,
): readonly string[] {
  const label = caption.replace(/[\\_~&]/gu, "\\$&");
  const render = (name: string | undefined): string | null => {
    if (!name) return null;
    const url = files.get(name)?.url;
    if (!url) return null;
    return name.endsWith(".png") ? `![${label}|720](${url})` : `[${label}](${url})`;
  };
  const lightBlock = render(light);
  const darkBlock = render(dark);
  if (!lightBlock) return darkBlock ? [darkBlock] : [];
  if (!darkBlock) return [lightBlock];
  return [lightBlock, `:::toggle[暗色版]\n  ${darkBlock}\n:::`];
}

export function formatReleaseCard({
  version,
  headline,
  releaseUrl,
  changes,
  files,
}: {
  readonly version: string;
  readonly headline: string;
  readonly releaseUrl: string;
  readonly changes: readonly UnreleasedChange[];
  readonly files: ReadonlyMap<string, CardMediaFile>;
}): string {
  const counts: string[] = [];
  const sections: string[] = [];
  const screenshotGaps: string[] = [];
  const missingFiles: string[] = [];
  for (const kind of CHANGELOG_SECTION_KINDS) {
    const entries = changes.filter((change) => change.kind === kind);
    if (entries.length === 0) continue;
    const name = kindNames[kind];
    counts.push(`${entries.length} ${name}`);
    sections.push(`## ${name}`);
    const bullets: string[] = [];
    for (const { entry, media, path } of entries) {
      if (media.length === 0) {
        bullets.push(`- ${entry}`);
        if (kind === "added" || kind === "changed") {
          screenshotGaps.push(`- ${name}：${firstSentence(entry)} 没有截图`);
        }
        continue;
      }
      sections.push(`### ${firstSentence(entry)}`, entry);
      for (const item of media) {
        sections.push(...renderMediaItem(item, files));
        for (const file of [item.light, item.dark]) {
          if (file && files.get(file)?.missing)
            missingFiles.push(`- ${path}：${file} 不在本地媒体库`);
        }
      }
    }
    if (bullets.length > 0) sections.push(bullets.join("\n"));
  }
  const gaps = [...screenshotGaps, ...missingFiles];
  if (gaps.length > 0) sections.push("## 素材缺口", gaps.join("\n"));
  const links = `[Release](${releaseUrl}) · [Changelog](https://nodex.jyu.app/changelog/#v${version})`;
  const blocks = [
    `**${headline}**`,
    `${links} · ${changes.length} 项更新：${counts.join(" · ")}`,
    ...sections,
  ];
  return `${blocks.join("\n\n")}\n`;
}
