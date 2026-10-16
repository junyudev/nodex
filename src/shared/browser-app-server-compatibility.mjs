/**
 * Browser peers and the primary app-server are independently supplied.
 * Compatibility is therefore an exact, conformance-tested artifact relation,
 * not a version-ordering guess between two unrelated Codex executables.
 */
export const TESTED_BROWSER_APP_SERVER_PAIRS = Object.freeze([
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31",
      protocolSchemaFingerprint: "b2499a5f8a61d8a66923b91b4929548240d1f5a366867662eaca8e075096cf8e",
      runtimeVersion: "0.163.0",
      sourceCommit: "83086188ae0614bd882818ff1aa23f3194962012",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1007.71326",
      manifestSha256: "7970c6ac859db710949ad5cb0c3202eb5a1a3bac794f59be5511694a76f7d651",
      peerCliVersion: "0.162.0-alpha.17.2",
      targetArch: "arm64",
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
