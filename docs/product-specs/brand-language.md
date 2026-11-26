# Brand Language

This document owns the product-wide naming boundary for user-visible Nodex
copy. It does not rename protocol types, source identifiers, storage keys,
compatibility layers, or third-party products.

## Product voice

- User-visible copy names the application and its agent experience **Nodex**.
  Nodex works on a task, runs a clock Automation, creates a worktree, compacts
  context, and asks the user for approval or clarification.
- Product-facing navigation and instructions use **task** for a Codex app-server
  Thread. Use `thread` only when the distinction is itself part of a technical
  or developer-facing surface.
- Do not use **ChatGPT** or **Codex** as a synonym for Nodex, the application,
  or the assistant in labels, descriptions, placeholders, toasts, dialogs,
  exported headings or notifications.

## The name

Nodex is named for what every Agent becomes in it: a node. Whichever provider
runs a chat, it can hand work to an Agent of any other provider and take work
from any other chat, so Nodex sits in every node rather than at the center of
the graph Aerial view draws. Two lines carry the idea:

- **Every agent, a node. Every node, Nodex.**
  (每个智能体都是一个节点，每个节点都是 Nodex。) The site closes its Aerial view
  section on it, the READMEs close theirs, and the About panel shows it. Its
  first half signs every social card and opens the home page's description.
- **Agent nodes, crossed.** (智能体节点，彼此交汇。) The site's wordmark can draw
  its x as two delegation lines crossing, in the colors Aerial view gives
  Claude Code and Codex; the footer says this line beside it.

Say what the name means in these places and let Aerial view show it everywhere
else. Agents read the same idea where their Nodex tools guidance begins. Node
is not a product noun: the interface keeps naming chats, subagents, Agents and
Pages. Copy that presents Nodex as a coordinator or orchestrator running the
Agents contradicts the name; describe the Agents working with one another.
Chinese copy uses each surface's own word for Agent.

## External names

Keep an external product name when the name tells the user which outside
account, asset, executable, configuration, model, or import source is involved.
Examples include:

- `Sign in with ChatGPT`, ChatGPT conversation history, and ChatGPT Atlas.
- Codex CLI, Codex config, a Codex import source, and a model whose formal name
  includes Codex.
- Codex-compatible app-server and protocol terminology on explicitly technical
  or developer-facing surfaces.

When an external runtime detail is not actionable, prefer a neutral phrase such
as `agent runtime` or `model` instead of leaking its implementation brand into
ordinary product copy.

## Code boundary

Existing `Codex*` types, modules, IPC channels, CSS hooks, storage keys, and
compatibility contracts remain unchanged unless their owning technical contract
is deliberately migrated. Branding cleanup changes presentation language, not
transport or persistence identity.
