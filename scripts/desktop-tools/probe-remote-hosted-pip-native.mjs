#!/usr/bin/env -S node --import tsx

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_FLAG = "--native-fixture";
const DEFAULT_RUNTIME_ROOT = ".generated/codex-runtime/agent-runtime/browser-runtime";
const TEAM_ID = "2DC432GLL2";
const PROBE_TIMEOUT_MS = 45_000;
const NATIVE_UI_OPT_IN_FLAG = "--allow-native-ui";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const delay = async (milliseconds) =>
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function parseProbeArguments(argv = process.argv.slice(2)) {
  const value = (name) =>
    argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  return {
    allowNativeUi: argv.includes(NATIVE_UI_OPT_IN_FLAG),
    capture: !argv.includes("--no-capture"),
    electronExecutable: value("electron-executable"),
    fixture: argv.includes(FIXTURE_FLAG),
    manifestPath: value("manifest"),
    outputDirectory: value("out-dir"),
    resultPath: value("result"),
    runtimeRoot: value("runtime-root"),
  };
}

/** Prevents this evidence runner from ever opening native windows as an implicit side effect. */
export function assertNativeUiOptIn(arguments_) {
  if (arguments_.allowNativeUi === true) return;
  throw new Error(
    `Native PiP evidence creates disposable macOS windows; rerun with ${NATIVE_UI_OPT_IN_FLAG} to opt in explicitly`,
  );
}

export function nativeProbeExitCode(report) {
  return report?.classification?.dynamicPathPassed === true ? 0 : 1;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function commandEvidence(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    exitCode: result.status,
    signal: result.signal,
    stderr: result.stderr?.trim() ?? "",
    stdout: result.stdout?.trim() ?? "",
  };
}

export async function inspectNativeRuntime(runtimeRootInput = DEFAULT_RUNTIME_ROOT) {
  const runtimeRoot = path.resolve(repositoryRoot, runtimeRootInput);
  const manifestPath = path.join(runtimeRoot, "browser-runtime-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const addonRelativePath = manifest.capabilities?.nativePip?.addon;
  if (typeof addonRelativePath !== "string" || addonRelativePath.length === 0) {
    throw new Error("Browser runtime manifest does not declare a native PiP addon");
  }
  const addonPath = path.resolve(runtimeRoot, addonRelativePath);
  if (!addonPath.startsWith(`${runtimeRoot}${path.sep}`)) {
    throw new Error("Native PiP addon escapes the verified runtime root");
  }
  const addonStats = await lstat(addonPath);
  if (!addonStats.isFile() || addonStats.isSymbolicLink()) {
    throw new Error("Native PiP addon is not an owned regular file");
  }
  const addonBytes = await readFile(addonPath);
  const addonArtifact = manifest.artifacts?.find((artifact) => artifact.path === addonRelativePath);
  if (!addonArtifact) throw new Error("Native PiP addon is absent from manifest artifacts");
  const actualSha256 = sha256(addonBytes);
  const hashVerified =
    addonArtifact.sha256 === actualSha256 && addonArtifact.size === addonBytes.length;
  const signatureVerification = commandEvidence("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    addonPath,
  ]);
  const signatureDetails = commandEvidence("/usr/bin/codesign", ["-dv", "--verbose=4", addonPath]);
  const teamId = signatureDetails.stderr.match(/^TeamIdentifier=(.+)$/mu)?.[1] ?? null;
  const architectures = commandEvidence("/usr/bin/lipo", ["-archs", addonPath]);
  return {
    addon: {
      architecture: architectures.stdout,
      bytes: addonBytes.length,
      expectedSha256: addonArtifact.sha256,
      hashVerified,
      path: addonPath,
      sha256: actualSha256,
      signatureDetails: signatureDetails.stderr.split("\n").filter(Boolean),
      signatureVerified: signatureVerification.exitCode === 0 && teamId === TEAM_ID,
      signingTeamId: teamId,
    },
    manifest: {
      browserPluginVersion: manifest.browserPlugin?.version ?? null,
      desktopBuild: manifest.desktopBuild ?? null,
      desktopBuildNumber: manifest.desktopBuildNumber ?? null,
      path: manifestPath,
      schemaVersion: manifest.schemaVersion ?? null,
      sha256: sha256(manifestBytes),
      targetArch: manifest.targetArch ?? null,
      targetPlatform: manifest.targetPlatform ?? null,
    },
    runtimeRoot,
  };
}

function sameBounds(left, right) {
  if (!left || !right) return false;
  return ["height", "width", "x", "y"].every((key) => left[key] === right[key]);
}

function stageByName(fixtureReport, name) {
  return fixtureReport.windowEvidence?.stages?.find((stage) => stage.name === name) ?? null;
}

function nativeRowsAtStage(stage) {
  if (!stage) return [];
  if (Array.isArray(stage.nativeRows)) return stage.nativeRows;
  return (stage.rows ?? []).filter((row) =>
    ["Computer Use", "Computer Use Controls"].includes(row.name),
  );
}

function collectLayerNodes(root) {
  if (!root || typeof root !== "object") return [];
  const nodes = [root];
  for (const child of root.sublayers ?? []) nodes.push(...collectLayerNodes(child));
  return nodes;
}

