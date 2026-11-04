const ESC = "\x1b";
const BEL = "\x07";

function csiFinalIndex(data: string, start: number): number {
  for (let index = start; index < data.length; index += 1) {
    const byte = data.charCodeAt(index);
    if (byte >= 0x40 && byte <= 0x7e) return index;
  }
  return -1;
}

function oscTerminatorIndex(data: string, start: number): number {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === BEL || data.startsWith(ESC + "\\", index)) return index;
  }
  return -1;
}

/** Historical terminal queries have already run and must not be sent to the display again. */
export function terminalReplayData(data: string): string {
  let replay = "";
  let offset = 0;
  while (offset < data.length) {
    const escape = data.indexOf(ESC, offset);
    if (escape < 0) break;
    replay += data.slice(offset, escape);
    offset = escape;
    const start = escape + 2;

    if (data[escape + 1] === "[") {
      const final = csiFinalIndex(data, start);
      if (final < 0) break;
      offset = final + 1;
      if (data[final] !== "n") replay += data.slice(escape, offset);
      continue;
    }
    if (data[escape + 1] === "]") {
      const terminator = oscTerminatorIndex(data, start);
      if (terminator < 0) break;
      offset = terminator + (data[terminator] === BEL ? 1 : 2);
      if (!/^\d+;\?$/.test(data.slice(start, terminator))) replay += data.slice(escape, offset);
      continue;
    }
    replay += ESC;
    offset += 1;
  }
  return replay + data.slice(offset);
}
