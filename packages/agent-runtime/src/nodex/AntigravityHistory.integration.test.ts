import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@nodex/runtime-contracts";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  AntigravityInstallation,
  type AntigravityExecutable,
} from "../provider/AntigravityInstallation.ts";
import { createHash } from "node:crypto";
import { make } from "./AntigravityHistory.ts";
import { layerPolicy } from "./ProviderConfiguration.ts";

const instanceId = ProviderInstanceId.make("antigravity-fixture");
const desktop = "8b7e76a5-152a-4685-9f0a-371052fac37e";
const commandLine = "d4968915-2f6e-4925-8612-cec47b5b2a77";
const folderless = "50b0b04e-fde6-4528-b701-c109885b9679";
const misplaced = "0f6a3b35-7f61-4f43-9a7e-1d5d2a6cb7a1";

/**
 * Behaves like agy: it lists and replays only the transcripts in the Gemini root it is given, and
 * writes its own state there as it goes.
 */
const peer = String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const [acp, geminiFlag, root, dataFlag, app, logFlag, log, telemetry] = process.argv.slice(2);
const tmp = process.env.TMPDIR;
assert.deepEqual([acp, geminiFlag, dataFlag, logFlag, telemetry],
  ["acp", "--gemini-dir", "--app-data-dir", "--log-file", "--disable-telemetry"]);