/** Turns raw CGWindow/AppKit snapshots into reviewable native hierarchy and lifecycle claims. */
export function deriveNativeWindowAssertions(fixtureReport) {
  const presentation = stageByName(fixtureReport, "01-presentation");
  const moved = stageByName(fixtureReport, "02-moved-owner");
  const avatarHost = stageByName(fixtureReport, "03-avatar-host");
  const completion = stageByName(fixtureReport, "04-completion-effect");
  const stopped = stageByName(fixtureReport, "05-stopped");
  const finalBaseline = stageByName(fixtureReport, "06-process-window-baseline");
  const presentationRows = nativeRowsAtStage(presentation);
  const movedRows = nativeRowsAtStage(moved);
  const content = presentationRows.find((row) => row.name === "Computer Use");
  const controls = presentationRows.find((row) => row.name === "Computer Use Controls");
  const nativeIds = [content?.id, controls?.id].filter(Number.isInteger);
  const movedById = new Map(movedRows.map((row) => [row.id, row]));
  const introspectionRows = (presentation?.nativeIntrospectionRows ?? []).filter((row) =>
    nativeIds.includes(row.windowNumber),
  );
  const contentIntrospection = introspectionRows.find((row) => row.title === "Computer Use");
  const controlsIntrospection = introspectionRows.find(
    (row) => row.title === "Computer Use Controls",
  );
  const contentLayers = collectLayerNodes(contentIntrospection?.contentLayerTree);
  const controlsLayers = collectLayerNodes(controlsIntrospection?.contentLayerTree);
  const completionContent = (completion?.nativeIntrospectionRows ?? []).find(
    (row) => row.windowNumber === content?.id,
  );
  const completionLayers = collectLayerNodes(completionContent?.contentLayerTree);
  const stoppedIntrospectionRows = (stopped?.nativeIntrospectionRows ?? []).filter((row) =>
    nativeIds.includes(row.windowNumber),
  );
  const panelHierarchyObserved =
    introspectionRows.length === 2 &&
    introspectionRows.every(
      (row) => row.isPanel === true && row.classChain?.includes("NSPanel") === true,
    );
  const nativePanelClassObserved =
    introspectionRows.length === 2 && introspectionRows.every((row) => row.class === "NSPanel");
  const pipStackContentHierarchyObserved =
    introspectionRows.length === 2 &&
    introspectionRows.every(
      (row) =>
        row.contentViewTree?.class === "PIPStackContentView" &&
        row.contentViewTree?.classChain?.includes("NSView") === true &&
        row.contentLayerTree?.class === "NSViewBackingLayer" &&
        row.contentLayerTree?.name === "PIPStackContentView",
    );
  const contentImageLayerContractObserved = contentLayers.some(
    (layer) =>
      layer.class === "CALayer" &&
      layer.cornerRadius === 8 &&
      layer.masksToBounds === true &&
      layer.frame?.width > 0 &&
      layer.frame?.height > 0,
  );
  const controlsLayerContractObserved =
    controlsLayers.some((layer) => layer.class === "CABackdropLayer") &&
    controlsLayers.some((layer) => layer.class === "CATextLayer") &&
    controlsLayers.some(
      (layer) =>
        typeof layer.name === "string" &&
        layer.name.startsWith("remote-hosted-pip-control-blur-mask-"),
    );
  const calayerHierarchyObserved =
    contentImageLayerContractObserved && controlsLayerContractObserved;
  const completionEffectLayerObserved = completionLayers.some(
    (layer) => layer.name === "remote-hosted-pip-completion",
  );
  const nativeWindowPairObserved =
    nativeIds.length === 2 &&
    new Set(nativeIds).size === 2 &&
    content !== undefined &&
    controls !== undefined;
  const nativeWindowPairCoLocated =
    nativeWindowPairObserved && sameBounds(content.bounds, controls.bounds);
  const nativeWindowsFollowedOwner =
    nativeWindowPairObserved &&
    nativeIds.every((id) => {
      const before = presentationRows.find((row) => row.id === id);
      const after = movedById.get(id);
      if (!before || !after) return false;
      return before.bounds?.x !== after.bounds?.x || before.bounds?.y !== after.bounds?.y;
    });
  const nativePanelsRemovedAfterStop = nativeRowsAtStage(stopped).length === 0;
  const nativePanelsParentedToOwner =
    introspectionRows.length === 2 &&
    introspectionRows.every(
      (row) =>
        Number.isInteger(row.parentWindowNumber) &&
        presentation?.browserWindowIds?.includes(row.parentWindowNumber) === true,
    );
  const ownerWindowNumber = introspectionRows[0]?.parentWindowNumber ?? null;
  const avatarHostPanelRows = (avatarHost?.nativeIntrospectionRows ?? []).filter((row) =>
    nativeIds.includes(row.windowNumber),
  );
  const avatarWindowNumber = avatarHost?.browserWindowIds?.find(
    (windowNumber) => windowNumber !== ownerWindowNumber,
  );
  const avatarWindow = (avatarHost?.nativeIntrospectionRows ?? []).find(
    (row) => row.windowNumber === avatarWindowNumber,
  );
  const avatarHostWindowObserved =
    Number.isInteger(avatarWindowNumber) &&
    avatarWindow?.class === "ElectronNSPanel" &&
    avatarWindow.classChain?.includes("NSWindow") === true &&
    avatarWindow.isPanel === false &&
    avatarWindow.isOpaque === false &&
    avatarWindow.isVisible === true &&
    avatarWindow.frame?.width === 384 &&
    avatarWindow.frame?.height > 0;
  const nativePanelsStayedOnPrimaryWithAvatarObserved =
    avatarHostPanelRows.length === 2 &&
    Number.isInteger(ownerWindowNumber) &&
    avatarHostPanelRows.every(
      (row) => row.isVisible === true && row.parentWindowNumber === ownerWindowNumber,
    );
  const nativePanelsDetachedAndHiddenAfterStop =
    stoppedIntrospectionRows.length === 2 &&
    stoppedIntrospectionRows.every(
      (row) => row.isVisible === false && row.parentWindowNumber === null,
    );
  const processWindowsReturnedToBaseline = finalBaseline?.rows?.length === 0;
  return {
    avatarHostWindowObserved,
    avatarWindowNumber: avatarWindowNumber ?? null,
    calayerHierarchyObserved,
    completionEffectLayerObserved,
    contentImageLayerContractObserved,
    controlsLayerContractObserved,
    nativePanelClassObserved,
    nativePanelWindowIds: nativeIds,
    nativePanelsDetachedAndHiddenAfterStop,
    nativePanelsParentedToOwner,
    nativePanelsRemovedAfterStop,
    nativePanelsStayedOnPrimaryWithAvatarObserved,
    nativeWindowPairCoLocated,
    nativeWindowPairObserved,
    nativeWindowsFollowedOwner,
    ownerWindowNumber,
    panelHierarchyObserved,
    pipStackContentHierarchyObserved,
    processWindowsReturnedToBaseline,
  };
}

