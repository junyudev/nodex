import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexSessionTransport, type CodexSessionTransportHandle } from "./CodexSessionTransport";
import {
  assertCodexHomeChangeSafe,
  initializeCodexHomeContinuity,
  readCodexHomeReceipt,
  writeCodexHomeReceipt,
} from "./CodexHomeContinuity";

const newHome = () => realpathSync(mkdtempSync(join(tmpdir(), "nodex-codex-home-")));
const initialization = (profileHome: string, overrides = {}) =>
  initializeCodexHomeContinuity({
    profileHome,
    selectedHome: join(profileHome, "native"),
    hasConfiguredHome: false,
    hasInheritedCodexHome: false,
    ...overrides,
  });

test("fresh and empty legacy Profiles use the selected native home without opening it", () => {
  const profileHome = newHome();
  try {
    mkdirSync(join(profileHome, "agent"));
    const database = new DatabaseSync(join(profileHome, "agent", "state_5.sqlite"));
    database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    database.close();
    expect(initialization(profileHome)).toEqual({
      codexHome: join(profileHome, "native"),
      pinLegacyHome: false,
      previousHome: null,
    });
    expect(readdirSync(profileHome)).toEqual(["agent"]);
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("legacy native IDs retain their home through readonly index inspection", () => {
  const profileHome = newHome();
  try {
    const agent = join(profileHome, "agent");
    mkdirSync(agent);
    const file = join(agent, "state_5.sqlite");
    const database = new DatabaseSync(file);
    database.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL); INSERT INTO threads VALUES('native-id','rollout.jsonl')",
    );
    database.close();
    const before = readFileSync(file);
    expect(initialization(profileHome)).toEqual({
      codexHome: agent,
      pinLegacyHome: true,
      previousHome: agent,
    });
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(agent)).toEqual(["state_5.sqlite"]);
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test.each(["hasConfiguredHome", "hasInheritedCodexHome"])(
  "first upgrade keeps the previous home for the guard when %s selects another",
  (selection) => {
    const profileHome = newHome();
    try {
      const agent = join(profileHome, "agent");
      const sessions = join(agent, "archived_sessions");
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "rollout-2026-native-id.jsonl.zst"), "opaque native history");
      expect(initialization(profileHome, { [selection]: true })).toEqual({
        codexHome: join(profileHome, "native"),
        pinLegacyHome: false,
        previousHome: agent,
      });
    } finally {
      rmSync(profileHome, { recursive: true, force: true });
    }
  },
);

test("active home receipts survive setting changes and reject invalid home identities", () => {
  const profileHome = newHome();
  try {
    const active = join(profileHome, "active");
    writeCodexHomeReceipt({ profileHome, codexHome: active });
    expect(initialization(profileHome, { hasConfiguredHome: true }).previousHome).toBe(active);
    expect(readCodexHomeReceipt(profileHome)).toBe(active);
    expect(readdirSync(join(profileHome, "runtime", "agent"))).toEqual(["codex-home.json"]);
    writeFileSync(
      join(profileHome, "runtime", "agent", "codex-home.json"),
      JSON.stringify({ version: 1, codexHome: "relative" }),
    );
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("absolute path");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("home receipts reject oversized, malformed and symlinked files", () => {
  const profileHome = newHome();
  try {
    const directory = join(profileHome, "runtime", "agent");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "codex-home.json");
    writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("too large");
    writeFileSync(file, "malformed");
    expect(() => readCodexHomeReceipt(profileHome)).toThrow();
    rmSync(file);
    const outside = join(profileHome, "outside.json");
    writeFileSync(outside, JSON.stringify({ version: 1, codexHome: join(profileHome, "native") }));
    symlinkSync(outside, file);
    expect(() => readCodexHomeReceipt(profileHome)).toThrow("regular file");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

test("native home symlinks retain canonical identity while regular files are rejected", () => {
  const profileHome = newHome();
  try {
    const target = join(profileHome, "native");
    const alias = join(profileHome, "alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    writeCodexHomeReceipt({ profileHome, codexHome: alias });
    expect(readCodexHomeReceipt(profileHome)).toBe(target);
    const regular = join(profileHome, "file");
    writeFileSync(regular, "content");
    expect(() => writeCodexHomeReceipt({ profileHome, codexHome: regular })).toThrow("directory");
  } finally {
    rmSync(profileHome, { recursive: true, force: true });
  }
});

const processConfig = {
  hostId: "local",
  generation: 1,
  command: "/pinned/codex",
  args: ["app-server"],
  env: { HOME: "/native-user", CODEX_HOME: "/old" },
  forceTermination: "1 second",
} as const;

const metadataPeer = (
  options: {
    readonly missing?: string;
    readonly actualHome?: string;
    readonly unreadable?: string;
  } = {},
) => {
  const requests: { method: string; params: unknown }[] = [];
  const events: string[] = [];
  const transport = CodexSessionTransport.of({
    canonicalPath: (path) => Effect.succeed(path),
    open: (config) =>
      Effect.gen(function* () {
        events.push("open");
        expect(config.env.HOME).toBe("/native-user");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            events.push("closed");
          }),
        );
        const client = {
          request: (
            method: string,
            params: { readonly threadId?: string; readonly includeTurns?: boolean },
          ) =>
            Effect.gen(function* () {
              requests.push({ method, params });
              if (method === "initialize")
                return { codexHome: options.actualHome ?? config.env.CODEX_HOME };
              if (method === "thread/turns/list") {
                if (params.threadId === options.unreadable)
                  return yield* new CodexAppServerRequestError({
                    method,
                    code: -32600,
                    errorMessage: "native history cannot be read",
                  });
                return { data: [], nextCursor: null, backwardsCursor: null };
              }
              expect(method).toBe("thread/read");
              expect(params.includeTurns).toBe(false);
              if (params.threadId === options.missing)
                return yield* new CodexAppServerRequestError({
                  method,
                  code: -32600,
                  errorMessage: `thread not loaded: ${params.threadId}`,
                });
              return { thread: { id: params.threadId } };
            }),
          notify: (method: string) =>
            Effect.sync(() => {
              events.push(method);
            }),
        };
        return {
          pid: 1,
          client,
          termination: Effect.never,
          transportKind: "stdio",
        } as unknown as CodexSessionTransportHandle;
      }),
  });
  return { transport, requests, events };
};

it.effect("home changes with no bound IDs and unchanged homes never start a native peer", () =>
  Effect.gen(function* () {
    const peer = metadataPeer();
    yield* assertCodexHomeChangeSafe({
      currentHome: "/old",
      targetHome: "/old",
      requiredThreadIds: ["owned"],
      processConfig,
    }).pipe(Effect.provideService(CodexSessionTransport, peer.transport));
    yield* assertCodexHomeChangeSafe({
      currentHome: "/old",
      targetHome: tmpdir(),
      requiredThreadIds: [],
      processConfig,
    }).pipe(Effect.provideService(CodexSessionTransport, peer.transport));
    expect(peer.events).toEqual([]);
  }),
);

it.effect("one scoped native peer checks each owned ID through metadata and closes", () =>
  Effect.gen(function* () {
    const peer = metadataPeer();
    yield* assertCodexHomeChangeSafe({
      currentHome: "/old",
      targetHome: tmpdir(),
      requiredThreadIds: ["root", "child", "root"],
      processConfig,
    }).pipe(Effect.provideService(CodexSessionTransport, peer.transport));
    expect(peer.events).toEqual(["open", "initialized", "closed"]);
    expect(peer.requests.map(({ method }) => method)).toEqual([
      "initialize",
      "thread/read",
      "thread/turns/list",
      "thread/read",
      "thread/turns/list",
    ]);
    expect(peer.requests.slice(1).map(({ params }) => params)).toEqual([
      { threadId: "root", includeTurns: false },
      { threadId: "root", limit: 1, itemsView: "summary" },
      { threadId: "child", includeTurns: false },
      { threadId: "child", limit: 1, itemsView: "summary" },
    ]);
  }),
);

it.effect("missing native IDs reject home changes and release the metadata peer", () =>
  Effect.gen(function* () {
    const peer = metadataPeer({ missing: "child" });
    const result = yield* Effect.result(
      assertCodexHomeChangeSafe({
        currentHome: "/old",
        targetHome: tmpdir(),
        requiredThreadIds: ["root", "child"],
        processConfig,
      }).pipe(Effect.provideService(CodexSessionTransport, peer.transport)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.threadId).toBe("child");
    expect(peer.events).toEqual(["open", "initialized", "closed"]);
  }),
);

it.effect("a peer that opens a different native home cannot validate the destination", () =>
  Effect.gen(function* () {
    const peer = metadataPeer({ actualHome: "/wrong" });
    const result = yield* Effect.exit(
      assertCodexHomeChangeSafe({
        currentHome: "/old",
        targetHome: tmpdir(),
        requiredThreadIds: ["root"],
        processConfig,
      }).pipe(Effect.provideService(CodexSessionTransport, peer.transport)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(peer.requests.map(({ method }) => method)).toEqual(["initialize"]);
    expect(peer.events).toEqual(["open", "closed"]);
  }),
);

it.effect("native metadata with unreadable stored history cannot validate a home change", () =>
  Effect.gen(function* () {
    const peer = metadataPeer({ unreadable: "root" });
    const result = yield* Effect.result(
      assertCodexHomeChangeSafe({
        currentHome: "/old",
        targetHome: tmpdir(),
        requiredThreadIds: ["root"],
        processConfig,
      }).pipe(Effect.provideService(CodexSessionTransport, peer.transport)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.threadId).toBe("root");
    expect(peer.requests.map(({ method }) => method)).toEqual([
      "initialize",
      "thread/read",
      "thread/turns/list",
    ]);
    expect(peer.events).toEqual(["open", "initialized", "closed"]);
  }),
);

it.effect("a nonexistent destination rejects bound native history before opening a peer", () =>
  Effect.gen(function* () {
    const peer = metadataPeer();
    const profileHome = yield* Effect.acquireRelease(Effect.sync(newHome), (home) =>
      Effect.sync(() => rmSync(home, { recursive: true, force: true })),
    );
    const result = yield* Effect.result(
      assertCodexHomeChangeSafe({
        currentHome: "/old",
        targetHome: join(profileHome, "missing"),
        requiredThreadIds: ["root"],
        processConfig,
      }).pipe(Effect.provideService(CodexSessionTransport, peer.transport)),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(peer.events).toEqual([]);
    expect(readdirSync(profileHome)).toEqual([]);
  }),
);
