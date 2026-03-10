This page demonstrates every Notion-flavored Markdown syntax available through the Notion MCP API.

---

# Heading 1
## Heading 2
### Heading 3
#### Heading 4

---

# Inline Text Formatting {color="blue"}

This is **bold text**, *italic text*, ~~strikethrough text~~, and `inline code`.

This has <span underline="true">underlined text</span> using the underline span.

You can combine them: ***bold italic***, **~~bold strikethrough~~**, *~~italic strikethrough~~*.

---

# Colors {color="purple"}

## Text Colors

<span color="gray">Gray text</span>, <span color="brown">Brown text</span>, <span color="orange">Orange text</span>, <span color="yellow">Yellow text</span>, <span color="green">Green text</span>, <span color="blue">Blue text</span>, <span color="purple">Purple text</span>, <span color="pink">Pink text</span>, <span color="red">Red text</span>

## Background Colors

<span color="gray_bg">Gray background</span>, <span color="brown_bg">Brown background</span>, <span color="orange_bg">Orange background</span>, <span color="yellow_bg">Yellow background</span>, <span color="green_bg">Green background</span>, <span color="blue_bg">Blue background</span>, <span color="purple_bg">Purple background</span>, <span color="pink_bg">Pink background</span>, <span color="red_bg">Red background</span>

---

# Block Colors {color="green"}

This is a green-colored block. {color="green"}

This is an orange-colored block. {color="orange"}

This is a red-colored block. {color="red"}

---

# Links and Citations {color="blue"}

[This is an inline link](https://example.com)

This sentence has a citation at the end.[^https://en.wikipedia.org/wiki/Markdown]

---

# Lists

## Bulleted List

- First bullet item
	Nested content under first item
- Second bullet item
- Third bullet item
	- Nested bullet
		- Deeply nested bullet

## Numbered List

1. First numbered item
1. Second numbered item
1. Third numbered item
	1. Nested numbered item
	1. Another nested item

## To-Do List

- [ ] Unchecked task
- [x] Completed task
- [ ] Another unchecked task
	- [x] Nested completed subtask

---

# Toggles

▶ Click to expand this toggle
	This content is hidden inside the toggle.
	You can put **any** content here.

▶# Toggle Heading 1
	Content inside a toggle heading 1.

▶## Toggle Heading 2
	Content inside a toggle heading 2.

▶### Toggle Heading 3
	Content inside a toggle heading 3.

---

# Quote Block {color="brown"}

> This is a single-line quote.

> This is a multi-line quote.<br>Second line of the quote.<br>Third line of the quote. {color="blue"}

---

# Callouts

<callout icon="💡" color="yellow_bg">
	**Tip:** This is a callout block with a lightbulb icon.
	You can include multiple paragraphs and *rich text* inside.
</callout>

<callout icon="⚠️" color="orange_bg">
	**Warning:** Be careful with this syntax!
</callout>

<callout icon="ℹ️" color="blue_bg">
	**Info:** Callouts support nested children too.
	- Bullet inside callout
	- Another bullet
</callout>

<callout icon="🔥" color="red_bg">
	**Important:** This callout has a red background.
</callout>

---

# Code Block

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

const greet = (user: User): string => {
  return `Hello, ${user.name}!`;
};
```

```python
def fibonacci(n: int) -> list[int]:
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result
```

---

# Math / Equations

## Inline Math

The quadratic formula is $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$ which solves $ax^2 + bx + c = 0$ .

## Block Math (Equation Block)

$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$

---

# Tables

## Simple Table

<table header-row="true">
	<tr>
		<td>Feature</td>
		<td>Supported</td>
		<td>Notes</td>
	</tr>
	<tr>
		<td>Bold</td>
		<td>Yes</td>
		<td>Use **double asterisks**</td>
	</tr>
	<tr>
		<td>Italic</td>
		<td>Yes</td>
		<td>Use *single asterisks*</td>
	</tr>
	<tr>
		<td>Code</td>
		<td>Yes</td>
		<td>Use `backticks`</td>
	</tr>
</table>

## Colored Table

<table fit-page-width="true" header-row="true" header-column="true">
	<colgroup>
		<col color="blue_bg">
		<col>
		<col>
	</colgroup>
	<tr color="gray_bg">
		<td>Category</td>
		<td>Q1</td>
		<td>Q2</td>
	</tr>
	<tr>
		<td>Revenue</td>
		<td color="green_bg">$1.2M</td>
		<td color="green_bg">$1.5M</td>
	</tr>
	<tr>
		<td>Costs</td>
		<td color="red_bg">$0.8M</td>
		<td color="orange_bg">$0.7M</td>
	</tr>
</table>

---

# Columns

<columns>
	<column>
		### Left Column
		This is the left column content.
		- Item A
		- Item B
	</column>
	<column>
		### Right Column
		This is the right column content.
		- Item C
		- Item D
	</column>
</columns>

---

# Divider

Content above the divider.

---

Content below the divider.

---

# Table of Contents

<table_of_contents/>

---

# Synced Block

<synced_block>
	This content can be synced across multiple pages.
	Once created, you can reference it elsewhere.
</synced_block>

---

# Date Mentions

Deadline: <mention-date start="2026-02-14"/>

Date range: <mention-date start="2026-03-01" end="2026-03-15"/>

Datetime: <mention-date start="2026-02-07T14:30:00Z"/>

---

# Escaped Characters

Special characters that need escaping: \* \~ \` \$ \[ \] \< \> \{ \} \| \^

Without escaping these would trigger formatting.

---

# Empty Block

Before empty block:
<empty-block/>
After empty block.

---

# Summary

This page covers the following Notion-flavored Markdown features:

1. Headings (H1 through H4)
1. Inline formatting (bold, italic, strikethrough, underline, code)
1. Text and background colors
1. Block-level colors
1. Links and citations
1. Bulleted, numbered, and to-do lists
1. Toggles and toggle headings
1. Quote blocks (single and multi-line)
1. Callout blocks with icons and colors
1. Code blocks with language syntax
1. Inline and block math equations
1. Simple and colored tables
1. Column layouts
1. Dividers
1. Table of contents
1. Synced blocks
1. Date and datetime mentions
1. Escaped special characters
1. Empty blocks