export function classifyNativeEvidence(fixtureReport, provenance, hostIdentity = null) {
  const operation = (name) => fixtureReport.operations?.find((entry) => entry.name === name);
  const requiredOperationOutcomes = [
    ["start-host", true],
    ["set-max-display-size", true],
    ["register-primary-host", true],
    ["set-suppressed-threads", true],
    ["set-active-thread", true],
    ["refresh-visibility", true],
    ["upsert-browser-presentation", true],
    ["read-has-presentation", true],
    ["register-moved-primary-host", true],
    ["register-avatar-host", true],
    ["complete-thread", true],
    ["invalidate-browser-presentation", true],
    ["read-has-presentation-after-invalidate", false],
    ["unregister-avatar-host", true],
    ["unregister-primary-host", true],
    ["clear-active-thread", true],
    ["stop-host", true],
  ];
  const failedOperations = requiredOperationOutcomes
    .filter(
      ([name, expected]) =>
        operation(name)?.status !== "success" || operation(name)?.value !== expected,
    )
    .map(([name]) => name);
  const activeTaskIds = operation("read-active-task-ids");
  const layoutAfterUpsert = operation("read-layout-after-upsert");
  const layoutAfterMove = operation("read-layout-after-move");
  const layoutAfterAvatar = operation("read-layout-after-avatar-host");
  const layoutStates = [layoutAfterUpsert, layoutAfterMove, layoutAfterAvatar];
  const activeTaskStateObserved =
    activeTaskIds?.status === "success" &&
    activeTaskIds.value?.length === 1 &&
    activeTaskIds.value[0]?.startsWith("native-evidence-thread-") === true;
  const primaryLayoutObserved = layoutStates.every(
    (entry) =>
      entry?.status === "success" &&
      entry.value?.currentHostID === "native-evidence-primary" &&
      Number.isFinite(entry.value?.stackDisplayHeight) &&
      entry.value.stackDisplayHeight > 0,
  );
  const windowAssertions = deriveNativeWindowAssertions(fixtureReport);
  const motion = fixtureReport.reduceMotion ?? {};
  const reduceMotionInputPolicyPassed =
    motion.toggledByHarness === false &&
    typeof motion.systemPreference === "boolean" &&
    motion.effectiveAnimatedRegistration === !motion.systemPreference;
  const failedAssertions = [
    ["active-task-state-observed", activeTaskStateObserved],
    ["primary-layout-observed", primaryLayoutObserved],
    ["native-window-pair-observed", windowAssertions.nativeWindowPairObserved],
    ["native-window-pair-co-located", windowAssertions.nativeWindowPairCoLocated],
    ["native-windows-followed-owner", windowAssertions.nativeWindowsFollowedOwner],
    ["native-panels-parented-to-owner", windowAssertions.nativePanelsParentedToOwner],
    ["avatar-host-window-observed", windowAssertions.avatarHostWindowObserved],
    [
      "native-panels-stayed-on-primary-with-avatar-observed",
      windowAssertions.nativePanelsStayedOnPrimaryWithAvatarObserved,
    ],
    ["native-panels-removed-after-stop", windowAssertions.nativePanelsRemovedAfterStop],
    [
      "native-panels-detached-and-hidden-after-stop",
      windowAssertions.nativePanelsDetachedAndHiddenAfterStop,
    ],
    ["appkit-panel-hierarchy-observed", windowAssertions.panelHierarchyObserved],
    ["native-panel-class-observed", windowAssertions.nativePanelClassObserved],
    ["pip-stack-content-hierarchy-observed", windowAssertions.pipStackContentHierarchyObserved],
    ["content-image-layer-contract-observed", windowAssertions.contentImageLayerContractObserved],
    ["controls-layer-contract-observed", windowAssertions.controlsLayerContractObserved],
    ["calayer-hierarchy-observed", windowAssertions.calayerHierarchyObserved],
    ["completion-effect-layer-observed", windowAssertions.completionEffectLayerObserved],
    ["reduce-motion-input-policy-passed", reduceMotionInputPolicyPassed],
    ["process-windows-returned-to-baseline", windowAssertions.processWindowsReturnedToBaseline],
  ]
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const nativeWindowsObserved = (fixtureReport.windowEvidence?.stages ?? []).some(
    (stage) => stage.nativePanelCandidates > 0,
  );
  const processWindowsReturnedToBaseline = windowAssertions.processWindowsReturnedToBaseline;
  const presentationObserved = operation("read-has-presentation")?.value === true;
  const hostStartAccepted = operation("start-host")?.value === true;
  const teardown = fixtureReport.teardown ?? {};
  const teardownPassed =
    teardown.scopeClosed === true &&
    teardown.windowsDestroyed === true &&
    teardown.hostStopped === true &&
    processWindowsReturnedToBaseline;
  const signedRuntime =
    provenance.addon.hashVerified === true && provenance.addon.signatureVerified === true;
  const signedHost = hostIdentity?.developerIdVerified === true;
  const dynamicPathPassed =
    signedRuntime &&
    signedHost &&
    fixtureReport.availability?.status === "available" &&
    failedOperations.length === 0 &&
    failedAssertions.length === 0 &&
    presentationObserved &&
    teardownPassed;
  return {
    activeTaskStateObserved,
    dynamicPathPassed,
    evidenceGrade: dynamicPathPassed
      ? nativeWindowsObserved
        ? signedHost
          ? "signed-addon-and-host-window-observed"
          : "signed-addon-unsigned-host-window-observed"
        : signedHost
          ? "signed-addon-and-host-api-observed"
          : "signed-addon-unsigned-host-api-observed"
      : signedRuntime
        ? signedHost
          ? "signed-addon-and-host-partial"
          : "signed-addon-unsigned-host-partial"
        : "unverified-runtime",
    failedOperations,
    failedAssertions,
    hostStartAccepted,
    motionAssertions: {
      nativeTransitionMode:
        motion.systemPreference === true
          ? "read-only-reduced-motion-input"
          : motion.systemPreference === false
            ? "read-only-standard-motion-input"
            : "system-preference-unavailable",
      reduceMotionInputPolicyPassed,
      systemPreference: motion.systemPreference ?? null,
      toggledByHarness: motion.toggledByHarness ?? false,
    },
    nativeWindowsObserved,
    presentationObserved,
    primaryLayoutObserved,
    processWindowsReturnedToBaseline,
    signedHost,
    signedRuntime,
    status: dynamicPathPassed ? "passed" : "partial",
    teardownPassed,
    windowAssertions,
  };
}

const swiftWindowEnumerator = String.raw`
import CoreGraphics
import Foundation

let requestedPID = Int32(CommandLine.arguments[1])!
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
let rows: [[String: Any]] = raw.compactMap { item in
  guard let ownerPID = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, ownerPID == requestedPID else {
    return nil
  }
  let bounds = item[kCGWindowBounds as String] as? [String: Any] ?? [:]
  return [
    "alpha": item[kCGWindowAlpha as String] as? Double ?? 0,
    "bounds": [
      "height": bounds["Height"] as? Double ?? 0,
      "width": bounds["Width"] as? Double ?? 0,
      "x": bounds["X"] as? Double ?? 0,
      "y": bounds["Y"] as? Double ?? 0,
    ],
    "id": (item[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0,
    "layer": (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
    "name": item[kCGWindowName as String] as? String ?? "",
    "ownerName": item[kCGWindowOwnerName as String] as? String ?? "",
  ]
}
let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
`;

