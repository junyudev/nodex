/**
 * Browser peers and the primary app-server are independently supplied.
 * Compatibility is therefore an exact, conformance-tested artifact relation,
 * not a version-ordering guess between two unrelated Codex executables.
 */
export const TESTED_BROWSER_APP_SERVER_PAIRS = Object.freeze([
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "cefea4ffee1fff04983a99c0dda99944d8b380e891e740a28b32f4b815a6e0b7",
      protocolSchemaFingerprint: "638e48fb7211e9391e375c357671ac4ded4b11735d584a3b1e1252852978771a",
      runtimeVersion: "0.171.0",
      sourceCommit: "ccf9be8cc458bd6b8336fe84d68d8893f2691a5e",
      targetArch: "x64",
      targetPlatform: "win32",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1117.41037",
      manifestSha256: "28d902e9bfab05a37e0e280c7dceaa2d6cf7e27166ac4daec402919a58493afa",
      peerCliVersion: "0.171.0-alpha.13",
      targetArch: "x64",
      targetPlatform: "win32",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "33a3248aa0f0b31b69a987658915517b0faed6498956ad823396353845033730",
      protocolSchemaFingerprint: "638e48fb7211e9391e375c357671ac4ded4b11735d584a3b1e1252852978771a",
      runtimeVersion: "0.171.0",
      sourceCommit: "ccf9be8cc458bd6b8336fe84d68d8893f2691a5e",
      targetArch: "arm64",
      targetPlatform: "win32",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1117.41037",
      manifestSha256: "a8134a9f87bc9c4e0862df17a3596e1e1b2b4aba59998d4a3fcb4726a3e30e3d",
      peerCliVersion: "0.171.0-alpha.13",
      targetArch: "arm64",
      targetPlatform: "win32",
    }),
  }),
  Object.freeze({
    appServer: Object.freeze({
      entrypointSha256: "fc8d77cf7585aded2b9bc487dad29c4ee2f066123e4e76dd3b17653a8322ce42",
      protocolSchemaFingerprint: "638e48fb7211e9391e375c357671ac4ded4b11735d584a3b1e1252852978771a",
      runtimeVersion: "0.171.0",
      sourceCommit: "ccf9be8cc458bd6b8336fe84d68d8893f2691a5e",
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
    browser: Object.freeze({
      browserPluginVersion: "26.1117.41037",
      manifestSha256: "cd520a3bd3b74a356454cd3aa1f8fec176a9fc90c819abed5c94069f2395aeb1",
      peerCliVersion: "0.171.0-alpha.13",
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
