# Nodex Markdown

Status: Active. [ADR 0073](../adr/0073-one-text-language-for-blocks.md) adopts
Nodex Markdown as the one text language of Blocks. Core links the Rust crate
natively; the app uses its WebAssembly build.

## Scope

Nodex Markdown is one text language for Blocks. It is GitHub Flavored Markdown,
read the way GitHub reads a comment, plus a small set of extensions for what
Markdown cannot say. The same language serves every exchange of text:

- **Exact text** says a Block tree exactly. It is what Agents read, write and
  patch, and the text projection Nodex stores. Every Block tree has one exact
  text, and reading that text gives the same Blocks back.
- **Portable text** is the same writer with the extensions left out, for apps
  that read only Markdown: the clipboard, chat apps and exports. It is not exact,
  and Nodex says so.

Every text this document shows is pinned by
`crates/nodex-markdown/tests/fixtures/cases.json`. Each case there
pairs one exact text with its Blocks, and may list other spellings that read as
the same Blocks. The fixture also lists texts an exact write refuses, and how
such text reads everywhere else. `src/shared/nodex-markdown/nodex-markdown-fixture.test.ts`
checks that every case's Blocks are Blocks as Nodex stores them, that the cases
cover every Block type Nodex keeps, every inline type and every style, and that every case marked `gfm`,
with its other GFM spellings, reads as its Blocks through the committed WebAssembly module.

## Rules the language follows

1. **GFM means what GitHub says.** Text that uses no extension reads as GitHub
   reads it, within what Blocks can hold.
2. **Where GitHub already has a form, use it.** Alerts are callouts, `<br>` is
   a line break, an HTML comment says nothing, and an autolink to a Page or a
   chat shows it.
3. **One extension mechanism.** Everything else Nodex-specific is a directive
   (`:::name`, `::name`, `:name`) or an attribute list (`{name="value"}`).
4. **One exact text.** The writer makes no choices of its own: separators,
   markers, fences and escapes all follow from the Blocks.
5. **Read as documented, or refuse.** An exact write that looks like Nodex
   syntax but is malformed is rejected with the reason. It is never read as
   something else.
6. **Content, never actions.** A directive says a Block or an inline atom. It
   never makes Nodex do anything; Agents act through typed tools. Quoting a
   directive, in code or in prose, has no effect.

## What the text says

The text says a Document's Blocks: each Block's type, its content props, its
text, and the Blocks under it. It leaves out what is not content:

- Block identities, except the identity of an owning Page, Database or Canvas,
  which is that Block's content. A write keeps the identity of each Block it
  leaves unchanged.
- A toggle's open or closed state, which belongs to the view.
- Text alignment, which Nodex does not offer outside table columns.
- A numbered item's `start` anywhere but the first item of a run, where Nodex
  numbers from it.
- An image's file name and natural size, which Nodex reads from the file and the
  image. A write keeps them on the images it leaves unchanged.

The empty string is the Document whose only Block is an empty paragraph.

## Reading

