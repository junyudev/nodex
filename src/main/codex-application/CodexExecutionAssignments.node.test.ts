import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_EXECUTION_STATSIG_SDK_KEY,
  emptyCodexExecutionAssignmentValues,
  type CodexExecutionAssignmentsPublication,
} from "../../shared/codex-execution-assignments";
import {
  codexExecutionAssignmentsTestHelpers,
  matchesExecutionAssignmentsIdentity,
  readPermissionRefreshFromPublication,
  readReadyExecutionAssignmentsFromPublication,
  type CurrentExecutionIdentity,
} from "./CodexExecutionAssignments";

const chatGptIdentity: CurrentExecutionIdentity = {
  principal: { userId: "user-1", accountId: "account-1" },
  authMethod: "chatgpt",
  unauthenticatedStableId: null,
};

const publication = (
  overrides: Partial<CodexExecutionAssignmentsPublication> = {},
): CodexExecutionAssignmentsPublication => ({
  userId: "user-1",
  accountId: "account-1",
  authMethod: "chatgpt",
  stableId: "stable-1",
  sdkKey: CODEX_EXECUTION_STATSIG_SDK_KEY,
  payload: JSON.stringify({
    user: {
      userID: "user-1",
      customIDs: { account_id: "account-1", stableID: "stable-1" },
      custom: { auth_method: "chatgpt" },
    },
  }),
  defaultEnableFeatures: {},
  executionValues: { ...emptyCodexExecutionAssignmentValues(), permissionRefresh: true },
  ...overrides,
});

describe("CodexExecutionAssignments", () => {
  test("matches authenticated, non-ChatGPT, and unauthenticated identities independently", () => {
    expect(matchesExecutionAssignmentsIdentity(publication(), chatGptIdentity)).toBe(true);
    expect(
      matchesExecutionAssignmentsIdentity(
        publication({ userId: null, accountId: null, authMethod: "apiKey", stableId: "stable-1" }),
        { principal: null, authMethod: "apiKey", unauthenticatedStableId: null },
      ),
    ).toBe(true);
    expect(
      matchesExecutionAssignmentsIdentity(
        publication({ userId: null, accountId: null, authMethod: null, stableId: "stable-1" }),
        { principal: null, authMethod: null, unauthenticatedStableId: "stable-1" },
      ),
    ).toBe(true);
  });

  test("never reuses assignments from a previous authenticated account", () => {
    expect(
      readPermissionRefreshFromPublication(publication(), {
        principal: { userId: "user-2", accountId: "account-2" },
        authMethod: "chatgpt",
        unauthenticatedStableId: null,
      }),
    ).toBeNull();
  });

  test("preserves loading, ready-empty, false, and true states", () => {
    expect(
      readPermissionRefreshFromPublication(publication({ payload: undefined }), chatGptIdentity),
    ).toBeNull();
    expect(
      readPermissionRefreshFromPublication(publication({ payload: null }), chatGptIdentity),
    ).toBe(false);
    expect(
      readPermissionRefreshFromPublication(
        publication({
          executionValues: { ...emptyCodexExecutionAssignmentValues(), permissionRefresh: false },
        }),
        chatGptIdentity,
      ),
    ).toBe(false);
    expect(readPermissionRefreshFromPublication(publication(), chatGptIdentity)).toBe(true);
  });

  test("rejects a ready payload whose embedded evaluation user does not match its publication", () => {
    expect(
      readPermissionRefreshFromPublication(
        publication({
          payload: JSON.stringify({
            user: {
              userID: "user-2",
              customIDs: { account_id: "account-2", stableID: "stable-1" },
              custom: { auth_method: "chatgpt" },
            },
          }),
        }),
        chatGptIdentity,
      ),
    ).toBeNull();
  });

  test("materializes ready-null publications as ready empty execution assignments", () => {
    expect(
      readReadyExecutionAssignmentsFromPublication(
        publication({
          payload: null,
          defaultEnableFeatures: undefined,
          executionValues: undefined,
        }),
        chatGptIdentity,
        "0.150.0",
      ),
    ).toEqual({
      identity: {
        userId: "user-1",
        accountId: "account-1",
        authMethod: "chatgpt",
        stableId: "stable-1",
      },
      values: emptyCodexExecutionAssignmentValues(),
      defaultEnableFeatures: {},
    });
  });

  test("applies the guardian experiment only when its app-server version gate is satisfied", () => {
    const source = publication({
      defaultEnableFeatures: { guardianv2: { enabled: true, nested: { a: 1 } } },
      executionValues: {
        ...emptyCodexExecutionAssignmentValues(),
        guardianV2Experiment: {
          min_app_server_version: "0.150.0",
          config: { nested: { b: 2 }, mode: "strict" },
        },
      },
    });
    expect(
      readReadyExecutionAssignmentsFromPublication(source, chatGptIdentity, "0.149.0")
        ?.defaultEnableFeatures,
    ).toEqual({ guardianv2: { enabled: true, nested: { a: 1 } } });
    expect(
      readReadyExecutionAssignmentsFromPublication(source, chatGptIdentity, "0.150.0")
        ?.defaultEnableFeatures,
    ).toEqual({
      guardianv2: { enabled: true, nested: { a: 1, b: 2 }, mode: "strict" },
    });
  });

  test("rejects malformed ready publications instead of partially trusting execution values", () => {
    expect(
      readReadyExecutionAssignmentsFromPublication(
        publication({ executionValues: undefined }),
        chatGptIdentity,
        "0.150.0",
      ),
    ).toBeNull();
    expect(
      readReadyExecutionAssignmentsFromPublication(
        publication({ sdkKey: "different-sdk-key" }),
        chatGptIdentity,
        "0.150.0",
      ),
    ).toBeNull();
  });

  test("persists the stable id in the Statsig user-data state using the native key", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "nodex-statsig-state-"));
    try {
      const statePath = join(userDataPath, codexExecutionAssignmentsTestHelpers.statsigStateFile);
      writeFileSync(statePath, JSON.stringify({ preserved: true }), "utf8");
      const stableId = codexExecutionAssignmentsTestHelpers.readOrCreateStableId(userDataPath);
      expect(codexExecutionAssignmentsTestHelpers.readOrCreateStableId(userDataPath)).toBe(
        stableId,
      );
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
        preserved: true,
        [codexExecutionAssignmentsTestHelpers.statsigStableIdKey]: stableId,
      });
      expect(codexExecutionAssignmentsTestHelpers.statsigStableIdKey).toBe("statsig-stable-id");
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });
});
