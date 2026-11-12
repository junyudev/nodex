/**
 * Browser peers and the primary app-server are independently supplied.
 * Compatibility is therefore an exact, conformance-tested artifact relation,
 * not a version-ordering guess between two unrelated Codex executables.
 */
export const TESTED_BROWSER_APP_SERVER_PAIRS = Object.freeze([
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0",
      protocolSchemaFingerprint: "6fa0fe27be2847f726cb5b4a361bf2033455ee22e52124751e7e18d079b0c4fd",
      runtimeVersion: "0.167.2",
      sourceCommit: "ce21072c90d32c40af7a55b60b2fb35c84a43a6a",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1103.60933",
      manifestSha256: "ff41f0236459ab8b433d9b4a937ac8da8603466841824781a40bdcdcc3bbd635",
      peerCliVersion: "0.167.0-alpha.3.2",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1",
      protocolSchemaFingerprint: "8261ecaf2cf5a159d1f02e84df9b6404a47d047116412f20d08df71192d27491",
      runtimeVersion: "0.166.0",
      sourceCommit: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1027.51404",
      manifestSha256: "c69c126c75637ede3e2a5c2616a3dab8f63e2dde6f44366e248b24c2bcaa7ab8",
      peerCliVersion: "0.166.0-alpha.5.1",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "9d563ee4e0441ff9d59d612013e0460ddf8e5709735c2d9f6b98b7ef8ca4eb42",
      protocolSchemaFingerprint: "8261ecaf2cf5a159d1f02e84df9b6404a47d047116412f20d08df71192d27491",
      runtimeVersion: "0.166.0",
      sourceCommit: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
      targetArch: "x64",
      targetPlatform: "win32",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1027.51404",
      manifestSha256: "e6ce0450de8b15bb90f82adbf79298c79e5ebe47ba5c0af7d90ab96f7c603896",
      peerCliVersion: "0.166.0-alpha.5.1",
      targetArch: "x64",
      targetPlatform: "win32",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "d92bb6a3259980a742049882f396eb09eb26734589accc7f2c5173b7ab926138",
      protocolSchemaFingerprint: "8261ecaf2cf5a159d1f02e84df9b6404a47d047116412f20d08df71192d27491",
      runtimeVersion: "0.166.0",
      sourceCommit: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
      targetArch: "arm64",
      targetPlatform: "win32",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1027.51404",
      manifestSha256: "ff73b2c5f103c0ac648e926a0bc387c6af9a226bbf1dc5d65dbabb278380b1e6",
      peerCliVersion: "0.166.0-alpha.5.1",
      targetArch: "arm64",
      targetPlatform: "win32",
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
