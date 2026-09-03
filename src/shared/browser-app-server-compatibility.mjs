/**
 * Browser peers and the primary app-server are independently supplied.
 * Compatibility is therefore an exact, conformance-tested artifact relation,
 * not a version-ordering guess between two unrelated Codex executables.
 */
export const TESTED_BROWSER_APP_SERVER_PAIRS = Object.freeze([
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "48563e2a0948dcc584b96ab52a98c117aa7216c0ffb653aaf62779871e48c677",
      protocolSchemaFingerprint: "e430c82b7ea1e6c8ddc2ba530318a9c01a4bb4be5ceaf6e2233e735905209f8f",
      runtimeVersion: "0.152.0",
      sourceCommit: "316795b3cf2a45e90d121d9f46499d4658b2645c",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.825.32147",
      manifestSha256: "c28a690685f2394b404d4c8bacb80fc03e38bfbdf0272706aa436321bf75091e",
      peerCliVersion: "0.150.0-alpha.12.2",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "9d5bc18517f418c722d46ef1afb4b4ef10d0965ef4a288e5db8ad2bcc24588b2",
      protocolSchemaFingerprint: "e430c82b7ea1e6c8ddc2ba530318a9c01a4bb4be5ceaf6e2233e735905209f8f",
      runtimeVersion: "0.152.0",
      sourceCommit: "316795b3cf2a45e90d121d9f46499d4658b2645c",
      targetArch: "x64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.825.32147",
      manifestSha256: "ab1d423b00afe26bbca6f137a686e1ef2d6f42f246bc6d0f33b6167910ea8285",
      peerCliVersion: "0.150.0-alpha.12.2",
      targetArch: "x64",
      targetPlatform: "darwin",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "48563e2a0948dcc584b96ab52a98c117aa7216c0ffb653aaf62779871e48c677",
      protocolSchemaFingerprint: "e430c82b7ea1e6c8ddc2ba530318a9c01a4bb4be5ceaf6e2233e735905209f8f",
      runtimeVersion: "0.152.0",
      sourceCommit: "316795b3cf2a45e90d121d9f46499d4658b2645c",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.901.20858",
      manifestSha256: "8fe63a61005577d552fd423fa8324b819a42b55a785246495e339fadf23d40ab",
      peerCliVersion: "0.153.0-alpha.5",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "9d5bc18517f418c722d46ef1afb4b4ef10d0965ef4a288e5db8ad2bcc24588b2",
      protocolSchemaFingerprint: "e430c82b7ea1e6c8ddc2ba530318a9c01a4bb4be5ceaf6e2233e735905209f8f",
      runtimeVersion: "0.152.0",
      sourceCommit: "316795b3cf2a45e90d121d9f46499d4658b2645c",
      targetArch: "x64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.901.20858",
      manifestSha256: "5642c413834d0a48fb1daa9cd7b19cceeaa16650d3b1d6357528dad3632e0b30",
      peerCliVersion: "0.153.0-alpha.5",
      targetArch: "x64",
      targetPlatform: "darwin",
    }),
  }),
]);

const identitiesEqual = (left, right) => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
};

export function isTestedBrowserAppServerPair(
  appServer,
  browser,
  testedPairs = TESTED_BROWSER_APP_SERVER_PAIRS,
) {
  return testedPairs.some(
    (pair) => identitiesEqual(pair.appServer, appServer) && identitiesEqual(pair.browser, browser),
  );
}

export function projectBundledAppServerRuntimeIdentity(metadata) {
  return {
    entrypointSha256: metadata.releaseAsset.entrypointSha256,
    protocolSchemaFingerprint: metadata.protocolSchemaFingerprint,
    runtimeVersion: metadata.appServerRuntimeVersion,
    sourceCommit: metadata.sourceRevision.commit,
    targetArch: metadata.targetArch,
    targetPlatform: metadata.targetPlatform,
  };
}

export function projectBrowserPeerRuntimeIdentity(metadata, manifestSha256) {
  return {
    browserPluginVersion: metadata.browserPlugin.version,
    manifestSha256,
    peerCliVersion: metadata.runtimeVersions.codexCli,
    targetArch: metadata.targetArch,
    targetPlatform: metadata.targetPlatform,
  };
}
