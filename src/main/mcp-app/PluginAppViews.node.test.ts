import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { makeAgentPluginReader } from "../../host/agent-plugins/AgentPluginReader";
import { makePluginMcpBroker } from "../../host/agent-plugins/broker";
import { packageFilesNode } from "../../host/agent-plugins/PackageFilesNode";
import type { PluginAppBinding } from "../../shared/agent-plugins/app-entrypoints";
import type { CatalogPlugin } from "../../host/agent-plugins/PluginCatalog";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type { PluginMcpLeaseScope } from "../../shared/agent-plugins/mcp-lease";
import type { PluginAppViewEvent } from "../../shared/agent-plugins/ipc";
import { readWorkspaceFileBinary } from "../workspace-files-service";
import { makePluginAppViews } from "./PluginAppViews";

const root = fileURLToPath(
  new URL("../../host/agent-plugins/fixtures/workbench-app/", import.meta.url),
);
const project = { spaceId: "space", projectId: "field" };
const pluginId = "workbench-field-notes@nodex-local";

it.live(
  "launches all three fixture placements and revokes its single-file grant with the broker lease",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dataRoot = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-plugin-app-"))),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const plugin = yield* makeAgentPluginReader(packageFilesNode).read(root);
        if (plugin.status !== "loaded") throw new Error("Fixture could not be loaded");
        const broker = yield* makePluginMcpBroker({
          executableSearchPath: [dirname(process.execPath)],
          resolveHeaders: () => Effect.succeed({}),
        });
        const pluginEntry: CatalogPlugin = {
          id: pluginId,
          scope: { kind: "projects", projectIds: [project.projectId] },
          root,
          package: plugin.package,
        };
        let entries: readonly CatalogPlugin[] = [pluginEntry];
        const changes = yield* PubSub.unbounded<void>();
        const scopes: PluginMcpLeaseScope[] = [];
        const file = { hostId: "local", path: join(dataRoot, "weather.fieldnote") };
        yield* Effect.promise(() => writeFile(file.path, "Clear skies"));
        const changed = yield* Deferred.make<PluginAppViewEvent>();
        const revoked = yield* Deferred.make<PluginAppViewEvent>();
        let watchedViewId: string | undefined;
        const owner = {
          windowId: 1,
          generation: "renderer",
          spaceId: project.spaceId,
          emit: (event: PluginAppViewEvent) => {
            if (event.kind === "revoked" && event.viewId !== watchedViewId) return;
            Deferred.doneUnsafe(
              event.kind === "revoked" ? revoked : changed,
              Effect.succeed(event),
            );
          },
        };
        const views = yield* makePluginAppViews({
          broker: {
            ...broker,
            openLease: (scope, ...args) => {
              scopes.push(scope);
              return broker.openLease(scope, ...args);
            },
          },
          files: {
            binary: (input) =>
              Effect.tryPromise(() => readWorkspaceFileBinary(input)).pipe(Effect.orDie),
          },
          home: dataRoot,
          catalog: () => Effect.sync(() => entries),
          changes: Stream.fromPubSub(changes),
          sessionIsInProject: (sessionId, projectId) =>
            Effect.succeed(sessionId === "chat" && projectId === project.projectId),
          ownerIsCurrent: () => true,
          projectIsActive: () => Effect.succeed(true),
        });
        const catalog = yield* views.list(project);
        expect(catalog.map(({ entry }) => entry.kind)).toEqual(["global", "thread", "file"]);
        expect(yield* views.list({ ...project, projectId: "other" })).toEqual([]);
        expect(yield* views.list({ ...project, projectId: null })).toEqual([]);
        entries = [{ ...pluginEntry, scope: { kind: "all" } }];
        expect(
          (yield* views.list({ ...project, projectId: null })).map(({ entry }) => entry.kind),
        ).toEqual(["global", "thread", "file"]);
        entries = [pluginEntry];
        const global = {
          kind: "global",
          projectId: project.projectId,
          pluginId,
          entryId: '["notes","open_notes","global"]',
        } satisfies PluginAppBinding;
        const globalView = yield* views.open(owner, global);
        expect(globalView.toolInput).toEqual({});
        expect(globalView.toolResult).toMatchObject({ structuredContent: { received: {} } });
        expect(globalView.resource.html).toContain("Field Notes");
        yield* views.close(owner, globalView.viewId);

        const thread = {
          ...global,
          kind: "thread",
          sessionId: "chat",
          entryId: '["notes","open_notes","thread"]',
        } as const;
        expect(
          yield* Effect.flip(views.open(owner, { ...thread, sessionId: "other" })),
        ).toMatchObject({ code: "app_unavailable" });
        const threadView = yield* views.open(owner, thread);
        watchedViewId = threadView.viewId;
        expect(threadView.toolInput).toEqual({});
        expect(scopes.at(-1)).toMatchObject({
          project,
          pluginId,
          principal: { kind: "interface-view", id: threadView.viewId, sessionId: "chat" },
        });
        entries = [{ ...pluginEntry, scope: { kind: "projects", projectIds: ["other"] } }];
        yield* PubSub.publish(changes, undefined);
        expect(yield* Deferred.await(revoked).pipe(Effect.timeout("3 seconds"))).toMatchObject({
          kind: "revoked",
          viewId: threadView.viewId,
        });
        entries = [pluginEntry];
        const binding = {
          ...global,
          kind: "file",
          entryId: '["notes","open_notes","file"]',
          file,
        } as const;
        const launch = yield* views.open(owner, binding);
        const uri = launch.toolInput.file?.resourceUri;
        expect(uri).toMatch(/^host-resource:\/\/[a-f0-9-]+$/u);
        expect(launch.toolInput).toEqual({ file: { name: "weather.fieldnote", resourceUri: uri } });
        expect(launch.toolResult).toMatchObject({
          structuredContent: { received: launch.toolInput },
        });
        const request = (method: string, params: unknown) =>
          views.request(owner, launch.viewId, method, params);
        const text = yield* request("resources/read", {
          uri,
          _meta: { "openai/resource": { representation: "text" } },
        });
        expect(text).toMatchObject({
          contents: [
            { uri, text: "Clear skies", _meta: { "openai/resource": { writable: false } } },
          ],
        });
        expect(yield* request("resources/read", { uri })).toMatchObject({
          contents: [{ uri, blob: Buffer.from("Clear skies").toString("base64") }],
        });
        for (const method of ["resources/read", "resources/subscribe", "resources/unsubscribe"]) {
          expect(
            yield* Effect.flip(request(method, { uri: "file:///another.fieldnote" })),
          ).toMatchObject({ code: "resource_not_granted" });
        }
        expect(
          yield* Effect.flip(request("openai/resources/write", { uri, text: "Cloudy" })),
        ).toMatchObject({ code: "unsupported" });
        expect(
          yield* Effect.flip(
            views.request({ ...owner, generation: "next" }, launch.viewId, "resources/read", {
              uri,
            }),
          ),
        ).toMatchObject({ code: "app_unavailable" });

        yield* request("resources/subscribe", { uri });
        yield* Effect.promise(() => writeFile(file.path, "Light clouds"));
        expect(yield* Deferred.await(changed).pipe(Effect.timeout("3 seconds"))).toMatchObject({
          kind: "resource-updated",
          viewId: launch.viewId,
          uri,
        });
        yield* request("resources/unsubscribe", { uri });

        // Disable the installation while a view is live.
        entries = [];
        yield* PubSub.publish(changes, undefined);
        expect(yield* Effect.flip(request("resources/read", { uri }))).toMatchObject({
          code: "app_unavailable",
        });
        expect(yield* Effect.flip(views.open(owner, binding))).toMatchObject({
          code: "app_unavailable",
        });
      }),
    ),
);