// This probe runs inside the disposable Electron Main process, so a tiny N-API helper can
// inspect AppKit objects that CoreGraphics deliberately abstracts away. It is compiled into the
// ignored evidence directory, loaded only by the fixture, and never shipped with Nodex.
const nativeWindowIntrospectorSource = String.raw`
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stddef.h>

extern "C" {
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
napi_status napi_create_function(
  napi_env env,
  const char* utf8name,
  size_t length,
  napi_callback callback,
  void* data,
  napi_value* result
);
napi_status napi_create_string_utf8(
  napi_env env,
  const char* value,
  size_t length,
  napi_value* result
);
napi_status napi_set_named_property(
  napi_env env,
  napi_value object,
  const char* utf8name,
  napi_value value
);
}

static NSArray<NSString*>* classChain(Class currentClass) {
  NSMutableArray<NSString*>* chain = [NSMutableArray array];
  while (currentClass != Nil) {
    [chain addObject:NSStringFromClass(currentClass)];
    currentClass = class_getSuperclass(currentClass);
  }
  return chain;
}

static NSDictionary* rectDictionary(NSRect rect) {
  return @{
    @"height": @(rect.size.height),
    @"width": @(rect.size.width),
    @"x": @(rect.origin.x),
    @"y": @(rect.origin.y),
  };
}

static NSDictionary* layerNode(CALayer* layer, NSInteger depth, NSInteger* budget) {
  if (layer == nil || depth > 6 || *budget <= 0) return @{};
  *budget -= 1;
  NSMutableArray* children = [NSMutableArray array];
  for (CALayer* child in layer.sublayers ?: @[]) {
    if (*budget <= 0) break;
    [children addObject:layerNode(child, depth + 1, budget)];
  }
  return @{
    @"bounds": rectDictionary(NSRectFromCGRect(layer.bounds)),
    @"class": NSStringFromClass(layer.class),
    @"cornerRadius": @(layer.cornerRadius),
    @"frame": rectDictionary(NSRectFromCGRect(layer.frame)),
    @"hidden": @(layer.hidden),
    @"masksToBounds": @(layer.masksToBounds),
    @"name": layer.name ?: (id)[NSNull null],
    @"opacity": @(layer.opacity),
    @"sublayers": children,
  };
}

static NSDictionary* viewNode(NSView* view, NSInteger depth, NSInteger* budget) {
  if (view == nil || depth > 6 || *budget <= 0) return @{};
  *budget -= 1;
  NSMutableArray* children = [NSMutableArray array];
  for (NSView* child in view.subviews ?: @[]) {
    if (*budget <= 0) break;
    [children addObject:viewNode(child, depth + 1, budget)];
  }
  return @{
    @"bounds": rectDictionary(view.bounds),
    @"class": NSStringFromClass(view.class),
    @"classChain": classChain(view.class),
    @"frame": rectDictionary(view.frame),
    @"hidden": @(view.hidden),
    @"layerClass": view.layer == nil ? (id)[NSNull null] : NSStringFromClass(view.layer.class),
    @"subviews": children,
    @"wantsLayer": @(view.wantsLayer),
  };
}

static NSInteger countLayerNodes(CALayer* layer, NSInteger remaining) {
  if (layer == nil || remaining <= 0) return 0;
  NSInteger count = 1;
  for (CALayer* child in layer.sublayers ?: @[]) {
    if (count >= remaining) break;
    count += countLayerNodes(child, remaining - count);
  }
  return count;
}

static NSDictionary* windowNode(NSWindow* window) {
  NSView* contentView = window.contentView;
  NSInteger viewBudget = 128;
  NSInteger layerBudget = 128;
  NSMutableArray* childWindowNumbers = [NSMutableArray array];
  for (NSWindow* child in window.childWindows ?: @[]) {
    [childWindowNumbers addObject:@(child.windowNumber)];
  }
  return @{
    @"alphaValue": @(window.alphaValue),
    @"canBecomeKeyWindow": @(window.canBecomeKeyWindow),
    @"canBecomeMainWindow": @(window.canBecomeMainWindow),
    @"childWindowNumbers": childWindowNumbers,
    @"class": NSStringFromClass(window.class),
    @"classChain": classChain(window.class),
    @"collectionBehavior": @((unsigned long long)window.collectionBehavior),
    @"contentLayerTree": contentView.layer == nil
      ? (id)[NSNull null]
      : layerNode(contentView.layer, 0, &layerBudget),
    @"contentViewTree": contentView == nil
      ? (id)[NSNull null]
      : viewNode(contentView, 0, &viewBudget),
    @"frame": rectDictionary(window.frame),
    @"hasShadow": @(window.hasShadow),
    @"ignoresMouseEvents": @(window.ignoresMouseEvents),
    @"isKeyWindow": @(window.isKeyWindow),
    @"isMainWindow": @(window.isMainWindow),
    @"isMiniaturized": @(window.isMiniaturized),
    @"isOpaque": @(window.isOpaque),
    @"isPanel": @([window isKindOfClass:NSPanel.class]),
    @"isVisible": @(window.isVisible),
    @"layerNodeCount": @(countLayerNodes(contentView.layer, 128)),
    @"level": @(window.level),
    @"parentWindowNumber": window.parentWindow == nil
      ? (id)[NSNull null]
      : @(window.parentWindow.windowNumber),
    @"styleMask": @((unsigned long long)window.styleMask),
    @"title": window.title ?: @"",
    @"windowControllerClass": window.windowController == nil
      ? (id)[NSNull null]
      : NSStringFromClass(window.windowController.class),
    @"windowNumber": @(window.windowNumber),
  };
}

static napi_value inspectWindows(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    NSMutableArray* rows = [NSMutableArray array];
    for (NSWindow* window in NSApp.windows ?: @[]) {
      [rows addObject:windowNode(window)];
    }
    NSError* error = nil;
    NSData* data = [NSJSONSerialization dataWithJSONObject:rows options:NSJSONWritingSortedKeys error:&error];
    NSString* json = data == nil
      ? [NSString stringWithFormat:@"[{\"introspectionError\":\"%@\"}]", error.localizedDescription ?: @"unknown"]
      : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    napi_value result = nullptr;
    napi_create_string_utf8(env, json.UTF8String, (size_t)[json lengthOfBytesUsingEncoding:NSUTF8StringEncoding], &result);
    return result;
  }
}

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(
  napi_env env,
  napi_value exports
) {
  napi_value function = nullptr;
  napi_create_function(env, "inspectWindows", (size_t)-1, inspectWindows, nullptr, &function);
  napi_set_named_property(env, exports, "inspectWindows", function);
  return exports;
}

extern "C" __attribute__((visibility("default"))) int node_api_module_get_api_version_v1(void) {
  return 8;
}
`;

