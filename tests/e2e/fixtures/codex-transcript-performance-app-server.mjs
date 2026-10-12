#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the authoritative fake native request implementation; the file channel only
// controls native notifications, so the app still consumes its normal transports.
const statePath = process.env.NODEX_FAKE_CODEX_STATE_PATH;
const commandPath = process.env.NODEX_FAKE_CODEX_COMMAND_PATH;
const logPath = process.env.NODEX_FAKE_CODEX_LOG_PATH;
const baseFixture = process.env.NODEX_FAKE_CODEX_BASE_FIXTURE;
const pressurePageReleasePath = process.env.NODEX_FAKE_CODEX_PRESSURE_PAGE_RELEASE_PATH;
if (!statePath || !commandPath || !logPath || !baseFixture)
  throw new Error("Transcript pressure fixture requires explicit isolated paths");
let consumed = 0;
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const record = (command) => fs.appendFileSync(logPath, `${JSON.stringify({ method: "fixture-command", params: command })}\n`);
const handle = (command) => {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const threadId = state.thread?.id;
  if (!threadId) throw new Error("The synthetic Thread has not been created through the app");
  if (command.type === "release-pressure-page") {
    if (!pressurePageReleasePath) throw new Error("Pressure page barrier is not configured");
    fs.writeFileSync(pressurePageReleasePath, "released");
    record(command);
    return;
  }
  if (command.type === "pressure") {
    const pressure = {
      id: "pressure-turn", rootTurnId: null, itemsView: "full", status: "completed",
      error: null, startedAt: 1_800_000_000, completedAt: 1_800_000_001, durationMs: 1000,
      items: Array.from({ length: 1001 }, (_, index) => ({
        type: "commandExecution", id: `pressure-command-${index.toString().padStart(4, "0")}`,
        command: `printf synthetic-${index}`, cwd: state.thread.cwd, pluginId: null,
        scriptPath: null, processId: null, source: "agent", status: "completed",
        commandActions: [{ type: "unknown", command: `printf synthetic-${index}` }],
        aggregatedOutput: `Synthetic output ${index}`, exitCode: 0, durationMs: 1,
      })),
    };
    const live = {
      id: "pressure-live-turn", rootTurnId: null, itemsView: "full", status: "inProgress",
      error: null, startedAt: 1_800_000_002, completedAt: null, durationMs: null,
      items: [{ type: "agentMessage", id: "pressure-live-answer", phase: "final_answer",
        text: "Eviction live sentinel.\n\n" + "A synthetic paragraph gives the live Turn a measurable viewport while completed tool history remains outside it.\n\n".repeat(80) + "Eviction viewport marker.",
        delivery: null, memoryCitation: null, questions: null }],
    };
    state.turns.push(pressure, live);
    writeState(state);
    notify("turn/started", { threadId, turn: { ...pressure, items: [], status: "inProgress" } });
    for (const item of pressure.items) {
      notify("item/started", { threadId, turnId: pressure.id, item, startedAtMs: 1_800_000_000_000 });
      notify("item/completed", { threadId, turnId: pressure.id, item, completedAtMs: 1_800_000_001_000 });
    }
    notify("turn/completed", { threadId, turn: pressure });
    notify("turn/started", { threadId, turn: { ...live, items: [] } });
    for (const item of live.items)
      notify("item/started", { threadId, turnId: live.id, item, startedAtMs: 1_800_000_002_000 });
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    record(command);
    return;
  }
  if (command.type === "start") {
    const turn = {
      id: "performance-stream-turn", rootTurnId: null, status: "inProgress",
      error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null,
      durationMs: null, itemsView: "full", items: [
        { type: "agentMessage", id: "stream-sibling", text: "Unchanged sibling", phase: "final_answer", delivery: null, memoryCitation: null, questions: null },
        { type: "agentMessage", id: "stream-target", text: "Stream baseline", phase: "final_answer", delivery: null, memoryCitation: null, questions: null },
      ],
    };
    state.turns.push(turn);
    writeState(state);
    notify("turn/started", { threadId, turn: { ...turn, items: [] } });
    for (const item of turn.items)
      notify("item/started", { threadId, turnId: turn.id, item, startedAtMs: Date.now() });
    notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    record(command);
    return;
  }
  const turn = state.turns.find((entry) => entry.id === "performance-stream-turn");
  if (!turn) throw new Error("The synthetic stream has not been started");
  if (command.type === "delta") {
    const item = turn.items.find((entry) => entry.id === "stream-target");
    item.text += command.delta;
    writeState(state);
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: item.id, delta: command.delta });
    record(command);
    return;
  }
  if (command.type !== "complete") throw new Error(`Unknown fixture command: ${command.type}`);
  turn.status = "completed";
  turn.completedAt = Math.floor(Date.now() / 1000);
  turn.durationMs = 1000;
  writeState(state);
  for (const item of turn.items)
    notify("item/completed", { threadId, turnId: turn.id, item, completedAtMs: Date.now() });
  notify("turn/completed", { threadId, turn });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  record(command);
};

fs.mkdirSync(path.dirname(commandPath), { recursive: true });
if (!fs.existsSync(commandPath)) fs.writeFileSync(commandPath, "");
// A restarted native process must not replay already executed synthetic commands.
consumed = fs.readFileSync(commandPath, "utf8").split("\n").filter(Boolean).length;
fs.watchFile(commandPath, { interval: 10 }, () => {
  const commands = fs.readFileSync(commandPath, "utf8").split("\n").filter(Boolean);
  while (consumed < commands.length) handle(JSON.parse(commands[consumed++]));
});
// Cold resumes normally keep controlled streams alive; interaction scenarios
// can opt into automatic completion for ordinary follow-up submissions.
if (JSON.parse(fs.readFileSync(statePath, "utf8")).turnSequence > 0)
  process.env.NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS =
    process.env.NODEX_FAKE_CODEX_RESUMED_COMPLETION_DELAY_MS ?? "120000";
await import(pathToFileURL(baseFixture).href);
