import * as Effect from "effect/Effect";

import { runProcessMain } from "../../../src/main/app/EffectProcessEntry";

const program = Effect.callback<void>((resume) => {
  const onSigint = (): void => {
    process.stdout.write("handled\n");
    resume(Effect.void);
  };
  process.once("SIGINT", onSigint);
  process.stdout.write("ready\n");
  return Effect.sync(() => process.removeListener("SIGINT", onSigint));
}).pipe(Effect.ensuring(Effect.sync(() => process.stdout.write("cleaned\n"))));

runProcessMain(program, { disableErrorReporting: true });
