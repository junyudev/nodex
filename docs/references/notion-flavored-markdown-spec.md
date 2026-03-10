### Notion-flavored Markdown
Notion-flavored Markdown is a variant of standard Markdown with additional features to support all Block and Rich text types.
Use tabs for indentation.
Use backslashes to escape characters. For example, \* will render as * and not as a bold delimiter.
These are the characters that should be escaped: \ * ~ ` $ [ ] < > { } | ^
Block types:
Markdown blocks use a {color="Color"} attribute list to set a block color.
Text:
Rich text {color="Color"}
	Children
Headings:
# Rich text {color="Color"}
## Rich text {color="Color"}
### Rich text {color="Color"}
#### Rich text {color="Color"}
(Headings 5 and 6 are not supported in Notion and will be converted to heading 4.)
Bulleted list:
- Rich text {color="Color"}
	Children
Numbered list:
1. Rich text {color="Color"}
	Children

Bulleted and numbered list items should contain inline rich text -- otherwise they will render as empty list items, which look awkward in the Notion UI. (The inline text should be rich text -- any other block type will not be rendered inline, but as a child to an empty list item.)
Empty line:
<empty-block/>
Notion renders blocks with appropriate spacing, so there is almost never a need to use empty lines.
To render correctly as an empty line, <empty-block/> must be on its own line with no other text.
Empty lines without <empty-block/> will be stripped out.
Rich text types:
Bold:
**Rich text**
Italic:
*Rich text*
Strikethrough:
~~Rich text~~
Underline:
<span underline="true">Rich text</span>
Inline code:
`Code`
Link:
`[Link text] (URL)`
Citation:
[^URL]
To create a citation, you can either reference a compressed URL like this,[^{{1}}] or a full URL like this.[^example.com]
Colors:
<span color?="Color">Rich text</span>
Inline math:
$Equation$ or $`Equation`$ if you want to use markdown delimiters within the equation.
There must be whitespace before the starting $ symbol and after the ending $ symbol. There must not be whitespace right after the starting $ symbol or before the ending $ symbol.
Inline line breaks within a block (this is mostly useful in multi-line quote blocks, where an ordinary newline character should not be used since it will break up the block structure):
<br>
Mentions:
Users, pages, databases, data sources, agents, dates, and datetimes can be mentioned:
<mention-user url="{{URL}}">User name</mention-user>
<mention-page url="{{URL}}">Page title</mention-page>
<mention-database url="{{URL}}">Database name</mention-database>
<mention-data-source url="{{URL}}">Data source name</mention-data-source>
<mention-agent url="{{URL}}">Agent name</mention-agent>
<mention-date start="YYYY-MM-DD" end="YYYY-MM-DD"/>
<mention-date start="YYYY-MM-DDThh:mm:ssZ" end="YYYY-MM-DDThh:mm:ssZ"/>
The URL must always be provided, and refer to an existing user, page, database, data source, agent, date, or datetime.
The inner text (name/title) is optional. The UI always displays the resolved name.
So an alternative self-closing format is also supported: <mention-user url="{{URL}}"/>
Custom emoji:
:emoji_name:
Colors:
Text colors (colored text with transparent background):
gray, brown, orange, yellow, green, blue, purple, pink, red
Background colors (colored background with contrasting text):
gray_bg, brown_bg, orange_bg, yellow_bg, green_bg, blue_bg, purple_bg, pink_bg, red_bg
Usage:
- Block colors: Add color="Color" to the first line of any block
- Rich text colors (text colors and background colors are both supported): Use <span color="Color">Rich text</span>

#### Advanced Block types for Page content
The following block types may only be used in page content.
<advanced-blocks>
Quote:
> Rich text {color="Color"}
	Children
Multi-line quote:
> Line 1<br>Line 2<br>Line 3 {color="Color"}
Use of a single > on a line without any other text should be avoided -- this will render as an empty blockquote, which is not visually appealing.
Unlike in standard markdown, multiple > lines will render as multiple separate quote blocks, not a single multi-line quote:
> Quote 1
> Quote 2
> Quote 3
To-do:
- [ ] Rich text {color="Color"}
	Children
- [x] Rich text {color="Color"}
	Children
Toggle (collapsed):
▶ Rich text {color="Color"}
	Children
Toggle (expanded):
▼ Rich text {color="Color"}
	Children
Toggle heading 1 (collapsed/expanded):
▶# Rich text {color="Color"}
▼# Rich text {color="Color"}
	Children
Toggle heading 2:
▶## Rich text {color="Color"}
▼## Rich text {color="Color"}
	Children
Toggle heading 3:
▶### Rich text {color="Color"}
▼### Rich text {color="Color"}
	Children
Toggle heading 4:
▶#### Rich text {color="Color"}
▼#### Rich text {color="Color"}
	Children
The ▶ marker denotes a collapsed toggle; ▼ denotes an expanded toggle. Both markers are interchangeable for parsing; the marker controls the initial open/closed state when rendered.
For toggles and toggle headings, the children must be indented in order for them to be toggleable. If you do not indent the children, they will not be contained within the toggle or toggle heading.
Divider:
---
Table:
<table fit-page-width?="true|false" header-row?="true|false" header-column?="true|false">
	<colgroup>
		<col color?="Color">
		<col color?="Color">
	</colgroup>
	<tr color?="Color">
		<td>Data cell</td>
		<td color?="Color">Data cell</td>
	</tr>
	<tr>
		<td>Data cell</td>
		<td>Data cell</td>
	</tr>
</table>
Note: All table attributes are optional. If omitted, they default to "false".
Table structure:
- <table>: Root element with optional attributes:
  - fit-page-width: Whether the table should fill the page width
  - header-row: Whether the first row is a header
  - header-column: Whether the first column is a header
- <colgroup>: Optional element defining column-wide styles. Do not include a <colgroup> element if you do not want to set any column colors or widths.
- <col>: Column definition with optional attributes:
  - color: The color of the column
  - width: The width of the column. Leave empty to auto-size.
- <tr>: Table row with optional color attribute
- <td>: Data cell with optional color attribute
Color precedence (highest to lowest):
1. Cell color (<td color="red">)
2. Row color (<tr color="blue_bg">)
3. Column color (<col color="gray">)
Contents of table cells:
- Table cells can only contain rich text. Other block types (headings, lists, images, etc.) are not supported.
- To apply rich text formatting inside of table cells, use Notion-flavored Markdown syntax, not HTML. For instance, bold text in a table should be wrapped in **, not <strong>.
Equation:
$$
Equation
$$
		Code:
```language
Code
```
Code fences may use backticks or tildes, and the opening and closing fence must use the same character. Use at least three fence characters. The closing fence may be longer than the opening fence. When code content itself includes a fence-like line, use a longer outer fence so the content remains literal.
Note: Do NOT escape special characters inside code blocks. Code block content is literal - write it exactly as it should appear. For example, write `const arr = [1, 2, 3]` NOT `const arr = \[1, 2, 3\]`. Backslash escaping rules only apply outside of code blocks.
XML blocks use the 'color' attribute to set a block color.
Callout:
<callout icon?="emoji" color?="Color">
	Rich text
	Children
</callout>
Callouts can contain multiple blocks and nested children, not just inline rich text. Each child block should be indented.
For any formatting inside of callout blocks, use Notion-flavored Markdown, not HTML. For instance, bold text in a callout should be wrapped in **, not <strong>.
Columns:
<columns>
	<column>
		Children
	</column>
	<column>
		Children
	</column>
</columns>
Page:
<page url="{{URL}}" color?="Color">Title</page>
WARNING: Using <page> with an existing page URL will MOVE the page to a new parent page with this content. If moving is not intended use the <mention-page> block instead.
Database:
<database url?="{{URL}}" inline?="true|false" icon?="Emoji" color?="Color" data-source-url?="{{URL}}">Title</database>
Provide either url or data-source-url attribute:
- If 'url' is an existing database URL, including it here will MOVE that database into the current page. If you just want to mention an existing database, use <mention-database> instead.
- If 'data-source-url' is an existing data source URL, creates a linked database view.
The 'inline' attribute toggles how the database is displayed in the UI. If set to "true", the database is fully visible and interactive on the page. If set to "false", the database is displayed as a sub-page. If you try to set inline to an invalid value, it will default to "false".
There is no 'Data Source' block type. Data Sources are always inside a Database, and only Databases can be inserted into a Page.
Audio:
<audio source="{{URL}}" color?="Color">Caption</audio>
File:
<file source="{{URL}}" color?="Color">Caption</file>
Image:
<image source="{{URL}}" color?="Color">Caption</image>
In Nodex, image `source` can also be a local asset URI:
`nodex://assets/<file-name>`.
Optional width is supported via `preview-width`:
`<image source="{{URL}}" preview-width="420">Caption</image>`
PDF:
<pdf source="{{URL}}" color?="Color">Caption</pdf>
Video:
<video source="{{URL}}" color?="Color">Caption</video>
(Note that source URLs can either be compressed URLs, such as source="{{1}}", or full URLs, such as source="example.com". Full URLs enclosed in curly brackets, like source="{{https://example.com}}" or source="{{example.com}}", do not work.)
Table of contents:
<table_of_contents color?="Color"/>
Synced block:
The original source for a synced block.
When creating a new synced block, do not provide the URL. After inserting the synced block into a page, the URL will be provided.
<synced_block url?="{{URL}}">
	Children
</synced_block>
Note: When creating new synced blocks, omit the url attribute - it will be auto-generated. When reading existing synced blocks, the url attribute will be present.
Synced block reference:
A reference to a synced block.
The synced block must already exist and url must be provided.
You can directly update the children of the synced block reference and it will update both the original synced block and the synced block reference.
<synced_block_reference url="{{URL}}">
	Children
</synced_block_reference>
Meeting notes:
<meeting-notes>
	Rich text (meeting title)
	<summary>
		AI-generated summary of the notes + transcript
	</summary>
	<notes>
		User notes
	</notes>
	<transcript>
		Transcript of the audio (cannot be edited)
	</transcript>
</meeting-notes>
- The <transcript> tag contains a raw transcript and cannot be edited by AI, but it can be edited by a user.
- When creating new meeting notes blocks, you must omit the <summary> and <transcript> tags.
- Only include <notes> in a new meeting notes block if the user is SPECIFICALLY requesting note content.
- Attempting to include or edit <transcript> will result in an error.
- All content within <summary>, <notes>, and <transcript> tags must be indented at least one level deeper than the <meeting-notes> tag.
Unknown (a block type that is not supported in the API yet):
<unknown url="{{URL}}" alt="Alt"/>
</advanced-blocks>
