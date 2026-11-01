import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import type { ApplicationNetworkRequirements } from "@nodex/codex-app-server-protocol/v2/ApplicationNetworkRequirements";
import { RoutingRequirements } from "../codex/chatgpt-backend-routing";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { allowsBrowserSessionRequest } from "../browser/browser-session-request-policy";
import { BROWSER_SIDEBAR_PARTITION } from "../../shared/browser-sidebar";
import { MainConfig } from "../app/MainConfig";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { shouldGrantAppRendererPermission } from "../renderer-permissions";

export class SessionPolicyRuntime extends Context.Service<
  SessionPolicyRuntime,
  { readonly installed: true }
>()("nodex/main/host-runtime/SessionPolicyRuntime") {}

/** Installs the application and Browser partition policies before any user window exists. */
export const live: Layer.Layer<
  SessionPolicyRuntime,
  never,
  ElectronSessionHost | MainConfig | BrowserApplication | CodexGateway
> = Layer.effect(
  SessionPolicyRuntime,
  Effect.gen(function* () {
    const host = yield* ElectronSessionHost;
    const config = yield* MainConfig;
    const browser = yield* BrowserApplication;
    const gateway = yield* CodexGateway;
    const network = yield* Ref.make<ApplicationNetworkRequirements | null>(null);
    const refreshNetwork = Effect.suspend(() =>
      gateway.requestRawOnHost(gateway.localHostId, "configRequirements/read", {}),
    ).pipe(
      Effect.flatMap((value) => Schema.decodeUnknownEffect(RoutingRequirements)(value)),
      Effect.flatMap((value) => Ref.set(network, value.requirements?.application?.network ?? null)),
      Effect.catch(() =>
        Effect.logWarning("Could not refresh Browser application network requirements"),
      ),
    );
    yield* Stream.merge(
      gateway
        .connectionChanges(gateway.localHostId)
        .pipe(Stream.filter((connection) => connection.kind === "ready")),
      gateway.events.pipe(
        Stream.filter(
          (event) =>
            event.kind === "notification" &&
            event.hostId === gateway.localHostId &&
            event.value.method === "account/updated",
        ),
      ),
    ).pipe(
      Stream.runForEach(() => refreshNetwork),
      Effect.catch(() => Effect.logWarning("Browser network requirements observation ended")),
      Effect.forkScoped({ startImmediately: true }),
    );
    const appSession = yield* host.defaultSession;
    const browserSession = yield* host.fromPartition(BROWSER_SIDEBAR_PARTITION);

    yield* host.scopedRegistration(
      () => {
        appSession.setPermissionCheckHandler((webContents, permission, origin, details) =>
          shouldGrantAppRendererPermission({
            developmentOrigin: config.rendererUrl,
            hasOwnerWindow: host.hasOwnerWindow(webContents),
            permission,
            webContentsType: webContents?.getType() ?? null,
            isMainFrame: details.isMainFrame,
            requestingOrigin: origin,
            requestedMediaTypes: details.mediaType ? [details.mediaType] : undefined,
          }),
        );
        appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
          callback(
            shouldGrantAppRendererPermission({
              developmentOrigin: config.rendererUrl,
              hasOwnerWindow: host.hasOwnerWindow(webContents),
              permission,
              webContentsType: webContents.getType(),
              isMainFrame: details.isMainFrame,
              requestingOrigin: details.requestingUrl,
              requestedMediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
            }),
          );
        });
      },
      () => {
        appSession.setPermissionCheckHandler(null);
        appSession.setPermissionRequestHandler(null);
      },
    );
    yield* host.scopedRegistration(
      () => {
        browserSession.setPermissionCheckHandler(browser.permissions.check);
        browserSession.setPermissionRequestHandler(browser.permissions.request);
        browserSession.webRequest.onBeforeRequest((details, callback) => {
          const allowed = allowsBrowserSessionRequest({
            url: details.url,
            developmentOrigin: config.rendererUrl,
            network: Ref.getUnsafe(network),
          });
          const navigation =
            details.resourceType === "mainFrame" || details.resourceType === "subFrame";
          const restricted =
            navigation &&
            browser.guest.isNavigationRestricted(
              details.webContentsId,
              details.url,
              details.resourceType,
            );
          const routed =
            allowed &&
            !restricted &&
            details.resourceType === "mainFrame" &&
            browser.guest.routeNavigation(details.webContentsId, details.url);
          callback({ cancel: !allowed || restricted || routed });
        });
      },
      () => {
        browserSession.setPermissionCheckHandler(null);
        browserSession.setPermissionRequestHandler(null);
        browser.permissions.dispose();
        browserSession.webRequest.onBeforeRequest(null);
      },
    );

    return SessionPolicyRuntime.of({ installed: true });
  }),
);
