#!/usr/bin/env node

// A scenario Codex whose `exec` is a held, observable utility generation, so a test can see which
// generations run at once and whether stopping one really ends its process. Every other command
// is the fake app server. This file is copied to the runtime's bin/codex, so it stands alone.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] !== "exec") {
  await import(process.env.NODEX_FAKE_CODEX_APP_SERVER_PATH);
} else {
  const directory = process.env.NODEX_FAKE_CODEX_EXEC_DIR;
  fs.mkdirSync(directory, { recursive: true });

  const flagValues = (flag) =>
    args.flatMap((value, index) => (value === flag ? [args[index + 1]] : []));

  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const { request, messages } = JSON.parse(prompt.split("JSON data:\n")[1]);
  const effort = flagValues("--config")
    .map((value) => /^model_reasoning_effort="?([a-z]+)"?$/u.exec(value)?.[1])
    .find(Boolean);

  fs.appendFileSync(
    path.join(directory, "generations.jsonl"),
    `${JSON.stringify({
      requestId: request.request_id,
      pid: process.pid,
      bodies: messages.map((message) => message.body),
      effort: effort ?? null,
    })}\n`,
  );

  // The test ends a generation by writing one of these files; until then it stays running.
  const decision = (name) => path.join(directory, `${request.request_id}.${name}`);
  while (!fs.existsSync(decision("answer")) && !fs.existsSync(decision("fail")))
    await new Promise((resolve) => setTimeout(resolve, 50));

  if (fs.existsSync(decision("fail"))) {
    process.stderr.write("error: the model is unavailable\n");
    process.exit(1);
  }
  fs.writeFileSync(
    flagValues("--output-last-message")[0],
    JSON.stringify({
      request_id: request.request_id,
      generation: request.generation,
      titles: [],
      suggestions: messages.map((message) => ({
        page_ids: [message.page_id],
        kind: "note",
        action: "keep",
        project_id: null,
        session_id: null,
        prompt: null,
        additions: [],
        chat_instance_id: null,
        chat_model: null,
        chat_effort: null,
        summary: "Keep this reference",
        rationale: null,
      })),
    }),
  );
  process.exit(0);
}
