#!/usr/bin/env node

import { spawn } from "child_process";
import { createConnection } from "net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import TOML from "smol-toml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───

const COLUMNS = [
  { id: "1-ideas", name: "Ideas" },
  { id: "2-analyzing", name: "Analyzing" },
  { id: "3-backlog", name: "Backlog" },
  { id: "4-planning", name: "Planning" },
  { id: "5-ready", name: "Ready" },
  { id: "6-in-progress", name: "In Progress" },
  { id: "7-review", name: "Review" },
  { id: "8-done", name: "Done" },
];

const PRIORITIES = new Set([
  "p0-critical",
  "p1-high",
  "p2-medium",
  "p3-low",
  "p4-later",
]);

const ESTIMATES = new Set(["xs", "s", "m", "l", "xl"]);
const DEFAULT_LS_DESCRIPTION_CHARS = 240;

const COMMANDS = new Set([
  "serve", "ls", "get", "add", "update", "rm", "mv",
  "history", "undo", "redo", "query", "schema", "backups", "help", "projects", "config",
]);

const SUBCOMMAND_ALIASES = new Map([
  ["list", "ls"],
  ["show", "get"],
  ["create", "add"],
  ["remove", "rm"],
  ["delete", "rm"],
  ["move", "mv"],
  ["hist", "history"],
]);

// ─── Config Resolution (TOML) ───

function loadTomlFile(path) {
  try {
    return TOML.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG_TOML = `# Nodex configuration
url = "http://localhost:51283"
# session_id = "my-agent"
# project = "default"

# [server]
# dir = "~/.nodex"
# port = 51283
# backup_auto_enabled = false
# backup_interval_hours = 6
# backup_retention = 28
# history_retention = 1000
`;

function applyTomlConfig(cfg, parsed) {
  if (parsed.url) cfg.url = parsed.url;
  if (parsed.session_id) cfg.sessionId = parsed.session_id;
  if (parsed.project) cfg.project = parsed.project;
}

function expandTilde(p) {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(1));
  return p;
}

function loadServerConfig() {
  const server = { dir: undefined, port: undefined, backup_auto_enabled: undefined, backup_interval_hours: undefined, backup_retention: undefined, history_retention: undefined };

  // User-level
  const homeConfig = join(homedir(), ".nodex", "config.toml");
  if (existsSync(homeConfig)) {
    const parsed = loadTomlFile(homeConfig);
    if (parsed?.server) applyServerToml(server, parsed.server);
  }

  // Project-level (CWD walk-up) overrides user-level
  const projectConfig = findProjectConfig();
  if (projectConfig) {
    const parsed = loadTomlFile(projectConfig);
    if (parsed?.server) applyServerToml(server, parsed.server);
  }

  // Env vars override TOML
  if (process.env.KANBAN_DIR) server.dir = process.env.KANBAN_DIR;
  if (process.env.KANBAN_PORT) server.port = parseInt(process.env.KANBAN_PORT, 10);
  if (process.env.KANBAN_BACKUP_AUTO_ENABLED !== undefined) server.backup_auto_enabled = parseBooleanEnvCli(process.env.KANBAN_BACKUP_AUTO_ENABLED);
  if (process.env.KANBAN_BACKUP_INTERVAL_HOURS) server.backup_interval_hours = parseInt(process.env.KANBAN_BACKUP_INTERVAL_HOURS, 10);
  if (process.env.KANBAN_BACKUP_RETENTION) server.backup_retention = parseInt(process.env.KANBAN_BACKUP_RETENTION, 10);
  if (process.env.KANBAN_HISTORY_RETENTION) server.history_retention = parseInt(process.env.KANBAN_HISTORY_RETENTION, 10);

  return server;
}

function applyServerToml(server, s) {
  if (s.dir !== undefined) server.dir = s.dir;
  if (s.port !== undefined) server.port = s.port;
  if (s.backup_auto_enabled !== undefined) server.backup_auto_enabled = s.backup_auto_enabled;
  if (s.backup_interval_hours !== undefined) server.backup_interval_hours = s.backup_interval_hours;
  if (s.backup_retention !== undefined) server.backup_retention = s.backup_retention;
  if (s.history_retention !== undefined) server.history_retention = s.history_retention;
}

function parseBooleanEnvCli(value) {
  if (value === undefined) return undefined;
  const n = value.trim().toLowerCase();
  if (n === "1" || n === "true" || n === "yes" || n === "on") return true;
  if (n === "0" || n === "false" || n === "no" || n === "off") return false;
  return undefined;
}

function ensureUserConfig() {
  const configDir = join(homedir(), ".nodex");
  const configPath = join(configDir, "config.toml");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, DEFAULT_CONFIG_TOML, "utf8");
  return configPath;
}

function findProjectConfig() {
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".nodex", "config.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig(cliFlags) {
  const cfg = { url: "http://localhost:51283", sessionId: undefined, project: "default" };

  const homeConfig = join(homedir(), ".nodex", "config.toml");
  const projectConfig = findProjectConfig();

  if (!existsSync(homeConfig) && !projectConfig) ensureUserConfig();

  if (existsSync(homeConfig)) {
    const parsed = loadTomlFile(homeConfig);
    if (parsed) applyTomlConfig(cfg, parsed);
  }

  if (projectConfig) {
    const parsed = loadTomlFile(projectConfig);
    if (parsed) applyTomlConfig(cfg, parsed);
  }

  if (process.env.NODEX_URL) cfg.url = process.env.NODEX_URL;
  if (process.env.NODEX_SESSION_ID) cfg.sessionId = process.env.NODEX_SESSION_ID;
  if (process.env.NODEX_PROJECT) cfg.project = process.env.NODEX_PROJECT;

  if (cliFlags.url) cfg.url = cliFlags.url;
  if (cliFlags.sessionId) cfg.sessionId = cliFlags.sessionId;
  if (cliFlags.project) cfg.project = cliFlags.project;

  return cfg;
}

function loadConfigWithSources() {
  const fields = {
    url: { value: "http://localhost:51283", source: "default" },
    sessionId: { value: undefined, source: "default" },
    project: { value: "default", source: "default" },
    "server.dir": { value: "~/.nodex", source: "default" },
    "server.port": { value: 51283, source: "default" },
    "server.backup_auto_enabled": { value: false, source: "default" },
    "server.backup_interval_hours": { value: 6, source: "default" },
    "server.backup_retention": { value: 28, source: "default" },
    "server.history_retention": { value: 1000, source: "default" },
  };

  const homeConfigPath = join(homedir(), ".nodex", "config.toml");
  const projectConfigPath = findProjectConfig();

  if (existsSync(homeConfigPath)) {
    const parsed = loadTomlFile(homeConfigPath);
    if (parsed) {
      if (parsed.url) fields.url = { value: parsed.url, source: homeConfigPath };
      if (parsed.session_id) fields.sessionId = { value: parsed.session_id, source: homeConfigPath };
      if (parsed.project) fields.project = { value: parsed.project, source: homeConfigPath };
      applyServerTomlSources(fields, parsed.server, homeConfigPath);
    }
  }

  if (projectConfigPath) {
    const parsed = loadTomlFile(projectConfigPath);
    if (parsed) {
      if (parsed.url) fields.url = { value: parsed.url, source: projectConfigPath };
      if (parsed.session_id) fields.sessionId = { value: parsed.session_id, source: projectConfigPath };
      if (parsed.project) fields.project = { value: parsed.project, source: projectConfigPath };
      applyServerTomlSources(fields, parsed.server, projectConfigPath);
    }
  }

  if (process.env.NODEX_URL) fields.url = { value: process.env.NODEX_URL, source: "env NODEX_URL" };
  if (process.env.NODEX_SESSION_ID) fields.sessionId = { value: process.env.NODEX_SESSION_ID, source: "env NODEX_SESSION_ID" };
  if (process.env.NODEX_PROJECT) fields.project = { value: process.env.NODEX_PROJECT, source: "env NODEX_PROJECT" };

  if (process.env.KANBAN_DIR) fields["server.dir"] = { value: process.env.KANBAN_DIR, source: "env KANBAN_DIR" };
  if (process.env.KANBAN_PORT) fields["server.port"] = { value: parseInt(process.env.KANBAN_PORT, 10), source: "env KANBAN_PORT" };
  if (process.env.KANBAN_BACKUP_AUTO_ENABLED !== undefined) fields["server.backup_auto_enabled"] = { value: parseBooleanEnvCli(process.env.KANBAN_BACKUP_AUTO_ENABLED), source: "env KANBAN_BACKUP_AUTO_ENABLED" };
  if (process.env.KANBAN_BACKUP_INTERVAL_HOURS) fields["server.backup_interval_hours"] = { value: parseInt(process.env.KANBAN_BACKUP_INTERVAL_HOURS, 10), source: "env KANBAN_BACKUP_INTERVAL_HOURS" };
  if (process.env.KANBAN_BACKUP_RETENTION) fields["server.backup_retention"] = { value: parseInt(process.env.KANBAN_BACKUP_RETENTION, 10), source: "env KANBAN_BACKUP_RETENTION" };
  if (process.env.KANBAN_HISTORY_RETENTION) fields["server.history_retention"] = { value: parseInt(process.env.KANBAN_HISTORY_RETENTION, 10), source: "env KANBAN_HISTORY_RETENTION" };

  return { fields, homeConfigPath, projectConfigPath };
}

