import {
  authorityResourceKey,
  canonicalizeAuthorityResources,
  verifyAuthorizedReadStamp,
  type AuthorityResource,
  type AuthorizedReadStamp,
} from "../../shared/authorized-read-stamp";
import { deliveryAddressKey, type DeliveryAddress } from "../../shared/recipient-delivery";

export type AuthorityVisibilityChange = "grant" | "revoke";

export interface AuthorityFence {
  readonly kind: AuthorityVisibilityChange | "address_reset" | "store_epoch_replaced";
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly roots: readonly AuthorityResource[];
}

export interface AuthorityReadLease {
  readonly leaseId: symbol;
  readonly deliveryAddress: DeliveryAddress;
  readonly storeEpoch: string | null;
  readonly addressGeneration: number;
  readonly observedCommitSeq: number;
  readonly subject: AuthorityResource;
  readonly requestDependencies: readonly AuthorityResource[];
}

export interface AuthorityRegistration {
  readonly stamp: AuthorizedReadStamp;
  release(): void;
}

export class StaleAuthorizedReadError extends Error {
  constructor(readonly requiredCommitSeq = 0) {
    super("Canonical read response is older than renderer authority");
    this.name = "StaleAuthorizedReadError";
  }
}

export class AuthorityFreshnessCapacityError extends Error {
  constructor(readonly boundary = "unknown") {
    super(`Renderer authority freshness index is at capacity (${boundary})`);
    this.name = "AuthorityFreshnessCapacityError";
  }
}

interface InFlightRead {
  readonly lease: AuthorityReadLease;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RegistrationState {
  readonly token: symbol;
  readonly roots: ReadonlySet<string>;
  readonly onFence: (fence: AuthorityFence) => void;
  readonly stamp: AuthorizedReadStamp;
}

interface AddressState {
  readonly deliveryAddress: DeliveryAddress;
  storeEpoch: string | null;
  generation: number;
  latestCommitSeq: number;
  addressFloor: number;
  readonly rootFloors: Map<string, number>;
  readonly inFlight: Map<symbol, InFlightRead>;
  readonly registrations: Map<symbol, RegistrationState>;
}

const DEFAULT_MAX_ADDRESSES = 200;
const DEFAULT_MAX_ROOT_FLOORS = 10_000;
const DEFAULT_MAX_IN_FLIGHT_READS = 256;
const DEFAULT_MAX_REGISTRATIONS = 10_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;

const normalizeResources = (
  resources: readonly AuthorityResource[],
): readonly AuthorityResource[] => canonicalizeAuthorityResources(resources);

const sameResources = (
  left: readonly AuthorityResource[],
  right: readonly AuthorityResource[],
): boolean => {
  const leftKeys = normalizeResources(left).map(authorityResourceKey);
  const rightKeys = normalizeResources(right).map(authorityResourceKey);
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
};

export class AuthorityFreshnessIndex {
  readonly #maxAddresses: number;
  readonly #maxRootFloors: number;
  readonly #maxInFlightReads: number;
  readonly #maxRegistrations: number;
  readonly #readTimeoutMs: number;
  readonly #onFenceError: ((error: unknown) => void) | undefined;
  readonly #addresses = new Map<string, AddressState>();

  constructor(
    input: {
      readonly maxAddresses?: number;
      readonly maxRootFloors?: number;
      readonly maxInFlightReads?: number;
      readonly maxRegistrations?: number;
      readonly readTimeoutMs?: number;
      readonly onFenceError?: (error: unknown) => void;
    } = {},
  ) {
    this.#maxAddresses = input.maxAddresses ?? DEFAULT_MAX_ADDRESSES;
    this.#maxRootFloors = input.maxRootFloors ?? DEFAULT_MAX_ROOT_FLOORS;
    this.#maxInFlightReads = input.maxInFlightReads ?? DEFAULT_MAX_IN_FLIGHT_READS;
    this.#maxRegistrations = input.maxRegistrations ?? DEFAULT_MAX_REGISTRATIONS;
    this.#readTimeoutMs = input.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.#onFenceError = input.onFenceError;
  }

  dispose(): void {
    for (const state of this.#addresses.values()) {
      for (const read of state.inFlight.values()) clearTimeout(read.timer);
    }
    this.#addresses.clear();
  }

