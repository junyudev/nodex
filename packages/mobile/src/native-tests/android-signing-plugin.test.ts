import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  withReleaseSigning,
}: {
  withReleaseSigning: (gradle: string) => string;
} = require("../../plugins/withAndroidReleaseSigning.cjs");

// The signing blocks of the React Native app template, which prebuild regenerates each time.
const template = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

const releaseSigning = (gradle: string) =>
  /release \{\n\s+signingConfig ([^\n]+)\n\s+minifyEnabled/u.exec(gradle)?.[1];

it("signs release builds with the pipeline's keystore and keeps debug builds on debug signing", () => {
  const gradle = withReleaseSigning(template);
  expect(releaseSigning(gradle)).toBe(
    'System.getenv("NODEX_ANDROID_KEYSTORE") ? signingConfigs.release : signingConfigs.debug',
  );
  expect(gradle).toMatch(/debug \{\n\s+signingConfig signingConfigs\.debug/u);
  expect(gradle).toMatch(/storeFile file\(keystore\)/u);
  expect(withReleaseSigning(gradle)).toBe(gradle);
});

it("fails the build rather than ship an unsigned release when the template changes", () => {
  expect(() => withReleaseSigning("android {\n}\n")).toThrow("signing configuration");
});