function applyServerTomlSources(fields, server, source) {
  if (!server) return;
  if (server.dir !== undefined) fields["server.dir"] = { value: server.dir, source };
  if (server.port !== undefined) fields["server.port"] = { value: server.port, source };
  if (server.backup_auto_enabled !== undefined) fields["server.backup_auto_enabled"] = { value: server.backup_auto_enabled, source };
  if (server.backup_interval_hours !== undefined) fields["server.backup_interval_hours"] = { value: server.backup_interval_hours, source };
  if (server.backup_retention !== undefined) fields["server.backup_retention"] = { value: server.backup_retention, source };
  if (server.history_retention !== undefined) fields["server.history_retention"] = { value: server.history_retention, source };
}

function formatSource(source) {
  if (source === "default" || source.startsWith("env ")) return source;
  const home = homedir();
  if (source.startsWith(home)) return "~" + source.slice(home.length);
  return source;
}

// ─── CSV Formatting ───

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvRow(values) {
  return values.map(csvEscape).join(",");
}

function csvTable(headers, rows) {
  const lines = [csvRow(headers)];
  for (const row of rows) {
    lines.push(csvRow(headers.map(h => row[h])));
  }
  return lines.join("\n");
}

function csvKeyValue(obj) {
  const lines = ["field,value"];
  for (const [key, val] of Object.entries(obj)) {
    lines.push(csvRow([key, val]));
  }
  return lines.join("\n");
}

function jsonOut(obj, flags) {
  console.log(JSON.stringify(obj, null, flags.pretty ? 2 : undefined));
}

function jsonlOut(values) {
  if (values.length === 0) return;
  console.log(values.map((value) => JSON.stringify(value)).join("\n"));
}

function tableCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\n/g, " \\n ");
}

function tableOut(headers, rows) {
  const widths = headers.map((header) => {
    const rowWidth = rows.reduce((max, row) => {
      return Math.max(max, tableCell(row[header]).length);
    }, 0);
    return Math.max(header.length, rowWidth);
  });

  const formatRow = (values) => {
    return values
      .map((value, idx) => String(value).padEnd(widths[idx]))
      .join(" | ");
  };

  const lines = [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("-|-"),
  ];

  for (const row of rows) {
    lines.push(formatRow(headers.map((header) => tableCell(row[header]))));
  }

  return lines.join("\n");
}

function getOutputFormat(flags) {
  if (flags.json) return "json";
  if (flags.table) return "table";
  if (flags.csv) return "csv";
  return "jsonl";
}

function rowsOut(headers, rows, flags) {
  const outputFormat = getOutputFormat(flags);
  if (outputFormat === "json") {
    jsonOut(rows, flags);
    return;
  }
  if (outputFormat === "table") {
    console.log(tableOut(headers, rows));
    return;
  }
  if (outputFormat === "jsonl") {
    jsonlOut(rows);
    return;
  }
  console.log(csvTable(headers, rows));
}

function keyValueOut(obj, flags) {
  const outputFormat = getOutputFormat(flags);
  if (outputFormat === "json") {
    jsonOut(obj, flags);
    return;
  }
  if (outputFormat === "table") {
    const rows = Object.entries(obj).map(([field, value]) => ({ field, value }));
    console.log(tableOut(["field", "value"], rows));
    return;
  }
  if (outputFormat === "jsonl") {
    jsonlOut([obj]);
    return;
  }
  console.log(csvKeyValue(obj));
}

// ─── File/Stdin Input ───

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveValue(val) {
  if (!val || typeof val !== "string" || !val.startsWith("@")) return val;
  const target = val.slice(1);
  if (target === "-") return readStdin();
  return readFileSync(resolve(process.cwd(), target), "utf8");
}

// ─── HTTP Helpers ───

let BASE_URL = "";

