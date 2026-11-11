import requireTestSkipReason from "./rules/require-test-skip-reason.ts";
import noTestRetries from "./rules/no-test-retries.ts";
import noWallClockInTests from "./rules/no-wall-clock-in-tests.ts";
import noPollingLoopInTests from "./rules/no-polling-loop-in-tests.ts";
import noRealTimeWaitInTests from "./rules/no-real-time-wait-in-tests.ts";
import noExplicitTestTimeout from "./rules/no-explicit-test-timeout.ts";
import noDirectWebContentsDestructionListener from "./rules/no-direct-webcontents-destruction-listener.ts";
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
    "require-test-skip-reason": requireTestSkipReason,
    "no-test-retries": noTestRetries,
    "no-wall-clock-in-tests": noWallClockInTests,
    "no-polling-loop-in-tests": noPollingLoopInTests,
    "no-real-time-wait-in-tests": noRealTimeWaitInTests,
    "no-explicit-test-timeout": noExplicitTestTimeout,
    "no-direct-webcontents-destruction-listener": noDirectWebContentsDestructionListener,
    "no-ambient-profile-authority": noAmbientProfileAuthority,
    "no-cast-runtime-snapshot-fixtures": noCastRuntimeSnapshotFixtures,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-testing-library-wait-in-act": noTestingLibraryWaitInAct,
  },
});