  beginRead(input: {
    readonly deliveryAddress: DeliveryAddress;
    readonly storeEpoch?: string;
    readonly observedCommitSeq: number;
    readonly subject: AuthorityResource;
    readonly requestDependencies: readonly AuthorityResource[];
  }): AuthorityReadLease {
    if (
      (input.storeEpoch !== undefined && !input.storeEpoch) ||
      !Number.isSafeInteger(input.observedCommitSeq) ||
      input.observedCommitSeq < 0 ||
      input.requestDependencies.length < 1
    ) {
      throw new TypeError("Authority read request is invalid");
    }
    const state = this.#address(
      input.deliveryAddress,
      input.storeEpoch ?? null,
      input.observedCommitSeq,
    );
    if (this.#inFlightCount() >= this.#maxInFlightReads) {
      this.#failClosed(state, state.latestCommitSeq);
      throw new AuthorityFreshnessCapacityError("in-flight reads");
    }
    const lease: AuthorityReadLease = {
      leaseId: Symbol("authority-read"),
      deliveryAddress: input.deliveryAddress,
      storeEpoch: state.storeEpoch,
      addressGeneration: state.generation,
      observedCommitSeq: Math.max(input.observedCommitSeq, state.latestCommitSeq),
      subject: input.subject,
      requestDependencies: normalizeResources(input.requestDependencies),
    };
    const timer = setTimeout(() => this.releaseRead(lease), this.#readTimeoutMs);
    state.inFlight.set(lease.leaseId, { lease, timer });
    return lease;
  }

  releaseRead(lease: AuthorityReadLease): void {
    const state = this.#addresses.get(deliveryAddressKey(lease.deliveryAddress));
    const active = state?.inFlight.get(lease.leaseId);
    if (!state || !active) return;
    clearTimeout(active.timer);
    state.inFlight.delete(lease.leaseId);
    this.#gcRootFloors(state);
  }