async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, options);
  } catch {
    throw new Error(`Cannot connect to ${BASE_URL}. Is the Nodex server running?`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function apiGet(path) {
  return apiFetch(path);
}

function apiPost(path, body) {
  return apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiPut(path, body) {
  return apiFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function apiDelete(path) {
  return apiFetch(path, { method: "DELETE" });
}

// ─── Project API prefix ───

function apiPrefix(config) {
  return `/api/projects/${encodeURIComponent(config.project)}`;
}

// ─── Column Helpers ───

function normalizeColumnId(input) {
  if (COLUMNS.some(c => c.id === input)) return input;

  const num = parseInt(input, 10);
  if (!isNaN(num)) {
    const col = COLUMNS.find(c => c.id.startsWith(`${num}-`));
    if (col) return col.id;
  }

  const lower = input.toLowerCase().replace(/-/g, " ");
  const byName = COLUMNS.find(c => c.name.toLowerCase() === lower);
  if (byName) return byName.id;

  const bySuffix = COLUMNS.find(c => c.id.split("-").slice(1).join("-") === input.toLowerCase());
  if (bySuffix) return bySuffix.id;

  const candidates = COLUMNS.flatMap(c => [c.id, c.name.toLowerCase(), c.id.split("-").slice(1).join("-")]);
  const suggestion = closestMatch(input, candidates);
  const suffix = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown column: ${input}.${suffix} Valid: ${COLUMNS.map(c => c.id).join(", ")}`);
}

// ─── Card Formatting ───

function cardToKV(card, columnId) {
  return {
    id: card.id,
    column: columnId,
    title: card.title,
    description: card.description || "",
    priority: card.priority,
    estimate: card.estimate || "",
    tags: Array.isArray(card.tags) ? card.tags.join(";") : "",
    dueDate: card.dueDate || "",
    assignee: card.assignee || "",
    blocked: card.agentBlocked ? "true" : "false",
    status: card.agentStatus || "",
    created: card.created,
    order: card.order,
  };
}

const LS_HEADERS = ["id", "column", "title", "priority", "estimate", "assignee", "blocked", "status", "tags", "order"];
const LS_FULL_HEADERS = [
  "id",
  "column",
  "title",
  "description",
  "descriptionLen",
  "descriptionTruncated",
  "priority",
  "estimate",
  "tags",
  "dueDate",
  "assignee",
  "agentBlocked",
  "agentStatus",
  "created",
  "order",
];

function cardToRow(card, columnId) {
  return {
    id: card.id,
    column: columnId,
    title: card.title,
    priority: card.priority,
    estimate: card.estimate || "",
    assignee: card.assignee || "",
    blocked: card.agentBlocked ? "true" : "false",
    status: card.agentStatus || "",
    tags: Array.isArray(card.tags) ? card.tags.join(";") : "",
    order: card.order,
  };
}

function truncateDescription(description, maxChars) {
  if (description.length <= maxChars) {
    return { value: description, truncated: false };
  }
  if (maxChars <= 3) {
    return { value: ".".repeat(maxChars), truncated: true };
  }
  return { value: `${description.slice(0, maxChars - 3)}...`, truncated: true };
}

function cardToFullRow(card, columnId, options) {
  const description = card.description || "";
  const truncated = options.descriptionFull
    ? { value: description, truncated: false }
    : truncateDescription(description, options.descriptionChars);

  return {
    id: card.id,
    column: columnId,
    title: card.title,
    description: truncated.value,
    descriptionLen: description.length,
    descriptionTruncated: truncated.truncated,
    priority: card.priority,
    estimate: card.estimate || "",
    tags: Array.isArray(card.tags) ? card.tags : [],
    dueDate: card.dueDate || "",
    assignee: card.assignee || "",
    agentBlocked: card.agentBlocked,
    agentStatus: card.agentStatus || "",
    created: card.created,
    order: card.order,
  };
}

// ─── Arg Parser ───

const OPTION_ALIASES = {
  "--url": "url",
  "--session-id": "sessionId",
  "--project": "project", "-p": "project",
  "--priority": "priority", "-P": "priority",
  "--estimate": "estimate", "-e": "estimate",
  "--description": "description", "-d": "description",
  "--tags": "tags", "-t": "tags",
  "--assignee": "assignee", "-a": "assignee",
  "--due": "due",
  "--agent-status": "agentStatus",
  "--title": "title",
  "--name": "name", "-n": "name",
  "--label": "label",
  "--card": "card",
  "--limit": "limit",
  "--offset": "offset",
  "--description-chars": "descriptionChars",
};

const BOOLEAN_OPTION_ALIASES = {
  "--help": "help",
  "-h": "help",
  "--json": "json",
  "--jsonl": "jsonl",
  "--csv": "csv",
  "--pretty": "pretty",
  "--table": "table",
  "--verbose": "verbose",
  "-v": "verbose",
  "--full": "full",
  "--description-full": "descriptionFull",
  "--blocked": "blocked",
  "--agent-blocked": "agentBlocked",
  "--no-agent-blocked": "agentBlockedFalse",
  "--clear-description": "clearDescription",
  "--clear-tags": "clearTags",
  "--clear-assignee": "clearAssignee",
  "--clear-due": "clearDue",
  "--clear-agent-status": "clearAgentStatus",
};

const OPTION_TOKENS = new Set([
  ...Object.keys(OPTION_ALIASES),
  ...Object.keys(BOOLEAN_OPTION_ALIASES),
]);

const FLAG_DISPLAY = {
  url: "--url",
  sessionId: "--session-id",
  project: "-p/--project",
  priority: "--priority",
  estimate: "--estimate",
  description: "--description",
  tags: "--tags",
  assignee: "--assignee",
  due: "--due",
  agentStatus: "--agent-status",
  title: "--title",
  name: "--name",
  label: "--label",
  card: "--card",
  limit: "--limit",
  offset: "--offset",
  descriptionChars: "--description-chars",
  help: "--help",
  json: "--json",
  jsonl: "--jsonl",
  csv: "--csv",
  pretty: "--pretty",
  table: "--table",
  verbose: "--verbose",
  full: "--full",
  descriptionFull: "--description-full",
  blocked: "--blocked",
  agentBlocked: "--agent-blocked",
  clearDescription: "--clear-description",
  clearTags: "--clear-tags",
  clearAssignee: "--clear-assignee",
  clearDue: "--clear-due",
  clearAgentStatus: "--clear-agent-status",
  yes: "--yes",
  noSafetyBackup: "--no-safety-backup",
};

const COMMAND_ALLOWED_FLAGS = {
  ls: new Set([
    "help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId",
    "priority", "assignee", "blocked", "limit", "offset", "full", "descriptionChars", "descriptionFull",
  ]),
  get: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  add: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId", "description", "priority", "estimate", "tags", "assignee", "due", "agentStatus", "agentBlocked"]),
  update: new Set([
    "help", "json", "jsonl", "csv", "pretty", "table", "verbose", "project", "url", "sessionId",
    "title", "description", "clearDescription", "priority", "estimate", "tags", "clearTags",
    "assignee", "clearAssignee", "due", "clearDue", "agentStatus", "clearAgentStatus",
    "agentBlocked",
  ]),
  rm: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  mv: new Set([
    "help", "json", "jsonl", "csv", "pretty", "table", "verbose", "project", "url", "sessionId",
    "title", "description", "clearDescription", "priority", "estimate", "tags", "clearTags",
    "assignee", "clearAssignee", "due", "clearDue", "agentStatus", "clearAgentStatus",
    "agentBlocked",
  ]),
  history: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId", "card", "limit", "offset"]),
  undo: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  redo: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  query: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  schema: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "project", "url", "sessionId"]),
  backups: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "url", "label", "yes", "noSafetyBackup"]),
  projects: new Set(["help", "json", "jsonl", "csv", "pretty", "table", "url", "sessionId", "project", "description", "name"]),
  config: new Set(["help", "json"]),
};

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function closestMatch(value, candidates) {
  const normalized = value.toLowerCase();
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = levenshtein(normalized, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (!best) return null;
  if (bestDistance > Math.max(2, Math.floor(value.length / 3))) return null;
  return best;
}

function resolveSubcommand(input) {
  if (COMMANDS.has(input)) return input;
  if (SUBCOMMAND_ALIASES.has(input)) return SUBCOMMAND_ALIASES.get(input);
  return null;
}

function assertValidProjectId(projectId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId)) {
    throw new Error(`Invalid project id "${projectId}". Use lowercase letters, numbers, and single hyphens.`);
  }
}

function assertValidPriority(priority) {
  if (!PRIORITIES.has(priority)) {
    throw new Error(`Invalid priority "${priority}". Valid: ${Array.from(PRIORITIES).join(", ")}`);
  }
}

function assertValidEstimate(estimate) {
  if (!ESTIMATES.has(estimate)) {
    throw new Error(`Invalid estimate "${estimate}". Valid: ${Array.from(ESTIMATES).join(", ")}`);
  }
}

function parseNonNegativeInt(raw, label) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function parseDueDate(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Invalid due date "${raw}". Expected YYYY-MM-DD`);
  }

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`Invalid due date "${raw}". Expected a real calendar date in YYYY-MM-DD`);
  }

  return raw;
}

function parseTags(raw) {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseCliArgs(argv) {
  const args = { _: [], flags: {} };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--") {
      args._.push(...argv.slice(i + 1));
      break;
    }

    if (BOOLEAN_OPTION_ALIASES[arg]) {
      const key = BOOLEAN_OPTION_ALIASES[arg];
      if (key === "agentBlockedFalse") {
        args.flags.agentBlocked = false;
      } else {
        args.flags[key] = true;
      }
      continue;
    }
    if (arg === "--yes") {
      args.flags.yes = true;
      continue;
    }
    if (arg === "--no-safety-backup") {
      args.flags.noSafetyBackup = true;
      continue;
    }

    if (OPTION_ALIASES[arg]) {
      const key = OPTION_ALIASES[arg];
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("-") && OPTION_TOKENS.has(next))) {
        throw new Error(`Option ${arg} requires a value`);
      }
      args.flags[key] = next;
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      const suggestion = closestMatch(arg, Array.from(OPTION_TOKENS));
      const suffix = suggestion ? ` Did you mean ${suggestion}?` : "";
      throw new Error(`Unknown option: ${arg}.${suffix}`);
    }

    args._.push(arg);
  }

  return args;
}

function validateCommandFlags(command, flags) {
  const allowed = COMMAND_ALLOWED_FLAGS[command];
  if (!allowed) return;

  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      const display = FLAG_DISPLAY[key] || `--${key}`;
      throw new Error(`Option ${display} is not valid for 'nodex ${command}'`);
    }
  }

  if (flags.pretty && !flags.json) {
    throw new Error("--pretty requires --json");
  }

  const outputFlags = [flags.json, flags.jsonl, flags.csv, flags.table].filter(Boolean);
  if (outputFlags.length > 1) {
    throw new Error("Only one output flag can be used at a time: --json, --jsonl, --csv, --table");
  }

  if ((flags.descriptionChars !== undefined || flags.descriptionFull) && !flags.full) {
    throw new Error("--description-chars and --description-full require --full");
  }

  if (flags.descriptionChars !== undefined && flags.descriptionFull) {
    throw new Error("Cannot use --description-chars together with --description-full");
  }
}