assert.equal(root, path.join(tmp, "gemini"));
assert.ok(["antigravity", "antigravity-cli"].includes(app));
assert.equal(log, path.join(tmp, "acp.log"));
assert.equal(process.cwd(), fs.realpathSync(path.join(tmp, "empty")));
assert.deepEqual(fs.readdirSync(process.cwd()), []);
assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, "1");
assert.equal(process.env.FIXTURE_HOST_SIGN_IN, "host");
assert.equal(process.env.FIXTURE_PROFILE_ONLY, undefined);
assert.equal(process.env.GEMINI_HOME, undefined);
assert.equal(process.env.AGY_ACP_FORCE_FILE_STORAGE, undefined);
const mode = process.env.FIXTURE_MODE;
const conversations = path.join(root, app, "conversations");
// Like agy, the title it generated for a conversation is its annotation.
assert.ok(!fs.existsSync(path.join(root, app, "conversation_summaries.db")));
const sessions = fs.readdirSync(conversations)
  .filter((name) => /\.(db|pb)$/.test(name))
  .map((name) => {
    const transcript = JSON.parse(fs.readFileSync(path.join(conversations, name), "utf8"));
    if (name.endsWith(".db")) assert.ok(fs.existsSync(path.join(conversations, name + "-wal")));
    const sessionId = name.slice(0, 36);
    const annotation = path.join(root, app, "annotations", sessionId + ".pbtxt");
    const title = fs.existsSync(annotation) ? fs.readFileSync(annotation, "utf8") : transcript.title;
    return { ...transcript, sessionId, title, cwd: transcript.cwd ?? process.cwd() };
  })
  .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(process.env.FIXTURE_REQUESTS, app + " " + method + "\n");
  const result = (value) => send({ id, result: value });
  const error = (code, message) => send({ id, error: { code, message, data: "private-payload" } });
  if (method === "initialize") {
    fs.writeFileSync(path.join(root, app, "conversation_summaries.db"), "agy index");
    fs.mkdirSync(path.join(root, app, "implicit"), { recursive: true });
    result({ protocolVersion: 2, agentInfo: { name: "Antigravity", version: "1.5.12" },
      agentCapabilities: { loadSession: true } });
  } else if (method === "session/list") {
    if (mode === "auth") {
      process.stderr.write("private-stderr");
      error(-32000, "Authentication required");
      continue;
    }
    // One conversation per page, in agy's own order.
    const index = params.cursor === undefined ? 0 : Number(params.cursor);
    assert.deepEqual(params, index === 0 ? {} : { cursor: String(index) });
    const { messages: _messages, ...row } = sessions[index] ?? {};
    result({
      sessions: sessions[index] ? [row] : [],
      ...(index + 1 < sessions.length ? { nextCursor: String(index + 1) } : {}),
    });
  } else if (method === "session/load") {
    const session = sessions.find(({ sessionId }) => sessionId === params.sessionId);
    assert.deepEqual(params, { sessionId: session.sessionId, cwd: session.cwd, mcpServers: [] });
    const update = (sessionId, role, text) => send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: role + "_message_chunk", content: { type: "text", text } } },
    });
    update(folderless(), "user", "Foreign conversation");
    if (mode === "auth") {
      error(-32000, "Authentication required");
      continue;
    }
    if (mode !== "empty")
      for (const [role, text] of session.messages) update(session.sessionId, role, text);
    if (mode === "rpc-error") error(-32603, "private-agent-message");
    else result({});
  } else {
    assert.fail("Unexpected method " + method);
  }
}
function folderless() { return process.env.FIXTURE_FOREIGN; }
`;

const harness = Effect.fn("AntigravityHistory.test.harness")(function* (mode: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-agy-history-test-" });
  const userHome = yield* fs.realPath(root);
  const workspace = path.join(userHome, "workspace");
  const gemini = path.join(userHome, ".gemini");
  const script = path.join(userHome, "peer.cjs");
  const requests = path.join(userHome, "requests.txt");
  yield* fs.makeDirectory(workspace);
  const transcript = (
    app: string,
    name: string,
    value: { cwd?: string; title: string; updatedAt: string; messages?: string[][] },
  ) =>
    fs
      .makeDirectory(path.join(gemini, app, "conversations"), { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            path.join(gemini, app, "conversations", name),
            JSON.stringify({ messages: [], ...value }),
          ),
        ),
      );
  // The desktop app keeps one encrypted file per conversation.
  yield* transcript("antigravity", `${desktop}.pb`, {
    cwd: workspace,
    title: "Desktop",
    updatedAt: "2026-10-01T00:00:00Z",
    messages: [
      ["user", "Desktop question"],
      ["agent", "Desktop answer"],
    ],
  });
  yield* transcript("antigravity", `${folderless}.pb`, {
    title: "No folder",
    updatedAt: "2026-11-01T00:00:00Z",
  });
  // agy keeps a SQLite database with its write-ahead log beside it.
  yield* transcript("antigravity-cli", `${commandLine}.db`, {
    cwd: workspace,
    title: "Command line",
    updatedAt: "2026-09-01T00:00:00Z",
    messages: [
      ["user", "Command-line question"],
      ["agent", "Command-line answer"],
    ],
  });
  yield* fs.writeFileString(
    path.join(gemini, "antigravity-cli", "conversations", `${commandLine}.db-wal`),
    "wal",
  );
  yield* fs.makeDirectory(path.join(gemini, "antigravity-cli", "annotations"));
  yield* fs.writeFileString(
    path.join(gemini, "antigravity-cli", "annotations", `${commandLine}.pbtxt`),
    "Generated title",
  );
  // The command line's index is its own; reading never needs or touches it.
  yield* fs.writeFileString(path.join(gemini, "antigravity-cli", "conversation_summaries.db"), "");
  // Neither a link nor another app's data, such as the separately installed IDE, is read.
  yield* fs.makeDirectory(path.join(userHome, "elsewhere"));
  yield* transcript("../elsewhere", `${misplaced}.pb`, {
    cwd: workspace,
    title: "Linked",
    updatedAt: "2026-12-01T00:00:00Z",
  });
  yield* fs.symlink(
    path.join(userHome, "elsewhere", "conversations", `${misplaced}.pb`),
    path.join(gemini, "antigravity", "conversations", `${misplaced}.pb`),
  );
  yield* transcript("antigravity-ide", `${misplaced}.pb`, {
    cwd: workspace,
    title: "Old editor",
    updatedAt: "2026-12-01T00:00:00Z",
  });

  // Every byte and every entry under the Gemini root, to prove reading writes nothing there.
  const sourceEvidence = Effect.gen(function* () {
    const evidence: Record<string, string> = {};
    const walk: (directory: string) => Effect.Effect<void, unknown> = Effect.fnUntraced(
      function* (directory) {
        for (const name of (yield* fs.readDirectory(directory)).toSorted()) {
          const file = path.join(directory, name);
          const info = yield* fs.stat(file);
          if (info.type === "Directory") yield* walk(file);
          else
            evidence[path.relative(gemini, file)] = createHash("sha256")
              .update(yield* fs.readFile(file))
              .digest("hex");
        }
      },
    );
    yield* walk(gemini);
    return evidence;
  });
  yield* fs.writeFileString(script, "(async () => {" + peer + "})().catch(() => process.exit(1));");
  const environment = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    GEMINI_HOME: undefined,
    AGY_ACP_FORCE_FILE_STORAGE: undefined,
    FIXTURE_HOST_SIGN_IN: "host",
    FIXTURE_PROFILE_ONLY: undefined,
    FIXTURE_REQUESTS: requests,
    FIXTURE_FOREIGN: folderless,
    FIXTURE_MODE: mode,
  };
  const acquired: Array<string | undefined> = [];
  const tempDirectories: string[] = [];
  const reader = yield* make().pipe(
    Effect.provide(
      Layer.mergeAll(
        layerPolicy({
          [instanceId]: {
            driver: ProviderDriverKind.make("antigravity"),
            enabled: true,
            config: { binaryPath: "fixture-agy" },
            environment: [{ name: "FIXTURE_PROFILE_ONLY", value: "profile", sensitive: false }],
          },
        }),
        Layer.mock(AntigravityInstallation)({
          managedDirectory: path.join(userHome, "managed"),
          acquire: (binaryPath, env) =>
            Effect.sync(() => {
              assert.equal(binaryPath, "fixture-agy");
              acquired.push(env?.FIXTURE_PROFILE_ONLY);
              return {
                executablePath: process.execPath,
                source: "override",
                version: "1.5.12",
                managedVersionDirectory: null,
              } satisfies AntigravityExecutable;
            }),
        }),
        Layer.succeed(HostProcess.Environment, environment),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand")
              return Effect.die("Unexpected process pipeline.");
            const temp = command.options.env?.TMPDIR;
            if (typeof temp === "string") tempDirectories.push(temp);
            return spawner.spawn(
              ChildProcess.make(command.command, [script, ...command.args], command.options),
            );
          }),
        ),
      ),
    ),
  );
  const home = yield* fs.realPath(gemini);
  return {
    reader,
    list: { instanceId, home },
    verify: (sessionId: string) => ({ instanceId, home, sessionId, sourceCwd: workspace }),
    workspace,
    methods: fs.readFileString(requests).pipe(Effect.map((content) => content.trim().split("\n"))),
    started: fs.exists(requests),
    cleanedUp: Effect.forEach(tempDirectories, (directory) => fs.exists(directory)),
    sourceEvidence,
    acquired,
  };
});

it.live("lists the desktop app and the command line together and copies either", () =>
  Effect.gen(function* () {
    const fixture = yield* harness("normal");
    const before = yield* fixture.sourceEvidence;
    const { entries } = yield* fixture.reader.list(fixture.list);
    assert.deepEqual(
      entries.map(({ nativeSessionId, title }) => [nativeSessionId, title]),
      [
        [desktop, "Desktop"],
        [commandLine, "Generated title"],
      ],
    );
    assert.equal(entries[0]?.cwd, fixture.workspace);
    assert.equal(entries[0]?.updatedAt, Date.UTC(2026, 9, 1));
    for (const [sessionId, question] of [
      [desktop, "Desktop question"],
      [commandLine, "Command-line question"],
    ] as const) {
      assert.deepEqual(yield* fixture.reader.verify(fixture.verify(sessionId)), {});
      const source = yield* fixture.reader.openImportSource({
        modelSelection: { instanceId },
        sourceHome: fixture.list.home,
        sourceNativeThreadId: sessionId,
        sourceCwd: fixture.workspace,
      });
      const page = yield* source.page(yield* source.capture(), null);
      assert.deepEqual(
        page.data.map(({ item }) => [
          item.type,
          item.type === "userMessage" && item.content[0]?.type === "text"
            ? item.content[0].text
            : item.type,
        ]),
        [
          ["userMessage", question],
          ["agentMessage", "agentMessage"],
        ],
      );
    }
    assert.deepEqual(yield* fixture.methods, [
      "antigravity initialize",
      "antigravity session/list",
      "antigravity session/list",
      "antigravity-cli initialize",
      "antigravity-cli session/list",
      "antigravity initialize",
      "antigravity session/load",
      "antigravity initialize",
      "antigravity session/load",
      "antigravity-cli initialize",
      "antigravity-cli session/load",
      "antigravity-cli initialize",
      "antigravity-cli session/load",
    ]);
    assert.deepEqual(fixture.acquired, Array(6).fill("profile"));
    assert.deepEqual(yield* fixture.cleanedUp, Array(6).fill(false));
    // agy wrote its index and memories into each snapshot; the originals gained nothing.
    assert.deepEqual(yield* fixture.sourceEvidence, before);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses a conversation whose transcript is no longer on this computer", () =>
  Effect.gen(function* () {
    const fixture = yield* harness("normal");
    for (const sessionId of [misplaced, "11111111-2222-4333-8444-555555555555"])
      assert.equal(
        (yield* fixture.reader.verify(fixture.verify(sessionId)).pipe(Effect.flip)).message,
        "This Antigravity conversation is no longer on this computer.",
      );
    // Nothing to snapshot, so agy never starts.
    assert.isFalse(yield* fixture.started);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [mode, message] of [
  [
    "auth",
    "Antigravity's command line isn't signed in on this computer, so its conversations can't be read. Run agy in a terminal to sign in, then try again.",
  ],
  ["empty", "Antigravity didn't return this conversation's history, so it can't be copied."],
  ["rpc-error", "Could not replay this Antigravity conversation."],
] as const) {
  it.live(`refuses a ${mode} replay with a safe message`, () =>
    Effect.gen(function* () {
      const fixture = yield* harness(mode);
      if (mode === "auth") {
        assert.equal((yield* fixture.reader.list(fixture.list).pipe(Effect.flip)).message, message);
      }
      assert.equal(
        (yield* fixture.reader.verify(fixture.verify(desktop)).pipe(Effect.flip)).message,
        message,
      );
      assert.deepEqual(
        yield* fixture.methods,
        mode === "auth"
          ? [
              "antigravity initialize",
              "antigravity session/list",
              "antigravity initialize",
              "antigravity session/load",
            ]
          : ["antigravity initialize", "antigravity session/load"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
