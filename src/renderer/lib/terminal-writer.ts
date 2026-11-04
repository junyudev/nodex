import type { IBuffer, Terminal } from "@xterm/xterm";

const ERASE = "\r\x1b[2K";
const UP_ERASE = "\x1b[1A" + ERASE;
const SUFFIX_MS = 8;
const UNIT_LIMIT = 1_048_576;
const PART_LIMIT = 4_096;
const HEAD_COMPACT = 128;
const UNIT_COMPACT = 65_536;
const BARRIER = "\x00";

interface WriterTarget extends Pick<Terminal, "write" | "reset"> {
  readonly buffer: {
    readonly active: Pick<IBuffer, "type" | "baseY" | "cursorY"> & {
      getLine(index: number): { readonly isWrapped: boolean } | undefined;
    };
  };
}

export function patchWrappedErase(term: Pick<WriterTarget, "buffer">, data: string): string {
  if (!data.startsWith(ERASE)) return data;
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") return data;

  let line = buffer.baseY + buffer.cursorY;
  let wrapped = 0;
  while (buffer.getLine(line)?.isWrapped) {
    wrapped++;
    line--;
  }
  return wrapped === 0 ? data : ERASE + UP_ERASE.repeat(wrapped) + data.slice(ERASE.length);
}

/** Parses prompt erases after preceding bytes, when the cursor and wraps are known. */
export function createWriter(term: WriterTarget) {
  const parts: string[] = [];
  let head = 0;
  let unreadUnits = 0;
  let consumedUnits = 0;
  let suffix = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled = false;
  let writing = false;
  // Bypassing rewrites invalidates the drain, while replacement also invalidates parse callbacks.
  let drainGeneration = 0;
  let operationGeneration = 0;
  let afterDrain: (() => void) | undefined;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const clearParts = () => {
    parts.length = 0;
    head = unreadUnits = consumedUnits = 0;
  };

  const drain = () => {
    if (head > HEAD_COMPACT || consumedUnits > UNIT_COMPACT) {
      parts.splice(0, head);
      head = consumedUnits = 0;
    }
    const chunk = parts[head];
    if (chunk === undefined) {
      writing = false;
      if (suffix.length > 0) return;
      scheduled = false;
      clearParts();
      const callback = afterDrain;
      afterDrain = undefined;
      callback?.();
      return;
    }
    head++;
    unreadUnits -= chunk.length;
    consumedUnits += chunk.length;
    writing = true;
    const generation = drainGeneration;
    term.write(patchWrappedErase(term, chunk), () => {
      if (generation === drainGeneration) drain();
    });
  };

  const bypass = (data: string, reset: boolean, onReset?: () => void) => {
    const raw = parts.slice(head).join("") + data + suffix;
    const callback = afterDrain;
    const generation = operationGeneration;
    drainGeneration++;
    cancelTimer();
    clearParts();
    suffix = "";
    scheduled = writing = false;
    afterDrain = undefined;
    const issue = () => {
      if (generation !== operationGeneration) return;
      if (reset) {
        term.reset();
        onReset?.();
      }
      term.write(raw, () => {
        if (generation === operationGeneration) callback?.();
      });
    };
    if (reset) term.write(BARRIER, issue);
    else issue();
  };

  const enqueue = (data: string, reset = false, onReset?: () => void): boolean => {
    if (unreadUnits + data.length + suffix.length > UNIT_LIMIT) {
      bypass(data, reset, onReset);
      return false;
    }
    let count = parts.length - head + 1;
    for (
      let match = data.indexOf(ERASE);
      match !== -1;
      match = data.indexOf(ERASE, match + ERASE.length)
    ) {
      count++;
      if (count > PART_LIMIT) {
        bypass(data, reset, onReset);
        return false;
      }
    }
    const [first, ...segments] = data.split(ERASE);
    if (first) parts.push(first);
    for (const segment of segments) parts.push(ERASE + segment);
    unreadUnits += data.length;
    return true;
  };

  const armSuffixTimer = () => {
    if (!suffix || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const trailing = suffix;
      suffix = "";
      if (!scheduled) {
        term.write(trailing);
        return;
      }
      if (enqueue(trailing) && !writing) drain();
    }, SUFFIX_MS);
  };

  const takeComplete = (data: string): string => {
    const joined = suffix + data;
    let length = Math.min(ERASE.length - 1, joined.length);
    while (length > 0 && !ERASE.startsWith(joined.slice(-length))) length--;
    const split = joined.length - length;
    suffix = joined.slice(split);
    return joined.slice(0, split);
  };

  const startBehindBarrier = (reset: boolean, onReset?: () => void) => {
    scheduled = writing = true;
    const drainEpoch = drainGeneration;
    const operationEpoch = operationGeneration;
    term.write(BARRIER, () => {
      if (operationEpoch !== operationGeneration) return;
      if (reset) {
        term.reset();
        onReset?.();
      }
      if (drainEpoch === drainGeneration) drain();
    });
  };

  return {
    write(data: string) {
      cancelTimer();
      const complete = takeComplete(data);
      if (scheduled) {
        if (enqueue(complete) && !writing) drain();
      } else if (complete.includes(ERASE)) {
        if (enqueue(complete)) startBehindBarrier(false);
      } else {
        term.write(complete);
      }
      armSuffixTimer();
    },

    flush(done: () => void) {
      cancelTimer();
      const trailing = suffix;
      suffix = "";
      const generation = operationGeneration;
      const finalBarrier = () =>
        term.write(BARRIER, () => {
          if (generation === operationGeneration) done();
        });
      if (!scheduled) {
        term.write(trailing);
        finalBarrier();
        return;
      }
      const previous = afterDrain;
      afterDrain = () => {
        previous?.();
        finalBarrier();
      };
      if (enqueue(trailing) && !writing) drain();
    },

    replaceOutput(data: string, done: () => void, onReset?: () => void) {
      drainGeneration++;
      operationGeneration++;
      cancelTimer();
      clearParts();
      suffix = "";
      afterDrain = done;
      const complete = takeComplete(data);
      if (!enqueue(complete, true, onReset)) return;
      startBehindBarrier(true, onReset);
      armSuffixTimer();
    },

    dispose() {
      drainGeneration++;
      operationGeneration++;
      cancelTimer();
      clearParts();
      suffix = "";
      scheduled = writing = false;
      afterDrain = undefined;
    },
  };
}