function assertNoConflictingClearFlags(flags) {
  const conflicts = [
    ["description", "clearDescription", "--description", "--clear-description"],
    ["tags", "clearTags", "--tags", "--clear-tags"],
    ["assignee", "clearAssignee", "--assignee", "--clear-assignee"],
    ["due", "clearDue", "--due", "--clear-due"],
    ["agentStatus", "clearAgentStatus", "--agent-status", "--clear-agent-status"],
  ];

  for (const [valueFlag, clearFlag, valueLabel, clearLabel] of conflicts) {
    if (flags[valueFlag] !== undefined && flags[clearFlag]) {
      throw new Error(`Cannot use ${valueLabel} together with ${clearLabel}`);
    }
  }
}

// ─── Command: projects ───

async function cmdProjects(positional, flags) {
  const sub = positional[0];

  if (sub && !["add", "rm", "mv", "ls", "list"].includes(sub)) {
    throw new Error(`Unknown projects subcommand: ${sub}. Valid: add, mv, rm`);
  }

  if (sub === "add") {
    const id = positional[1];
    const name = positional[2];
    if (!id || !name) throw new Error("Usage: nodex projects add <id> <name> [--description <text>]");

    assertValidProjectId(id);

    const body = { id, name };
    if (flags.description !== undefined) body.description = flags.description;

    const project = await apiPost("/api/projects", body);
    keyValueOut({ id: project.id, name: project.name, description: project.description || "" }, flags);
    return;
  }

  if (sub === "rm") {
    const id = positional[1];
    if (!id) throw new Error("Usage: nodex projects rm <id>");
    assertValidProjectId(id);
    await apiDelete(`/api/projects/${encodeURIComponent(id)}`);
    if (flags.json) {
      jsonOut({ success: true, projectId: id }, flags);
      return;
    }
    rowsOut(["status", "projectId"], [{ status: "deleted", projectId: id }], flags);
    return;
  }

  if (sub === "mv") {
    const oldId = positional[1];
    const newId = positional[2];
    if (!oldId || !newId) throw new Error("Usage: nodex projects mv <old-id> <new-id> [--name <name>] [--description <text>]");

    assertValidProjectId(newId);

    const body = { newId };
    if (flags.name !== undefined) body.name = flags.name;
    if (flags.description !== undefined) body.description = flags.description;

    const project = await apiPut(`/api/projects/${encodeURIComponent(oldId)}`, body);
    keyValueOut({ id: project.id, name: project.name, description: project.description || "" }, flags);
    return;
  }

  // Default: list projects
  const data = await apiGet("/api/projects");
  const headers = ["id", "name", "description", "created"];
  const rows = data.projects.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description || "",
    created: p.created,
  }));

  rowsOut(headers, rows, flags);
}

// ─── Command: ls ───

async function cmdLs(positional, flags, config) {
  const prefix = apiPrefix(config);
  const lsOptions = {
    full: flags.full === true,
    descriptionFull: flags.descriptionFull === true,
    descriptionChars: flags.descriptionChars !== undefined
      ? parseNonNegativeInt(flags.descriptionChars, "--description-chars")
      : DEFAULT_LS_DESCRIPTION_CHARS,
  };
  let cards = [];

  if (positional[0]) {
    const colId = normalizeColumnId(positional[0]);
    const col = await apiGet(`${prefix}/column?id=${encodeURIComponent(colId)}`);
    cards = col.cards.map((card) => {
      if (lsOptions.full) {
        return cardToFullRow(card, col.id, lsOptions);
      }
      return cardToRow(card, col.id);
    });
  } else {
    const board = await apiGet(`${prefix}/board`);
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (lsOptions.full) {
          cards.push(cardToFullRow(card, col.id, lsOptions));
        } else {
          cards.push(cardToRow(card, col.id));
        }
      }
    }
  }

  if (flags.priority) {
    assertValidPriority(flags.priority);
    cards = cards.filter(c => c.priority === flags.priority);
  }
  if (flags.assignee) cards = cards.filter(c => c.assignee === flags.assignee);
  if (flags.blocked) {
    cards = cards.filter((card) => {
      if (lsOptions.full) return card.agentBlocked === true;
      return card.blocked === "true";
    });
  }
  if (flags.offset) cards = cards.slice(parseNonNegativeInt(flags.offset, "--offset"));
  if (flags.limit) cards = cards.slice(0, parseNonNegativeInt(flags.limit, "--limit"));

  rowsOut(lsOptions.full ? LS_FULL_HEADERS : LS_HEADERS, cards, flags);
}

// ─── Command: get ───

async function cmdGet(positional, flags, config) {
  const cardId = positional[0];
  if (!cardId) throw new Error("Usage: nodex get <card-id>");

  const prefix = apiPrefix(config);
  const card = await apiGet(
    `${prefix}/card?cardId=${encodeURIComponent(cardId)}`
  );

  if (flags.json) {
    jsonOut(card, flags);
  } else {
    keyValueOut(cardToKV(card, card.columnId), flags);
  }
}

// ─── Command: add ───

async function cmdAdd(positional, flags, config) {
  const columnRaw = positional[0];
  const title = positional[1];
  if (!columnRaw || !title) throw new Error("Usage: nodex add <column> <title> [opts]");

  const prefix = apiPrefix(config);
  const columnId = normalizeColumnId(columnRaw);
  const body = { columnId, title };
  if (config.sessionId) body.sessionId = config.sessionId;

  if (flags.description !== undefined) body.description = await resolveValue(flags.description);
  if (flags.priority) {
    assertValidPriority(flags.priority);
    body.priority = flags.priority;
  }
  if (flags.estimate) {
    assertValidEstimate(flags.estimate);
    body.estimate = flags.estimate;
  }
  if (flags.tags !== undefined) body.tags = parseTags(flags.tags);
  if (flags.assignee !== undefined) body.assignee = flags.assignee;
  if (flags.due !== undefined) body.dueDate = parseDueDate(flags.due);
  if (flags.agentStatus !== undefined) body.agentStatus = await resolveValue(flags.agentStatus);
  if (flags.agentBlocked === true) body.agentBlocked = true;

  const card = await apiPost(`${prefix}/board`, body);

  if (flags.json) {
    jsonOut(card, flags);
    return;
  }
  keyValueOut(cardToKV(card, columnId), flags);
}

// ─── Command: update ───

async function cmdUpdate(positional, flags, config) {
  const cardId = positional[0];
  if (!cardId) throw new Error("Usage: nodex update <card-id> [opts]");
  assertNoConflictingClearFlags(flags);

  const prefix = apiPrefix(config);
  const body = { cardId };
  if (config.sessionId) body.sessionId = config.sessionId;

  if (flags.title !== undefined) body.title = await resolveValue(flags.title);

  if (flags.clearDescription) {
    body.description = "";
  } else if (flags.description !== undefined) {
    body.description = await resolveValue(flags.description);
  }

  if (flags.priority !== undefined) {
    assertValidPriority(flags.priority);
    body.priority = flags.priority;
  }

  if (flags.estimate !== undefined) {
    assertValidEstimate(flags.estimate);
    body.estimate = flags.estimate;
  }

  if (flags.clearTags) {
    body.tags = [];
  } else if (flags.tags !== undefined) {
    body.tags = parseTags(flags.tags);
  }

  if (flags.clearAssignee) {
    body.assignee = "";
  } else if (flags.assignee !== undefined) {
    body.assignee = flags.assignee;
  }

  if (flags.clearDue) {
    body.dueDate = null;
  } else if (flags.due !== undefined) {
    body.dueDate = parseDueDate(flags.due);
  }

  if (flags.clearAgentStatus) {
    body.agentStatus = "";
  } else if (flags.agentStatus !== undefined) {
    body.agentStatus = await resolveValue(flags.agentStatus);
  }

  if (flags.agentBlocked !== undefined) body.agentBlocked = flags.agentBlocked;

  const card = await apiPut(`${prefix}/card`, body);

  if (flags.json) {
    jsonOut(card, flags);
  } else if (flags.verbose) {
    keyValueOut(cardToKV(card, card.columnId || "unknown"), flags);
  } else {
    rowsOut(["status", "cardId"], [{ status: "updated", cardId }], flags);
  }
}