  async admitRead(
    lease: AuthorityReadLease,
    candidate: unknown,
    onFence: (fence: AuthorityFence) => void,
  ): Promise<AuthorityRegistration> {
    const stamp = await verifyAuthorizedReadStamp(candidate);
    const state = this.#addresses.get(deliveryAddressKey(lease.deliveryAddress));
    const active = state?.inFlight.get(lease.leaseId);
    const replacedByStamp = Boolean(
      state &&
      state.storeEpoch !== null &&
      state.storeEpoch !== stamp.store_epoch &&
      lease.storeEpoch === state.storeEpoch,
    );
    if (state && replacedByStamp) {
      this.#replaceEpoch(state, stamp.store_epoch, stamp.covered_commit_seq);
    }
    if (state && state.storeEpoch === null) state.storeEpoch = stamp.store_epoch;
    if (!state || !active || !this.#stampMatchesLease(state, lease, stamp, replacedByStamp)) {
      const requiredCommitSeq = state
        ? Math.max(lease.observedCommitSeq, this.#requiredCommitSeq(state))
        : lease.observedCommitSeq;
      this.releaseRead(lease);
      throw new StaleAuthorizedReadError(requiredCommitSeq);
    }
    this.releaseRead(lease);
    return this.#registerStamp(state, stamp, onFence);
  }

  /**
   * Adopts a Core-authored snapshot already present in an external cache.
   * Callers must evict the cache entry from `onFence`; this path never infers
   * roots from response payload fields.
   */
  async registerSnapshot(
    candidate: unknown,
    onFence: (fence: AuthorityFence) => void,
  ): Promise<AuthorityRegistration> {
    const stamp = await verifyAuthorizedReadStamp(candidate);
    const key = deliveryAddressKey(stamp.delivery_address);
    const existing = this.#addresses.get(key);
    if (existing && existing.storeEpoch !== null && existing.storeEpoch !== stamp.store_epoch) {
      throw new StaleAuthorizedReadError(this.#requiredCommitSeq(existing));
    }
    const state = existing ?? this.#address(stamp.delivery_address, stamp.store_epoch, 0);
    if (state.storeEpoch === null) state.storeEpoch = stamp.store_epoch;
    if (
      stamp.covered_commit_seq < state.latestCommitSeq ||
      stamp.covered_commit_seq < state.addressFloor
    ) {
      throw new StaleAuthorizedReadError(this.#requiredCommitSeq(state));
    }
    return this.#registerStamp(state, stamp, onFence);
  }

  #registerStamp(
    state: AddressState,
    stamp: AuthorizedReadStamp,
    onFence: (fence: AuthorityFence) => void,
  ): AuthorityRegistration {
    if (this.#registrationCount() >= this.#maxRegistrations) {
      this.#failClosed(state, state.latestCommitSeq);
      throw new AuthorityFreshnessCapacityError("registrations");
    }
    const roots = new Set(stamp.authorization_dependencies.map(authorityResourceKey));
    if (
      roots.size > this.#maxRootFloors ||
      [...roots].some((root) => (state.rootFloors.get(root) ?? 0) > stamp.covered_commit_seq)
    ) {
      if (roots.size > this.#maxRootFloors) {
        this.#failClosed(state, state.latestCommitSeq);
        throw new AuthorityFreshnessCapacityError("registration roots");
      }
      throw new StaleAuthorizedReadError(this.#requiredCommitSeq(state, roots));
    }
    const token = Symbol("authority-registration");
    state.latestCommitSeq = Math.max(state.latestCommitSeq, stamp.covered_commit_seq);
    state.registrations.set(token, { token, roots, onFence, stamp });
    let activeRegistration = true;
    return {
      stamp,
      release: () => {
        if (!activeRegistration) return;
        activeRegistration = false;
        state.registrations.delete(token);
        this.#gcRootFloors(state);
      },
    };
  }

  admitVisibility(input: {
    readonly deliveryAddress: DeliveryAddress;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly change: AuthorityVisibilityChange | "conservative_reset";
    readonly roots: readonly AuthorityResource[];
  }): void {
    const state = this.#address(input.deliveryAddress, input.storeEpoch, input.commitSeq);
    if (input.change === "conservative_reset") {
      this.#fenceAddress(state, input.commitSeq, "address_reset");
      return;
    }
    if (input.roots.length < 1) {
      throw new TypeError("Exact visibility change has no roots");
    }
    const roots = normalizeResources(input.roots);
    state.latestCommitSeq = Math.max(state.latestCommitSeq, input.commitSeq);
    const changedRoots: AuthorityResource[] = [];
    for (const root of roots) {
      const key = authorityResourceKey(root);
      const previous = state.rootFloors.get(key) ?? 0;
      if (previous >= input.commitSeq) continue;
      state.rootFloors.set(key, input.commitSeq);
      changedRoots.push(root);
    }
    if (state.rootFloors.size > this.#maxRootFloors) {
      this.#failClosed(state, input.commitSeq);
      throw new AuthorityFreshnessCapacityError("visibility roots");
    }
    if (changedRoots.length === 0) return;
    const rootKeys = new Set(changedRoots.map(authorityResourceKey));
    const fence: AuthorityFence = {
      kind: input.change,
      storeEpoch: input.storeEpoch,
      commitSeq: input.commitSeq,
      roots: changedRoots,
    };
    for (const registration of [...state.registrations.values()]) {
      if (![...rootKeys].some((root) => registration.roots.has(root))) continue;
      this.#deliverFence(registration, fence);
    }
    this.#gcRootFloors(state);
  }

  observeAddress(input: {
    readonly deliveryAddress: DeliveryAddress;
    readonly storeEpoch: string;
    readonly commitSeq: number;
  }): void {
    this.#address(input.deliveryAddress, input.storeEpoch, input.commitSeq);
  }

  admitAddressReset(input: {
    readonly deliveryAddress: DeliveryAddress;
    readonly storeEpoch: string;
    readonly requiredCommitSeq: number;
  }): void {
    const state = this.#address(input.deliveryAddress, input.storeEpoch, input.requiredCommitSeq);
    this.#fenceAddress(state, input.requiredCommitSeq, "address_reset");
  }

  diagnostics(): {
    readonly addresses: number;
    readonly addressFloors: number;
    readonly rootFloors: number;
    readonly inFlightReads: number;
    readonly registrations: number;
  } {
    const states = [...this.#addresses.values()];
    return {
      addresses: states.length,
      addressFloors: states.filter((state) => state.addressFloor > 0).length,
      rootFloors: states.reduce((total, state) => total + state.rootFloors.size, 0),
      inFlightReads: this.#inFlightCount(),
      registrations: this.#registrationCount(),
    };
  }

  reset(): void {
    for (const state of this.#addresses.values()) {
      for (const read of state.inFlight.values()) clearTimeout(read.timer);
    }
    this.#addresses.clear();
  }

  #address(
    deliveryAddress: DeliveryAddress,
    storeEpoch: string | null,
    observedCommitSeq: number,
  ): AddressState {
    const key = deliveryAddressKey(deliveryAddress);
    const existing = this.#addresses.get(key);
    if (existing) {
      if (
        storeEpoch !== null &&
        existing.storeEpoch !== null &&
        existing.storeEpoch !== storeEpoch
      ) {
        this.#replaceEpoch(existing, storeEpoch, observedCommitSeq);
      }
      if (existing.storeEpoch === null && storeEpoch !== null) {
        existing.storeEpoch = storeEpoch;
      }
      existing.latestCommitSeq = Math.max(existing.latestCommitSeq, observedCommitSeq);
      return existing;
    }
    if (this.#addresses.size >= this.#maxAddresses) {
      throw new AuthorityFreshnessCapacityError("delivery addresses");
    }
    const state: AddressState = {
      deliveryAddress,
      storeEpoch,
      generation: 0,
      latestCommitSeq: observedCommitSeq,
      addressFloor: 0,
      rootFloors: new Map(),
      inFlight: new Map(),
      registrations: new Map(),
    };
    this.#addresses.set(key, state);
    return state;
  }

  #replaceEpoch(state: AddressState, storeEpoch: string, commitSeq: number): void {
    const fence: AuthorityFence = {
      kind: "store_epoch_replaced",
      storeEpoch,
      commitSeq,
      roots: [],
    };
    for (const registration of [...state.registrations.values()]) {
      this.#deliverFence(registration, fence);
    }
    state.storeEpoch = storeEpoch;
    state.generation += 1;
    state.latestCommitSeq = commitSeq;
    state.addressFloor = commitSeq;
    state.rootFloors.clear();
  }

  #stampMatchesLease(
    state: AddressState,
    lease: AuthorityReadLease,
    stamp: AuthorizedReadStamp,
    allowLeaseEpochReplacement: boolean,
  ): boolean {
    if (
      (!allowLeaseEpochReplacement &&
        lease.storeEpoch !== null &&
        stamp.store_epoch !== lease.storeEpoch) ||
      (!allowLeaseEpochReplacement && lease.addressGeneration !== state.generation) ||
      (state.storeEpoch !== null && stamp.store_epoch !== state.storeEpoch) ||
      deliveryAddressKey(stamp.delivery_address) !== deliveryAddressKey(lease.deliveryAddress) ||
      authorityResourceKey(stamp.subject) !== authorityResourceKey(lease.subject) ||
      !sameResources(stamp.request_dependencies, lease.requestDependencies) ||
      (!allowLeaseEpochReplacement && stamp.covered_commit_seq < lease.observedCommitSeq) ||
      stamp.covered_commit_seq < state.latestCommitSeq ||
      stamp.covered_commit_seq < state.addressFloor
    ) {
      return false;
    }
    return true;
  }

  #fenceAddress(state: AddressState, commitSeq: number, kind: "address_reset"): void {
    state.generation += 1;
    state.latestCommitSeq = Math.max(state.latestCommitSeq, commitSeq);
    state.addressFloor = Math.max(state.addressFloor, commitSeq);
    state.rootFloors.clear();
    const fence: AuthorityFence = {
      kind,
      storeEpoch: state.storeEpoch ?? "unknown",
      commitSeq,
      roots: [],
    };
    for (const registration of [...state.registrations.values()]) {
      this.#deliverFence(registration, fence);
    }
  }

