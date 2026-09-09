import { Visitor, type ImportDeclaration } from "oxc-parser";
import { parseTypeScriptSource, sourcePosition } from "../lib/oxc-source";

export type EffectBoundaryDiagnosticCode =
  | "application-ambient-process"
  | "application-root-uninterruptible"
  | "application-static-layer-build"
  | "application-unsafe-runtime"
  | "application-unstructured-async"
  | "conversation-internal-import"
  | "effect-free-import"
  | "node-runtime-outside-entry"
  | "production-unbounded-channel"
  | "run-outside-boundary"
  | "unstable-outside-adapter";

export interface EffectBoundaryDiagnostic {
  readonly code: EffectBoundaryDiagnosticCode;
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly path: string;
}

interface EffectBoundaryInput {
  readonly path: string;
  readonly sourceText: string;
}

const effectFreeRoots = [
  "packages/codex-app-server-protocol/",
  "packages/core-protocol/",
  "src/preload/",
  "src/renderer/",
  "src/shared/",
];

const effectApplicationRoots = [
  "src/main/app/",
  "src/main/automation-application/",
  "src/main/browser-application/",
  "src/main/codex-application/",
  "src/main/codex-runtime/",
  "src/main/core-runtime/",
  "src/main/database-application/",
  "src/main/git-application/",
  "src/main/host-runtime/",
  "src/main/initial-project/",
  "src/main/ipc/handlers/",
  "src/main/library-application/",
  "src/main/nodex-agent-application/",
  "src/main/project-application/",
  "src/main/terminal-runtime/",
  "src/main/window-runtime/",
];

const unstructuredConstructors = new Set(["AbortController", "EventEmitter", "Promise"]);
const unstructuredTimers = new Set(["setInterval", "setTimeout"]);
const ambientProcessProperties = new Set(["arch", "cwd", "env", "platform"]);
const lifecycleBypassingCalls = new Set([
  "doneUnsafe",
  "interruptUnsafe",
  "makeUnsafe",
  "offerUnsafe",
]);

const staticApplicationRoots = new Set([
  "src/main/app/ApplicationOperationsLive.ts",
  "src/main/app/ApplicationStateLive.ts",
  "src/main/app/CodexApplicationLive.ts",
  "src/main/app/ConversationApplicationLive.ts",
  "src/main/app/CoreApplicationLive.ts",
  "src/main/app/HostApplicationLive.ts",
  "src/main/app/MainApplicationLive.ts",
  "src/main/app/MainFoundationLive.ts",
  "src/main/app/RendererIngressLive.ts",
  "src/main/app/WindowApplicationLive.ts",
]);

const applicationProgramRoots = new Set([
  "src/main/app/MainApp.ts",
  "src/main/app/MainApplicationLive.ts",
]);

// This adapter only exists to drive the companion package's deterministic protocol tests.
const testOnlyUnboundedChannelAdapters = new Set([
  "packages/effect-codex-app-server/src/_internal/stdio.ts",
]);

// These qualified operations preserve synchronous external ingress. Queue admission
// and completion never suspend; interruption and resource release remain Effect-owned.
const synchronousIngressUnsafeCalls = new Map<string, ReadonlySet<string>>([
  [
    "src/main/core-runtime/ProjectionLiveRuntime.ts",
    new Set(["Deferred.doneUnsafe", "Queue.offerUnsafe"]),
  ],
  [
    "src/main/core-runtime/DocumentLiveRuntime.ts",
    new Set(["Deferred.doneUnsafe", "Queue.offerUnsafe"]),
  ],
  // Node pipe callbacks offer into Stream.callback's scoped, bounded sliding queue.
  ["src/main/host-runtime/ChromeControlRuntime.ts", new Set(["Queue.offerUnsafe"])],
  // Capture the renderer generation before an IPC Effect can start after navigation.
  // Only its completion cell is allocated synchronously; settlement stays effectful.
  ["src/main/host-runtime/EditorHistoryRuntime.ts", new Set(["Deferred.makeUnsafe"])],
]);

function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isEffectModule(moduleName: string): boolean {
  return (
    moduleName === "effect" || moduleName.startsWith("effect/") || moduleName.startsWith("@effect/")
  );
}

function isUnstableEffectModule(moduleName: string): boolean {
  return moduleName.includes("/unstable/") || moduleName.endsWith("/unstable");
}

function isEffectFreePath(path: string): boolean {
  return effectFreeRoots.some((root) => path.startsWith(root));
}

function isEffectApplicationModule(path: string): boolean {
  if (/\.(?:integration|node\.test|spec|test|test-support)\.[cm]?[jt]sx?$/.test(path)) return false;
  return effectApplicationRoots.some((root) => path.startsWith(root));
}

