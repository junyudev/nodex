import { useEffect, useEffectEvent, useRef, useState } from "react";

const failureMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Settings that Main owns, read afresh every time Settings opens and on retry. Reads and the
 * writes passed through `serialize` reach Main one at a time, so a read started during a save
 * returns the saved result instead of landing after it with the state from before; a read
 * superseded by a newer one is dropped.
 */
export function useSettingsRead<Snapshot>(
  open: boolean,
  read: () => Promise<Snapshot>,
  accept: (snapshot: Snapshot) => void,
) {
  const [request, setRequest] = useState(0);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setRequest(request + 1);
  }
  const [settled, setSettled] = useState<{
    readonly request: number;
    readonly error: string | null;
  }>({ request: 0, error: null });

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serialize = <Result>(task: () => Promise<Result>) => {
    const run = queue.current.then(task);
    queue.current = run.catch(() => undefined);
    return run;
  };

  const start = useEffectEvent((isCurrent: () => boolean) => {
    void serialize(read).then(
      (snapshot) => {
        if (!isCurrent()) return;
        accept(snapshot);
        setSettled({ request, error: null });
      },
      (cause: unknown) => {
        if (isCurrent()) setSettled({ request, error: failureMessage(cause) });
      },
    );
  });
  useEffect(() => {
    if (request === 0) return;
    let active = true;
    start(() => active);
    return () => {
      active = false;
    };
  }, [request]);

  const reading = settled.request !== request;
  return {
    /** True from opening until that read settles. */
    reading,
    /** Why the latest read failed, until the next one starts. */
    error: reading ? null : settled.error,
    retry: () => setRequest((current) => current + 1),
    serialize,
  };
}
