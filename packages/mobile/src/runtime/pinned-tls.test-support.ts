import type { NativePinnedTls, NativeTlsOptions, TlsEvent } from "./pinned-tls";

/** In-memory native frontier: tests control delivery without starting native networking. */
export class FakePinnedTls implements NativePinnedTls {
  listeners = new Map<string, (event: TlsEvent) => void>();
  active = new Set<string>();
  starts: { id: string; options: NativeTlsOptions; socket: boolean }[] = [];
  sent: { id: string; body: string; binary: boolean }[] = [];
  onStart: (id: string, socket: boolean) => void = () => {};
  listen(id: string, listener: (event: TlsEvent) => void) {
    this.listeners.set(id, listener);
    return () => {
      this.listeners.delete(id);
    };
  }
  emit(id: string, event: TlsEvent) {
    this.listeners.get(id)?.(event);
  }
  startRequest(id: string, options: NativeTlsOptions) {
    this.start(id, options, false);
  }
  openSocket(id: string, options: NativeTlsOptions) {
    this.start(id, options, true);
  }
  private start(id: string, options: NativeTlsOptions, socket: boolean) {
    this.active.add(id);
    this.starts.push({ id, options, socket });
    this.onStart(id, socket);
  }
  send(id: string, body: string, binary: boolean) {
    this.sent.push({ id, body, binary });
  }
  cancel(id: string) {
    this.active.delete(id);
  }
}