function isTestModule(path: string): boolean {
  return /\.(?:integration|node\.test|spec|test|test-support)\.[cm]?[jt]sx?$/.test(path);
}

function canImportConversationInternals(path: string): boolean {
  return (
    path.startsWith("src/main/codex-application/") ||
    path === "src/main/app/CodexApplicationLive.ts" ||
    isTestModule(path)
  );
}

function isEffectAdapter(path: string): boolean {
  return (
    path.startsWith("src/main/platform/") ||
    path.startsWith("packages/effect-codex-app-server/") ||
    path === "scripts/codex-probe-session.ts"
  );
}

const nodeRuntimeEntries = new Set([
  "packages/effect-codex-app-server/scripts/generate.ts",
  "scripts/codex-probe-session.ts",
  "scripts/probe-acp-agent.ts",
  "scripts/testing/probe-agent-cli-bootstrap.ts",
  "scripts/dev-launcher.ts",
  "scripts/verify-native-runtime.ts",
  "src/main/app/MainEntry.ts",
  "src/main/git-worker/entry.ts",
  "src/main/worktree-worker/entry.ts",
  "src/main/worktree-worker/stdio-entry.ts",
]);

const effectRunBoundaries = new Set([
  ...nodeRuntimeEntries,
  "scripts/scenarios/adapters/core-client-seed-runtime.ts",
]);