Nodex Markdown is read by the rules of
[Markdown Interchange](./markdown-interchange.md#reading-markdown): CommonMark
with GFM tables, task lists, strikethrough and bare-URL links, CJK-friendly
emphasis, `$$` math, and GitHub's own departures from the GFM specification.
This document adds the extensions and the edge forms exact text needs.

Two things vary with where text comes from:

- **Line breaks.** Text people and Agents write is read as a comment: a single
  newline inside a paragraph is a line break, and the lines of a top-level
  paragraph keep their indentation. A Markdown file is read as a document: a
  single newline is a space, as GitHub reads a README. Exact text is always read
  as a comment.
- **Strictness.** An exact write rejects malformed Nodex syntax: a container
  without its closing line, a line of colons that closes nothing, a directive
  with a missing or unknown attribute (Agent config keeps attributes it does not
  know), an attribute list with an invalid value, and HTML Nodex does not read.
  Everywhere else such text is read as the text it is, except that a container
  without its closing line still reads as a container, as
  [Containers](#containers) describes, so a reply reads while it streams.

### Where Nodex reads GFM differently from GitHub

- Headings five and six read as four, the deepest heading Nodex has.
- HTML is read only where Nodex has the same thing: `<br>` is a line break, a
  comment says nothing, and `<b>`, `<strong>`, `<i>`, `<em>`, `<s>`, `<del>`,
  `<u>` and `<ins>` are their styles. `<sub>`, `<sup>` and `<kbd>` have no Nodex
  style: exact writes reject them, and other reading keeps their text. All other
  HTML is text, and exact writes reject it, since GitHub would have shown it
  differently.
- Math is also read as models write it: `\(…\)` is inline math, and `\[…\]` is
  a math Block on lines of its own and inline math within a line. GitHub reads
  these as escaped brackets.
- Footnotes and single-dollar math are text. A link's title is not kept.
- An image description that ends in a pipe and a number gives the image's
  width, as `![Diagram|480](url)`. GitHub keeps it in the image's alternative
  text and shows the image at its own size.
- The directive names and attribute lists below have Nodex meanings. Any other
  directive, such as `:::note`, is text.

## Writing exact text

### Layout

- Lines end with `\n`. No line ends in spaces or tabs, and the text does not
  end with a newline.
- A list item follows the line before it directly when that line ends a list
  item: a sibling, its parent item's text, or the last line of an item nested
  in the one before. A blank line separates every other pair of Blocks, such as
  a paragraph and the list after it, or a quote's text and its first child.
- A container's body starts on the line after its opening line, and its
  closing `:::` follows the body's last line.
- A list item's children are indented by the width of its marker and the space
  after it: two columns for `- ` and `- [ ] `, three for `1. `, four for `10. `.
  A quote's children continue its `> ` prefix, with `>` alone on blank lines.
  A container's body is indented two spaces past its opening line, so a
  container inside it indents again.
- An empty list item, heading or quote is its marker alone: `-`, `- [ ]`, `1.`,
  `#`, `>`.

### Escapes

Exact text has the fewest escapes that keep it exact. To write a Block's text,
the writer first escapes every ASCII punctuation character with a backslash,
and writes every space or tab at a line's start or end as a character reference
(`&#x20;` or `&#x9;`). Then, from the last escape to the first, it removes each
escape whose removal leaves the Block reading the same in its place, in exact
mode. Code spans, code Blocks and math are literal and have no escapes. An
implementation may use equivalent context rules, but its output must match this
definition.

So `snake_case`, `[draft`, `a | b`, `#5`, `50% & more` and `:::note` read as
typed, while these keep their escapes:

| Text                      | Exact text                 | What the escape prevents |
| ------------------------- | -------------------------- | ------------------------ |
| `- not a list`            | `\- not a list`            | a bullet                 |
| `2024. was a year`        | `2024\. was a year`        | a numbered item          |
| `# not a heading`         | `\# not a heading`         | a heading                |
| `*not emphasis*`          | `\*not emphasis*`          | emphasis                 |
| `Issue #` as a heading    | `# Issue \#`               | a closing hash           |
| `https://example.com`     | `https\://example.com`     | a bare-URL link          |
| `Use the <div> element`   | `Use the \<div> element`   | raw HTML                 |
| `:::toggle[Not a toggle]` | `\:::toggle[Not a toggle]` | a toggle                 |
| `Ends with {color="red"}` | `Ends with \{color="red"}` | an attribute list        |
| `    four spaces in`      | `&#x20;   four spaces in`  | indented code            |
| `trailing ` (a space)     | `trailing&#x20;`           | the space being dropped  |

### Line breaks

A line break is a newline. Where a newline cannot stand, it is `<br>`: in a
table cell, in a directive's label, and at the start or end of a text. A text
that is only a line break is `<br><!-- -->`, since `<br>` alone is an empty
paragraph. Spaces that start the line after a break are written by the escape
rules, so they stay text.

## Extension syntax

### Attribute lists

An attribute list is `{`, attributes separated by single spaces, and `}`. An
attribute is a name of lowercase letters, digits and hyphens, followed either
by `="value"` or by nothing, as a flag. Values are double-quoted and decode
character references; nothing else in them is an escape, so a backslash is
itself, as in `C:\tmp\notes`. A value holds no line break of its own. The writer
writes a quotation mark as `&quot;`, a newline as `&#10;`, and `&` as `&amp;`
only where it would begin a character reference. Single-quoted and unquoted
values, `#id` and `.class` are not attributes: an exact write rejects them, and
other reading takes the directive as text. Each directive writes its attributes
in the order listed below, and leaves out attributes at their defaults.

A Block's own attribute list ends its text, after a space, or is its whole text.
It is an attribute list only if the Block takes every name in it; otherwise it
is text. Once it is one, every value must be valid. The colors are `gray`,
`brown`, `red`, `orange`, `yellow`, `green`, `blue`, `purple` and `pink`:

```text
# Title {color="blue"}
Text {color="red" background="yellow"}
- [x] Done {background="green"}
{background="gray"}
```

The last line is an empty paragraph with a background. `color` is the text
color and `background` the background color. Paragraphs, headings, list items,
quotes, callouts and toggles take both. A table takes `color`, and a table cell
takes `background`.

### Directives

| Form      | Syntax                                    | Holds                           |
| --------- | ----------------------------------------- | ------------------------------- |
| Container | `:::name[label]{attributes}`, body, `:::` | a Block and the Blocks under it |
| Leaf      | `::name{attributes}` on a line of its own | a Block with no text            |
| Inline    | `:name{attributes}`                       | an inline atom, such as a date  |
| Span      | `:span[text]{attributes}`                 | text with underline or colors   |

- A container's label is the Block's text, read as inline Nodex Markdown on one
  line. Its body is the Blocks under it. Labels and attributes may be left out
  when empty. A leaf has no label. An inline atom always has its braces, even
  empty, as in `:agent-config{}`. A span always has its label.
- Directive names are exactly those in the tables below. Any other name is text.
- Directives and attribute lists are not read inside code spans, code Blocks or
  math, so `` `::page{id="x"}` `` is code.

### Containers

A container is an opening line, a body and a closing line:

```text
:::toggle[Details]
  Hidden paragraph

  :::callout[Inside]{icon="📌"}
    - detail
  :::
:::
```

- The opening line is `:::`, the name, an optional label and optional
  attributes, and nothing else.
- The body is the Block's children, indented two spaces past the opening line,
  with blank lines left empty. It is read with that indentation removed, as a
  list item's children are, so a container inside it indents again and a line of
  colons inside a code Block is code.
- The closing line is `:::` at the opening line's indentation. Exact writes
  require it, so a write cut short is refused rather than read short.
- Fences are always three colons. Nesting is indentation, never a count of
  colons. Inside a list item or a quote, all three lines take its indentation or
  its `> ` like any other line.

Containers as other Markdown tools write them, with an unindented body, read
too. When the first body line is not indented past the opening line, the body
runs to a line of three or more colons outside any code Block, which closes the
innermost open container. An opening line with more than three colons reads the
same.

Outside exact writes, a container without its closing line still reads as a
container: an indented body ends where its indentation does, and an unindented
body runs to the end of the Block that holds it, as an unclosed code fence does.
A reply streaming in reads at each moment as the start of what it will be.

## Blocks

| Block                   | Exact text                                                               | Fixture case                      |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------- |
| `paragraph`             | `Text`                                                                   | a paragraph                       |
| empty `paragraph`       | `<br>`                                                                   | an empty paragraph between Blocks |
| paragraph with children | `:::paragraph[Text]{color background}` … `:::`                           | a paragraph with Blocks under it  |
| `heading`               | `#` to `####`, a space, `Text`                                           | headings                          |
| toggle heading          | `:::toggle[Text]{heading="2" color background}` … `:::`                  | a toggle heading                  |
| `bulletListItem`        | `- Text`                                                                 | bullets                           |
| `numberedListItem`      | `1. Text`, numbered on from the first item's `start`                     | numbers                           |
| `checkListItem`         | `- [ ] Text`, `- [x] Text`                                               | tasks                             |
| `toggleListItem`        | `:::toggle[Text]{color background}` … `:::`                              | a toggle                          |
| `quote`                 | `> Text`                                                                 | a quote                           |
| `callout`               | `> [!TIP]` and the other alerts, or `:::callout[Text]{icon}` …           | the default callout is a tip      |
| `codeBlock`             | a backtick fence with the language                                       | a code Block                      |
| `mathBlock`             | `$$` fences                                                              | an equation                       |
| `table`                 | a pipe table, inside `:::table{…}` when it needs attributes              | a table                           |
| `divider`               | `---`                                                                    | a divider                         |
| `image`                 | `![Caption](url)` alone on its line, `![Caption\|480](url)` with a width | an image                          |
| `page`                  | `::page{id="…"}`                                                         | an owning Page                    |
| `database`              | `::database{id="…"}`                                                     | an owning Database and Canvas     |
| `canvas`                | `::canvas{id="…"}`                                                       | an owning Database and Canvas     |
| `pageRef`               | `::page-ref{page="…"}`                                                   | Block references                  |
| `databaseViewRef`       | `::database-view-ref{view="…" hint="…"}`                                 | Block references                  |
| `syncedBlockRef`        | `::synced-block-ref{source="…"}`                                         | Block references                  |
| `templateRef`           | `::template-ref{source="…" hint="…"}`                                    | Block references                  |

### Text Blocks and their children

A list item's, quote's or alert's first paragraph is its text, and the Blocks
after it are its children, as in GitHub. When such a Block's text is empty and
its first child is a paragraph, the text is written as `<!-- -->`, which says
nothing but keeps the paragraph a child:

```text
- <!-- -->

  Paragraph under an empty item
```

Markdown nests Blocks only under list items and quotes, so a paragraph or toggle
with Blocks under it is a container:

```text
:::paragraph[Parent]
  First child

  - Listed child
:::
```

A heading can hold Blocks only as a toggle heading. Code, math, tables,
dividers, images and the resource Blocks never hold Blocks.

### Headings and numbers

A heading is one to four `#`, a space and its text. A numbered list's first item
is written with its `start`, which defaults to one, and each item after it with
the next number. Only the first number is read, as GitHub reads it.

### Callouts

A callout whose icon is an alert's is that alert. A callout with any other icon
is a container:

| Icon | Exact text       |
| ---- | ---------------- |
| ℹ️   | `> [!NOTE]`      |
| 💡   | `> [!TIP]`       |
| ❗   | `> [!IMPORTANT]` |
| ⚠️   | `> [!WARNING]`   |
| 🛑   | `> [!CAUTION]`   |

```text
> [!TIP]
> The default callout {background="blue"}

:::callout[Heads up<br>second line]{icon="📌" color="red"}
  - detail
:::
```

The alert's text follows on the lines after the marker. Alerts read
case-insensitively.

### Code and math

A code Block is a backtick fence one longer than the longest run of backticks in
its code, and at least three, with the language's catalog id. Plain text has no
language written. The code follows line by line exactly as it is. Empty code is
the two fences. Tilde fences, indented code and language aliases such as `ts`
are read too. A math Block is a `$$` fence, longer than any line of the source
that is only dollars. A ` ```math ` fence also reads as a math Block, as
GitHub shows it.

### Tables

A table whose state GFM can say is a pipe table:

```text
| Name | Score |
| --- | ---: |
| Alpha | 10 |
```

Each row is `|`, then each cell as a space, its text, a space and `|`. An empty
cell is a single space. The delimiter row writes each column's alignment: `---`,
`:---:` or `---:`. Cells hold inline text, with `\|` for a pipe and `<br>` for a
line break, and end with a `{background="…"}` list when the cell has a
background.

A table that needs more is the same pipe table inside a `:::table` container:

| Attribute | Values                                                    | Default    |
| --------- | --------------------------------------------------------- | ---------- |
| `header`  | `none`, `column` or `both`                                | the row    |
| `widths`  | each column's width in pixels, or `auto`, comma-separated | all `auto` |
| `color`   | the table's text color                                    | none       |

With `header="none"` the first pipe row is an ordinary row. Nodex tables have no
merged cells. When a table's only row is its header row, every cell is a header,
so the table has no header column to state and is a plain pipe table.

### Images

An image alone on its line is an image Block, as GitHub shows it on a line of
its own: `![Caption](url)`. The caption is plain text, written with the fewest
escapes inside the brackets and read as the image's description. A width the
image was resized to follows the caption after a pipe, as Obsidian writes it:
`![Caption|480](url)`, or `![|480](url)` without a caption. A caption that
itself ends in a pipe and a number keeps its pipe escaped: `![Score \|10](url)`.
A URL with spaces, angle brackets or unbalanced parentheses is written as
`<url>`; a link's URL is written the same way. A pending image has no URL:
`![Uploading]()`. An image takes no color.

The URL names where the picture comes from: a Library File as `nodex://files/<id>`,
a web or `data:` image, or a file path, absolute or a `file:` URL, read from the
computer the content belongs to. Nodex shows an image it cannot read as unavailable.

An image anywhere else is an inline image, as GitHub shows it in place: within
text, in a list item's or quote's text, in a table cell, or inside a link, which
makes the image open the link, as a badge does in `[![build](badge.svg)](ci)`.
An inline image takes a width the same way. Nodex shows an inline image at the
height of the text, so icons and badges look as they do on GitHub, and a larger
image shows as a thumbnail that opens full size. A paragraph whose whole text is
one inline image that opens no link ends with `<!-- -->`, since the image alone
would be an image Block: `![icon](url)<!-- -->`.

The inline image is an inline type of the Block Document schema with its
`url`, `alt`, `width` and the link it opens; `url` names the source as it does for
an image Block.

### Resource Blocks

Leaf directives say Blocks that are references or owned resources:

- `::page{id}`, `::database{id}` and `::canvas{id}` are owning shells, and `id`
  is the owned resource's identity. A write may keep an owning shell only where
  it already stands. Creating, moving or deleting what it owns is a typed
  command.
- `::page-ref{page}`, `::database-view-ref{view hint}`,
  `::synced-block-ref{source}` and `::template-ref{source hint}` refer to a
  Page, a Database view or a source Block.

## Inline content

| Inline content       | Exact text                                               |
| -------------------- | -------------------------------------------------------- |
| bold, italic, strike | `**bold**`, `*italic*`, `~~strike~~`                     |
| code                 | `` `code` ``                                             |
| underline, colors    | `:span[text]{underline color="red" background="yellow"}` |
| link                 | `[text](url)`, or the bare URL when the text is the URL  |
| Page mention         | `<nodex://pages/ID>`                                     |
| date mention         | `:date{start end tz format time-format reminder}`        |
| chat mention         | `<nodex://sessions/ID>`                                  |
| attachment           | `:attachment{kind mode source name mime bytes origin}`   |
| Agent config         | `:agent-config{mode provider model reasoning speed}`     |
| inline math          | `$$E = mc^2$$`                                           |
| inline image         | `![alt](url)` within text, `[![alt](url)](link)` linked  |
| line break           | a newline, or `<br>` where a newline cannot stand        |

### Styles

The writer groups runs of text by their outermost shared wrapper and writes the
wrappers in this order, outermost first: link, span, bold, italic, strike, code.
Adjacent runs share one wrapper, so `[**`code`** in a link](url)` and
`***both***` are written that way.

Where a delimiter could not open or close where it stands, its range is written
inside a span with no attributes, whose brackets give the delimiter edges it
can open and close at. This covers bold that ends on punctuation before a
letter, and a style that starts right after another style ends:

```text
:span[**Note:**]plain
**a*b***:span[*c*]
```

A line break carries no style. Underscores, single tildes, `<https://…>` and the
HTML style tags are read but never written.

### Links and mentions

A link to a Page with its own text stays a link: `[Roadmap](nodex://pages/ID)`.
An autolink to a Page, `<nodex://pages/ID>`, is a Page mention, which shows the
Page's current title. An autolink to a Session, `<nodex://sessions/ID>`, is a
chat mention, which shows the chat's current title; these are the links Nodex
copies for a Page and a chat. A mention's text is never in the exact text, so
the exact text does not change when the Page or chat is renamed.

A chat mention names the chat's Session, the identity Page links, the sidebar
and the Workbench use. A newly added mention must name a Session in the current
Profile; projectless Sessions and Sessions in other Projects are valid targets. Until the schema renames it, it is the `threadMention`
inline type, whose `uuid` holds the Session's id. A conversation that only Codex
holds has no Session and is not mentioned: it is imported first, or linked as
`[Title](codex://threads/ID)`.

A code span's fence is one backtick longer than the longest run inside it. It is
padded with a space on each side when the code starts or ends with a backtick,
or starts and ends with a space. Inline math follows the same rule with dollar
signs, starting from two: `$$$a $$ b$$$`.

### Inline atoms

- **Date mention.** `start`, and optionally `end`, is `YYYY-MM-DD` or a date and
  time with its offset. `tz` is an IANA time zone. `format`, `time-format` and
  `reminder` take the values the date picker offers.
- **Attachment.** `kind` is `file`, `folder` or `text`. `mode` is `link`, or is
  left out for `materialized`. Then come `source`, `name`, `mime`, and `bytes`
  (never for a folder) and `origin`.
- **Agent config.** `mode`, `provider`, `model`, `reasoning` and `speed` as
  [Agent config](../product-specs/nfm-editor-agent-config-behavior.md) defines
  them. Attributes Nodex does not know are kept after them, as written.

## Portable text

Portable text is exact text with the extensions left out, as near as Markdown can
say them, and with the result reported as not exact.
[Markdown Interchange](./markdown-interchange.md#writing-markdown) owns those
rules. Because the two share one writer, portable text differs from exact text
only where an extension was used. Where Markdown is read as a document, a line
break is written as a backslash at the line's end.

## Agent contract

Agents read and write Page bodies in Nodex Markdown:

- `fetch` returns exact Nodex Markdown. Writes take Nodex Markdown in the one
  `markdown` field, and the CLI takes it as a body or a draft's `markdown`. The
  language includes GFM without a separate input format.
- Exact patches match `oldMarkdown` against the exact text and write
  `newMarkdown`.
- The Agent guide teaches GFM and this document's extensions only.

## Open questions

- **Header rows.** New tables from the editor have no header row, so most of
  them need `:::table{header="none"}`. If new tables started with a header row,
  most tables would be plain GFM.
- **Files.** A Markdown file is read as a document, so exact text with line
  breaks saved to a file and read back as a file loses them. One option is for
  the CLI to name a file's reading.
- **Codex reply forms.** Codex writes some forms of its own in replies, such as
  file citations `【F:src/parser.ts†L18】` and `:codex-file-citation{…}`. If
  replies through the Codex backend carry them, the boundary reader could read
  them as links to the file. They are not Nodex Markdown either way.
