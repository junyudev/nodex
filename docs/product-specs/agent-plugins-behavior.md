# Agent Plugins behavior

## Stage 1 — local installation and review

The initial release covers installing, reviewing, enabling, disabling, and
uninstalling plugins. The Plugins page shows Nodex-installed plugins alongside
[Codex-home plugins](plugins-behavior.md), with the source visible in the list
and details. Nodex manages its own installations in the current Profile.
Codex-home actions apply to the active local Codex home.

### Install and review

Choose a local Plugin package folder from the Plugins page. Nodex accepts
Agent Plugins 1.0.0, Codex compatibility packages, and Claude-style packages
for skills and MCP servers. Nodex reports when it cannot read the package or
its declared manifest version. The review shows:

- The package name and layout, plus the declared version and author when
  supplied.
- The skills and their descriptions.
- Each MCP server and what it would launch or connect to. For a local server,
  show the command, arguments, working directory, and required configuration.
  For a remote server, show the transport and endpoint. Keep credential
  values out of the review.
- Supported hook declarations, labeled as not executed, and app mappings,
  labeled as requiring OpenAI-hosted services.
- Package diagnostics, including reasons why reported contributions are invalid.

Confirm to install a copy of the reviewed package. Installing the same source
folder again updates that installation after review. A failed update keeps the
previous copy and its settings.

### Enable, disable, and uninstall

Enable an installed plugin explicitly for each Project that should use it.
Project selections are independent. Stage 1 records them for future delivery.
The Plugins page shows that Agent delivery is unavailable. Installation and
activation are review-only in this release. Agents keep their existing
inventories, and Nodex leaves the installed plugin's MCP servers disconnected.

Disabling removes the selected Project's activation and keeps the installation,
its local data, and the other Projects' activations. Uninstalling removes the
Nodex-managed package copy and its activations in every Project. The person
chooses whether to keep or delete any plugin data stored by Nodex. The source
folder, Codex-home installations, and existing chat history remain in place.

## Stage 2 — planned delivery to Codex and Claude Code

In a Project where a plugin is enabled, Codex and Claude Code Agents can discover
its available skills and call its connected MCP tools. Skills also appear in the
Project's skill picker and can be suggested for Inbox work in that Project.
New, resumed, forked, and delegated Sessions use the current activation for their
execution Project. Each Session's normal permission and approval rules still
apply.

Disabling a plugin cuts off further calls through its existing connections in
that Project. By the next turn the plugin's skills and tools are gone from that
Project's Agent and picker inventories. Uninstalling applies the same withdrawal
in every Project. Text and tool results from earlier turns stay in chat history.

Hook execution and opening a plugin's MCP App from an entry point are later
capabilities. App mappings remain listed as OpenAI-hosted dependencies.