// ─── Command: rm ───

async function cmdRm(positional, flags, config) {
  const cardId = positional[0];
  if (!cardId) throw new Error("Usage: nodex rm <card-id>");

  const prefix = apiPrefix(config);
  let url = `${prefix}/card?cardId=${encodeURIComponent(cardId)}`;
  if (config.sessionId) url += `&sessionId=${encodeURIComponent(config.sessionId)}`;

  await apiDelete(url);
  if (flags.json) {
    jsonOut({ success: true, cardId }, flags);
    return;
  }
  rowsOut(["status", "cardId"], [{ status: "deleted", cardId }], flags);
}

// ─── Command: mv ───

async function cmdMv(positional, flags, config) {
  const cardId = positional[0];
  const fromColumnRaw = positional[1];
  const toColumnRaw = positional[2];
  if (!cardId || !fromColumnRaw || !toColumnRaw) throw new Error("Usage: nodex mv <card-id> <from> <to> [order]");
  assertNoConflictingClearFlags(flags);

  const prefix = apiPrefix(config);
  const fromColumn = normalizeColumnId(fromColumnRaw);
  const toColumn = normalizeColumnId(toColumnRaw);

  // Atomic move: asserts card is still in <from> column (fails with 409 if already moved)
  const body = { cardId, fromColumnId: fromColumn, toColumnId: toColumn };
  if (positional[3] !== undefined) body.newOrder = parseNonNegativeInt(positional[3], "order");
  if (config.sessionId) body.sessionId = config.sessionId;

  const moveResult = await apiPut(`${prefix}/move`, body);
  const cardUpdates = {};

  if (flags.title !== undefined) cardUpdates.title = await resolveValue(flags.title);

  if (flags.clearDescription) {
    cardUpdates.description = "";
  } else if (flags.description !== undefined) {
    cardUpdates.description = await resolveValue(flags.description);
  }

  if (flags.priority !== undefined) {
    assertValidPriority(flags.priority);
    cardUpdates.priority = flags.priority;
  }

  if (flags.estimate !== undefined) {
    assertValidEstimate(flags.estimate);
    cardUpdates.estimate = flags.estimate;
  }

  if (flags.clearTags) {
    cardUpdates.tags = [];
  } else if (flags.tags !== undefined) {
    cardUpdates.tags = parseTags(flags.tags);
  }

  if (flags.clearAssignee) {
    cardUpdates.assignee = "";
  } else if (flags.assignee !== undefined) {
    cardUpdates.assignee = flags.assignee;
  }

  if (flags.clearDue) {
    cardUpdates.dueDate = null;
  } else if (flags.due !== undefined) {
    cardUpdates.dueDate = parseDueDate(flags.due);
  }

  if (flags.clearAgentStatus) {
    cardUpdates.agentStatus = "";
  } else if (flags.agentStatus !== undefined) {
    cardUpdates.agentStatus = await resolveValue(flags.agentStatus);
  }

  if (flags.agentBlocked !== undefined) cardUpdates.agentBlocked = flags.agentBlocked;

  const hasCardUpdates = Object.keys(cardUpdates).length > 0;
  let cardAfterMove = null;

  if (hasCardUpdates) {
    cardAfterMove = await apiPut(`${prefix}/card`, {
      cardId,
      ...(config.sessionId ? { sessionId: config.sessionId } : {}),
      ...cardUpdates,
    });
  } else if (flags.verbose || flags.json) {
    cardAfterMove = await apiGet(
      `${prefix}/card?cardId=${encodeURIComponent(cardId)}`
    );
  }

  if (flags.json) {
    jsonOut({
      success: moveResult.success !== false,
      cardId,
      toColumnId: toColumn,
      card: cardAfterMove || undefined,
      updated: hasCardUpdates,
    }, flags);
    return;
  }

  if (flags.verbose && cardAfterMove) {
    keyValueOut(cardToKV(cardAfterMove, toColumn), flags);
    return;
  }

  rowsOut(
    ["status", "cardId", "toColumnId"],
    [{ status: "moved", cardId, toColumnId: toColumn }],
    flags
  );
}

// ─── Command: history ───

async function cmdHistory(_positional, flags, config) {
  const prefix = apiPrefix(config);
  let data;

  if (flags.card) {
    data = await apiGet(`${prefix}/history/card?cardId=${encodeURIComponent(flags.card)}`);
  } else {
    const limit = flags.limit !== undefined ? String(parseNonNegativeInt(flags.limit, "--limit")) : "20";
    const offset = flags.offset !== undefined ? String(parseNonNegativeInt(flags.offset, "--offset")) : "0";
    let url = `${prefix}/history?limit=${limit}&offset=${offset}`;
    if (config.sessionId) url += `&sessionId=${encodeURIComponent(config.sessionId)}`;
    data = await apiGet(url);
  }

  const headers = ["id", "operation", "cardId", "columnId", "timestamp", "fromColumn", "toColumn"];
  const rows = data.entries.map(e => ({
    id: e.id,
    operation: e.operation,
    cardId: e.cardId,
    columnId: e.columnId,
    timestamp: e.timestamp,
    fromColumn: e.fromColumnId || "",
    toColumn: e.toColumnId || "",
  }));

  if (flags.json) {
    jsonOut(data, flags);
    return;
  }
  rowsOut(headers, rows, flags);
}

// ─── Command: undo ───

async function cmdUndo(_positional, flags, config) {
  const prefix = apiPrefix(config);
  const body = {};
  if (config.sessionId) body.sessionId = config.sessionId;

  const result = await apiPost(`${prefix}/undo`, body);

  if (flags.json) {
    jsonOut(result, flags);
  } else {
    rowsOut(["status", "operation", "cardId"], [
      { status: "undone", operation: result.entry.operation, cardId: result.entry.cardId },
    ], flags);
  }
}

// ─── Command: redo ───

async function cmdRedo(_positional, flags, config) {
  const prefix = apiPrefix(config);
  const body = {};
  if (config.sessionId) body.sessionId = config.sessionId;

  const result = await apiPost(`${prefix}/redo`, body);

  if (flags.json) {
    jsonOut(result, flags);
  } else {
    rowsOut(["status", "operation", "cardId"], [
      { status: "redone", operation: result.entry.operation, cardId: result.entry.cardId },
    ], flags);
  }
}

// ─── Command: query ───

async function cmdQuery(positional, flags, config) {
  const prefix = apiPrefix(config);
  const sql = positional[0];
  if (!sql) throw new Error('Usage: nodex query "<sql>" [params...]');

  const params = positional.slice(1);
  const result = await apiPost(`${prefix}/query`, { sql, params });

  if (flags.json) {
    jsonOut(result, flags);
    return;
  }
  rowsOut(result.columns, result.rows, flags);
}

// ─── Command: schema ───

async function cmdSchema(_positional, flags, config) {
  const prefix = apiPrefix(config);
  const data = await apiGet(`${prefix}/schema`);

  if (flags.json) {
    jsonOut(data, flags);
  } else {
    const headers = ["table", "column", "type", "nullable", "default", "primaryKey"];
    const rows = [];
    for (const table of data.tables) {
      for (const col of table.columns) {
        rows.push({
          table: table.name,
          column: col.name,
          type: col.type,
          nullable: String(col.nullable),
          default: col.defaultValue || "",
          primaryKey: String(col.primaryKey),
        });
      }
    }
    rowsOut(headers, rows, flags);
  }
}

// ─── Command: backups ───

const BACKUP_HEADERS = [
  "id",
  "createdAt",
  "trigger",
  "label",
  "includesAssets",
  "dbBytes",
  "assetsBytes",
  "totalBytes",
];

