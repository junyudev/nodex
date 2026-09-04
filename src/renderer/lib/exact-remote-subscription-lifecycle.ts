export interface ExactRemoteSubscriptionLifecycle<Result> {
  ensure(): Promise<Result>;
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

  const ensure = (): Promise<Result> => {
    if (disposed) return Promise.resolve(input.inactiveResult());
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
    if (disposed || closing || input.hasSubscribers()) return;
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
    remoteOpen = false;
  };

  return { ensure, releaseIfIdle, invalidate };
};
