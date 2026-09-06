export interface ExactRemoteSubscriptionLifecycle<Result> {
  ensure(): Promise<Result>;
  /** Invoke at the admission boundary; do not await again before sending the command. */
  run<CommandResult>(
    command: (subscription: Result) => Promise<CommandResult>,
  ): Promise<CommandResult>;
  /** Main has retired this logical session; an in-flight open is no longer evidence. */
  invalidate(): void;
  releaseIfIdle(): void;
}

export const createExactRemoteSubscriptionLifecycle = <Result>(input: {
  readonly hasSubscribers: () => boolean;
  readonly open: () => Promise<Result>;
  readonly isOpenResult: (result: Result) => boolean;
  readonly alreadyOpenResult: () => Result;
  readonly inactiveResult: () => Result;
  readonly close: () => Promise<unknown>;
  readonly finalize: () => void;
}): ExactRemoteSubscriptionLifecycle<Result> => {
  let disposed = false;
  let remoteOpen = false;
  let opening: Promise<Result> | null = null;
  let closing: Promise<void> | null = null;
  let version = 0;
  let admissionVersion = 0;

  const ensure = (): Promise<Result> => {
    if (disposed || !input.hasSubscribers()) return Promise.resolve(input.inactiveResult());
    if (closing) return closing.then(ensure);
    if (remoteOpen) return Promise.resolve(input.alreadyOpenResult());
    if (opening) return opening;
    const openingVersion = version;
    const command = input
      .open()
      .then((result) => {
        if (openingVersion !== version) return input.inactiveResult();
        if (input.isOpenResult(result)) remoteOpen = true;
        return result;
      })
      .finally(() => {
        opening = null;
      });
    opening = command;
    return command;
  };

  const releaseIfIdle = (): void => {
    if (disposed || input.hasSubscribers()) return;
    admissionVersion += 1;
    if (closing) return;
    const operation = (async () => {
      await opening?.catch(() => undefined);
      if (input.hasSubscribers()) return;
      if (remoteOpen) {
        remoteOpen = false;
        await input.close().catch(() => undefined);
      }
      if (input.hasSubscribers()) return;
      disposed = true;
      input.finalize();
    })();
    closing = operation.finally(() => {
      closing = null;
      if (disposed || !input.hasSubscribers()) return;
      void ensure().catch(() => undefined);
    });
  };

  const invalidate = (): void => {
    version += 1;
    admissionVersion += 1;
    remoteOpen = false;
  };

  const run = async <CommandResult>(
    command: (subscription: Result) => Promise<CommandResult>,
  ): Promise<CommandResult> => {
    const admittedVersion = admissionVersion;
    const result = await ensure();
    // A successful open is evidence only for the owner that requested it. Releasing
    // and immediately reviving the same key must not revive its queued commands.
    if (disposed || !input.hasSubscribers() || admittedVersion !== admissionVersion) {
      return command(input.inactiveResult());
    }
    return command(result);
  };

  return { ensure, run, releaseIfIdle, invalidate };
};
