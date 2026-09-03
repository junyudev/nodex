import { describe, expect, test } from "vite-plus/test";
import {
  assertNativeUiOptIn,
  classifyNativeEvidence,
  inspectNativeRuntime,
  nativeProbeExitCode,
  parseProbeArguments,
} from "./probe-remote-hosted-pip-native.mjs";

const verifiedProvenance = {
  addon: { hashVerified: true, signatureVerified: true },
};

describe("Remote Hosted PiP native evidence probe", () => {
  test("requires capture by default and accepts an explicit no-capture evidence run", () => {
    expect(parseProbeArguments([])).toMatchObject({
      allowNativeUi: false,
      capture: true,
      fixture: false,
    });
    expect(
      parseProbeArguments([
        "--allow-native-ui",
        "--no-capture",
        "--electron-executable=/tmp/Electron.app/Contents/MacOS/Electron",
        "--runtime-root=/tmp/runtime",
        "--out-dir=/tmp/evidence",
      ]),
    ).toMatchObject({
      allowNativeUi: true,
      capture: false,
      electronExecutable: "/tmp/Electron.app/Contents/MacOS/Electron",
      fixture: false,
      outputDirectory: "/tmp/evidence",
      runtimeRoot: "/tmp/runtime",
    });
  });

  test("requires an explicit native-window opt-in before running the dynamic probe", () => {
    expect(() => assertNativeUiOptIn({ allowNativeUi: false })).toThrow(
      "rerun with --allow-native-ui",
    );
    expect(() => assertNativeUiOptIn({ allowNativeUi: true })).not.toThrow();
  });

  test("returns a failing process status unless the full dynamic classification passed", () => {
    expect(nativeProbeExitCode({ classification: { dynamicPathPassed: true } })).toBe(0);
    expect(nativeProbeExitCode({ classification: { dynamicPathPassed: false } })).toBe(1);
    expect(nativeProbeExitCode({})).toBe(1);
  });

  test("does not call an unsigned-host partial run full signed-native evidence", () => {
    const classification = classifyNativeEvidence(
      {
        operations: [
          { name: "start-host", status: "success", value: false },
          { name: "register-primary-host", status: "success", value: true },
        ],
        teardown: { hostStopped: true, scopeClosed: true, windowsDestroyed: true },
        windowEvidence: {
          stages: [
            {
              name: "06-process-window-baseline",
              nativePanelCandidates: 0,
              rows: [],
            },
          ],
        },
      },
      verifiedProvenance,
      { developerIdVerified: false },
    );

    expect(classification).toMatchObject({
      dynamicPathPassed: false,
      evidenceGrade: "signed-addon-unsigned-host-partial",
      hostStartAccepted: false,
      processWindowsReturnedToBaseline: true,
      signedHost: false,
      signedRuntime: true,
      status: "partial",
      teardownPassed: true,
    });
  });

  test("requires the complete Platform sequence, a presentation, and process-window teardown", () => {
    const successfulOperations = [
      "start-host",
      "set-max-display-size",
      "register-primary-host",
      "set-suppressed-threads",
      "set-active-thread",
      "refresh-visibility",
      "upsert-browser-presentation",
      "read-has-presentation",
      "register-moved-primary-host",
      "register-avatar-host",
      "complete-thread",
      "invalidate-browser-presentation",
      "unregister-avatar-host",
      "unregister-primary-host",
      "clear-active-thread",
      "stop-host",
    ].map((name) => ({ name, status: "success", value: true }));
    successfulOperations.push(
      {
        name: "read-has-presentation-after-invalidate",
        status: "success",
        value: false,
      },
      {
        name: "read-active-task-ids",
        status: "success",
        value: ["native-evidence-thread-42"],
      },
      ...[
        "read-layout-after-upsert",
        "read-layout-after-move",
        "read-layout-after-avatar-host",
      ].map((name) => ({
        name,
        status: "success",
        value: { currentHostID: "native-evidence-primary", stackDisplayHeight: 240 },
      })),
    );
    const presentationNativeRows = [
      { bounds: { height: 200, width: 320, x: 100, y: 100 }, id: 42, name: "Computer Use" },
      {
        bounds: { height: 200, width: 320, x: 100, y: 100 },
        id: 43,
        name: "Computer Use Controls",
      },
    ];
    const introspectionRows = presentationNativeRows.map((row) => ({
      class: "NSPanel",
      classChain: ["NSPanel", "NSWindow", "NSObject"],
      contentLayerTree: {
        class: "NSViewBackingLayer",
        name: "PIPStackContentView",
        sublayers:
          row.name === "Computer Use"
            ? [
                {
                  class: "CALayer",
                  cornerRadius: 8,
                  frame: { height: 180, width: 300 },
                  masksToBounds: true,
                  sublayers: [],
                },
              ]
            : [
                { class: "CABackdropLayer", sublayers: [] },
                { class: "CATextLayer", sublayers: [] },
                {
                  class: "CALayer",
                  name: "remote-hosted-pip-control-blur-mask-fixture",
                  sublayers: [],
                },
              ],
      },
      contentViewTree: {
        class: "PIPStackContentView",
        classChain: ["PIPStackContentView", "NSView", "NSObject"],
      },
      isPanel: true,
      layerNodeCount: 4,
      parentWindowNumber: 99,
      title: row.name,
      windowNumber: row.id,
    }));
    const classification = classifyNativeEvidence(
      {
        availability: { status: "available" },
        operations: successfulOperations,
        reduceMotion: {
          effectiveAnimatedRegistration: true,
          systemPreference: false,
          toggledByHarness: false,
        },
        teardown: { hostStopped: true, scopeClosed: true, windowsDestroyed: true },
        windowEvidence: {
          stages: [
            {
              browserWindowIds: [99],
              name: "01-presentation",
              nativeIntrospectionRows: introspectionRows,
              nativePanelCandidates: 2,
              nativeRows: presentationNativeRows,
              rows: presentationNativeRows,
            },
            {
              name: "02-moved-owner",
              nativePanelCandidates: 2,
              nativeRows: presentationNativeRows.map((row) => ({
                ...row,
                bounds: { ...row.bounds, x: 160, y: 140 },
              })),
              rows: [],
            },
            {
              browserWindowIds: [99, 100],
              name: "03-avatar-host",
              nativeIntrospectionRows: [
                ...introspectionRows.map((row) => ({
                  ...row,
                  isVisible: true,
                  parentWindowNumber: 99,
                })),
                {
                  class: "ElectronNSPanel",
                  classChain: ["ElectronNSPanel", "ElectronNSWindow", "NSWindow"],
                  frame: { height: 800, width: 384, x: 1000, y: 0 },
                  isOpaque: false,
                  isPanel: false,
                  isVisible: true,
                  parentWindowNumber: null,
                  title: "Nodex Native PiP Evidence",
                  windowNumber: 100,
                },
              ],
              nativePanelCandidates: 2,
              nativeRows: presentationNativeRows,
              rows: [],
            },
            {
              name: "04-completion-effect",
              nativeIntrospectionRows: introspectionRows.map((row) =>
                row.title === "Computer Use"
                  ? {
                      ...row,
                      contentLayerTree: {
                        ...row.contentLayerTree,
                        sublayers: [
                          ...row.contentLayerTree.sublayers,
                          {
                            class: "CALayer",
                            name: "remote-hosted-pip-completion",
                            sublayers: [],
                          },
                        ],
                      },
                    }
                  : row,
              ),
              nativePanelCandidates: 2,
              nativeRows: presentationNativeRows,
              rows: [],
            },
            {
              name: "05-stopped",
              nativeIntrospectionRows: introspectionRows.map((row) => ({
                ...row,
                isVisible: false,
                parentWindowNumber: null,
              })),
              nativePanelCandidates: 0,
              nativeRows: [],
              rows: [],
            },
            {
              name: "06-process-window-baseline",
              nativePanelCandidates: 0,
              nativeRows: [],
              rows: [],
            },
          ],
        },
      },
      verifiedProvenance,
      { developerIdVerified: true },
    );

    expect(classification).toMatchObject({
      dynamicPathPassed: true,
      evidenceGrade: "signed-addon-and-host-window-observed",
      failedAssertions: [],
      failedOperations: [],
      nativeWindowsObserved: true,
      presentationObserved: true,
      processWindowsReturnedToBaseline: true,
      signedHost: true,
      status: "passed",
      teardownPassed: true,
      windowAssertions: {
        avatarHostWindowObserved: true,
        calayerHierarchyObserved: true,
        completionEffectLayerObserved: true,
        nativePanelClassObserved: true,
        nativePanelsDetachedAndHiddenAfterStop: true,
        nativePanelsParentedToOwner: true,
        nativePanelsRemovedAfterStop: true,
        nativePanelsStayedOnPrimaryWithAvatarObserved: true,
        nativeWindowPairObserved: true,
        nativeWindowsFollowedOwner: true,
        panelHierarchyObserved: true,
        pipStackContentHierarchyObserved: true,
      },
    });
  });

  test("does not promote generic native windows without an AppKit/CALayer hierarchy", () => {
    const operations = [
      "start-host",
      "set-max-display-size",
      "register-primary-host",
      "set-suppressed-threads",
      "set-active-thread",
      "refresh-visibility",
      "upsert-browser-presentation",
      "read-has-presentation",
      "register-moved-primary-host",
      "register-avatar-host",
      "complete-thread",
      "invalidate-browser-presentation",
      "unregister-avatar-host",
      "unregister-primary-host",
      "clear-active-thread",
      "stop-host",
    ].map((name) => ({ name, status: "success", value: true }));
    operations.push({
      name: "read-has-presentation-after-invalidate",
      status: "success",
      value: false,
    });
    const classification = classifyNativeEvidence(
      {
        availability: { status: "available" },
        operations,
        reduceMotion: {
          effectiveAnimatedRegistration: true,
          systemPreference: false,
          toggledByHarness: false,
        },
        teardown: { hostStopped: true, scopeClosed: true, windowsDestroyed: true },
        windowEvidence: {
          stages: [
            {
              name: "01-presentation",
              nativePanelCandidates: 1,
              nativeRows: [{ bounds: { x: 1, y: 1 }, id: 42, name: "unknown" }],
              rows: [],
            },
            { name: "05-stopped", nativePanelCandidates: 0, nativeRows: [], rows: [] },
            { name: "06-process-window-baseline", rows: [] },
          ],
        },
      },
      verifiedProvenance,
      { developerIdVerified: true },
    );

    expect(classification.dynamicPathPassed).toBe(false);
    expect(classification.failedAssertions).toEqual(
      expect.arrayContaining([
        "active-task-state-observed",
        "primary-layout-observed",
        "native-window-pair-observed",
        "appkit-panel-hierarchy-observed",
        "calayer-hierarchy-observed",
      ]),
    );
  });

  test.runIf(process.platform === "darwin")(
    "verifies the manifest-pinned production addon without loading it",
    async () => {
      const provenance = await inspectNativeRuntime();

      expect(provenance).toMatchObject({
        addon: {
          architecture: process.arch === "x64" ? "x86_64" : process.arch,
          hashVerified: true,
          signatureVerified: true,
          signingTeamId: "2DC432GLL2",
        },
        manifest: {
          targetArch: process.arch,
          targetPlatform: "darwin",
        },
      });
    },
  );
});