async function prepareWindowEnumerator(root) {
  const swiftPath = path.join(root, "list-owned-windows.swift");
  const executablePath = path.join(root, "list-owned-windows");
  await writeFile(swiftPath, swiftWindowEnumerator, "utf8");
  const result = commandEvidence("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    swiftPath,
    "-o",
    executablePath,
  ]);
  if (result.exitCode !== 0) {
    return {
      error: result.stderr || result.stdout || "window enumerator compilation failed",
      executablePath: null,
    };
  }
  return { error: null, executablePath };
}

async function prepareNativeWindowIntrospector(root) {
  const sourcePath = path.join(root, "native-window-introspector.mm");
  const addonPath = path.join(root, "native-window-introspector.node");
  await writeFile(sourcePath, nativeWindowIntrospectorSource, "utf8");
  const compilation = commandEvidence("/usr/bin/clang++", [
    "-std=c++20",
    "-O2",
    "-fobjc-arc",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "AppKit",
    "-framework",
    "QuartzCore",
    "-o",
    addonPath,
    sourcePath,
  ]);
  if (compilation.exitCode !== 0) {
    return {
      addonPath: null,
      compilation,
      error: compilation.stderr || compilation.stdout || "native introspector compilation failed",
      inspect: null,
    };
  }
  try {
    const addon = createRequire(import.meta.url)(addonPath);
    if (typeof addon.inspectWindows !== "function") {
      throw new Error("native introspector did not export inspectWindows");
    }
    return {
      addonPath,
      compilation,
      error: null,
      inspect: () => JSON.parse(addon.inspectWindows()),
    };
  } catch (error) {
    return {
      addonPath,
      compilation,
      error: error instanceof Error ? error.message : String(error),
      inspect: null,
    };
  }
}

function listOwnedMacOSWindows(enumerator, pid) {
  if (!enumerator.executablePath) return { error: enumerator.error, rows: [] };
  const result = commandEvidence(enumerator.executablePath, [String(pid)]);
  if (result.exitCode !== 0) {
    return { error: result.stderr || result.stdout || "window enumeration failed", rows: [] };
  }
  try {
    return { error: null, rows: JSON.parse(result.stdout) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), rows: [] };
  }
}

async function captureOwnedWindows(outputDirectory, stageName, rows) {
  const captures = [];
  const stageDirectory = path.join(outputDirectory, "windows", stageName);
  await mkdir(stageDirectory, { recursive: true });
  for (const row of rows) {
    if (row.id <= 0 || row.bounds.width <= 0 || row.bounds.height <= 0) continue;
    const destination = path.join(stageDirectory, `window-${row.id}.png`);
    const result = commandEvidence("/usr/sbin/screencapture", ["-x", `-l${row.id}`, destination]);
    let bytes = 0;
    if (result.exitCode === 0) {
      try {
        bytes = (await stat(destination)).size;
      } catch {
        bytes = 0;
      }
    }
    captures.push({
      bytes,
      destination,
      error: result.exitCode === 0 ? null : result.stderr || result.stdout,
      windowId: row.id,
    });
  }
  return captures;
}

function serializeError(error) {
  if (error instanceof Error) return { message: error.message, name: error.name };
  return { message: String(error), name: "UnknownError" };
}

