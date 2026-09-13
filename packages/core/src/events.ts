import type {
  Disposable,
  PdrError,
  RpcSessionEvent,
  SessionSnapshot,
  SubscriptionId,
  SubscriptionOptions,
} from "@protodriver/contracts";

interface PendingEvent {
  event: RpcSessionEvent;
  readonly coalescingKeys?: string[];
}

interface Subscriber {
  readonly id: SubscriptionId;
  readonly listener: (event: RpcSessionEvent) => void | Promise<void>;
  readonly queue: PendingEvent[];
  readonly coalesced: Map<string, PendingEvent>;
  pendingLossless: number;
  delivering: boolean;
  terminated: boolean;
}

export interface SessionEventDeliveryOptions {
  readonly maximumLosslessQueueDepth: number;
  readonly maximumReplayCount: number;
  readonly onListenerError?: (subscriptionId: SubscriptionId, cause: unknown) => void;
  readonly onSubscriberTerminated?: (subscriptionId: SubscriptionId, reason: PdrError) => void;
}

export interface SessionSubscriberQueueState {
  readonly pendingLosslessEvents: number;
  readonly pendingCoalescedEvents: number;
  readonly delivering: boolean;
}

/** Runtime default corresponding to HostResourceLimits.maximumLosslessQueueDepth. */
export const DEFAULT_MAXIMUM_LOSSLESS_QUEUE_DEPTH = 1024;

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function overflowError(maximumLosslessQueueDepth: number): PdrError {
  return {
    code: "rpc.subscriber-overflow",
    message: `subscriber exceeded ${maximumLosslessQueueDepth} pending lossless events`,
    retryability: "after-recovery",
    details: { maximumLosslessQueueDepth },
  };
}

function pendingEvent(event: RpcSessionEvent): PendingEvent {
  if (event.kind === "operation-progress" || event.kind === "transfer-progress") {
    return { event, coalescingKeys: [`operation:${event.operationId}`] };
  }
  if (event.kind === "state-cells") {
    return {
      event,
      coalescingKeys: Object.keys(event.changed).map((name) => `cell:${name}`),
    };
  }
  return { event };
}

/**
 * Bounded, non-blocking delivery for lifecycle subscribers.
 *
 * Lossless entries and coalescible entries deliberately use separate
 * accounting. A coalescible slot is keyed by operation or state-cell name
 * and moves to the tail when replaced, preserving the sequence order of the
 * latest values rather than delivering a newer replacement ahead of an
 * intervening lossless event.
 */
export class SessionEventDelivery {
  readonly #options: SessionEventDeliveryOptions;
  readonly #subscribers = new Map<SubscriptionId, Subscriber>();
  readonly #replay: RpcSessionEvent[] = [];

