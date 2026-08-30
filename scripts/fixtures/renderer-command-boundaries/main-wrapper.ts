declare const ipc: {
  readonly handle: (channel: string, handler: unknown) => unknown;
};

const handle = (channel: string, handler: unknown): unknown => ipc.handle(channel, handler);
const core = (channel: string, handler: unknown): unknown => handle(channel, handler);

export const registration = core("projects:update", () => undefined);
