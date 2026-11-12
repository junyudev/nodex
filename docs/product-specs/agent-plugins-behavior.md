# Agent Plugins behavior

## Local installation and review

The initial release covers installing, reviewing, enabling, disabling, and
uninstalling plugins. The Plugins page shows Nodex-installed plugins alongside
[Codex-home plugins](plugins-behavior.md), with the source visible in the list
and details. Nodex manages its own installations in the current Profile on this device.
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

Confirm to install a copy of the reviewed package. If the staged bytes differ
from the preview, review the updated package before confirming again. Installing the same source
folder again updates that installation after review. A failed update keeps the
previous copy and its settings. Reload reads the installation's source folder
again and replaces the managed copy while preserving its Project selections.

When a registry writer exits before releasing its lock, the Nodex-installed
section offers **Repair lock**. Repair leaves a live writer's lock in place.

### Enable, disable, and uninstall

Select a Project in the Nodex-installed section and enable each plugin that
the Project should use. Project selections are independent.

Disabling removes the selected Project's activation and keeps the installation,
its local data, and the other Projects' activations. Uninstalling removes the
Nodex-managed package copy and its activations in every Project. The person
chooses whether to keep or delete any plugin data stored by Nodex. The source
folder, Codex-home installations, and existing chat history remain in place.

## Codex delivery

In a Project where a Plugin is enabled, Codex can discover its skills and call
its connected MCP tools. New, resumed, and forked Sessions use the activation
for their execution Project. A native Codex duplicate is suppressed for the
Session. If Nodex cannot safely suppress the duplicate, the Session reports
the conflict before starting. Normal permissions and approval rules apply.

Disabling, uninstalling, or reloading a Plugin revokes the affected tool
connections. An archived Project also loses its connections and skill access.
Codex uses the current skills and tools after its Project process goes idle and
recycles. Earlier messages and tool results remain in the conversation.

## Claude Code delivery

Claude Code Sessions load the Project's enabled plugin skills and connect to its
MCP tools. If a native marketplace plugin has the same manifest name, the Nodex
copy takes precedence for that query. When a native duplicate cannot be safely
disabled, such as a managed installation, the Session reports the conflict
before starting. Changing the Project's activation refreshes the query before
the next prompt.

## Planned delivery

The Project skill picker and skill suggestions for Inbox work are planned
separately.

Hook execution and opening a plugin's MCP App from an entry point are later
capabilities. App mappings remain listed as OpenAI-hosted dependencies.
