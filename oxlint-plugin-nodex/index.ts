import { definePlugin } from "@oxlint/plugins";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noAmbientProfileAuthority from "./rules/no-ambient-profile-authority.ts";
import noCastRuntimeSnapshotFixtures from "./rules/no-cast-runtime-snapshot-fixtures.ts";
import noTestingLibraryWaitInAct from "./rules/no-testing-library-wait-in-act.ts";

export default definePlugin({
  meta: {
    name: "nodex",
  },
  rules: {
    "no-ambient-profile-authority": noAmbientProfileAuthority,
    "no-cast-runtime-snapshot-fixtures": noCastRuntimeSnapshotFixtures,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-testing-library-wait-in-act": noTestingLibraryWaitInAct,
  },
});
