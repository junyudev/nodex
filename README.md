# Nodex

SQLite-based kanban board for managing coding agents.

## Features

- Multi-project kanban with 8 workflow columns
- Electron desktop app + browser-accessible HTTP API
- Local SQLite storage (`kanban.db`) with real-time updates
- Notion-like card-stage editor with Notion-flavored Markdown
- Whole-store backups (`kanban.db` + assets) with manual and auto policies

## Getting Started

```bash
bun install
bun run dev
```

Default API/server URL: [http://localhost:51283](http://localhost:51283)

## CLI Examples

```bash
# List ready cards
nodex ls 5

# Move a card and set status
nodex mv abc1234 6 --agent-status "Starting work..."

# Create a manual backup
nodex backups create --label "before refactor"

# List backups
nodex backups

# Restore a backup (requires confirmation)
nodex backups restore <backup-id> --yes
```

## Backup API

```bash
# List backups
curl http://localhost:51283/api/backups

# Create manual backup
curl -X POST http://localhost:51283/api/backups \
  -H "Content-Type: application/json" \
  -d '{"label":"before migration"}'

# Restore backup (confirm required)
curl -X POST http://localhost:51283/api/backups/<backup-id>/restore \
  -H "Content-Type: application/json" \
  -d '{"confirm":true}'
```

## Project-Scoped API Example

```bash
# Read a single column in the default project
curl "http://localhost:51283/api/projects/default/column?id=5-ready"
```