function backupToRow(backup) {
  return {
    id: backup.id,
    createdAt: backup.createdAt,
    trigger: backup.trigger,
    label: backup.label || "",
    includesAssets: String(Boolean(backup.includesAssets)),
    dbBytes: backup.dbBytes,
    assetsBytes: backup.assetsBytes,
    totalBytes: backup.totalBytes,
  };
}

async function cmdBackups(positional, flags) {
  const sub = positional[0];

  if (!sub) {
    const data = await apiGet("/api/backups");
    const rows = data.backups.map(backupToRow);
    if (flags.json) {
      jsonOut(data.backups, flags);
    } else {
      console.log(csvTable(BACKUP_HEADERS, rows));
    }
    return;
  }

  if (sub === "create") {
    const body = {};
    if (flags.label) body.label = flags.label;
    const backup = await apiPost("/api/backups", body);
    if (flags.json) {
      jsonOut(backup, flags);
    } else {
      console.log(csvKeyValue(backupToRow(backup)));
    }
    return;
  }

  if (sub === "restore") {
    const backupId = positional[1];
    if (!backupId) {
      throw new Error("Usage: nodex backups restore <backup-id> --yes [--no-safety-backup]");
    }
    if (!flags.yes) {
      throw new Error("Restore is destructive. Re-run with --yes to confirm.");
    }

    const result = await apiPost(`/api/backups/${encodeURIComponent(backupId)}/restore`, {
      confirm: true,
      createSafetyBackup: !flags.noSafetyBackup,
    });

    if (flags.json) {
      jsonOut(result, flags);
    } else {
      console.log(
        csvKeyValue({
          success: String(Boolean(result.success)),
          restoredBackupId: result.restoredBackupId || backupId,
          safetyBackupId: result.safetyBackupId || "",
        })
      );
    }
    return;
  }

  throw new Error(`Unknown backups subcommand: ${sub}`);
}

// ─── Command: config ───

const CONFIG_DISPLAY_NAMES = {
  url: "url", sessionId: "session_id", project: "project",
  "server.dir": "server.dir", "server.port": "server.port",
  "server.backup_auto_enabled": "server.backup_auto_enabled",
  "server.backup_interval_hours": "server.backup_interval_hours",
  "server.backup_retention": "server.backup_retention",
  "server.history_retention": "server.history_retention",
};

function cmdConfigShow(flags) {
  const { fields } = loadConfigWithSources();

  if (flags.json) {
    const out = {};
    for (const [key, { value, source }] of Object.entries(fields)) {
      out[CONFIG_DISPLAY_NAMES[key]] = { value: value ?? null, source };
    }
    jsonOut(out, flags);
    return;
  }

  const agentKeys = ["url", "sessionId", "project"];
  const serverKeys = Object.keys(fields).filter(k => k.startsWith("server."));

  console.log("\nAgent configuration:");
  for (const key of agentKeys) {
    const { value, source } = fields[key];
    const name = CONFIG_DISPLAY_NAMES[key];
    const val = value ?? "(unset)";
    console.log(`  ${name.padEnd(12)} = ${String(val).padEnd(30)} (${formatSource(source)})`);
  }

  console.log("\nServer configuration:");
  for (const key of serverKeys) {
    const { value, source } = fields[key];
    const name = CONFIG_DISPLAY_NAMES[key].replace("server.", "");
    const val = value ?? "(unset)";
    console.log(`  ${name.padEnd(22)} = ${String(val).padEnd(20)} (${formatSource(source)})`);
  }
  console.log();
}

async function cmdConfigInteractive() {
  if (!process.stdin.isTTY) {
    console.error("Error: Interactive config requires a terminal. Use 'nodex config show' instead.");
    process.exit(1);
  }

  const { createInterface } = await import("node:readline/promises");
  const { homeConfigPath } = loadConfigWithSources();

  // Show current config
  cmdConfigShow({});

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const cwdConfigPath = join(process.cwd(), ".nodex", "config.toml");

    console.log("Which config do you want to edit?");
    console.log(`  1. User-level   (${formatSource(homeConfigPath)})`);
    console.log(`  2. Project-level (${formatSource(cwdConfigPath)})`);

    const choice = (await rl.question("> ")).trim();
    if (choice !== "1" && choice !== "2") {
      console.log("Cancelled.");
      return;
    }

    const isUserLevel = choice === "1";
    const targetPath = isUserLevel ? homeConfigPath : cwdConfigPath;
    const existing = loadTomlFile(targetPath) || {};

    console.log(`\nEditing ${formatSource(targetPath)}`);

    const newConfig = {};

    const urlDefault = existing.url || "";
    const urlAnswer = (await rl.question(`  url [${urlDefault || "http://localhost:51283"}]: `)).trim();
    if (urlAnswer) newConfig.url = urlAnswer;
    else if (existing.url) newConfig.url = existing.url;

    const sidDefault = existing.session_id || "";
    const sidAnswer = (await rl.question(`  session_id [${sidDefault}]: `)).trim();
    if (sidAnswer) newConfig.session_id = sidAnswer;
    else if (existing.session_id) newConfig.session_id = existing.session_id;

    const projDefault = existing.project || "";
    const projAnswer = (await rl.question(`  project [${projDefault || "default"}]: `)).trim();
    if (projAnswer) newConfig.project = projAnswer;
    else if (existing.project) newConfig.project = existing.project;

    // Server settings
    const existingServer = existing.server || {};
    console.log("\nServer settings (leave blank to keep default):");

    const dirDefault = existingServer.dir || "";
    const dirAnswer = (await rl.question(`  dir [${dirDefault || "~/.nodex"}]: `)).trim();
    if (dirAnswer) (newConfig.server ??= {}).dir = dirAnswer;
    else if (existingServer.dir) (newConfig.server ??= {}).dir = existingServer.dir;

    const portDefault = existingServer.port;
    const portAnswer = (await rl.question(`  port [${portDefault ?? 51283}]: `)).trim();
    if (portAnswer) (newConfig.server ??= {}).port = parseInt(portAnswer, 10);
    else if (existingServer.port !== undefined) (newConfig.server ??= {}).port = existingServer.port;

    const backupAutoDefault = existingServer.backup_auto_enabled;
    const backupAutoAnswer = (await rl.question(`  backup_auto_enabled [${backupAutoDefault ?? false}]: `)).trim();
    if (backupAutoAnswer) (newConfig.server ??= {}).backup_auto_enabled = backupAutoAnswer === "true" || backupAutoAnswer === "1";
    else if (existingServer.backup_auto_enabled !== undefined) (newConfig.server ??= {}).backup_auto_enabled = existingServer.backup_auto_enabled;

    const backupIntervalDefault = existingServer.backup_interval_hours;
    const backupIntervalAnswer = (await rl.question(`  backup_interval_hours [${backupIntervalDefault ?? 6}]: `)).trim();
    if (backupIntervalAnswer) (newConfig.server ??= {}).backup_interval_hours = parseInt(backupIntervalAnswer, 10);
    else if (existingServer.backup_interval_hours !== undefined) (newConfig.server ??= {}).backup_interval_hours = existingServer.backup_interval_hours;

    const backupRetentionDefault = existingServer.backup_retention;
    const backupRetentionAnswer = (await rl.question(`  backup_retention [${backupRetentionDefault ?? 28}]: `)).trim();
    if (backupRetentionAnswer) (newConfig.server ??= {}).backup_retention = parseInt(backupRetentionAnswer, 10);
    else if (existingServer.backup_retention !== undefined) (newConfig.server ??= {}).backup_retention = existingServer.backup_retention;

    const historyRetentionDefault = existingServer.history_retention;
    const historyRetentionAnswer = (await rl.question(`  history_retention [${historyRetentionDefault ?? 1000}]: `)).trim();
    if (historyRetentionAnswer) (newConfig.server ??= {}).history_retention = parseInt(historyRetentionAnswer, 10);
    else if (existingServer.history_retention !== undefined) (newConfig.server ??= {}).history_retention = existingServer.history_retention;

    // Write file
    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const header = "# Nodex configuration\n";
    writeFileSync(targetPath, header + TOML.stringify(newConfig), "utf8");
    console.log(`\nSaved ${formatSource(targetPath)}`);
  } finally {
    rl.close();
  }
}

