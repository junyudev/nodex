import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  session,
  type IpcMainEvent,
  type WebContents,
} from "electron";
import {
  makeMcpAppSandboxController,
  type McpAppSandboxHost,
  type McpAppSandboxHostOptions,
} from "../mcp-app/mcp-app-sandbox-host";
import { makeMcpAppSandboxProtocolCache } from "../mcp-app/mcp-app-sandbox-protocol";
import { MCP_APP_SANDBOX_GUEST_MESSAGE_CHANNEL } from "../../shared/mcp-app/mcp-app-sandbox-contract";

export type McpAppSandboxRuntimeOptions = Omit<
  McpAppSandboxHostOptions,
  "applicationName" | "locale" | "preferredSystemLanguages"
>;

export class McpAppSandboxRuntime extends Context.Service<
  McpAppSandboxRuntime,
  {
    readonly createHost: (owner: WebContents) => McpAppSandboxHost;
    readonly consumeUserGesture: (
      owner: WebContents,
      sandboxId: string,
      initId?: string,
    ) => boolean;
  }
>()("nodex/main/host-runtime/McpAppSandboxRuntime") {}

export const live = (options: McpAppSandboxRuntimeOptions): Layer.Layer<McpAppSandboxRuntime> =>
  Layer.effect(
    McpAppSandboxRuntime,
    Effect.gen(function* () {
      const hostOptions: McpAppSandboxHostOptions = {
        ...options,
        applicationName: app.getName(),
        locale: app.getLocale(),
        preferredSystemLanguages: app.getPreferredSystemLanguages(),
      };
      const protocolCache = yield* makeMcpAppSandboxProtocolCache(options.fetch ?? net.fetch);
      const runTimer = yield* FiberSet.makeRuntime();
      const controller = yield* makeMcpAppSandboxController(
        hostOptions,
        protocolCache,
        {
          schedule: (delayMs, task) => {
            const fiber = runTimer(
              Effect.sleep(Duration.millis(delayMs)).pipe(Effect.andThen(Effect.sync(task))),
            );
            return () => {
              void runTimer(Fiber.interrupt(fiber));
            };
          },
        },
        {
          defaultSession: session.defaultSession,
          fromPartition: (partition) => session.fromPartition(partition),
          onGuestMessage: (listener) => {
            const onMessage = listener as (event: IpcMainEvent, rawMessage: unknown) => void;
            ipcMain.on(MCP_APP_SANDBOX_GUEST_MESSAGE_CHANNEL, onMessage);
            return () => ipcMain.removeListener(MCP_APP_SANDBOX_GUEST_MESSAGE_CHANNEL, onMessage);
          },
          showGuestContextMenu: (owner, guest) => {
            Menu.buildFromTemplate([
              {
                label: "DevTools",
                click: () => {
                  if (guest.isDestroyed()) return;
                  guest.openDevTools({ mode: "detach" });
                },
              },
            ]).popup({
              window: BrowserWindow.fromWebContents(owner) ?? undefined,
            });
          },
        },
      );
      return McpAppSandboxRuntime.of({
        createHost: controller.createHost,
        consumeUserGesture: controller.consumeUserGesture,
      });
    }),
  );