function isEffectRunBoundary(path: string): boolean {
  if (/\.(?:integration|test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  return effectRunBoundaries.has(path);
}

function isNodeRuntimeEntry(path: string): boolean {
  return nodeRuntimeEntries.has(path);
}

function effectNamespaceFromImport(declaration: ImportDeclaration): string[] {
  const moduleName = declaration.source.value;
  if (moduleName !== "effect" && moduleName !== "effect/Effect") return [];
  return declaration.specifiers.flatMap((specifier) => {
    if (specifier.type === "ImportNamespaceSpecifier") return [specifier.local.name];
    if (moduleName === "effect/Effect" && specifier.type === "ImportDefaultSpecifier") {
      return [specifier.local.name];
    }
    if (
      specifier.type === "ImportSpecifier" &&
      (specifier.imported.type === "Identifier"
        ? specifier.imported.name === "Effect"
        : specifier.imported.value === "Effect")
    ) {
      return [specifier.local.name];
    }
    return [];
  });
}

function moduleNamespaceFromImport(
  declaration: ImportDeclaration,
  exportedName: "Layer" | "PubSub" | "Queue",
): string[] {
  const moduleName = declaration.source.value;
  if (moduleName !== "effect" && moduleName !== `effect/${exportedName}`) return [];
  return declaration.specifiers.flatMap((specifier) => {
    if (specifier.type === "ImportNamespaceSpecifier") return [specifier.local.name];
    if (moduleName === `effect/${exportedName}` && specifier.type === "ImportDefaultSpecifier") {
      return [specifier.local.name];
    }
    if (
      specifier.type === "ImportSpecifier" &&
      (specifier.imported.type === "Identifier"
        ? specifier.imported.name === exportedName
        : specifier.imported.value === exportedName)
    ) {
      return [specifier.local.name];
    }
    return [];
  });
}

export function analyzeEffectBoundaries({
  path: inputPath,
  sourceText,
}: EffectBoundaryInput): EffectBoundaryDiagnostic[] {
  const path = normalizeProjectPath(inputPath);
  const program = parseTypeScriptSource(path, sourceText);
  const diagnostics: EffectBoundaryDiagnostic[] = [];
  const effectNamespaces = new Set<string>();
  const layerNamespaces = new Set<string>();
  const pubSubNamespaces = new Set<string>();
  const queueNamespaces = new Set<string>();
  const nodeRuntimeNamespaces = new Set<string>();
  const applicationModule = isEffectApplicationModule(path);

  const report = (code: EffectBoundaryDiagnosticCode, offset: number, message: string): void => {
    const position = sourcePosition(sourceText, offset);
    diagnostics.push({ code, column: position.column, line: position.line, message, path });
  };

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const moduleName = statement.source.value;
    effectNamespaceFromImport(statement).forEach((name) => effectNamespaces.add(name));
    moduleNamespaceFromImport(statement, "Layer").forEach((name) => layerNamespaces.add(name));
    moduleNamespaceFromImport(statement, "PubSub").forEach((name) => pubSubNamespaces.add(name));
    moduleNamespaceFromImport(statement, "Queue").forEach((name) => queueNamespaces.add(name));
    if (
      moduleName.includes("codex-application/internal/") &&
      !canImportConversationInternals(path)
    ) {
      report(
        "conversation-internal-import",
        statement.start,
        "Private Conversation Entity state may only be imported inside the Codex application or its composition root.",
      );
    }
    if (moduleName === "@effect/platform-node/NodeRuntime") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          nodeRuntimeNamespaces.add(specifier.local.name);
        }
      }
    }
    if (!isEffectModule(moduleName)) continue;

    if (isEffectFreePath(path)) {
      report(
        "effect-free-import",
        statement.start,
        `${path} belongs to an Effect-free renderer, preload, shared, or wire-contract boundary.`,
      );
    }
    if (isUnstableEffectModule(moduleName) && !isEffectAdapter(path)) {
      report(
        "unstable-outside-adapter",
        statement.start,
        `${moduleName} is unstable and may only be imported by a dedicated platform or companion-package adapter.`,
      );
    }
  }

  new Visitor({
    NewExpression(node) {
      if (!applicationModule || node.callee.type !== "Identifier") return;
      if (!unstructuredConstructors.has(node.callee.name)) return;
      report(
        "application-unstructured-async",
        node.start,
        `${node.callee.name} creates a second lifecycle inside an Effect application Module; use scoped Effect concurrency or a platform adapter.`,
      );
    },
    CallExpression(node) {
      if (
        applicationModule &&
        node.callee.type === "Identifier" &&
        unstructuredTimers.has(node.callee.name)
      ) {
        report(
          "application-unstructured-async",
          node.start,
          `${node.callee.name} is not Scope-owned; use Effect sleep/Schedule with a scoped fiber.`,
        );
        return;
      }
      if (node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier") return;
      if (
        applicationModule &&
        lifecycleBypassingCalls.has(node.callee.property.name) &&
        !synchronousIngressUnsafeCalls
          .get(path)
          ?.has(
            node.callee.object.type === "Identifier"
              ? `${node.callee.object.name}.${node.callee.property.name}`
              : "",
          )
      ) {
        report(
          "application-unsafe-runtime",
          node.start,
          `${node.callee.property.name} bypasses Effect lifecycle and interruption semantics; use the effectful API or a narrowly ledgered synchronous callback ingress.`,
        );
        return;
      }
      if (node.callee.object.type !== "Identifier") return;
      if (
        staticApplicationRoots.has(path) &&
        layerNamespaces.has(node.callee.object.name) &&
        (node.callee.property.name === "build" || node.callee.property.name === "buildWithScope")
      ) {
        report(
          "application-static-layer-build",
          node.start,
          "Static application roots compose Layer values; only keyed child-resource owners may build a Layer dynamically.",
        );
        return;
      }
      if (
        applicationProgramRoots.has(path) &&
        effectNamespaces.has(node.callee.object.name) &&
        node.callee.property.name === "uninterruptible"
      ) {
        report(
          "application-root-uninterruptible",
          node.start,
          "The application program must stay interruptible; protect only a narrow publication section.",
        );
        return;
      }
      if (
        !isTestModule(path) &&
        !testOnlyUnboundedChannelAdapters.has(path) &&
        node.callee.property.name === "unbounded" &&
        (queueNamespaces.has(node.callee.object.name) ||
          pubSubNamespaces.has(node.callee.object.name))
      ) {
        report(
          "production-unbounded-channel",
          node.start,
          "Production channels need an explicit capacity and overflow/recovery policy.",
        );
        return;
      }
      if (
        nodeRuntimeNamespaces.has(node.callee.object.name) &&
        node.callee.property.name === "runMain" &&
        !isNodeRuntimeEntry(path)
      ) {
        report(
          "node-runtime-outside-entry",
          node.start,
          "NodeRuntime.runMain may only appear in a designated process, worker, or standalone script entry.",
        );
        return;
      }
      if (isEffectRunBoundary(path) || !effectNamespaces.has(node.callee.object.name)) return;
      if (!/^run(?:Promise|Fork|Sync)/.test(node.callee.property.name)) return;

      report(
        "run-outside-boundary",
        node.start,
        `${node.callee.object.name}.${node.callee.property.name} may only run at a designated runtime boundary or in tests.`,
      );
    },
    MemberExpression(node) {
      if (!applicationModule || node.object.type !== "Identifier") return;
      if (node.object.name !== "process" || node.property.type !== "Identifier") return;
      if (!ambientProcessProperties.has(node.property.name)) return;
      report(
        "application-ambient-process",
        node.start,
        `process.${node.property.name} is ambient runtime configuration; inject immutable MainConfig or a dedicated platform capability.`,
      );
    },
  }).visit(program);

  return diagnostics;
}