  constructor(options: SessionEventDeliveryOptions) {
    this.#options = {
      ...options,
      maximumLosslessQueueDepth: requireNonNegativeSafeInteger(
        options.maximumLosslessQueueDepth,
        "maximumLosslessQueueDepth",
      ),
      maximumReplayCount: requireNonNegativeSafeInteger(
        options.maximumReplayCount,
        "maximumReplayCount",
      ),
    };
  }

  subscribe(
    subscriptionId: SubscriptionId,
    listener: (event: RpcSessionEvent) => void | Promise<void>,
    options: SubscriptionOptions = {},
  ): Disposable {
    if (this.#subscribers.has(subscriptionId)) {
      throw new Error(`subscription ${subscriptionId} already exists`);
    }
    const replayLast = requireNonNegativeSafeInteger(options.replayLast ?? 0, "replayLast");
    if (replayLast > this.#options.maximumReplayCount) {
      throw new RangeError(
        `replayLast ${replayLast} exceeds maximumReplayCount ${this.#options.maximumReplayCount}`,
      );
    }
    const subscriber: Subscriber = {
      id: subscriptionId,
      listener,
      queue: [],
      coalesced: new Map(),
      pendingLossless: 0,
      delivering: false,
      terminated: false,
    };
    this.#subscribers.set(subscriptionId, subscriber);
    for (const event of this.#replay.slice(-replayLast)) this.#enqueue(subscriber, event);
    return { dispose: () => this.unsubscribe(subscriptionId) };
  }

  unsubscribe(subscriptionId: SubscriptionId): void {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber === undefined) return;
    this.#discard(subscriber);
    this.#subscribers.delete(subscriptionId);
  }

  clear(): void {
    for (const subscriber of this.#subscribers.values()) this.#discard(subscriber);
    this.#subscribers.clear();
  }

  /** Records one session event for replay and offers it to every subscriber. */
  publish(event: RpcSessionEvent): void {
    this.#remember(event);
    for (const subscriber of [...this.#subscribers.values()]) this.#enqueue(subscriber, event);
  }

  /** Delivers an already-addressed RPC event without adding it to replay. */
  publishTo(subscriptionId: SubscriptionId, event: RpcSessionEvent): void {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber !== undefined) this.#enqueue(subscriber, event);
  }

  terminate(subscriptionId: SubscriptionId, reason: PdrError): void {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber !== undefined) this.#terminate(subscriber, reason);
  }

  queueState(subscriptionId: SubscriptionId): SessionSubscriberQueueState | undefined {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber === undefined) return undefined;
    return {
      pendingLosslessEvents: subscriber.pendingLossless,
      pendingCoalescedEvents: subscriber.coalesced.size,
      delivering: subscriber.delivering,
    };
  }

  #remember(event: RpcSessionEvent): void {
    if (this.#options.maximumReplayCount === 0) return;
    this.#replay.push(event);
    if (this.#replay.length > this.#options.maximumReplayCount) this.#replay.shift();
  }

  #enqueue(subscriber: Subscriber, event: RpcSessionEvent): void {
    if (subscriber.terminated) return;
    const pending = pendingEvent(event);
    if (pending.coalescingKeys === undefined || pending.coalescingKeys.length === 0) {
      if (subscriber.pendingLossless >= this.#options.maximumLosslessQueueDepth) {
        this.#terminate(subscriber, overflowError(this.#options.maximumLosslessQueueDepth));
        return;
      }
      subscriber.pendingLossless += 1;
    } else {
      for (const key of pending.coalescingKeys) {
        const replaced = subscriber.coalesced.get(key);
        if (replaced !== undefined) this.#removeKey(subscriber, replaced, key);
        subscriber.coalesced.set(key, pending);
      }
    }
    subscriber.queue.push(pending);
    this.#schedule(subscriber);
  }

  #removeKey(subscriber: Subscriber, pending: PendingEvent, key: string): void {
    subscriber.coalesced.delete(key);
    const keys = pending.coalescingKeys!;
    const keyIndex = keys.indexOf(key);
    if (keyIndex >= 0) keys.splice(keyIndex, 1);
    if (pending.event.kind === "state-cells" && key.startsWith("cell:")) {
      const name = key.slice("cell:".length);
      const changed = { ...pending.event.changed };
      delete changed[name];
      pending.event = { ...pending.event, changed };
    }
    if (keys.length === 0) {
      const queueIndex = subscriber.queue.indexOf(pending);
      if (queueIndex >= 0) subscriber.queue.splice(queueIndex, 1);
    }
  }

  #schedule(subscriber: Subscriber): void {
    if (subscriber.delivering || subscriber.terminated) return;
    subscriber.delivering = true;
    queueMicrotask(() => void this.#drain(subscriber));
  }

  async #drain(subscriber: Subscriber): Promise<void> {
    while (!subscriber.terminated) {
      const pending = subscriber.queue.shift();
      if (pending === undefined) break;
      if (pending.coalescingKeys === undefined || pending.coalescingKeys.length === 0) {
        subscriber.pendingLossless -= 1;
      } else {
        for (const key of pending.coalescingKeys) {
          if (subscriber.coalesced.get(key) === pending) subscriber.coalesced.delete(key);
        }
      }
      try {
        await subscriber.listener(pending.event);
      } catch (cause) {
        try {
          if (this.#options.onListenerError === undefined) {
            console.error(`session event listener ${subscriber.id} failed`, cause);
          } else {
            this.#options.onListenerError(subscriber.id, cause);
          }
        } catch {
          // Error reporting is subject to the same isolation as the listener.
        }
        // A synchronous throw does not pass through await's normal yield.
        // Yield explicitly so the throwing subscriber cannot run its next
        // event ahead of peers still waiting to start this one.
        await Promise.resolve();
      }
    }
    subscriber.delivering = false;
    if (!subscriber.terminated && subscriber.queue.length > 0) this.#schedule(subscriber);
  }

  #terminate(subscriber: Subscriber, reason: PdrError): void {
    if (subscriber.terminated) return;
    subscriber.terminated = true;
    this.#discard(subscriber);
    this.#subscribers.delete(subscriber.id);
    queueMicrotask(() => {
      try {
        this.#options.onSubscriberTerminated?.(subscriber.id, reason);
      } catch {
        // Termination reporting cannot fault the surviving session.
      }
    });
  }

  #discard(subscriber: Subscriber): void {
    subscriber.terminated = true;
    subscriber.queue.length = 0;
    subscriber.coalesced.clear();
    subscriber.pendingLossless = 0;
  }
}