  #failClosed(state: AddressState, commitSeq: number): void {
    this.#fenceAddress(state, commitSeq, "address_reset");
  }

  #deliverFence(registration: RegistrationState, fence: AuthorityFence): void {
    try {
      registration.onFence(fence);
    } catch (error) {
      this.#onFenceError?.(error);
    }
  }

  #gcRootFloors(state: AddressState): void {
    const activeRoots = new Set(
      [...state.registrations.values()].flatMap((registration) => [...registration.roots]),
    );
    const inFlightFloors = [...state.inFlight.values()].map(({ lease }) => lease.observedCommitSeq);
    for (const [root, floor] of state.rootFloors) {
      if (activeRoots.has(root)) continue;
      if (inFlightFloors.some((observed) => observed < floor)) continue;
      state.rootFloors.delete(root);
    }
  }

  #inFlightCount(): number {
    return [...this.#addresses.values()].reduce((total, state) => total + state.inFlight.size, 0);
  }

  #registrationCount(): number {
    return [...this.#addresses.values()].reduce(
      (total, state) => total + state.registrations.size,
      0,
    );
  }

  #requiredCommitSeq(state: AddressState, roots: ReadonlySet<string> = new Set()): number {
    return Math.max(
      state.latestCommitSeq,
      state.addressFloor,
      ...[...roots].map((root) => state.rootFloors.get(root) ?? 0),
    );
  }
}

export const rendererAuthorityFreshnessIndex = new AuthorityFreshnessIndex();
