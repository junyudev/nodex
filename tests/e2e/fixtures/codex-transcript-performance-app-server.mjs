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
if (!statePath || !commandPath || !logPath || !baseFixture)
  throw new Error("Transcript streaming fixture requires explicit isolated paths");
const notify = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const writeState = (state) => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, statePath);
};
const record = (command) => fs.appendFileSync(logPath, `${JSON.stringify({ method: "fixture-command", params: command })}\n`);
/** Runs a command in the Turn's own process; anything else leaves it for later. */
const handle = (command, state) => {
  const threadId = state.thread?.id;
  // Streams go into the Turn the app started for the controlled prompt, as a model's reply would.
  const turn = state.turns.find(
    (entry) => entry.id === state.controlledTurnId && entry.status === "inProgress",
  );
  // A command that arrives before the app started the controlled prompt's Turn waits for it.
  if (!threadId || !turn) return false;
  // Every app-server process of the Profile reads the channel; only the Turn's own one answers,
  // and it may start after the test wrote its commands.
  if (state.controlledTurnPid !== process.pid) return false;
  state.executedCommands = (state.executedCommands ?? 0) + 1;
  const message = (id, phase) => ({
    type: "agentMessage", id, text: "", phase, delivery: null, memoryCitation: null, questions: null,
  });
  if (command.type === "item") {
    const index = turn.items.findIndex((item) => item.id === command.item.id);
    if (index < 0) turn.items.push(command.item);
    else turn.items[index] = command.item;
    writeState(state);
    if (index < 0)
      notify("item/started", { threadId, turnId: turn.id, item: command.item, startedAtMs: Date.now() });
    notify("item/completed", { threadId, turnId: turn.id, item: command.item, completedAtMs: Date.now() });
    record(command);
    return true;
  }
  if (command.type === "start") {
    // A commentary sibling settles first; the final answer then streams like Codex streams it.
    const sibling = { ...message("stream-sibling", "commentary"), text: "Unchanged sibling" };
    const target = message("stream-target", "final_answer");
    notify("item/started", { threadId, turnId: turn.id, item: { ...sibling, text: "" }, startedAtMs: Date.now() });
    notify("item/completed", { threadId, turnId: turn.id, item: sibling, completedAtMs: Date.now() });
    notify("item/started", { threadId, turnId: turn.id, item: target, startedAtMs: Date.now() });
    target.text = "Stream baseline\n\n";
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: target.id, delta: target.text });
    turn.items.push(sibling, target);
    writeState(state);
    record(command);
    return true;
  }
  if (command.type === "delta") {
    const item = turn.items.find((entry) => entry.id === "stream-target");
    item.text += command.delta;
    writeState(state);
    notify("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: item.id, delta: command.delta });
    record(command);
    return true;
  }
  if (command.type !== "complete") throw new Error(`Unknown fixture command: ${command.type}`);
  turn.status = "completed";
  turn.completedAt = Math.floor(Date.now() / 1000);
  turn.durationMs = 1000;
  writeState(state);
  const target = turn.items.find((entry) => entry.id === "stream-target");
  notify("item/completed", { threadId, turnId: turn.id, item: target, completedAtMs: Date.now() });
  notify("turn/completed", { threadId, turn });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
  record(command);
  return true;
};

fs.mkdirSync(path.dirname(commandPath), { recursive: true });
if (!fs.existsSync(commandPath)) fs.writeFileSync(commandPath, "");
// The executed count is durable, so a restarted native process never replays a command.
setInterval(() => {
  const commands = fs.readFileSync(commandPath, "utf8").split("\n").filter(Boolean);
  for (;;) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const next = state.executedCommands ?? 0;
    if (next >= commands.length || !handle(JSON.parse(commands[next]), state)) break;
  }
}, 10);
// Cold resumes normally keep controlled streams alive; interaction scenarios
// can opt into automatic completion for ordinary follow-up submissions.
if (JSON.parse(fs.readFileSync(statePath, "utf8")).turnSequence > 0)
  process.env.NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS =
    process.env.NODEX_FAKE_CODEX_RESUMED_COMPLETION_DELAY_MS ?? "120000";
await import(pathToFileURL(baseFixture).href);
