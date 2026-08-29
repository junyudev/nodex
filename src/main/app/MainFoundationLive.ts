import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { BrowserProfileHelperPlatform } from "../browser/browser-profile-helper-client";
import * as ElectronApp from "../platform/electron/ElectronApp";
import * as ElectronDesktop from "../platform/electron/ElectronDesktop";
import * as ElectronIpc from "../platform/electron/ElectronIpc";
import * as ElectronSessionHost from "../platform/electron/ElectronSessionHost";
import * as ElectronWindowHost from "../platform/electron/ElectronWindowHost";
import * as BrowserProfileHelperNode from "../platform/node/BrowserProfileHelperNode";
import * as ApplicationSettings from "../settings/ApplicationSettings";
import * as ProfileAssets from "../local-store/ProfileAssets";
import * as MainConfig from "./MainConfig";
import * as MainCleanup from "./MainCleanup";
import * as MainObservability from "./MainObservability";
import * as MainShutdown from "./MainShutdown";
import * as ScopedCallbackRuntime from "./ScopedCallbackRuntime";

export type MainFoundation =
  | MainConfig.MainConfig
  | MainCleanup.MainCleanup
  | MainObservability.MainObservability
  | MainShutdown.MainShutdown
  | ScopedCallbackRuntime.ScopedCallbackRuntime
  | ElectronApp.ElectronApp
  | ElectronDesktop.ElectronDesktop
  | ElectronIpc.ElectronIpc
  | ElectronIpc.ElectronSyncIpc
  | ElectronSessionHost.ElectronSessionHost
  | ElectronWindowHost.ElectronWindowHost
  | BrowserProfileHelperPlatform
  | ApplicationSettings.ApplicationSettings
  | ProfileAssets.ProfileAssets
  | NodeServices.NodeServices;

const electronPlatform = Layer.mergeAll(
  ElectronApp.live,
  ElectronDesktop.live,
  ElectronIpc.live,
  ElectronSessionHost.live,
  ElectronWindowHost.live,
);

const nodePlatform = BrowserProfileHelperNode.live.pipe(Layer.provideMerge(NodeServices.layer));

export const make = (config: unknown): Layer.Layer<MainFoundation, MainConfig.MainConfigError> => {
  const base = Layer.mergeAll(
    MainConfig.layer(config),
    MainCleanup.layer,
    MainObservability.layer,
    MainShutdown.layer,
    ScopedCallbackRuntime.layer,
    nodePlatform,
  );
  const profileServices = Layer.merge(ApplicationSettings.live, ProfileAssets.live).pipe(
    Layer.provideMerge(base),
  );
  return electronPlatform.pipe(Layer.provideMerge(profileServices));
};
