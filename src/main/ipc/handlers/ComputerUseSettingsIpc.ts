import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import type { ComputerUseSoundMode } from "../../../shared/computer-use-settings";
import { MainConfig } from "../../app/MainConfig";
import { ComputerUseSettingsRuntime } from "../../host-runtime/ComputerUseSettingsRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

export class ComputerUseSettingsIpcError extends Schema.TaggedError<ComputerUseSettingsIpcError>()(
  "ComputerUseSettingsIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const validate = <A>(
  operation: string,
  parse: () => A,
): Effect.Effect<A, ComputerUseSettingsIpcError> =>
  Effect.try({
    try: parse,
    catch: (cause) => new ComputerUseSettingsIpcError({ operation, cause }),
  });

const parseBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
};

export const live: Layer.Layer<
  never,
  never,
  ElectronIpc | MainConfig | ComputerUseSettingsRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const settings = yield* ComputerUseSettingsRuntime;
    const trusted = (event: IpcMainInvokeEvent, capabilityName: string) =>
      validate("authorize-renderer", () =>
        requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl),
      );

    yield* ipc.handleQuery("computer-use-settings-get", (event) =>
      trusted(event, "Computer Use settings").pipe(Effect.andThen(settings.getSnapshot)),
    );
    yield* ipc.handlePlainCommand(
      "computer-use-settings-remove-app-approval",
      (event, bundleIdentifier: string) =>
        trusted(event, "Computer Use app approval update").pipe(
          Effect.andThen(settings.removeAppApproval(bundleIdentifier)),
        ),
    );
    yield* ipc.handlePlainCommand(
      "computer-use-settings-remove-message-approval",
      (event, chatGuid: string) =>
        trusted(event, "Computer Use message approval update").pipe(
          Effect.andThen(settings.removeMessageApproval(chatGuid)),
        ),
    );
    yield* ipc.handlePlainCommand(
      "computer-use-settings-set-always-hide-pip",
      (event, value: unknown) =>
        trusted(event, "Computer Use picture-in-picture setting").pipe(
          Effect.andThen(
            validate("always-hide-picture-in-picture", () =>
              parseBoolean(value, "Computer Use picture-in-picture setting"),
            ),
          ),
          Effect.flatMap(settings.setAlwaysHidePictureInPicture),
        ),
    );
    yield* ipc.handlePlainCommand("computer-use-settings-set-locked-use", (event, value: unknown) =>
      trusted(event, "Computer Use Locked Use setting").pipe(
        Effect.andThen(
          validate("locked-use", () => parseBoolean(value, "Computer Use Locked Use setting")),
        ),
        Effect.flatMap(settings.setLockedUseEnabled),
      ),
    );
    yield* ipc.handlePlainCommand(
      "computer-use-settings-set-sound-mode",
      (event, soundMode: ComputerUseSoundMode) =>
        trusted(event, "Computer Use sound setting").pipe(
          Effect.andThen(settings.setSoundMode(soundMode)),
        ),
    );
  }),
);
