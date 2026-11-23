# ADR 0087: Codex installs plugins; Nodex extends them to every Agent

- Status: Accepted
- Date: 2026-11-14
- Owners: Nodex maintainers
- Supersedes: [ADR 0086](0086-agent-plugins-delivery.md)

## Context

ADR 0086 gave Nodex its own Plugin registry beside the Codex home. The result was
two plugin systems on one Plugins page, with different install flows, labels and
detail views. Codex threads then needed per-Project app-server processes, an
experimental capability-root field and duplicate suppression so that a plugin
was not loaded twice.

The Codex app-server already implements Agent Plugins: marketplaces, install from
a Git repository or a local folder, the portable and Codex layouts, per-plugin
enablement, hook review, MCP sign-in and connected apps. Nodex's Customize surface
is built on it.

## Decision

### One installation authority

A person installs, updates, disables and uninstalls plugins through Codex's plugin
system for the Profile's Codex home, using Customize. There is no Nodex plugin
registry. A plugin's identity is its Codex plugin id, `name@marketplace`.

Installing from an arbitrary folder uses a marketplace Nodex owns in the Profile.
Nodex copies the chosen folder into that marketplace, shows the person what the copy
contains and installs exactly that copy. Updating from the folder copies it again
and reinstalls. The marketplace remembers each plugin's source folder.

### Project scope

An installed and enabled plugin applies to every Project and to chats without a
Project. A person can limit it to chosen Projects. The scope is a Profile setting
on this host. Codex threads receive out-of-scope plugins as disabled through their
thread configuration when they start, fork or resume cold; a change applies to the
next such start. Other Agents receive only in-scope plugins.

### Delivery

Codex loads plugins natively. Nodex adds nothing to Codex threads except the
out-of-scope overrides.

For every other Agent, the Host resolves the Session's plugins once when the
Session opens: it reads each in-scope plugin's installed package from the Codex
plugin cache, generates an immutable skills-only directory for the resolved set,
and opens a revocable broker lease for each plugin MCP server it can run. One
Session plugin contract (`src/shared/agent-plugins/session-plugins.ts`) crosses the
Host and Agent Runtime boundary for all backends. Each adapter maps it to its native
form. When the resolved set changes, its revision changes, leases are revoked, and
the backend refreshes at its next safe point: Claude Code in a fresh query before
the next turn, ACP at the next activation.

The broker runs stdio servers and HTTP servers that need no sign-in. Servers that
need sign-in, connected apps and hooks stay Codex-only, because their credentials
and trust live in Codex. Customize states these limits on the plugin instead of
showing per-Agent delivery status.

ACP harnesses that advertise HTTP MCP receive plugin servers and the skill catalog
through `mcpServers`. Others receive the skill catalog over the existing stdio
bridge. Nodex makes no assumption about native skill discovery in ACP harnesses.
OpenCode delivery waits until native discovery and Session refresh are verified.

### Views

MCP App entry points (global, thread and file) launch through the broker with an
interface lease for the plugin, using the plugin's own name and logo.

## Consequences

- Plugins installed in Nodex also work in Codex outside Nodex, which is the same
  home. Nodex never writes Codex configuration except through Customize actions the
  person takes and per-thread overrides.
- Codex delivery has no Nodex-specific process topology or experimental fields.
- The Host keeps no per-backend copies of installation state. Session resolution
  reads the current Codex inventory and scope.
- Revocation is the broker's: a revoked lease refuses new calls and withholds
  results of calls already in flight.
- A plugin that only works in Codex is still installable; Customize says so.
