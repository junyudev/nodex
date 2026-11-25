import { describe, expect, it, test, afterEach } from "vite-plus/test";
import {
  generatedStringDiscriminatorValues,
  parseCodexAppServerMessage,
} from "./codex-app-server-message-parser";
import {
  buildChatGptDesktopUserAgent,
  CHATGPT_DESKTOP_ORIGINATOR,
  extractChatGptAccountIdFromAuthToken,
  requestChatGptDesktop,
} from "./chatgpt-desktop-request";
import path from "node:path";
import { join } from "node:path";
import { resolveCodexHome } from "./codex-home";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { CODEX_FEATURE_DEFAULTS, codexFeatureDefaultLaunchArgs } from "./codex-feature-defaults";
import { agentImportInternals } from "./agent-import-operations";

describe("Codex app-server message parser", () => {
  it("validates native promotion identity without changing its wire fields", () => {
    for (const method of ["thread/realtime/item/started", "thread/realtime/item/completed"]) {
      const parsed = parseCodexAppServerMessage({
        method,
        params: {
          threadId: "thread",
          item: {
            type: "bemItemPromoted",
            id: "receipt",
            realtimeSessionId: "session",
            turnId: "turn",
            itemId: "artifact",
            presentation: { type: "wholeItem" },
          },
        },
      });
      expect(parsed).toEqual({
        success: true,
        data: {
          kind: "notification",
          notification: {
            method,
            params: {
              threadId: "thread",
              item: {
                type: "bemItemPromoted",
                id: "receipt",
                realtimeSessionId: "session",
                turnId: "turn",
                itemId: "artifact",
                presentation: { type: "wholeItem" },
              },
            },
          },
        },
      });
      expect(
        parseCodexAppServerMessage({
          method,
          params: {
            threadId: "thread",
            item: {
              type: "bemItemPromoted",
              id: "receipt",
              realtimeSessionId: "session",
              turnId: "turn",
              itemId: 3,
              presentation: { type: "wholeItem" },
            },
          },
        }).success,
      ).toBe(false);
    }
    const raw = { type: "bemItemPromoted", item_id: "raw", turn_id: "turn" };
    expect(
      parseCodexAppServerMessage({
        method: "thread/realtime/itemAdded",
        params: { threadId: "thread", item: raw },
      }),
    ).toEqual({
      success: true,
      data: {
        kind: "notification",
        notification: {
          method: "thread/realtime/itemAdded",
          params: { threadId: "thread", item: raw },
        },
      },
    });
  });
  it("preserves a valid generated notification as a discriminated object", () => {
    const result = parseCodexAppServerMessage({
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: null,
        plan: [{ step: "Implement", status: "inProgress" }],
      },
    });

    expect(result).toEqual({
      success: true,
      data: {
        kind: "notification",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: null,
            plan: [{ step: "Implement", status: "inProgress" }],
          },
        },
      },
    });
  });

  it("rejects known notifications and requests with mismatched params", () => {
    expect(
      parseCodexAppServerMessage({
        method: "turn/plan/updated",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server notification 'turn/plan/updated'.",
    });

    expect(
      parseCodexAppServerMessage({
        id: 1,
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server request 'item/commandExecution/requestApproval'.",
    });
  });

  it("validates explicit private requests separately", () => {
    const valid = parseCodexAppServerMessage({
      id: "private-1",
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        question: "Choose",
        options: [{ label: "A" }],
      },
    });
    expect(valid.success && valid.data.kind).toBe("request");

    expect(
      parseCodexAppServerMessage({
        id: "private-2",
        method: "item/tool/requestOptionPicker",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({
      success: false,
      error: "Invalid params for Codex server request 'item/tool/requestOptionPicker'.",
    });

    const userVerification = parseCodexAppServerMessage({
      id: "private-mcp-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "browser-use",
        mode: "openai/userVerification",
        _meta: { verificationUrl: "https://example.com" },
      },
    });
    expect(userVerification).toEqual({
      success: true,
      data: {
        kind: "request",
        request: {
          id: "private-mcp-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "browser-use",
            mode: "openai/userVerification",
            _meta: { verificationUrl: "https://example.com" },
          },
        },
      },
    });
  });

  it("classifies unknown server requests so the client can send method-not-found", () => {
    expect(
      parseCodexAppServerMessage({
        id: 99,
        method: "future/request",
        params: { value: true },
      }),
    ).toEqual({
      success: true,
      data: {
        kind: "unknownRequest",
        request: { id: 99, method: "future/request", params: { value: true } },
      },
    });
  });

  it("requires exactly one response payload", () => {
    expect(parseCodexAppServerMessage({ id: 1, result: { ok: true } }).success).toBe(true);
    expect(
      parseCodexAppServerMessage({
        id: 2,
        error: { code: -32000, message: "no" },
      }).success,
    ).toBe(true);
    expect(parseCodexAppServerMessage({ id: 3 })).toEqual({
      success: false,
      error: "Invalid JSON-RPC envelope from codex app-server.",
    });
    expect(
      parseCodexAppServerMessage({
        id: 4,
        result: {},
        error: { code: -32000, message: "ambiguous" },
      }),
    ).toEqual({
      success: false,
      error: "Codex JSON-RPC response must contain exactly one of result or error.",
    });
  });

  it("collects generated discriminator enums without a handwritten method list", () => {
    expect(
      generatedStringDiscriminatorValues(
        {
          anyOf: [
            { properties: { method: { enum: ["one"] } } },
            { properties: { method: { const: "two" } } },
          ],
        },
        "method",
      ),
    ).toEqual(new Set(["one", "two"]));
  });
});

