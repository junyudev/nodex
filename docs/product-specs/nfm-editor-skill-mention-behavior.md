# Page Editor Skill Mention Behavior

Status: Active
Last updated: 2026-11-10

Type `$` followed by a skill name at the start of a Block or after whitespace.
The picker opens when the query matches an available skill name prefix. The
`@` picker also includes a Skills section. Picking a row replaces the query
with one inline skill mention. File-backed skill editing uses standard Markdown.

The Page’s context supplies its skills. Library Pages see personal skills, and
Pages shown in a Project also see skills from its source directories. The picker
groups identical invocation names and labels the locations and Agents that can
use each skill. A chat beside the Page supplies its own execution context when
it receives a message.

Hover a mention to see the skill’s name, description, and locations. Click it
or select it with the arrow keys and press Enter to open its `SKILL.md`. If
several files share the name, choose one to open. A file on another host opens
through that host’s file route. A mention whose skill is
unavailable shows `$name` and explains its state on hover.

A mention stores only the invocation name, including any plugin qualification
and the provider’s case. It stays in the Page if the skill moves or disappears.
A mention creates no Page or chat backlink. Nodex Markdown writes it as
`:skill{name="review"}`. Use that syntax to author an atom through the CLI or
an Agent’s Page tools. Plain `$review`, `$5` and `$HOME` remain prose in a Page.

Prompt blocks, Send to chat, Add to composer, and Inbox dispatch project the
mention as a whitespace-delimited `$name` in the message. The receiving Agent
uses its own skills. Portable Markdown, plain text, and mobile display also use
`$name`. Copying Blocks within Nodex keeps the atom through the structured
clipboard. Pasting its plain spelling produces text.