async function cmdConfig(positional, flags) {
  if (positional[0] && positional[0] !== "show") {
    throw new Error(`Unknown config subcommand: ${positional[0]}. Valid: show`);
  }
  if (positional[0] === "show" || flags.json) {
    cmdConfigShow(flags);
    return;
  }
  await cmdConfigInteractive();
}

// ─── Help ───

function printMainHelp() {
  console.log(`Usage: nodex <command> [args] [options]

Server:
  nodex                          Start server (default)
  nodex serve [path] [-p port]   Start server explicitly

Project Commands:
  nodex projects                       List all projects
  nodex projects add <id> <name>       Create a project
  nodex projects mv <old-id> <new-id>  Rename a project
  nodex projects rm <id>               Delete a project

Config:
  nodex config                   Edit config interactively
  nodex config show              Show resolved config with sources

Agent Commands:
  nodex ls [column]              List cards
  nodex get <card-id>            Get card details
  nodex add <column> <title>     Create card
  nodex update <card-id>         Update card
  nodex rm <card-id>             Delete card
  nodex mv <card-id> <column>    Move card (supports update opts)
  nodex history                  View edit history
  nodex undo                     Undo last action
  nodex redo                     Redo last undone
  nodex query "<sql>" [params]   Run SQL query
  nodex schema                   Show DB schema
  nodex backups                  List backups / create / restore
  Aliases: list/show/create/remove/delete/move/hist

Global Options:
  -p, --project <id>  Project to operate on (default: "default")
  --url <url>          Server URL (default: http://localhost:51283)
  --session-id <id> Session ID for undo/redo
  --json            Output JSON array/object
  --jsonl           Output JSON Lines (default)
  --csv             Output CSV
  --pretty          Pretty-print JSON output
  --table           Output aligned table text
  -v, --verbose     Verbose output (e.g. full card after update)
  -h, --help        Show help

Config: .nodex/config.toml (CWD walk-up, then ~/.nodex/config.toml)
  url = "http://localhost:51283"
  session_id = "my-session"
  project = "default"
  [server]
  dir = "~/.nodex"
  port = 51283

Env vars: NODEX_URL, NODEX_SESSION_ID, NODEX_PROJECT
Server env vars: KANBAN_DIR, KANBAN_PORT, KANBAN_BACKUP_*

File Input: Use @filepath or @- for stdin
  nodex add 3 "Task" -d @./plan.md
  cat notes.md | nodex add 3 "Task" -d @-`);
}

function printCommandHelp(cmd) {
  const help = {
    ls: `Usage: nodex ls [column] [options]

  List cards. Without column, lists all cards across all columns.
  Column accepts: full ID (5-ready), number (5), or name (ready).

  Options:
    -p, --project <id>  Project (default: "default")
    --priority <p>    Filter by priority
    --assignee <name> Filter by assignee
    --blocked         Show only blocked cards
    --limit <n>       Limit results
    --offset <n>      Skip first n results
    --full            Include full card fields
    --description-chars <n>  Truncate description to n chars (requires --full)
    --description-full       Include full description (requires --full)
    --jsonl           JSON Lines output (default)
    --json            JSON array output
    --csv             CSV output
    --table           Print aligned text table`,

    get: `Usage: nodex get <card-id>

  Get detailed card info. Column is auto-resolved.
  Default output format is JSON Lines.`,

    add: `Usage: nodex add <column> <title> [options]

  Create a new card. Column accepts: full ID, number, or name.

  Options:
    -p, --project <id>        Project (default: "default")
    -d, --description <text>  Description (supports @file/@-)
    -P, --priority <p>        Priority: p0-critical..p4-later
    -e, --estimate <e>        Estimate: xs, s, m, l, xl
    -t, --tags <t1,t2>        Comma-separated tags
    -a, --assignee <name>     Assignee
    --due <YYYY-MM-DD>        Due date
    --agent-status <text>     Agent status (supports @file/@-)
    --agent-blocked           Mark as blocked
    --jsonl                   JSON Lines output (default)
    --json                    JSON object output
    --csv                     CSV output
    --table                   Print aligned text table`,

    update: `Usage: nodex update <card-id> [options]

  Update card properties. Column is auto-resolved.
  Default output: updated,<card-id> (minimal). Use -v for full details.

  Options:
    -p, --project <id>          Project (default: "default")
    --title <text>              New title
    -d, --description <text>    Description (supports @file/@-)
    -P, --priority <p>          Priority
    -e, --estimate <e>          Estimate
    -t, --tags <t1,t2>          Tags
    -a, --assignee <name>       Assignee
    --due <YYYY-MM-DD>          Due date
    --agent-status <text>       Status (supports @file/@-)
    --clear-description         Clear description
    --clear-tags                Clear tags
    --clear-assignee            Clear assignee
    --clear-due                 Clear due date
    --clear-agent-status        Clear status
    --agent-blocked             Set blocked
    --no-agent-blocked          Clear blocked
    -v, --verbose               Show full card details
    --jsonl                     JSON Lines output (default)
    --json                      JSON object output
    --csv                       CSV output
    --table                     Print aligned text table`,

    rm: `Usage: nodex rm <card-id>

  Delete a card. Column is auto-resolved.`,

    mv: `Usage: nodex mv <card-id> <from> <to> [order] [opts]

  Move card from one column to another. Fails if the card is no longer in <from>
  (e.g. already claimed by another agent). Order defaults to end of column.

  Options:
    -p, --project <id>          Project (default: "default")
    --title <text>              New title
    -d, --description <text>    Description (supports @file/@-)
    -P, --priority <p>          Priority
    -e, --estimate <e>          Estimate
    -t, --tags <t1,t2>          Tags
    -a, --assignee <name>       Assignee
    --due <YYYY-MM-DD>          Due date
    --agent-status <text>       Status (supports @file/@-)
    --clear-description         Clear description
    --clear-tags                Clear tags
    --clear-assignee            Clear assignee
    --clear-due                 Clear due date
    --clear-agent-status        Clear status
    --agent-blocked             Set blocked
    --no-agent-blocked          Clear blocked
    -v, --verbose               Show full card details
    --jsonl                     JSON Lines output (default)
    --json                      JSON object output
    --csv                       CSV output
    --table                     Print aligned text table`,

    history: `Usage: nodex history [options]

  Options:
    --card <id>     Show history for specific card
    --limit <n>     Limit results (default: 20)
    --offset <n>    Pagination offset
    --jsonl         JSON Lines output (default)
    --json          JSON object output
    --csv           CSV output
    --table         Print aligned text table`,

    undo: `Usage: nodex undo

  Undo the last operation.`,

    redo: `Usage: nodex redo

  Redo the last undone operation.`,

    query: `Usage: nodex query "<sql>" [param1] [param2] ...

  Execute a read-only SQL query. Parameters replace ? placeholders.
  Default output format is JSON Lines.
  Example: nodex query "SELECT * FROM cards WHERE priority = ?" p1-high
  Use --table for aligned text output.`,

    schema: `Usage: nodex schema

  Show database table schema.
  Default output format is JSON Lines.
  Use --table for aligned text output.`,

    backups: `Usage: nodex backups [subcommand]

  Manage whole-store backups.

  Subcommands:
    nodex backups
      List backups
    nodex backups create [--label <text>]
      Create a manual backup
    nodex backups restore <backup-id> --yes [--no-safety-backup]
      Restore a backup (creates pre-restore safety backup by default)

  Options:
    --label <text>       Optional backup label (create)
    --yes                Required confirmation for restore
    --no-safety-backup   Skip automatic pre-restore safety backup`,

    serve: `Usage: nodex serve [kanban-path] [options]

  Start the Nodex server.

  Options:
    -p, --port <port>   Port (default: 51283)
    --dev               Development mode

  Settings resolved: defaults → config.toml [server] → env vars → CLI flags
  Use .nodex/config.toml in project dir to separate dev/production config.`,

    projects: `Usage: nodex projects [subcommand]

  Manage projects.

  Subcommands:
    nodex projects                          List all projects
    nodex projects add <id> <name>          Create a project
    nodex projects mv <old-id> <new-id>     Rename a project (updates all references)
    nodex projects rm <id>                  Delete a project (and all its data)

  Options:
    -d, --description <text>  Project description (for add/mv)
    -n, --name <name>         Project display name (for mv)`,

    config: `Usage: nodex config [show] [options]

  View or edit Nodex configuration interactively.

  Subcommands:
    nodex config         Interactive config editor
    nodex config show    Display resolved config with sources

  Options:
    --json                Output config as JSON (with show)

  Config resolution (lowest to highest priority):
    1. Defaults
    2. User-level:    ~/.nodex/config.toml
    3. Project-level: .nodex/config.toml (walked up from CWD)
    4. Env vars:      NODEX_URL, NODEX_SESSION_ID, NODEX_PROJECT
                      KANBAN_DIR, KANBAN_PORT, KANBAN_BACKUP_*
    5. CLI flags:     --url, --session-id, --project, --port, [path]

  Use [server] section for dir, port, backup settings.
  Project-level config overrides user-level (useful for dev/production split).`,
  };

  console.log(help[cmd] || `Unknown command: ${cmd}. Run 'nodex help' for usage.`);
}