describe("chatgpt-desktop-request", () => {
  function buildAuthToken(accountId = "acct_123"): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
        },
      }),
    ).toString("base64url");
    return `${header}.${payload}.signature`;
  }

  describe("chatgpt desktop request helper", () => {
    test("injects desktop auth headers and preserves caller headers", async () => {
      const authToken = buildAuthToken("acct_abc");
      let capturedUrl = "";
      let capturedInit: RequestInit | null = null;

      const response = await requestChatGptDesktop(
        {
          readAuthStatus: async () => ({
            authMethod: "chatgpt",
            authToken,
            requiresOpenaiAuth: false,
          }),
          fetchImpl: async (url, init) => {
            capturedUrl = url;
            capturedInit = init;
            return new Response("{}", { status: 200 });
          },
          getAppVersion: () => "0.1.8",
        },
        {
          action: "transcribe audio",
          baseUrl: "https://chatgpt.com/backend-api/",
          path: "/transcribe",
          method: "POST",
          headers: {
            "Content-Type": "multipart/form-data; boundary=test",
            "X-Codex-Base64": "1",
          },
          body: "cGF5bG9hZA==",
        },
      );

      expect(response.status).toBe(200);
      expect(capturedUrl).toBe("https://chatgpt.com/backend-api/transcribe");

      if (!capturedInit) {
        throw new Error("Expected fetch init");
      }

      const fetchInit = capturedInit as RequestInit;
      const headers = new Headers(fetchInit.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${authToken}`);
      expect(headers.get("ChatGPT-Account-Id")).toBe("acct_abc");
      expect(headers.get("originator")).toBe(CHATGPT_DESKTOP_ORIGINATOR);
      expect(headers.get("User-Agent")).toBe(buildChatGptDesktopUserAgent("0.1.8"));
      expect(headers.get("Content-Type")).toBe("multipart/form-data; boundary=test");
      expect(headers.get("X-Codex-Base64")).toBe(null);

      const bodyBytes = new Uint8Array(await new Response(fetchInit.body).arrayBuffer());
      expect(Buffer.from(bodyBytes).toString("utf8")).toBe("payload");
    });

    test("decodes X-Codex-Base64 request bodies before fetch", async () => {
      let capturedInit: RequestInit | null = null;

      await requestChatGptDesktop(
        {
          readAuthStatus: async () => ({
            authMethod: "chatgpt",
            authToken: buildAuthToken(),
            requiresOpenaiAuth: false,
          }),
          fetchImpl: async (_url, init) => {
            capturedInit = init;
            return new Response("{}", { status: 200 });
          },
          getAppVersion: () => "0.1.8",
        },
        {
          action: "transcribe audio",
          baseUrl: "https://chatgpt.com/backend-api",
          path: "/transcribe",
          method: "POST",
          headers: {
            "Content-Type": "multipart/form-data; boundary=test",
            "X-Codex-Base64": "1",
          },
          body: "YmFzZTY0LXBheWxvYWQ=",
        },
      );

      if (!capturedInit) {
        throw new Error("Expected fetch init");
      }

      const fetchInit = capturedInit as RequestInit;
      const headers = new Headers(fetchInit.headers);
      expect(headers.get("X-Codex-Base64")).toBe(null);
      const bodyBytes = new Uint8Array(await new Response(fetchInit.body).arrayBuffer());
      expect(Buffer.from(bodyBytes).toString("utf8")).toBe("base64-payload");
    });

    test("retries once with a refreshed token after a 401", async () => {
      const refreshFlags: boolean[] = [];
      const seenAuthorizations: string[] = [];

      const response = await requestChatGptDesktop(
        {
          readAuthStatus: async ({ refreshToken }) => {
            refreshFlags.push(refreshToken);
            return {
              authMethod: "chatgpt",
              authToken: refreshToken
                ? buildAuthToken("acct_second")
                : buildAuthToken("acct_first"),
              requiresOpenaiAuth: false,
            };
          },
          fetchImpl: async (_url, init) => {
            const headers = new Headers(init.headers);
            seenAuthorizations.push(headers.get("Authorization") ?? "");
            return seenAuthorizations.length === 1
              ? new Response("unauthorized", { status: 401 })
              : new Response("{}", { status: 200 });
          },
          getAppVersion: () => "0.1.8",
        },
        {
          action: "transcribe audio",
          baseUrl: "https://chatgpt.com/backend-api",
          path: "/transcribe",
          method: "POST",
        },
      );

      expect(response.status).toBe(200);
      expect(refreshFlags.join(",")).toBe("false,true");
      expect(seenAuthorizations.length).toBe(2);
      expect(seenAuthorizations[0]?.includes("acct_first")).toBe(false);
      expect(seenAuthorizations[1]?.includes("acct_second")).toBe(false);
    });

    test("does not retry a 403 response", async () => {
      let fetchCallCount = 0;
      const response = await requestChatGptDesktop(
        {
          readAuthStatus: async () => ({
            authMethod: "chatgpt",
            authToken: buildAuthToken(),
            requiresOpenaiAuth: false,
          }),
          fetchImpl: async () => {
            fetchCallCount += 1;
            return new Response("forbidden", { status: 403 });
          },
          getAppVersion: () => "0.1.8",
        },
        {
          action: "transcribe audio",
          baseUrl: "https://chatgpt.com/backend-api",
          path: "/transcribe",
          method: "POST",
        },
      );

      expect(response.status).toBe(403);
      expect(fetchCallCount).toBe(1);
    });

    test("throws the caller-provided auth error when chatgpt auth is unavailable", async () => {
      let didThrow = false;

      try {
        await requestChatGptDesktop(
          {
            readAuthStatus: async () => ({
              authMethod: "apikey",
              authToken: null,
              requiresOpenaiAuth: false,
            }),
            fetchImpl: async () => new Response("{}", { status: 200 }),
            getAppVersion: () => "0.1.8",
          },
          {
            action: "transcribe audio",
            baseUrl: "https://chatgpt.com/backend-api",
            path: "/transcribe",
            method: "POST",
            missingAuthErrorMessage: "ChatGPT authentication is required for dictation.",
          },
        );
      } catch (error) {
        didThrow = true;
        expect((error as Error).message).toBe("ChatGPT authentication is required for dictation.");
      }

      expect(didThrow).toBe(true);
    });

    test("extracts the ChatGPT account id from a JWT payload", () => {
      expect(extractChatGptAccountIdFromAuthToken(buildAuthToken("acct_xyz"))).toBe("acct_xyz");
      expect(extractChatGptAccountIdFromAuthToken("not-a-token")).toBe(null);
    });
  });
});

describe("native Codex home selection", () => {
  it("selects the configured home before an inherited home and expands the user directory", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ~/work-codex ",
        environment: { CODEX_HOME: path.resolve("/host/inherited") },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "~/work-codex",
      resolvedHomePath: path.resolve("/host/user/work-codex"),
      source: "settings",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("inherits CODEX_HOME when the Profile override is empty", () => {
    expect(
      resolveCodexHome({
        configuredHome: " ",
        environment: { CODEX_HOME: " /host/inherited/../codex " },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/codex"),
      source: "environment",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("uses the native user home when neither override selects a directory", () => {
    expect(
      resolveCodexHome({
        environment: { CODEX_HOME: " " },
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/user/.codex"),
      source: "default",
      accountHomePath: "",
      resolvedAccountHomePath: null,
    });
  });

  it("selects account credentials without changing shared native history identity", () => {
    expect(
      resolveCodexHome({
        configuredAccountHome: " ~/codex-personal ",
        environment: {},
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toEqual({
      homePath: "",
      resolvedHomePath: path.resolve("/host/user/.codex"),
      source: "default",
      accountHomePath: "~/codex-personal",
      resolvedAccountHomePath: path.resolve("/host/user/codex-personal"),
    });
    expect(() =>
      resolveCodexHome({
        configuredAccountHome: "relative/account",
        environment: {},
        homeDirectory: path.resolve("/host/user"),
      }),
    ).toThrow("Codex account directory must be an absolute path or start with ~/.");
  });

  it.each([
    { configuredHome: "relative/codex", environment: {} },
    { configuredHome: "", environment: { CODEX_HOME: "relative/codex" } },
  ])("rejects a relative home instead of silently selecting another account: %j", (input) => {
    expect(() => resolveCodexHome({ ...input, homeDirectory: path.resolve("/host/user") })).toThrow(
      "Codex home must be an absolute path or start with ~/.",
    );
  });
});

describe("codex-feature-defaults", () => {
  const temporaryHomes: string[] = [];
  async function createTemporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "nodex-codex-feature-defaults-"));
    temporaryHomes.push(home);
    return home;
  }
  afterEach(async () => {
    await Promise.all(
      temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  describe("Codex feature launch defaults", () => {
    test("supplies supported defaults without creating native configuration", async () => {
      const home = await createTemporaryHome();
      const args = await codexFeatureDefaultLaunchArgs(home);
      expect(args).toEqual(
        Object.keys(CODEX_FEATURE_DEFAULTS).flatMap((feature) => [
          "-c",
          `features.${feature}=true`,
        ]),
      );
      await expect(stat(join(home, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    });
    test("preserves explicit choices and all native configuration bytes", async () => {
      const home = await createTemporaryHome();
      const configPath = join(home, "config.toml");
      const source =
        '# User configuration\nmodel = "native-model"\n\n[features]\nunified_exec = false\nprevent_idle_sleep = false\ncustom_feature = true\n';
      await writeFile(configPath, source);
      expect(await codexFeatureDefaultLaunchArgs(home)).toEqual([
        "-c",
        "features.shell_snapshot=true",
        "-c",
        "features.multi_agent=true",
        "-c",
        "features.respect_system_proxy=true",
      ]);
      expect(await readFile(configPath, "utf8")).toBe(source);
    });
    test("normalizes older integer defaults only in the process overrides", async () => {
      const home = await createTemporaryHome();
      const configPath = join(home, "config.toml");
      const source =
        "[features.multi_agent_v2]\nmax_concurrent_threads_per_session = 4.0\nmin_wait_timeout_ms = 10000\n";
      await writeFile(configPath, source);
      const args = await codexFeatureDefaultLaunchArgs(home);
      expect(args).toContain("features.multi_agent_v2.max_concurrent_threads_per_session=4");
      expect(args).toContain("features.multi_agent_v2.min_wait_timeout_ms=10000");
      expect(await readFile(configPath, "utf8")).toBe(source);
    });
    test("rejects malformed native configuration without overwriting it", async () => {
      const home = await createTemporaryHome();
      const configPath = join(home, "config.toml");
      const source = 'features = "invalid"\n';
      await writeFile(configPath, source);
      await expect(codexFeatureDefaultLaunchArgs(home)).rejects.toThrow(
        "Codex config [features] must be a TOML table",
      );
      expect(await readFile(configPath, "utf8")).toBe(source);
    });
  });
});

describe("agent import config policy", () => {
  test("keeps only absent, passive config keys", () => {
    const edits = agentImportInternals.buildSafeConfigEdits(
      {
        approval_policy: "never",
        features: { search: true },
        model: "private-model",
        notify: ["private-command"],
        web_search: "live",
      },
      { features: { search: false } },
    );
    expect(edits).toEqual([{ keyPath: "web_search", label: "web_search", value: "live" }]);
  });

  test("removes credentials when translating MCP servers", () => {
    const edits = agentImportInternals.buildMcpConfigEdits(
      {
        mcp_servers: {
          docs: {
            command: "docs-server",
            env: { API_KEY: "must-be-reauthorized" },
          },
        },
      },
      {},
    );
    expect(edits).toEqual([
      {
        keyPath: "mcp_servers",
        label: "docs",
        value: { docs: { command: "docs-server" } },
      },
    ]);
  });
});
