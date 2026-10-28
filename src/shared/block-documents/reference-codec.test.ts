import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import { readMarkdown } from "../nodex-markdown";
import { writeMarkdown } from "../nodex-markdown";
import {
  BlockDocumentCodecError,
  createPageDocumentGenesis,
  materializePageDocument,
} from "./block-document-codec";

const appendParagraphChild = (document: Y.Doc): void => {
  const root = document.getXmlFragment("body").get(0);
  if (!(root instanceof Y.XmlElement)) throw new Error("Missing body root");
  const reference = root.get(0);
  if (!(reference instanceof Y.XmlElement)) throw new Error("Missing reference");
  const childGroup = new Y.XmlElement("blockGroup");
  const childContainer = new Y.XmlElement("blockContainer");
  childContainer.setAttribute("id", "nested-under-reference");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("backgroundColor", "default");
  paragraph.setAttribute("textAlignment", "left");
  paragraph.setAttribute("textColor", "default");
  childContainer.insert(0, [paragraph]);
  childGroup.insert(0, [childContainer]);
  reference.insert(reference.length, [childGroup]);
};

describe("Block-first reference codec", () => {
  test("requires owning Page identity", () => {
    expect(() => readMarkdown("::page{}", "exact")).toThrow("id");
  });

  test("round-trips canonical references through the BlockNote adapter", () => {
    const source =
      '::page-ref{page="card-1"}\n\n::database-view-ref{view="view-1" hint="Roadmap"}\n\n::template-ref{source="template-1" hint="Incident & review"}';
    const blockNoteBlocks = readMarkdown(source, "exact");

    expect(blockNoteBlocks.every((block) => (block.children?.length ?? 0) === 0)).toBe(true);
    expect(writeMarkdown(blockNoteBlocks)).toBe(source);
  });

  test("hoists attempted children out of reference and resource Blocks", () => {
    const blocks = readMarkdown(
      '::page-ref{page="card-1"}\n\nPage child\n\n::database-view-ref{view="view-1"}\n\nView child\n\n::page{id="page-shell"}\n\nPage shell child',
    );

    expect(blocks.map((block) => block.type)).toEqual([
      "pageRef",
      "paragraph",
      "databaseViewRef",
      "paragraph",
      "page",
      "paragraph",
    ]);
  });

  test("rejects persisted children beneath canonical references", () => {
    const genesis = createPageDocumentGenesis({
      documentId: "reference-children",
      title: "References",
      markdown: '::page-ref{page="card-1"}',
    });
    appendParagraphChild(genesis.document);

    expect(() => materializePageDocument(genesis.document)).toThrow(BlockDocumentCodecError);
  });
});
