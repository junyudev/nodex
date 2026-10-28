import { describe, expect, test } from "vite-plus/test";
import { htmlToBlocks } from "./index";
import { writePortableMarkdown } from "../nodex-markdown";

const asMessage = (html: string) => writePortableMarkdown(htmlToBlocks(html));

describe("HTML import", () => {
  test.each([
    [
      "chat line breaks",
      "<span>first line</span><br><span>second line</span>",
      "first line\nsecond line",
    ],
    [
      "lines written as divs, with an empty line between paragraphs",
      "<div>Buy milk</div><div>Call Sam</div><div><br></div><div>Later</div>",
      "Buy milk\nCall Sam\n\nLater",
    ],
    [
      "mail nested in a direction wrapper",
      '<div dir="ltr">Hi team,<div><br></div><div>The build is <b>green</b>.</div><div>Thanks</div></div>',
      "Hi team,\n\nThe build is **green**.\nThanks",
    ],
    [
      "a document's CSS marks and its weight-resetting wrapper",
      '<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span>Plain paragraph</span></p><p><span style="font-weight:700">Bold</span> and <span style="font-style:italic">slanted</span></p></b>',
      "Plain paragraph\n\n**Bold** and *slanted*",
    ],
    [
      "a web page's structure",
      '<h2>Install</h2><p>Run <code>npm i</code>, then read <a href="https://example.com/docs">the docs</a>.</p><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><pre><code class="language-sh">make\nmake test</code></pre>',
      "## Install\n\nRun `npm i`, then read [the docs](https://example.com/docs).\n- one\n- two\n  - nested\n\n```bash\nmake\nmake test\n```",
    ],
    [
      "a spreadsheet's cells",
      "<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Apple</td><td>3</td></tr></table>",
      "| Name | Qty |\n| --- | --- |\n| Apple | 3 |",
    ],
    [
      "checklists",
      '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>',
      "- [x] done\n- [ ] todo",
    ],
  ])("keeps %s", (_source, html, markdown) => {
    expect(asMessage(html).markdown).toBe(markdown);
  });
});
