import { documentBytesToBase64 } from "../../../shared/block-documents/http-wire";
import { writePortableMarkdown, type MarkdownBlock } from "../../../shared/nodex-markdown";
import type { VisualCaptureResult, VisualPageContext } from "../../../shared/visual/bridge";
import type { VisualRow, VisualValue } from "../../../shared/visual/contract";
import { visualBlockSource } from "../../../shared/visual/page-blocks";
import { visualAdapter } from "./visual-adapter";

const text = (value: string) => [{ type: "text", text: value }];
const paragraph = (value: string): MarkdownBlock => ({ type: "paragraph", content: text(value) });

const displayCell = (value: VisualValue | undefined) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

function portableTable(rows: string[][]): MarkdownBlock {
  return {
    type: "table",
    content: {
      type: "tableContent",
      headerRows: 1,
      rows: rows.map((row) => ({ cells: row.map((value) => text(value)) })),
    },
  };
}

function dataTable(rows: readonly VisualRow[]): MarkdownBlock | undefined {
  const fields = rows.flatMap(Object.keys);
  if (!fields.length) return undefined;
  const columns = [...new Set(fields)];
  // Sparse JSON can have a different field in every row. Keep the table linear in its data.
  if (rows.length * columns.length > Math.max(10_000, fields.length * 3)) {
    return portableTable([
      ["Row", "Field", "Value"],
      ...rows.flatMap((row, index) =>
        Object.entries(row).map(([name, value]) => [String(index + 1), name, displayCell(value)]),
      ),
    ]);
  }
  return portableTable([
    columns,
    ...rows.map((row) =>
      columns.map((name) => displayCell(Object.hasOwn(row, name) ? row[name] : undefined)),
    ),
  ]);
}

function projectVisual({ captures, resolved }: VisualCaptureResult): MarkdownBlock[] | undefined {
  if (!resolved) return undefined;
  const { captions, rows } = resolved;
  const capture = captures[0];
  const blocks: MarkdownBlock[] = [];
  if (capture)
    blocks.push({
      type: "image",
      props: {
        url: `data:image/png;base64,${documentBytesToBase64(capture.png)}`,
        caption: captions.join(" · "),
      },
    });
  for (const [figure, caption] of captions.entries()) {
    blocks.push(paragraph(caption));
    const sources = Object.entries(rows[figure]);
    for (const [name, data] of sources) {
      const table = dataTable(data);
      if (!table) continue;
      if (sources.length > 1) blocks.push(paragraph(name));
      blocks.push(table);
    }
  }
  return blocks;
}

function* pageBlocks(blocks: readonly MarkdownBlock[]): Generator<MarkdownBlock> {
  for (const block of blocks) {
    yield block;
    if (block.children) yield* pageBlocks(block.children);
  }
}

/** Copies the current Page with its Visual captures and resolved source data. */
export async function writePortablePageMarkdown(
  blocks: readonly MarkdownBlock[],
  page: VisualPageContext,
): Promise<string> {
  const projections = Object.create(null) as Record<string, MarkdownBlock[]>;
  // Capture one figure at a time so an export cannot open unbounded offscreen guests.
  for (const block of pageBlocks(blocks)) {
    const source = visualBlockSource(block);
    if (!block.id || source === undefined) continue;
    const result = await visualAdapter.capture(source, page, ["light"]).catch(() => undefined);
    const replacement = result && projectVisual(result);
    if (replacement) projections[block.id] = replacement;
  }
  return writePortableMarkdown(blocks, { blockProjections: projections }).markdown;
}
