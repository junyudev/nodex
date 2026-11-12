import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { makeAgentPluginReader } from "../../../host/agent-plugins/AgentPluginReader";
import { packageFilesNode } from "../../../host/agent-plugins/PackageFilesNode";
import {
  makePluginInstallation,
  PluginInstallation,
} from "../../../host/agent-plugins/PluginInstallation";
import { makePluginInstallationStoreNode } from "../../../host/agent-plugins/PluginInstallationStoreNode";
import type { PluginProject } from "../../../shared/agent-plugins/installation-registry";
import {
  PORTABLE_1_0_MANIFEST_SCHEMA,
  PORTABLE_1_0_MCP_SCHEMA,
} from "../../../shared/agent-plugins/portable-1.0.0";
import { testLayer } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { live } from "./AgentPluginsIpc";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  BrowserWindow: { fromWebContents: () => ({}) },
}));

function sender(type = "window") {
  const frame = { url: "http://localhost:5173/?spaceId=team" };
  return {
    sender: { getType: () => type, mainFrame: frame },
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
}

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;

it.effect(
  "validates Agent Plugin requests and admits activation only for a Project in the sender Space",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-agent-plugin-ipc-"))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const plugins = makePluginInstallation(
        makeAgentPluginReader(packageFilesNode),
        makePluginInstallationStoreNode(home),
        randomUUID,
      );
      const projectIsActive = vi.fn(({ spaceId, projectId }: PluginProject) =>
        Effect.succeed(spaceId === "team" && projectId === "active"),
      );
      yield* Layer.build(
        live({ personalSpaceId: "personal", projectIsActive }).pipe(
          Layer.provide(
            Layer.mergeAll(
              testLayer({ rendererUrl: "http://localhost:5173" }),
              Layer.succeed(PluginInstallation, plugins),
              Layer.succeed(ElectronDesktop, { dialog: {} } as ElectronDesktop["Service"]),
              Layer.succeed(ElectronWindowHost, {
                all: Effect.succeed([]),
                destroyAll: Effect.void,
                fromWebContents: () => Effect.succeed(null),
                onCreated: () => Effect.void,
              }),
              Layer.succeed(
                ElectronIpc,
                makeTestElectronIpc({
                  handle: (channel: string, handler: Handler) =>
                    Effect.sync(() => {
                      handlers.set(channel, handler);
                    }),
                  on: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      );
      const invoke = (channel: string, input: unknown, event = sender()) =>
        handlers.get("agent-plugins:" + channel)!(event, input);
      const id = "a".repeat(64);
      for (const [channel, raw] of [
        ["list", {}],
        ["list", { projectId: " " }],
        ["preview", { directory: "./plugin" }],
        ["preview", { directory: join(home, "bad\0folder") }],
        ["install", { directory: home }],
        ["install", { directory: home, previewDigest: "bad" }],
        ["reload", { id: "../../outside" }],
        ["set-project-enabled", { id, projectId: "active", enabled: "true" }],
        ["set-project-enabled", { id, projectId: "active", spaceId: "personal", enabled: true }],
        ["uninstall", { id }],
        ["uninstall", { id, data: "purge" }],
      ] as const) {
        expect(yield* invoke(channel, raw), channel).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
      }
      expect(yield* invoke("list", { projectId: null }, sender("webview"))).toMatchObject({
        ok: false,
        error: { code: "policy_denied" },
      });
      expect(
        yield* invoke("set-project-enabled", { id, projectId: "archived", enabled: true }),
      ).toMatchObject({
        ok: false,
        error: { code: "invalid-project" },
      });
      expect(yield* invoke("list", { projectId: "active" })).toEqual({
        ok: true,
        value: { installations: [], writerStatus: "clear" },
      });
      const directory = join(home, "source");
      yield* Effect.promise(async () => {
        await mkdir(directory);
        await writeFile(
          join(directory, "plugin.json"),
          JSON.stringify({ $schema: PORTABLE_1_0_MANIFEST_SCHEMA, name: "example.review" }),
        );
        await writeFile(
          join(directory, "mcp.json"),
          JSON.stringify({
            $schema: PORTABLE_1_0_MCP_SCHEMA,
            mcpServers: {
              example: {
                type: "streamable-http",
                url: "https://example.test/mcp?token=example-token",
                headers: { Authorization: "Bearer example-secret" },
              },
            },
          }),
        );
      });
      const review = yield* invoke("preview", { directory });
      expect(review).toMatchObject({
        ok: true,
        value: {
          status: "loaded",
          package: {
            digest: /^[a-f0-9]{64}$/,
            mcpServers: [
              {
                key: "example",
                transport: { type: "streamable-http", url: "https://example.test/mcp" },
                configuration: ["Authorization"],
              },
            ],
          },
        },
      });
      expect(JSON.stringify(review)).not.toMatch(/example-token|example-secret/);
      expect((yield* plugins.list).installations).toEqual([]);
      expect(projectIsActive.mock.calls).toEqual([
        [{ spaceId: "team", projectId: "archived" }],
        [{ spaceId: "team", projectId: "active" }],
      ]);
    }).pipe(Effect.scoped),
);