// ─── Singleton Check ───

function isPortInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { resolve(false); });
  });
}

// ─── Server Start (existing nodex logic) ───

function parseServeArgs(args) {
  const result = { path: null, port: null, dev: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printCommandHelp("serve");
      process.exit(0);
    }
    if (arg === "--port" || arg === "-p") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --port requires a value");
        process.exit(1);
      }
      result.port = parseInt(next, 10);
      i += 1;
      if (isNaN(result.port)) {
        console.error("Error: Invalid port number");
        process.exit(1);
      }
      continue;
    }
    if (arg === "--dev") {
      result.dev = true;
      continue;
    }
    if (!arg.startsWith("-") && !result.path) {
      result.path = arg;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Error: Unknown option for serve: ${arg}`);
      process.exit(1);
    }
  }

  // Resolution: CLI flag → env → TOML (user + project) → default
  const serverCfg = loadServerConfig();
  if (!result.path) {
    result.path = serverCfg.dir ? expandTilde(serverCfg.dir) : join(homedir(), ".nodex");
  }
  if (result.port === null) {
    result.port = typeof serverCfg.port === "number" ? serverCfg.port : 51283;
  }

  return result;
}

async function cmdServe(args) {
  const serveArgs = parseServeArgs(args);

  if (await isPortInUse(serveArgs.port)) {
    console.error(
      `Nodex is already running on port ${serveArgs.port}.\n` +
      `  Use -p <port> to start on a different port.`
    );
    process.exit(1);
  }

  const kanbanDir = resolve(process.cwd(), serveArgs.path);

  if (!existsSync(kanbanDir)) {
    console.log(`Creating kanban directory: ${kanbanDir}`);
    mkdirSync(kanbanDir, { recursive: true });
  }

  const packageRoot = resolve(__dirname, "..");

  console.log(`Starting Nodex...`);
  console.log(`  Kanban directory: ${kanbanDir}`);
  console.log(`  Port: ${serveArgs.port}`);
  console.log(`  Mode: ${serveArgs.dev ? "development" : "production"}`);

  // Pass all resolved server settings as env vars to the Electron child.
  // The CLI does CWD walk-up for project-level config; the child process can't
  // reliably do that since its cwd is set to packageRoot.
  const serverCfg = loadServerConfig();
  const env = {
    ...process.env,
    KANBAN_DIR: kanbanDir,
    KANBAN_PORT: String(serveArgs.port),
  };
  if (serverCfg.backup_auto_enabled !== undefined && !process.env.KANBAN_BACKUP_AUTO_ENABLED)
    env.KANBAN_BACKUP_AUTO_ENABLED = String(serverCfg.backup_auto_enabled);
  if (serverCfg.backup_interval_hours !== undefined && !process.env.KANBAN_BACKUP_INTERVAL_HOURS)
    env.KANBAN_BACKUP_INTERVAL_HOURS = String(serverCfg.backup_interval_hours);
  if (serverCfg.backup_retention !== undefined && !process.env.KANBAN_BACKUP_RETENTION)
    env.KANBAN_BACKUP_RETENTION = String(serverCfg.backup_retention);
  if (serverCfg.history_retention !== undefined && !process.env.KANBAN_HISTORY_RETENTION)
    env.KANBAN_HISTORY_RETENTION = String(serverCfg.history_retention);

  let child;
  if (serveArgs.dev) {
    child = spawn("npx", ["electron-vite", "dev"], {
      cwd: packageRoot,
      env,
      stdio: "inherit",
    });
  } else {
    // Production: run the built Electron app
    const electronPath = resolve(packageRoot, "node_modules/.bin/electron");
    child = spawn(electronPath, [resolve(packageRoot, "out/main/index.js")], {
      cwd: packageRoot,
      env,
      stdio: "inherit",
    });
  }

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

// ─── Main Dispatch ───

function isLikelyServeInvocation(argv) {
  const firstArg = argv[0];
  if (!firstArg) return false;
  if (firstArg.startsWith("-")) return true;
  if (firstArg === "." || firstArg === ".." || firstArg.startsWith("~")) return true;
  return existsSync(resolve(process.cwd(), firstArg));
}

async function main() {
  const argv = process.argv.slice(2);

  // No args → start server
  if (argv.length === 0) {
    await cmdServe([]);
    return;
  }

  const firstArg = argv[0];

  // Global help
  if (firstArg === "--help" || firstArg === "-h") {
    printMainHelp();
    return;
  }

  const subcommand = resolveSubcommand(firstArg);

  // Backward-compatible: allow `nodex <path>` / `nodex -p 1234` for serve mode
  if (!subcommand) {
    if (isLikelyServeInvocation(argv)) {
      await cmdServe(argv);
      return;
    }
    const known = Array.from(new Set([...COMMANDS, ...SUBCOMMAND_ALIASES.keys()]));
    const suggestion = closestMatch(firstArg, known);
    const suffix = suggestion ? ` Did you mean "${suggestion}"?` : "";
    throw new Error(`Unknown command: ${firstArg}.${suffix} Run 'nodex help' for usage.`);
  }

  const restArgs = argv.slice(1);

  if (subcommand === "serve") {
    await cmdServe(restArgs);
    return;
  }

  const parsed = parseCliArgs(restArgs);
  validateCommandFlags(subcommand, parsed.flags);

  if (parsed.flags.help) {
    if (subcommand === "help") {
      if (parsed._[0]) {
        const target = resolveSubcommand(parsed._[0]) || parsed._[0];
        printCommandHelp(target);
      } else {
        printMainHelp();
      }
    } else {
      printCommandHelp(subcommand);
    }
    return;
  }

  if (subcommand === "help") {
    if (parsed._[0]) {
      const target = resolveSubcommand(parsed._[0]) || parsed._[0];
      printCommandHelp(target);
    } else {
      printMainHelp();
    }
    return;
  }

  const config = loadConfig(parsed.flags);
  BASE_URL = config.url;

  // Projects command doesn't need project config
  if (subcommand === "projects") {
    try {
      await cmdProjects(parsed._, parsed.flags);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  // Config command — purely local, no server needed
  if (subcommand === "config") {
    try {
      await cmdConfig(parsed._, parsed.flags);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  assertValidProjectId(config.project);

  const commands = {
    ls: cmdLs,
    get: cmdGet,
    add: cmdAdd,
    update: cmdUpdate,
    rm: cmdRm,
    mv: cmdMv,
    history: cmdHistory,
    undo: cmdUndo,
    redo: cmdRedo,
    query: cmdQuery,
    schema: cmdSchema,
    backups: cmdBackups,
  };

  try {
    await commands[subcommand](parsed._, parsed.flags, config);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
