import { hostCapabilities } from "../host-capabilities";
import { randomUUID } from "node:crypto";
import { app, screen } from "electron";
import * as Layer from "effect/Layer";
import {
  buildCodexAttestationSignals,
  CodexAttestation,
  makeCodexAttestation,
} from "../../codex-application/CodexAttestation";
import { loadNativeDeviceCheckBridge } from "./native-devicecheck";

const NODEX_BUNDLE_IDENTIFIER = "app.jyu.nodex";
const appSessionId = randomUUID();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const live = (options: {
  readonly architecture: string;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
}): Layer.Layer<CodexAttestation> => {
  let deviceCheck: ReturnType<typeof loadNativeDeviceCheckBridge> | undefined;
  const generateDeviceCheckToken = hostCapabilities(options.platform, options.architecture)
    .deviceCheck
    ? () => {
        deviceCheck ??= loadNativeDeviceCheckBridge({
          packaged: options.isPackaged,
          resourcesPath: options.resourcesPath,
          appPath: options.projectRootPath,
          architecture: options.architecture,
        });
        return deviceCheck.generateToken();
      }
    : undefined;

  return Layer.succeed(
    CodexAttestation,
    makeCodexAttestation({
      platform: options.platform,
      architecture: options.architecture,
      bundleIdentifier: NODEX_BUNDLE_IDENTIFIER,
      getSignals: () => {
        const display = screen.getPrimaryDisplay();
        return buildCodexAttestationSignals({
          appSessionId,
          displayHeight: display.size.height,
          displayWidth: display.size.width,
          locale: app.getLocale(),
          preferredLanguages: app.getPreferredSystemLanguages(),
          screenScale: display.scaleFactor,
          timezone,
        });
      },
      ...(generateDeviceCheckToken ? { generateDeviceCheckToken } : {}),
    }),
  );
};
