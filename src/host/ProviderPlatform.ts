import type * as Effect from "effect/Effect";
import type {
  WindowsDesktopToolsService,
  WindowsProcessIdentity,
} from "../main/platform/node/WindowsDesktopTools";
import * as Context from "effect/Context";
import type { ResolvedCodexRuntime } from "../main/codex/codex-runtime";
import type { CodexAccountHome } from "../main/platform/node/CodexAccountHome";

export class CodexPlatform extends Context.Service<
  CodexPlatform,
  {
    readonly runtime: ResolvedCodexRuntime;
    readonly windowsDesktopTools?: {
      readonly coreExecutable: string;
      readonly native: WindowsDesktopToolsService;
      readonly ready: Effect.Effect<void>;
      readonly hostIdentity: () => WindowsProcessIdentity | undefined;
    };
    readonly codexHome: string;
    readonly accountHome: CodexAccountHome;
    readonly runtimeStateHome: string;
  }
>()("nodex/main/app/CodexPlatform") {}

export class CodexLocalLaunch extends Context.Service<
  CodexLocalLaunch,
  { readonly configOverrides: ReadonlyArray<string> }
>()("nodex/main/app/CodexLocalLaunch") {}