async function runElectronFixture(arguments_) {
  const resultPath = path.resolve(arguments_.resultPath);
  const outputDirectory = path.dirname(resultPath);
  const progressPath = path.join(outputDirectory, "progress.json");
  const writeProgress = async (stage, details = {}) => {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      progressPath,
      `${JSON.stringify({ at: new Date().toISOString(), fixturePid: process.pid, stage, ...details }, null, 2)}\n`,
      "utf8",
    );
  };

  await writeProgress("fixture-entered");
  const { app, BrowserWindow, screen, systemPreferences } = await import("electron");
  const userDataPath = path.join(outputDirectory, "electron-user-data");
  await mkdir(userDataPath, { recursive: true });
  app.setName("Nodex Native PiP Evidence");
  app.setPath("userData", userDataPath);
  app.on("window-all-closed", (event) => event.preventDefault());
  await writeProgress("electron-imported");
  const { register } = await import("tsx/esm/api");
  const unregisterTsx = register();
  await writeProgress("tsx-registered");
  // Electron's synchronous CJS bridge can race a still-evaluating Effect ESM module when a
  // tsx-transformed Main module is imported in parallel. Finish each dependency before loading
  // the next platform boundary so this runner measures native behavior, not loader timing.
  const Context = await import("effect/Context");
  const Effect = await import("effect/Effect");
  const Exit = await import("effect/Exit");
  const Fiber = await import("effect/Fiber");
  const Layer = await import("effect/Layer");
  const Scope = await import("effect/Scope");
  const Stream = await import("effect/Stream");
  await writeProgress("effect-imports-complete");
  const callbackModule = await import("../../src/main/app/ScopedCallbackRuntime.ts");
  await writeProgress("callback-runtime-imported");
  const platformModule =
    await import("../../src/main/platform/electron/RemoteHostedPipNativePlatform.ts");
  await writeProgress("native-platform-imported");
  const metadata = await import("../../src/shared/browser-runtime-metadata.ts");
  await writeProgress("runtime-metadata-imported");
  const report = {
    availability: null,
    events: [],
    fixturePid: process.pid,
    operations: [],
    platform: process.platform,
    processArch: process.arch,
    schemaVersion: 1,
    teardown: { hostStopped: false, scopeClosed: false, windowsDestroyed: false },
    userDataPath,
    windowEvidence: { captureEnabled: arguments_.capture, stages: [] },
  };
  let scope = null;
  let eventFiber = null;
  let hostStopped = false;
  let windowEnumerator = { error: "window enumerator not prepared", executablePath: null };
  let windowIntrospector = {
    addonPath: null,
    error: "native introspector not prepared",
    inspect: null,
  };
  const windows = [];
  const knownBrowserWindowIds = new Set();

  const recordOperation = async (name, effect) => {
    const startedAt = performance.now();
    try {
      const value = await Effect.runPromise(effect);
      const entry = { durationMs: performance.now() - startedAt, name, status: "success", value };
      report.operations.push(entry);
      return entry;
    } catch (error) {
      const entry = {
        durationMs: performance.now() - startedAt,
        error: serializeError(error),
        name,
        status: "failure",
        value: null,
      };
      report.operations.push(entry);
      return entry;
    }
  };

  const snapshotWindows = async (stageName) => {
    const listed = listOwnedMacOSWindows(windowEnumerator, process.pid);
    const currentBrowserWindowIds = BrowserWindow.getAllWindows()
      .filter((window) => !window.isDestroyed())
      .map((window) => window.getMediaSourceId?.().match(/^window:(\d+):/u)?.[1])
      .filter(Boolean)
      .map(Number);
    for (const windowId of currentBrowserWindowIds) knownBrowserWindowIds.add(windowId);
    const nativeRows = listed.rows.filter((row) => !knownBrowserWindowIds.has(row.id));
    let nativeIntrospectionRows = [];
    let nativeIntrospectionError = windowIntrospector.error;
    if (windowIntrospector.inspect) {
      try {
        nativeIntrospectionRows = windowIntrospector.inspect();
        nativeIntrospectionError = null;
      } catch (error) {
        nativeIntrospectionError = error instanceof Error ? error.message : String(error);
      }
    }
    const captures = arguments_.capture
      ? await captureOwnedWindows(outputDirectory, stageName, listed.rows)
      : [];
    report.windowEvidence.stages.push({
      browserWindowIds: [...knownBrowserWindowIds].sort((left, right) => left - right),
      captures,
      enumerationError: listed.error,
      name: stageName,
      nativeIntrospectionError,
      nativeIntrospectionRows,
      nativePanelCandidates: nativeRows.length,
      nativeRows,
      rows: listed.rows,
    });
  };

  try {
    await app.whenReady();
    await writeProgress("electron-ready");
    app.dock?.hide();
    await mkdir(outputDirectory, { recursive: true });
    windowEnumerator = await prepareWindowEnumerator(outputDirectory);
    await writeProgress("window-enumerator-prepared", { error: windowEnumerator.error });
    windowIntrospector = await prepareNativeWindowIntrospector(outputDirectory);
    report.windowEvidence.nativeIntrospector = {
      addonPath: windowIntrospector.addonPath,
      compilation: windowIntrospector.compilation,
      error: windowIntrospector.error,
    };
    await writeProgress("native-window-introspector-prepared", {
      error: windowIntrospector.error,
    });
    const manifestRaw = JSON.parse(await readFile(path.resolve(arguments_.manifestPath), "utf8"));
    const manifest = metadata.parseBrowserRuntimeManifest(manifestRaw);
    if (!manifest) throw new Error("Native fixture rejected the Browser runtime manifest");
    const expectedExports = manifest.capabilities.nativePip.exports.expectedExports;

    scope = await Effect.runPromise(Scope.make());
    const nativeLayer = platformModule
      .live({
        expectedExports,
        platform: process.platform,
        verifiedAddonPath: path.resolve(
          path.dirname(arguments_.manifestPath),
          manifest.capabilities.nativePip.addon,
        ),
      })
      .pipe(Layer.provide(callbackModule.layer));
    const nativeContext = await Effect.runPromise(Layer.buildWithScope(nativeLayer, scope));
    const native = Context.get(nativeContext, platformModule.RemoteHostedPipNativePlatform);
    report.availability = native.availability;
    await writeProgress("native-platform-built", { availability: native.availability });
    eventFiber = Effect.runFork(
      native.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            report.events.push({ at: new Date().toISOString(), event });
          }),
        ),
      ),
    );

    const display = screen.getPrimaryDisplay().workArea;
    const owner = new BrowserWindow({
      backgroundColor: "#0c1b24",
      frame: true,
      height: Math.min(520, display.height - 80),
      show: false,
      title: `Nodex Native PiP Evidence ${process.pid}`,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      width: Math.min(760, display.width - 80),
      x: display.x + 40,
      y: display.y + 40,
    });
    windows.push(owner);
    await owner.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        "<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:linear-gradient(135deg,#0b2530,#1d5160);color:white;font:700 42px system-ui;display:grid;place-items:center}small{font-size:16px;opacity:.8}</style><main>Native PiP evidence<br><small>disposable owner window</small></main>",
      )}`,
    );
    owner.showInactive();
    await writeProgress("owner-window-ready");
    await delay(250);
    const imageDataUrl = (await owner.webContents.capturePage()).toDataURL();
    const threadId = `native-evidence-thread-${process.pid}`;
    const presentationId = `browser:${JSON.stringify([threadId, "evidence-browser", "tab-1"])}`;
    const readReducedMotion = () => {
      try {
        return systemPreferences.getAnimationSettings().prefersReducedMotion;
      } catch {
        return null;
      }
    };
    const reduceMotion = readReducedMotion();
    report.reduceMotion = {
      effectiveAnimatedRegistration: reduceMotion !== true,
      systemPreference: reduceMotion,
      toggledByHarness: false,
    };
    native.setShouldShowTask((candidateThreadId) => candidateThreadId === threadId);

    const ownerRegistration = (animated) => {
      const bounds = owner.getContentBounds();
      return {
        anchorRect: {
          height: 104,
          width: 104,
          x: Math.max(0, bounds.width - 136),
          y: Math.max(0, bounds.height - 136),
        },
        anchors: [
          {
            alignment: "bottom-right",
            point: { x: Math.max(0, bounds.width - 28), y: Math.max(0, bounds.height - 28) },
          },
        ],
        animated,
        animationSpring: animated
          ? { damping: 26, initialVelocity: 0, mass: 1, stiffness: 260 }
          : null,
        contentBounds: bounds,
        id: "native-evidence-primary",
        interactionPassthroughRect: null,
        isCodexHomeAvailable: true,
        nativeWindowHandle: owner.getNativeWindowHandle(),
        presentationScope: "thread",
        title: owner.getTitle(),
      };
    };

    await snapshotWindows("00-owner-only");
    await writeProgress("native-operation-sequence-starting");
    await recordOperation(
      "start-host",
      native.startHost({
        closeTooltip: "Close Picture-in-Picture",
        hide: "Hide Picture-in-Picture",
        hideForAllActiveTasks: "Hide for all active tasks",
        hideForTask: "Hide for this task",
        placementTooltip: "Move Picture-in-Picture",
      }),
    );
    await recordOperation("set-max-display-size", native.setMaxDisplaySize(200));
    await recordOperation("register-primary-host", native.registerHost(ownerRegistration(false)));
    await recordOperation("set-suppressed-threads", native.setSuppressedThreadIds([]));
    await recordOperation("set-active-thread", native.setActiveThreadId(threadId));
    await recordOperation("refresh-visibility", native.refreshVisibility([threadId]));
    await recordOperation(
      "upsert-browser-presentation",
      native.upsertBrowserContent({
        appIconPath: null,
        imageDataUrl,
        presentationId,
        threadId,
      }),
    );
    await delay(650);
    await recordOperation("read-has-presentation", native.hasAnyPresentation);
    await recordOperation("read-active-task-ids", native.readActiveTaskIds);
    await recordOperation("read-layout-after-upsert", native.readLayoutState);
    await snapshotWindows("01-presentation");

    const movedBounds = owner.getBounds();
    owner.setBounds({
      height: Math.max(420, movedBounds.height - 40),
      width: Math.max(620, movedBounds.width - 60),
      x: Math.min(display.x + display.width - movedBounds.width, movedBounds.x + 120),
      y: Math.min(display.y + display.height - movedBounds.height, movedBounds.y + 80),
    });
    await delay(200);
    await recordOperation(
      "register-moved-primary-host",
      native.registerHost(ownerRegistration(reduceMotion !== true)),
    );
    await delay(500);
    await recordOperation("read-layout-after-move", native.readLayoutState);
    await snapshotWindows("02-moved-owner");

    const avatarWidth = Math.min(384, display.width);
    const avatarHeight = display.height;
    const avatar = new BrowserWindow({
      backgroundColor: "#00000000",
      focusable: false,
      frame: false,
      fullscreenable: false,
      hasShadow: false,
      height: avatarHeight,
      maximizable: false,
      minimizable: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      type: "panel",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      width: avatarWidth,
      x: display.x + display.width - avatarWidth,
      y: display.y,
    });
    windows.push(avatar);
    await avatar.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        "<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:transparent}.avatar{position:absolute;right:24px;bottom:24px;width:112px;height:121px;border-radius:50%;display:grid;place-items:center;background:#f3c956;font:700 16px system-ui;color:#302b1f}</style><div class=avatar>avatar host</div>",
      )}`,
    );
    avatar.setAlwaysOnTop(true, "floating");
    avatar.setVisibleOnAllWorkspaces(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    });
    avatar.showInactive();
    const avatarBounds = avatar.getContentBounds();
    const mascot = {
      height: 121,
      width: 112,
      x: avatarBounds.width - 112 - 24,
      y: avatarBounds.height - 121 - 24,
    };
    await recordOperation(
      "register-avatar-host",
      native.registerHost({
        anchorRect: mascot,
        anchors: [
          {
            alignment: "top-right",
            point: { x: mascot.x + mascot.width / 2, y: mascot.y + mascot.height / 2 },
          },
        ],
        animated: reduceMotion !== true,
        animationSpring:
          reduceMotion === true
            ? null
            : { damping: 18.85, initialVelocity: 0, mass: 1, stiffness: 180 },
        contentBounds: avatarBounds,
        id: "avatar-overlay",
        interactionPassthroughRect: mascot,
        isCodexHomeAvailable: false,
        nativeWindowHandle: avatar.getNativeWindowHandle(),
        presentationScope: "all",
        title: "Nodex Native PiP Evidence Avatar",
      }),
    );
    await delay(500);
    await recordOperation("read-layout-after-avatar-host", native.readLayoutState);
    await snapshotWindows("03-avatar-host");

    await recordOperation("complete-thread", native.completeThread(threadId));
    await delay(450);
    await snapshotWindows("04-completion-effect");
    await recordOperation(
      "invalidate-browser-presentation",
      native.invalidateBrowserContent(presentationId),
    );
    await delay(250);
    await recordOperation("read-has-presentation-after-invalidate", native.hasAnyPresentation);
    await recordOperation("unregister-avatar-host", native.unregisterHost("avatar-overlay"));
    await recordOperation(
      "unregister-primary-host",
      native.unregisterHost("native-evidence-primary"),
    );
    await recordOperation("clear-active-thread", native.setActiveThreadId(null));
    const stopped = await recordOperation("stop-host", native.stopHost);
    hostStopped = stopped.status === "success" && stopped.value === true;
    await delay(200);
    await snapshotWindows("05-stopped");
    await writeProgress("native-operation-sequence-complete");
  } catch (error) {
    report.fatalError = serializeError(error);
    await writeProgress("fixture-failed", { error: report.fatalError });
  } finally {
    await writeProgress("teardown-starting");
    if (eventFiber) await Effect.runPromise(Fiber.interrupt(eventFiber)).catch(() => undefined);
    await writeProgress("event-fiber-interrupted");
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch((error) => {
        report.scopeCloseError = serializeError(error);
      });
      report.teardown.scopeClosed = true;
    }
    await writeProgress("effect-scope-closed");
    for (const window of windows.toReversed()) {
      if (!window.isDestroyed()) window.destroy();
    }
    report.teardown.hostStopped = hostStopped;
    report.teardown.windowsDestroyed = windows.every((window) => window.isDestroyed());
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (listOwnedMacOSWindows(windowEnumerator, process.pid).rows.length === 0) break;
      await delay(50);
    }
    await snapshotWindows("06-process-window-baseline");
    await writeProgress("fixture-windows-destroyed", { teardown: report.teardown });
    await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeProgress("fixture-result-written");
    unregisterTsx();
    app.quit();
  }
}

