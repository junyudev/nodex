import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const MainConfigValue = Schema.Struct({
  assistantStreamingDebug: Schema.Boolean,
  appVersion: Schema.String,
  arch: Schema.String,
  argv: Schema.Array(Schema.String),
  composerAppshotHelperPath: Schema.NullOr(Schema.String),
  documentsPath: Schema.String,
  environment: Schema.Record(Schema.String, Schema.String),
  environmentPath: Schema.NullOr(Schema.String),
  homeDirectory: Schema.String,
  initialProjectsDirectory: Schema.NullOr(Schema.String),
  isDefaultApp: Schema.Boolean,
  isPackaged: Schema.Boolean,
  nodexHome: Schema.String,
  platform: Schema.String,
  profileSettingsPath: Schema.String,
  profileId: Schema.String,
  projectRootPath: Schema.String,
  rendererUrl: Schema.NullOr(Schema.String),
  resourcesPath: Schema.String,
  runtimeBinaryPath: Schema.String,
});

export type MainConfigValue = typeof MainConfigValue.Type;

export class MainConfig extends Context.Service<MainConfig, MainConfigValue>()(
  "nodex/main/app/MainConfig",
) {}

export class MainConfigError extends Schema.TaggedError<MainConfigError>()("MainConfigError", {
  cause: Schema.Defect(),
}) {}

const decode = Schema.decodeUnknownEffect(MainConfigValue);

export const layer = (input: unknown): Layer.Layer<MainConfig, MainConfigError> =>
  Layer.effect(
    MainConfig,
    decode(input).pipe(Effect.mapError((cause) => new MainConfigError({ cause }))),
  );

export const testLayer = (overrides: Partial<MainConfigValue> = {}): Layer.Layer<MainConfig> =>
  Layer.succeed(
    MainConfig,
    MainConfig.of({
      assistantStreamingDebug: false,
      appVersion: "0.0.0-test",
      arch: "arm64",
      argv: [],
      composerAppshotHelperPath: null,
      documentsPath: "/tmp/Documents",
      environment: {},
      environmentPath: null,
      homeDirectory: "/tmp",
      initialProjectsDirectory: null,
      isDefaultApp: false,
      isPackaged: false,
      nodexHome: "/tmp/nodex-test",
      platform: "darwin",
      profileSettingsPath: "/tmp/nodex-test/config.toml",
      profileId: "test-profile",
      projectRootPath: "/tmp/nodex-project",
      rendererUrl: null,
      resourcesPath: "/tmp/nodex-resources",
      runtimeBinaryPath: "/tmp/nodex-runtime",
      ...overrides,
    }),
  );
