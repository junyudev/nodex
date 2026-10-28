/**
 * Source-shaped fixtures, not application clipboard captures. The Notes div shape was
 * reproduced in Chromium; the other wrappers are representative reconstructions.
 */
export const richHtmlSpacerFixtures = [
  {
    source: "Notes div lines",
    html: "<div>第一行</div><div>第二行</div><div><br></div><div>第三行</div>",
    composer: "第一行\n第二行\n\n第三行",
  },
  {
    source: "TextEdit Cocoa paragraphs",
    html: '<meta charset="utf-8"><p class="p1"><span class="s1">第一行</span></p><p class="p1">第二行</p><p class="p2"><span class="s1"><br></span></p><p class="p1">第三行</p>',
  },
  {
    source: "Pages styled paragraphs",
    html: '<div><p style="margin:0"><span style="font-size:12pt">第一行</span></p><p>第二行</p><p><span>&nbsp;</span></p><p>第三行</p></div>',
  },
  {
    source: "Google Docs paragraph and sibling break",
    html: '<b id="docs-internal-guid-1" style="font-weight:normal"><p dir="ltr"><span>第一行</span></p><p dir="ltr"><span>第二行</span></p><br><p dir="ltr"><span>第三行</span></p></b>',
  },
  {
    source: "Word paragraph placeholders",
    html: '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body><!--StartFragment--><p class="MsoNormal"><span>第一行<o:p></o:p></span></p><p class="MsoNormal">第二行<o:p></o:p></p><p class="MsoNormal"><span><o:p>&nbsp;</o:p></span></p><p class="MsoNormal">第三行<o:p></o:p></p><!--EndFragment--></body></html>',
  },
  {
    source: "web editor empty paragraphs",
    html: '<div data-slate-fragment="fragment"><p>第一行</p><p>第二行</p><p></p><p><br></p><p>&nbsp;</p><p>第三行</p></div>',
  },
  {
    source: "web editor nested div spacers and edge breaks",
    html: '<div><div><span><br>第一行<br></span></div><div>第二行<br class="Apple-interchange-newline"></div><div><span><br></span></div><div>第三行</div></div>',
    composer: "第一行\n第二行\n\n第三行",
  },
] as const;

export const richHtmlPlainText = "第一行\n第二行\n\n第三行";
export const richHtmlPageMarkdown = "第一行\n\n第二行\n\n第三行";