async function spawnFixture(input) {
  const requireFromProbe = createRequire(import.meta.url);
  const electronExecutable = path.resolve(input.electronExecutable ?? requireFromProbe("electron"));
  const electronBundlePath = electronExecutable.includes(".app/")
    ? electronExecutable.slice(0, electronExecutable.indexOf(".app/") + 4)
    : electronExecutable;
  const signatureVerification = commandEvidence("/usr/bin/codesign", [
    "--verify",
    "--strict",
    electronBundlePath,
  ]);
  const signatureDetails = commandEvidence("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    electronBundlePath,
  ]);
  const teamId = signatureDetails.stderr.match(/^TeamIdentifier=(.+)$/mu)?.[1] ?? null;
  const authority = signatureDetails.stderr.match(/^Authority=(.+)$/mu)?.[1] ?? null;
  const hostIdentity = {
    authority,
    developerIdVerified:
      signatureVerification.exitCode === 0 &&
      teamId !== null &&
      teamId !== "not set" &&
      authority?.startsWith("Developer ID Application:") === true,
    executablePath: electronExecutable,
    inspectedBundlePath: electronBundlePath,
    signatureVerified: signatureVerification.exitCode === 0,
    signingTeamId: teamId,
  };
  const environment = { ...process.env, NODE_ENV: "test" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronExecutable,
    [
      fileURLToPath(import.meta.url),
      FIXTURE_FLAG,
      `--manifest=${input.manifestPath}`,
      `--result=${input.resultPath}`,
      ...(input.capture ? [] : ["--no-capture"]),
    ],
    {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", timedOut: true });
    }, PROBE_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut: false });
    });
  });
  return {
    ...exit,
    hostIdentity,
    stderr: stderr.slice(-16_384),
    stdout: stdout.slice(-16_384),
  };
}

