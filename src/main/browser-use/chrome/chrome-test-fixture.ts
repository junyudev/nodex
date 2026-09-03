import { parseChromeBrowserAuthority } from "./ChromeBrowserFamilyRegistry";

export const TEST_CHROME_EXTENSION_IDS = [
  "hehggadaopoacecdllhhajmbjkdcmajg",
  "odlomjlbamekndcpllcnffbgeohgkmjh",
] as const;

export const TEST_CHROME_HOST_NAME = "com.openai.codexextension";

export const TEST_CHROME_FAMILY_DESCRIPTOR = {
  browserDiagnostics: [
    {
      browserFamily: "chrome",
      displayName: "Google Chrome",
      extensionIds: TEST_CHROME_EXTENSION_IDS,
      extensionManagementUrl: "chrome://extensions",
      macos: {
        applicationNames: ["Google Chrome.app"],
        bundleId: "com.google.Chrome",
        nativeMessagingManifestDirectories: [
          "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        ],
        processNames: ["Google Chrome", "Google Chrome Helper"],
        userDataDirectorySegments: ["Library", "Application Support", "Google", "Chrome"],
      },
      shortDisplayName: "Chrome",
      storeUrl: "https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg",
    },
    {
      browserFamily: "edge",
      displayName: "Microsoft Edge",
      extensionIds: TEST_CHROME_EXTENSION_IDS,
      extensionManagementUrl: "edge://extensions",
      macos: {
        applicationNames: ["Microsoft Edge.app"],
        bundleId: "com.microsoft.edgemac",
        nativeMessagingManifestDirectories: [
          "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        ],
        processNames: ["Microsoft Edge", "Microsoft Edge Helper"],
        userDataDirectorySegments: ["Library", "Application Support", "Microsoft Edge"],
      },
      shortDisplayName: "Edge",
      storeUrl:
        "https://microsoftedge.microsoft.com/addons/detail/odlomjlbamekndcpllcnffbgeohgkmjh",
    },
  ],
  browserExtensions: [
    {
      browserFamily: "chrome",
      browserIconAssetPath: "assets/google-chrome.png",
      extensionIds: TEST_CHROME_EXTENSION_IDS,
      storeExtensionId: TEST_CHROME_EXTENSION_IDS[0],
      storeUrl: "https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg",
    },
    {
      browserFamily: "edge",
      browserIconAssetPath: "assets/microsoft-edge.svg",
      extensionIds: TEST_CHROME_EXTENSION_IDS,
      storeExtensionId: TEST_CHROME_EXTENSION_IDS[1],
      storeUrl:
        "https://microsoftedge.microsoft.com/addons/detail/odlomjlbamekndcpllcnffbgeohgkmjh",
    },
  ],
  extensionHostName: TEST_CHROME_HOST_NAME,
  extensionIds: TEST_CHROME_EXTENSION_IDS,
};

export const TEST_CHROME_AUTHORITY = parseChromeBrowserAuthority(TEST_CHROME_FAMILY_DESCRIPTOR, {
  extensionIds: TEST_CHROME_EXTENSION_IDS,
  hostName: TEST_CHROME_HOST_NAME,
});
