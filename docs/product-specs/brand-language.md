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