function defaultOutputDirectory() {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  return path.join(repositoryRoot, "runs.local", "remote-hosted-pip", "native", timestamp);
}

export async function runNativeProbe(arguments_ = parseProbeArguments()) {
  assertNativeUiOptIn(arguments_);
  if (process.platform !== "darwin") throw new Error("Signed native PiP evidence requires macOS");
  const provenance = await inspectNativeRuntime(arguments_.runtimeRoot ?? DEFAULT_RUNTIME_ROOT);
  if (!provenance.addon.hashVerified || !provenance.addon.signatureVerified) {
    throw new Error("Native runtime failed manifest hash or Developer ID verification");
  }
  if (provenance.manifest.targetArch !== process.arch) {
    throw new Error(
      `Native runtime architecture ${provenance.manifest.targetArch} does not match ${process.arch}`,
    );
  }
  const outputDirectory = path.resolve(arguments_.outputDirectory ?? defaultOutputDirectory());
  const fixtureResultPath = path.join(outputDirectory, "fixture-result.json");
  await mkdir(outputDirectory, { recursive: true });
  const fixtureProcess = await spawnFixture({
    capture: arguments_.capture,
    electronExecutable: arguments_.electronExecutable,
    manifestPath: provenance.manifest.path,
    resultPath: fixtureResultPath,
  });
  let fixtureReport;
  try {
    fixtureReport = JSON.parse(await readFile(fixtureResultPath, "utf8"));
  } catch (error) {
    fixtureReport = { fatalError: serializeError(error), operations: [], teardown: {} };
  }
  const classification = classifyNativeEvidence(
    fixtureReport,
    provenance,
    fixtureProcess.hostIdentity,
  );
  const provenClaims = [
    "the manifest-pinned Developer ID signed addon passes static identity verification",
  ];
  if (fixtureReport.availability?.status === "available") {
    provenClaims.push("the signed addon loads through RemoteHostedPipNativePlatform");
  }
  if (classification.presentationObserved) {
    provenClaims.push("a disposable Electron native window admits Browser PiP presentation state");
  }
  if (classification.nativeWindowsObserved) {
    provenClaims.push("the signed addon creates process-owned native window surfaces");
  }
  if (classification.windowAssertions.panelHierarchyObserved) {
    provenClaims.push(
      "the Browser presentation is a co-located pair of NSPanel windows parented to the disposable owner",
    );
  }
  if (classification.windowAssertions.calayerHierarchyObserved) {
    provenClaims.push(
      "the content and controls panels expose the expected PIPStackContentView and CALayer composition",
    );
  }
  if (classification.windowAssertions.nativeWindowsFollowedOwner) {
    provenClaims.push("both native panel window IDs follow a disposable owner move and resize");
  }
  if (classification.windowAssertions.avatarHostWindowObserved) {
    provenClaims.push(
      "a production-shaped transparent avatar host window can coexist without stealing the primary host",
    );
  }
  if (classification.windowAssertions.completionEffectLayerObserved) {
    provenClaims.push("thread completion installs the named native completion CALayer");
  }
  if (classification.teardownPassed) {
    provenClaims.push("the scoped host and disposable Electron windows tear down to baseline");
  }
  const report = {
    classification,
    evidence: {
      doesNotProve: [
        "Computer Use CALayer producer transport because the harness never spawns or connects it",
        "real Chrome extension/native-messaging routing",
        "Browser PiP click callback because safe automation does not inject a global mouse event",
        "placement-control transfer from the primary owner to the avatar host",
        "native drag and resize gestures because the harness does not synthesize pointer input",
        "Reduce Motion transition parity unless the read-only system preference was already enabled",
        "a packaged and notarized Nodex distribution because the host is a disposable Electron copy signed only for this test",
        "x86_64 behavior because this run requires a native x86_64 host and machine",
        "pre-exit NSPanel object deallocation; stop hides and detaches the panels before the disposable process exits",
        ...(classification.signedHost
          ? []
          : [
              "release-signed host admission because the disposable Electron executable has no Developer ID team",
            ]),
      ],
      observableBlockers: [
        ...(classification.hostStartAccepted
          ? []
          : [
              "startRemoteHostedPIPContentHost returned false without a native error payload; presentation upsert was consequently rejected",
            ]),
      ],
      productionBrowserTouched: false,
      productionNodexTouched: false,
      productionWindowTouched: false,
      proves: provenClaims,
      tier: "signed-native-disposable-host",
    },
    fixture: fixtureReport,
    fixtureProcess,
    outputDirectory,
    provenance,
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
  };
  const reportPath = path.join(outputDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ reportPath, report }, null, 2)}\n`);
  return report;
}

const arguments_ = parseProbeArguments();
if (arguments_.fixture) {
  // Electron emits `ready` only after the ESM entry module finishes evaluating. Keep the
  // fixture promise off the top-level-await chain or `app.whenReady()` deadlocks forever.
  void runElectronFixture(arguments_).catch(async (error) => {
    const resultPath = arguments_.resultPath ? path.resolve(arguments_.resultPath) : null;
    if (resultPath) {
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(
        path.join(path.dirname(resultPath), "progress.json"),
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            error: serializeError(error),
            fixturePid: process.pid,
            stage: "fixture-promise-rejected",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    if (arguments_.resultPath) {
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(
        resultPath,
        `${JSON.stringify(
          {
            availability: null,
            fatalError: serializeError(error),
            fixturePid: process.pid,
            operations: [],
            schemaVersion: 1,
            teardown: { hostStopped: false, scopeClosed: false, windowsDestroyed: true },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    const { app } = await import("electron");
    app.quit();
    process.exitCode = 1;
  });
} else {
  const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
  if (entryPath === import.meta.url) {
    const report = await runNativeProbe(arguments_);
    process.exitCode = nativeProbeExitCode(report);
  }
}
