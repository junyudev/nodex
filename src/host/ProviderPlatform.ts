import type * as Effect from "effect/Effect";
import type {
  WindowsDesktopToolsService,
  WindowsProcessIdentity,
} from "../main/platform/node/WindowsDesktopTools";
import * as Context from "effect/Context";
import type { DesktopToolsRuntime } from "../main/codex/codex-runtime";
import type { CodexPackage, CodexPackageAvailability } from "../main/codex/CodexPackage";
import type { MainApplicationError } from "../main/app/MainExit";
import type { CodexAccountHome } from "../main/platform/node/CodexAccountHome";

export class CodexPlatform extends Context.Service<
  CodexPlatform,
  {
    readonly desktopTools: DesktopToolsRuntime;
    readonly package: CodexPackage;
    /** Wait for this launch's package verification, if started, then read the current value. */
    readonly packageAfterStartupCheck: Effect.Effect<CodexPackageAvailability>;
    readonly usesExternalExecutable: boolean;
    readonly ordinaryPackageAfterStartupCheck: Effect.Effect<CodexPackageAvailability>;
    readonly windowsDesktopTools?: {
      readonly coreExecutable: string;
      readonly native: WindowsDesktopToolsService;
      readonly ready: Effect.Effect<void>;
      readonly hostIdentity: () => WindowsProcessIdentity | undefined;
    };
    readonly accountPresent: Effect.Effect<boolean>;
    readonly codexHome: string;
    readonly accountHome: CodexAccountHome;
    readonly runtimeStateHome: string;
  }
>()("nodex/main/app/CodexPlatform") {}

export class CodexLocalLaunch extends Context.Service<
  CodexLocalLaunch,
  {
    readonly prepareAccount: Effect.Effect<CodexAccountHome, MainApplicationError>;
    readonly declaration: readonly string[];
    readonly resolveOverrides: (
      environment: Readonly<NodeJS.ProcessEnv>,
      searchPaths: readonly string[],
    ) => Effect.Effect<readonly string[], MainApplicationError>;
  }
>()("nodex/main/app/CodexLocalLaunch") {}
