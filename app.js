// ../../packages/core/src/clock.ts
var RESOLUTION_SAMPLE_LIMIT = 1e5;
var RESOLUTION_CHANGES_REQUIRED = 32;
var MICROSECONDS_PER_MILLISECOND = 1e3;
function requireFiniteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}
function nextSequence(current) {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("clock sequence exhausted Number.MAX_SAFE_INTEGER");
  }
  return current + 1;
}
function measureResolutionUs(readMilliseconds) {
  const originMs = readMilliseconds();
  let previousMs = originMs;
  let minimumUs = Number.POSITIVE_INFINITY;
  let changes = 0;
  for (let sample = 0; sample < RESOLUTION_SAMPLE_LIMIT && changes < RESOLUTION_CHANGES_REQUIRED; sample += 1) {
    const currentMs = readMilliseconds();
    const deltaUs = (currentMs - previousMs) * MICROSECONDS_PER_MILLISECOND;
    if (deltaUs > 0) {
      minimumUs = Math.min(minimumUs, deltaUs);
      changes += 1;
    }
    previousMs = currentMs;
  }
  return {
    originMs,
    resolutionUs: Number.isFinite(minimumUs) ? Math.max(1, minimumUs) : 1
  };
}
var CallbackDisposable = class {
  #callback;
  constructor(callback) {
    this.#callback = callback;
  }
  dispose() {
    const callback = this.#callback;
    this.#callback = void 0;
    callback?.();
  }
};
var RealClock = class {
  resolutionUs;
  #originMs;
  #sequence = 0;
  constructor() {
    const measured = measureResolutionUs(() => performance.now());
    this.#originMs = measured.originMs;
    this.resolutionUs = measured.resolutionUs;
  }
  monotonicUs() {
    return (performance.now() - this.#originMs) * MICROSECONDS_PER_MILLISECOND;
  }
  wallClockUnixMs() {
    return Date.now();
  }
  nextSequence() {
    this.#sequence = nextSequence(this.#sequence);
    return this.#sequence;
  }
  sleep(ms, signal) {
    requireFiniteNonNegative(ms, "delay");
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(handle);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  timer(ms, fn) {
    requireFiniteNonNegative(ms, "delay");
    const handle = setTimeout(fn, ms);
    return new CallbackDisposable(() => clearTimeout(handle));
  }
  interval(ms, fn) {
    requireFiniteNonNegative(ms, "delay");
    const handle = setInterval(fn, ms);
    return new CallbackDisposable(() => clearInterval(handle));
  }
};

// ../../packages/core/src/limits.ts
var encoder = new TextEncoder();
var SIZE_NODE_OVERHEAD = 8;
var DEFAULT_PHASE_ONE_LIMITS = Object.freeze({
  maximumBufferedBytesPerChannel: 4 * 1024 * 1024,
  maximumDiagnosticBufferBytes: 2 * 1024 * 1024,
  maximumRpcMessageBytes: 8 * 1024 * 1024,
  maximumPendingRpcCalls: 256,
  maximumSubscriptionsPerClient: 16,
  maximumConcurrentOperations: 32,
  maximumOpenResources: 64,
  maximumOutstandingBrokerCalls: 64,
  maximumResourceChunkBytes: 1024 * 1024,
  maximumCaptureParts: 4096
});
var HostResourceLimitError = class extends Error {
  error;
  constructor(code, limit, maximum, observed, scope) {
    const error = {
      code,
      message: `${scope} exceeds ${limit}: observed ${observed}, maximum ${maximum}`,
      retryability: "no",
      details: { limit, maximum, observed, scope }
    };
    super(error.message);
    this.name = "HostResourceLimitError";
    this.error = error;
  }
};
function canonicalPublic(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPublic).join(",")}]`;
  const record2 = value;
  return `{${Object.keys(record2).sort().map((key) => `${JSON.stringify(key)}:${canonicalPublic(record2[key])}`).join(",")}}`;
}
function rpcBytes(value, meter, replacement) {
  meter?.reserve(8);
  const active = /* @__PURE__ */ new Set();
  const visit = (item) => {
    meter?.iteration();
    if (item === null || typeof item === "boolean") return SIZE_NODE_OVERHEAD;
    if (typeof item === "number" || typeof item === "bigint") {
      return SIZE_NODE_OVERHEAD + 8;
    }
    if (typeof item === "string") {
      meter?.text(item);
      return SIZE_NODE_OVERHEAD + encoder.encode(item).byteLength;
    }
    if (item instanceof ArrayBuffer) return SIZE_NODE_OVERHEAD + item.byteLength;
    if (ArrayBuffer.isView(item)) return SIZE_NODE_OVERHEAD + item.byteLength;
    if (active.has(item)) throw new TypeError("RPC size accounting does not accept cycles");
    meter?.reserve(16);
    active.add(item);
    try {
      if (Array.isArray(item)) {
        return SIZE_NODE_OVERHEAD + item.reduce((sum, member) => sum + visit(member), 0);
      }
      if (item instanceof Set) {
        let total2 = SIZE_NODE_OVERHEAD;
        for (const member of item) {
          total2 += visit(member);
        }
        return total2;
      }
      if (item instanceof Map) {
        let total2 = SIZE_NODE_OVERHEAD;
        let replaced = false;
        for (const [key, member] of item) {
          const keyBytes = visit(key);
          const selected = replacement?.map === item && replacement.key === key;
          if (selected) replaced = true;
          const value2 = selected ? replacement.value : member;
          const bytes = keyBytes + visit(value2);
          total2 += bytes;
          if (replacement?.map === item) replacement.entry?.(key, value2, bytes);
        }
        if (replacement?.map === item && !replaced) {
          const bytes = visit(replacement.key) + visit(replacement.value);
          total2 += bytes;
          replacement.entry?.(replacement.key, replacement.value, bytes);
        }
        return total2;
      }
      let total = SIZE_NODE_OVERHEAD;
      if (meter) {
        let count2 = 0;
        for (const key in item) {
          meter.iteration();
          if (Object.hasOwn(item, key)) count2++;
        }
        meter.reserve(8 + count2 * 56);
      }
      for (const [key, member] of Object.entries(item)) {
        if (member === void 0) continue;
        if (typeof member === "function" || typeof member === "symbol") {
          throw new TypeError(`RPC size accounting cannot measure ${typeof member}`);
        }
        meter?.text(key);
        total += encoder.encode(key).byteLength;
        total += visit(member);
      }
      return total;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
}
var CanonicalSizeAccounting = class {
  publicValueBytes(value) {
    return encoder.encode(canonicalPublic(value)).byteLength;
  }
  rpcMessageBytes(message, meter) {
    if (message === void 0 || typeof message === "function" || typeof message === "symbol") {
      throw new TypeError(`RPC size accounting cannot measure ${typeof message}`);
    }
    return rpcBytes(message, meter);
  }
  rpcMapEntryBytes(map, key, value, meter, entry) {
    return rpcBytes(map, meter, { map, key, value, ...entry ? { entry } : {} });
  }
};
var DEFAULT_CAUSE_DETAIL_KEYS = ["errno", "syscall", "address", "port", "path"];
function publicDetail(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
  return void 0;
}
function snapshotPlatformCause(cause, detailKeys = DEFAULT_CAUSE_DETAIL_KEYS) {
  if (typeof cause === "string") return { typeName: "String", message: cause };
  const source = cause;
  const serializableDetails = {};
  for (const key of detailKeys) {
    const detail = source[key];
    if (detail === void 0) continue;
    const value = publicDetail(detail);
    if (value !== void 0) serializableDetails[key] = value;
  }
  return {
    typeName: source.constructor?.name ?? "Object",
    ...source.name === void 0 ? {} : { name: source.name },
    ...source.message === void 0 ? {} : { message: source.message },
    ...source.code === void 0 ? {} : { code: source.code },
    ...source.stack === void 0 ? {} : { stack: source.stack },
    ...Object.keys(serializableDetails).length === 0 ? {} : { serializableDetails }
  };
}

// ../../packages/core/src/events.ts
var DEFAULT_MAXIMUM_LOSSLESS_QUEUE_DEPTH = 1024;
function requireNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
function overflowError(maximumLosslessQueueDepth) {
  return {
    code: "rpc.subscriber-overflow",
    message: `subscriber exceeded ${maximumLosslessQueueDepth} pending lossless events`,
    retryability: "after-recovery",
    details: { maximumLosslessQueueDepth }
  };
}
function pendingEvent(event) {
  if (event.kind === "operation-progress" || event.kind === "transfer-progress") {
    return { event, coalescingKeys: [`operation:${event.operationId}`] };
  }
  if (event.kind === "state-cells") {
    return {
      event,
      coalescingKeys: Object.keys(event.changed).map((name) => `cell:${name}`)
    };
  }
  return { event };
}
var SessionEventDelivery = class {
  #options;
  #subscribers = /* @__PURE__ */ new Map();
  #replay = [];
  constructor(options) {
    this.#options = {
      ...options,
      maximumLosslessQueueDepth: requireNonNegativeSafeInteger(
        options.maximumLosslessQueueDepth,
        "maximumLosslessQueueDepth"
      ),
      maximumReplayCount: requireNonNegativeSafeInteger(
        options.maximumReplayCount,
        "maximumReplayCount"
      )
    };
  }
  subscribe(subscriptionId, listener, options = {}) {
    if (this.#subscribers.has(subscriptionId)) {
      throw new Error(`subscription ${subscriptionId} already exists`);
    }
    const replayLast = requireNonNegativeSafeInteger(options.replayLast ?? 0, "replayLast");
    if (replayLast > this.#options.maximumReplayCount) {
      throw new RangeError(
        `replayLast ${replayLast} exceeds maximumReplayCount ${this.#options.maximumReplayCount}`
      );
    }
    const subscriber = {
      id: subscriptionId,
      listener,
      queue: [],
      coalesced: /* @__PURE__ */ new Map(),
      pendingLossless: 0,
      delivering: false,
      terminated: false
    };
    this.#subscribers.set(subscriptionId, subscriber);
    for (const event of this.#replay.slice(-replayLast)) this.#enqueue(subscriber, event);
    return { dispose: () => this.unsubscribe(subscriptionId) };
  }
  unsubscribe(subscriptionId) {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber === void 0) return;
    this.#discard(subscriber);
    this.#subscribers.delete(subscriptionId);
  }
  clear() {
    for (const subscriber of this.#subscribers.values()) this.#discard(subscriber);
    this.#subscribers.clear();
  }
  /** Records one session event for replay and offers it to every subscriber. */
  publish(event) {
    this.#remember(event);
    for (const subscriber of [...this.#subscribers.values()]) this.#enqueue(subscriber, event);
  }
  /** Delivers an already-addressed RPC event without adding it to replay. */
  publishTo(subscriptionId, event) {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber !== void 0) this.#enqueue(subscriber, event);
  }
  terminate(subscriptionId, reason) {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber !== void 0) this.#terminate(subscriber, reason);
  }
  queueState(subscriptionId) {
    const subscriber = this.#subscribers.get(subscriptionId);
    if (subscriber === void 0) return void 0;
    return {
      pendingLosslessEvents: subscriber.pendingLossless,
      pendingCoalescedEvents: subscriber.coalesced.size,
      delivering: subscriber.delivering
    };
  }
  #remember(event) {
    if (this.#options.maximumReplayCount === 0) return;
    this.#replay.push(event);
    if (this.#replay.length > this.#options.maximumReplayCount) this.#replay.shift();
  }
  #enqueue(subscriber, event) {
    if (subscriber.terminated) return;
    const pending = pendingEvent(event);
    if (pending.coalescingKeys === void 0 || pending.coalescingKeys.length === 0) {
      if (subscriber.pendingLossless >= this.#options.maximumLosslessQueueDepth) {
        this.#terminate(subscriber, overflowError(this.#options.maximumLosslessQueueDepth));
        return;
      }
      subscriber.pendingLossless += 1;
    } else {
      for (const key of pending.coalescingKeys) {
        const replaced = subscriber.coalesced.get(key);
        if (replaced !== void 0) this.#removeKey(subscriber, replaced, key);
        subscriber.coalesced.set(key, pending);
      }
    }
    subscriber.queue.push(pending);
    this.#schedule(subscriber);
  }
  #removeKey(subscriber, pending, key) {
    subscriber.coalesced.delete(key);
    const keys = pending.coalescingKeys;
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
  #schedule(subscriber) {
    if (subscriber.delivering || subscriber.terminated) return;
    subscriber.delivering = true;
    queueMicrotask(() => void this.#drain(subscriber));
  }
  async #drain(subscriber) {
    while (!subscriber.terminated) {
      const pending = subscriber.queue.shift();
      if (pending === void 0) break;
      if (pending.coalescingKeys === void 0 || pending.coalescingKeys.length === 0) {
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
          if (this.#options.onListenerError === void 0) {
            console.error(`session event listener ${subscriber.id} failed`, cause);
          } else {
            this.#options.onListenerError(subscriber.id, cause);
          }
        } catch {
        }
        await Promise.resolve();
      }
    }
    subscriber.delivering = false;
    if (!subscriber.terminated && subscriber.queue.length > 0) this.#schedule(subscriber);
  }
  #terminate(subscriber, reason) {
    if (subscriber.terminated) return;
    subscriber.terminated = true;
    this.#discard(subscriber);
    this.#subscribers.delete(subscriber.id);
    queueMicrotask(() => {
      try {
        this.#options.onSubscriberTerminated?.(subscriber.id, reason);
      } catch {
      }
    });
  }
  #discard(subscriber) {
    subscriber.terminated = true;
    subscriber.queue.length = 0;
    subscriber.coalesced.clear();
    subscriber.pendingLossless = 0;
  }
};

// ../../packages/core/src/rpc.ts
var SessionRpcError = class extends Error {
  error;
  constructor(error) {
    super(error.message);
    this.name = "SessionRpcError";
    this.error = error;
  }
};
var SessionRpcClosedError = class extends Error {
  constructor(message = "session RPC adapter is closed") {
    super(message);
    this.name = "SessionRpcClosedError";
  }
};
function workerLostPdrError(cause) {
  return {
    code: "session.worker-lost",
    message: "the session worker was lost; reconnect is required",
    retryability: "after-reconnect",
    ...cause instanceof Error ? {
      platformCause: {
        typeName: cause.constructor.name,
        name: cause.name,
        message: cause.message,
        ...cause.stack === void 0 ? {} : { stack: cause.stack }
      }
    } : {}
  };
}
var SessionWorkerLostError = class extends SessionRpcError {
  constructor(cause) {
    super(workerLostPdrError(cause));
    this.name = "SessionWorkerLostError";
  }
};
var AsyncMessageQueue = class {
  #values = [];
  #waiters = [];
  #closed = false;
  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === void 0) this.#values.push(value);
    else waiter({ done: false, value });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: void 0 });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== void 0) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: void 0 });
        return new Promise((resolve) => this.#waiters.push(resolve));
      }
    };
  }
};
function assertCorrelated(request2, response) {
  if (response.callId !== request2.callId) {
    throw new Error(`RPC response callId ${response.callId} does not match ${request2.callId}`);
  }
  if (response.method !== request2.kind) {
    throw new Error(`RPC response method ${response.method} does not match ${request2.kind}`);
  }
}
var SessionRpcEnvelope = class {
  #maximumMessageBytes;
  #maximumPendingCalls;
  #maximumSubscriptions;
  #sizeAccounting;
  #onMessageMeasured;
  #activeSubscriptions = /* @__PURE__ */ new Set();
  #subscriptionReservations = /* @__PURE__ */ new Set();
  constructor(options) {
    this.#maximumMessageBytes = options.maximumMessageBytes ?? DEFAULT_PHASE_ONE_LIMITS.maximumRpcMessageBytes;
    this.#maximumPendingCalls = options.maximumPendingCalls ?? DEFAULT_PHASE_ONE_LIMITS.maximumPendingRpcCalls;
    this.#maximumSubscriptions = options.maximumSubscriptionsPerClient ?? DEFAULT_PHASE_ONE_LIMITS.maximumSubscriptionsPerClient;
    this.#sizeAccounting = options.sizeAccounting ?? new CanonicalSizeAccounting();
    this.#onMessageMeasured = options.onMessageMeasured;
  }
  beforeRequest(request2, pendingCalls) {
    this.measure(request2);
    if (pendingCalls >= this.#maximumPendingCalls) {
      throw new HostResourceLimitError(
        "rpc.pending-call-limit",
        "maximumPendingRpcCalls",
        this.#maximumPendingCalls,
        pendingCalls + 1,
        "rpc"
      );
    }
    if (request2.kind !== "subscribe") return;
    const id = request2.params.subscriptionId;
    if (this.#activeSubscriptions.has(id) || this.#subscriptionReservations.has(id)) return;
    const observed = this.#activeSubscriptions.size + this.#subscriptionReservations.size + 1;
    if (observed > this.#maximumSubscriptions) {
      throw new HostResourceLimitError(
        "rpc.subscription-limit",
        "maximumSubscriptionsPerClient",
        this.#maximumSubscriptions,
        observed,
        "rpc"
      );
    }
    this.#subscriptionReservations.add(id);
  }
  settle(request2, response) {
    if (response !== void 0) this.measure(response);
    if (request2.kind === "subscribe") {
      const id = request2.params.subscriptionId;
      this.#subscriptionReservations.delete(id);
      if (response?.kind === "ok") this.#activeSubscriptions.add(id);
    } else if (request2.kind === "unsubscribe" && response?.kind === "ok") {
      this.#activeSubscriptions.delete(request2.params.subscriptionId);
    }
  }
  abandon(request2) {
    if (request2.kind === "subscribe") {
      this.#subscriptionReservations.delete(request2.params.subscriptionId);
    }
  }
  measure(message) {
    const bytes = this.#sizeAccounting.rpcMessageBytes(message);
    this.#onMessageMeasured?.(message, bytes);
    if (bytes > this.#maximumMessageBytes) {
      throw new HostResourceLimitError(
        "rpc.message-too-large",
        "maximumRpcMessageBytes",
        this.#maximumMessageBytes,
        bytes,
        "rpc"
      );
    }
    return bytes;
  }
};
function isResponse(message) {
  return message.kind === "ok" || message.kind === "error";
}
function isEvent(message) {
  return message.kind === "event" || message.kind === "diagnostics" || message.kind === "client-evicted" || message.kind === "subscriber-evicted";
}
var PostMessageSessionRpcAdapter = class {
  #endpoint;
  #events = new AsyncMessageQueue();
  #pending = /* @__PURE__ */ new Map();
  #envelope;
  #onMessage;
  #closed = false;
  #terminalError = new SessionRpcClosedError();
  constructor(endpoint, options = {}) {
    this.#endpoint = endpoint;
    this.#envelope = new SessionRpcEnvelope(options);
    this.#onMessage = ({ data }) => this.#receive(data);
    endpoint.addEventListener("message", this.#onMessage);
    endpoint.start?.();
  }
  get events() {
    return this.#events;
  }
  request(request2) {
    if (this.#closed) return Promise.reject(this.#terminalError);
    if (this.#pending.has(request2.callId)) {
      return Promise.reject(new Error(`duplicate RPC callId ${request2.callId}`));
    }
    try {
      this.#envelope.beforeRequest(request2, this.#pending.size);
    } catch (cause) {
      return Promise.reject(cause);
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(request2.callId, { request: request2, resolve, reject });
      try {
        this.#endpoint.postMessage(request2);
      } catch (error) {
        this.#pending.delete(request2.callId);
        this.#envelope.abandon(request2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async close() {
    this.#terminate(new SessionRpcClosedError());
  }
  workerLost(cause) {
    this.#terminate(new SessionWorkerLostError(cause));
  }
  #receive(message) {
    if (this.#closed) return;
    if (isEvent(message)) {
      try {
        this.#envelope.measure(message);
        this.#events.push(message);
      } catch (cause) {
        if (cause instanceof HostResourceLimitError && "subscriptionId" in message) {
          this.#events.push({
            kind: "subscriber-evicted",
            subscriptionId: message.subscriptionId,
            reason: cause.error
          });
        }
      }
      return;
    }
    if (!isResponse(message)) return;
    const pending = this.#pending.get(message.callId);
    if (pending === void 0) return;
    this.#pending.delete(message.callId);
    try {
      assertCorrelated(pending.request, message);
      this.#envelope.settle(pending.request, message);
      pending.resolve(message);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  #terminate(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#terminalError = error;
    this.#endpoint.removeEventListener("message", this.#onMessage);
    this.#endpoint.close?.();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#events.close();
  }
};
var DeviceSessionRpcClient = class {
  #adapter;
  #clock;
  #eventDelivery;
  #diagnosticListeners = /* @__PURE__ */ new Map();
  #heartbeats = /* @__PURE__ */ new Map();
  #onHeartbeatError;
  #onDiagnosticListenerError;
  #nextCall = 1;
  #nextSubscription = 1;
  #closed = false;
  constructor(adapter, options = {}) {
    this.#adapter = adapter;
    this.#clock = options.clock ?? new RealClock();
    this.#onHeartbeatError = options.onHeartbeatError;
    this.#onDiagnosticListenerError = options.onDiagnosticListenerError;
    this.#eventDelivery = new SessionEventDelivery({
      maximumLosslessQueueDepth: options.maximumLosslessQueueDepth ?? DEFAULT_MAXIMUM_LOSSLESS_QUEUE_DEPTH,
      // Replay is owned by the worker subscription. Addressed events arrive
      // here already selected for this subscriber.
      maximumReplayCount: 0,
      ...options.onListenerError === void 0 ? {} : { onListenerError: options.onListenerError },
      onSubscriberTerminated: (subscriptionId, reason) => {
        try {
          options.onSubscriberTerminated?.(subscriptionId, reason);
        } finally {
          this.#requestUnsubscribe(subscriptionId);
        }
      }
    });
    void this.#pumpEvents();
  }
  async attach(clientId) {
    const policy = await this.#call("attach-client", { clientId });
    this.#startHeartbeat(clientId, policy);
    return policy;
  }
  async detach(clientId) {
    this.#heartbeats.get(clientId)?.dispose();
    this.#heartbeats.delete(clientId);
    await this.#call("detach-client", { clientId });
  }
  getSnapshot() {
    return this.#call("get-snapshot", {});
  }
  resolveCandidates(request2) {
    return this.#call("resolve-candidates", { request: request2 });
  }
  connect(request2) {
    return this.#call("connect", { request: request2 });
  }
  async disconnect(reason) {
    await this.#call("disconnect", reason === void 0 ? {} : { reason });
  }
  startOperation(request2) {
    return this.#call("start-operation", { request: request2 });
  }
  awaitOperation(operationId) {
    return this.#call("await-operation", { operationId });
  }
  async acknowledgeOperation(operationId) {
    await this.#call("acknowledge-operation", { operationId });
  }
  async cancelOperation(operationId) {
    await this.#call("cancel-operation", { operationId });
  }
  subscribe(listener, options) {
    const subscriptionId = this.#subscriptionId();
    this.#eventDelivery.subscribe(subscriptionId, listener);
    void this.#call("subscribe", options === void 0 ? { subscriptionId } : { subscriptionId, options }).catch(() => this.#eventDelivery.unsubscribe(subscriptionId));
    let disposed = false;
    return {
      subscriptionId,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#eventDelivery.unsubscribe(subscriptionId);
        this.#requestUnsubscribe(subscriptionId);
      }
    };
  }
  subscribeDiagnostics(listener, options) {
    const subscriptionId = this.#subscriptionId();
    this.#diagnosticListeners.set(subscriptionId, listener);
    void this.#call("subscribe-diagnostics", options === void 0 ? { subscriptionId } : { subscriptionId, options }).catch(() => this.#diagnosticListeners.delete(subscriptionId));
    return this.#subscription(subscriptionId, this.#diagnosticListeners);
  }
  inspectTransferCheckpoint(checkpointId) {
    return this.#call("inspect-checkpoint", { checkpointId });
  }
  resumeTransfer(request2) {
    return this.#call("resume-transfer", { request: request2 });
  }
  openRawTerminal(subscriptionId) {
    return this.#call("open-raw-terminal", { subscriptionId });
  }
  writeRawTerminal(terminalId, bytes) {
    return this.#call("write-raw-terminal", { terminalId, bytes });
  }
  exitRawTerminal(terminalId) {
    return this.#call("exit-raw-terminal", { terminalId });
  }
  startCapture(destinationId, options) {
    return this.#call("start-capture", { destinationId, options });
  }
  stopCapture(captureId) {
    return this.#call("stop-capture", { captureId });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const heartbeat of this.#heartbeats.values()) heartbeat.dispose();
    this.#heartbeats.clear();
    this.#eventDelivery.clear();
    this.#diagnosticListeners.clear();
    await this.#adapter.close();
  }
  async #call(kind, params) {
    if (this.#closed) throw new SessionRpcClosedError("session RPC client is closed");
    const callId = `call-${this.#nextCall++}`;
    const request2 = { kind, callId, params };
    const response = await this.#adapter.request(request2);
    if (response.kind === "error") throw new SessionRpcError(response.error);
    return response.result;
  }
  #subscriptionId() {
    return `subscription-${this.#nextSubscription++}`;
  }
  #startHeartbeat(clientId, policy) {
    this.#heartbeats.get(clientId)?.dispose();
    let sequence = 0;
    const heartbeat = this.#clock.interval(policy.heartbeatIntervalMs, () => {
      sequence += 1;
      void this.#call("client-heartbeat", { clientId, sequence }).catch((cause) => {
        try {
          this.#onHeartbeatError?.(clientId, cause);
        } catch {
        }
      });
    });
    this.#heartbeats.set(clientId, heartbeat);
  }
  #subscription(subscriptionId, listeners) {
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        listeners.delete(subscriptionId);
        this.#requestUnsubscribe(subscriptionId);
      }
    };
  }
  #requestUnsubscribe(subscriptionId) {
    if (this.#closed) return;
    void this.#call("unsubscribe", { subscriptionId }).catch(() => {
    });
  }
  async #pumpEvents() {
    for await (const message of this.#adapter.events) {
      if (this.#closed) return;
      if (message.kind === "event") {
        this.#eventDelivery.publishTo(message.subscriptionId, message.event);
      } else if (message.kind === "diagnostics") {
        const listener = this.#diagnosticListeners.get(message.subscriptionId);
        if (listener !== void 0) {
          queueMicrotask(() => {
            if (this.#diagnosticListeners.get(message.subscriptionId) !== listener) return;
            void Promise.resolve().then(() => listener(message.batch)).catch((cause) => {
              try {
                this.#onDiagnosticListenerError?.(message.subscriptionId, cause);
              } catch {
              }
            });
          });
        }
      } else if (message.kind === "subscriber-evicted") {
        this.#eventDelivery.terminate(message.subscriptionId, message.reason);
        this.#diagnosticListeners.delete(message.subscriptionId);
      }
    }
  }
};

// src/lifecycle.ts
function installBrowserReleaseHooks(options) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void options.release();
  };
  options.window.addEventListener("beforeunload", release);
  return {
    dispose: () => options.window.removeEventListener("beforeunload", release)
  };
}

// src/hex-window.ts
var HEX_OCTETS = Object.freeze(Array.from(
  { length: 256 },
  (_, value) => value.toString(16).padStart(2, "0")
));
var HexWindow = class {
  #maximumBytes;
  #records = [];
  #retainedBytes = 0;
  constructor(maximumBytes = 32 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("maximumBytes must be a positive safe integer");
    }
    this.#maximumBytes = maximumBytes;
  }
  append(record2) {
    const omitted = Math.max(0, record2.bytes.byteLength - this.#maximumBytes);
    const retained = omitted === 0 ? record2.bytes : record2.bytes.subarray(omitted);
    const prefix = `${record2.sequence.toString().padStart(6)} ${record2.tUs.toFixed(0).padStart(10)} ${record2.direction.toUpperCase()}`;
    const text = `${prefix}${omitted === 0 ? "" : ` \u2026 ${omitted} earlier bytes not rendered`} ${hex(retained)}`;
    this.#records.push({ retainedBytes: retained.byteLength, text });
    this.#retainedBytes += retained.byteLength;
    while (this.#retainedBytes > this.#maximumBytes && this.#records.length > 1) {
      const removed = this.#records.shift();
      if (removed !== void 0) this.#retainedBytes -= removed.retainedBytes;
    }
    return `${this.#records.map(({ text: line }) => line).join("\n")}
`;
  }
};
function hex(bytes) {
  let rendered = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (index > 0) rendered += " ";
    rendered += HEX_OCTETS[bytes[index]];
  }
  return rendered;
}

// src/package-storage.ts
var PACKAGES = "packages";
function request(source) {
  return new Promise((resolve, reject) => {
    source.addEventListener("success", () => resolve(source.result), { once: true });
    source.addEventListener(
      "error",
      () => reject(source.error ?? new Error("IndexedDB package request failed")),
      { once: true }
    );
  });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB package transaction aborted")),
      { once: true }
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB package transaction failed")),
      { once: true }
    );
  });
}
async function openDatabase(factory, name) {
  const opening = factory.open(name, 1);
  opening.addEventListener("upgradeneeded", () => {
    const database = opening.result;
    if (!database.objectStoreNames.contains(PACKAGES)) {
      database.createObjectStore(PACKAGES, { autoIncrement: true });
    }
  });
  return await request(opening);
}
function storedBytes(value, id) {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`browser.package-storage.invalid-record: stored package ${id} is not raw bytes`);
  }
  return Uint8Array.from(value);
}
function numericKey(key) {
  if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 1) {
    throw new Error("browser.package-storage.invalid-key: IndexedDB did not return a positive integer key");
  }
  return key;
}
var BrowserPackageStore = class {
  #database;
  constructor(factory, databaseName = "protodriver-imported-packages") {
    this.#database = openDatabase(factory, databaseName);
  }
  async add(bytes) {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    try {
      const key = await request(transaction.objectStore(PACKAGES).add(Uint8Array.from(bytes)));
      await done;
      return numericKey(key);
    } catch (cause) {
      try {
        transaction.abort();
      } catch {
      }
      await done.catch(() => void 0);
      throw cause;
    }
  }
  async list() {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readonly");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(PACKAGES);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    if (keys.length !== values.length) {
      throw new Error("browser.package-storage.invalid-record: package keys and values differ in length");
    }
    return Object.freeze(keys.map((key, index) => {
      const id = numericKey(key);
      return Object.freeze({ id, byteLength: storedBytes(values[index], id).byteLength });
    }));
  }
  async read(id) {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readonly");
    const done = transactionDone(transaction);
    const value = await request(transaction.objectStore(PACKAGES).get(id));
    await done;
    return value === void 0 ? null : storedBytes(value, id);
  }
  async remove(id) {
    const database = await this.#database;
    const transaction = database.transaction(PACKAGES, "readwrite", { durability: "strict" });
    const done = transactionDone(transaction);
    await request(transaction.objectStore(PACKAGES).delete(id));
    await done;
  }
};

// ../../packages/contracts/src/limits.ts
var DEFAULT_CAPTURE_CAPACITY_POLICY = Object.freeze({
  supportedPayloadBytes: 1048576,
  measuredSourceCutBytes: 9472207,
  measuredCompleteBytes: 64737185,
  headroomNumerator: 11,
  headroomDenominator: 10,
  maximumQueueBytes: 4 * 1024 * 1024,
  maximumRetainedBytes: Math.ceil(64737185 * 11 / 10)
});
var DEFAULT_HOST_RESOURCE_LIMITS = {
  maximumBufferedBytesPerChannel: 4 * 1024 * 1024,
  maximumConcurrentTimers: 1024,
  maximumTransferWindowBytes: 4 * 1024 * 1024,
  maximumChunksInFlight: 64,
  maximumRpcMessageBytes: 8 * 1024 * 1024,
  maximumResourceChunkBytes: 1024 * 1024,
  maximumDiagnosticBufferBytes: 2 * 1024 * 1024,
  maximumEventReplayCount: 256,
  maximumLosslessQueueDepth: 1024,
  maximumRetainedOperationResults: 64,
  maximumClientsPerSession: 4,
  maximumPendingRpcCalls: 256,
  maximumSubscriptionsPerClient: 16,
  maximumDiagnosticSubscribers: 4,
  maximumConcurrentOperations: 32,
  maximumOpenResources: 64,
  maximumOutstandingBrokerCalls: 64,
  maximumCaptureParts: 4096,
  // The largest of three complete 1 MiB Device 3 captures was 64,737,185
  // encoded bytes. Retain 10% measured-population variance headroom, then add
  // the separately reserved browser capture queue to form the host envelope.
  maximumCaptureInMemoryBytes: DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes + DEFAULT_CAPTURE_CAPACITY_POLICY.maximumRetainedBytes
};

// ../../packages/core/src/capture-path.ts
var CapturePartNameError = class extends Error {
  rule;
  constructor(name, rule) {
    super(`capture part name ${JSON.stringify(name)} rejected by ${rule} rule`);
    this.name = "CapturePartNameError";
    this.rule = rule;
  }
};
var MAX_CAPTURE_PART_NAME_LENGTH = 255;
var PORTABLE_CAPTURE_PART_NAME = /^[A-Za-z0-9._-]+$/;
var WINDOWS_RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function assertCapturePartName(name) {
  if (name.length === 0 || name.length > MAX_CAPTURE_PART_NAME_LENGTH) {
    throw new CapturePartNameError(name, "length");
  }
  if (!PORTABLE_CAPTURE_PART_NAME.test(name)) {
    throw new CapturePartNameError(name, "character-set");
  }
  if (name.startsWith(".")) {
    throw new CapturePartNameError(name, "leading-dot");
  }
  if (name.endsWith(".")) {
    throw new CapturePartNameError(name, "trailing-dot");
  }
  const basename = name.split(".", 1)[0];
  if (basename !== void 0 && WINDOWS_RESERVED_DEVICE.test(basename)) {
    throw new CapturePartNameError(name, "reserved-device");
  }
}

// ../../packages/core/src/capture-rpc.ts
function causeSnapshot(cause) {
  if (!(cause instanceof Error)) return void 0;
  return snapshotPlatformCause(cause);
}
function captureError(code, message, cause) {
  const platformCause = causeSnapshot(cause);
  return {
    code,
    message,
    retryability: "no",
    ...platformCause === void 0 ? {} : { platformCause }
  };
}
var CaptureDestinationRegistry = class {
  #destinations = /* @__PURE__ */ new Map();
  #maximumPartsPerDestination;
  #nextId = 1;
  constructor(maximumPartsPerDestination = DEFAULT_PHASE_ONE_LIMITS.maximumCaptureParts) {
    this.#maximumPartsPerDestination = maximumPartsPerDestination;
  }
  get size() {
    return this.#destinations.size;
  }
  async register(destination, sessionId) {
    const id = `capture-destination-${this.#nextId++}`;
    this.#destinations.set(id, { id, destination, sessionId, partsOpened: 0 });
    return id;
  }
  async release(id) {
    this.#destinations.delete(id);
  }
  async handle(request2, sessionId) {
    const entry = this.#destinations.get(request2.destinationId);
    if (entry === void 0 || entry.sessionId !== sessionId) {
      return {
        kind: "error",
        error: captureError(
          "capture.destination-unknown",
          `capture destination ${request2.destinationId} is not registered`
        )
      };
    }
    try {
      switch (request2.kind) {
        case "open-part": {
          assertCapturePartName(request2.name);
          if (entry.partsOpened >= this.#maximumPartsPerDestination) {
            throw new HostResourceLimitError(
              "capture.part-limit",
              "maximumCaptureParts",
              this.#maximumPartsPerDestination,
              entry.partsOpened + 1,
              "capture"
            );
          }
          entry.partsOpened += 1;
          let resourceId;
          try {
            resourceId = await entry.destination.openPart(
              request2.name,
              request2.contentType === void 0 ? void 0 : { contentType: request2.contentType }
            );
          } catch (cause) {
            entry.partsOpened -= 1;
            throw cause;
          }
          return {
            kind: "part-opened",
            resourceId
          };
        }
        case "commit-destination":
          await entry.destination.commit();
          return { kind: "ok" };
        case "abort-destination":
          await entry.destination.abort(request2.error);
          return { kind: "ok" };
      }
    } catch (cause) {
      if (cause instanceof HostResourceLimitError) {
        return { kind: "error", error: cause.error };
      }
      return {
        kind: "error",
        error: captureError(
          `capture.${request2.kind}-failed`,
          cause instanceof Error ? cause.message : String(cause),
          cause
        )
      };
    }
  }
};
function isCaptureResponse(message) {
  return message.kind === "part-opened" || message.kind === "ok" || message.kind === "error";
}
function serveCaptureDestinationRpc(endpoint, registry, sessionId) {
  let closed = false;
  const onMessage = ({ data }) => {
    if (closed || isCaptureResponse(data)) return;
    void registry.handle(data, sessionId).then((response) => {
      if (!closed) endpoint.postMessage(response);
    });
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();
  return {
    dispose() {
      if (closed) return;
      closed = true;
      endpoint.removeEventListener("message", onMessage);
      endpoint.close?.();
    }
  };
}

// ../../packages/core/src/resources.ts
var ResourceBrokerError = class extends Error {
  error;
  constructor(error) {
    super(error.message);
    this.name = "ResourceBrokerError";
    this.error = error;
  }
};
var PartialResourceWriteError = class extends Error {
  knownAcceptedBytes;
  requestedBytes;
  constructor(knownAcceptedBytes, requestedBytes, message = "resource write was partial") {
    super(message);
    this.name = "PartialResourceWriteError";
    this.knownAcceptedBytes = requireNonNegativeSafeInteger2(knownAcceptedBytes, "knownAcceptedBytes");
    this.requestedBytes = requireNonNegativeSafeInteger2(requestedBytes, "requestedBytes");
    if (knownAcceptedBytes >= requestedBytes) {
      throw new RangeError("a partial write must accept fewer bytes than requested");
    }
  }
};
function requireNonNegativeSafeInteger2(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}
function pdrError(code, message, details) {
  return {
    code,
    message,
    retryability: "no",
    ...details === void 0 ? {} : { details }
  };
}
function causeSnapshot2(cause) {
  if (!(cause instanceof Error)) return void 0;
  return snapshotPlatformCause(cause);
}
function failure(cause, operation) {
  if (cause instanceof ResourceBrokerError) return cause.error;
  if (cause instanceof PartialResourceWriteError) {
    const base2 = pdrError(
      "resource.partial-write",
      cause.message,
      {
        knownAcceptedBytes: cause.knownAcceptedBytes,
        requestedBytes: cause.requestedBytes
      }
    );
    const platformCause2 = causeSnapshot2(cause);
    return platformCause2 === void 0 ? base2 : { ...base2, platformCause: platformCause2 };
  }
  const base = pdrError(
    `resource.${operation}-failed`,
    cause instanceof Error ? cause.message : String(cause)
  );
  const platformCause = causeSnapshot2(cause);
  return platformCause === void 0 ? base : { ...base, platformCause };
}
function responseError(callId, error) {
  return { kind: "error", callId, error };
}
function sameSession(scope, sessionId) {
  return scope.kind !== "host" && scope.sessionId === sessionId;
}
var ResourceBrokerHost = class {
  #namespace = crypto.randomUUID();
  #resources = /* @__PURE__ */ new Map();
  #callsById = /* @__PURE__ */ new Map();
  #callByResource = /* @__PURE__ */ new Map();
  #maximumOpenResources;
  #maximumOutstandingCalls;
  #maximumChunkBytes;
  #nextResource = 1;
  #nextRegistrationOrder = 1;
  #currentReadBufferBytes = 0;
  #highWaterReadBufferBytes = 0;
  constructor(options = {}) {
    this.#maximumOpenResources = options.maximumOpenResources ?? DEFAULT_PHASE_ONE_LIMITS.maximumOpenResources;
    this.#maximumOutstandingCalls = options.maximumOutstandingCalls ?? DEFAULT_PHASE_ONE_LIMITS.maximumOutstandingBrokerCalls;
    this.#maximumChunkBytes = options.maximumChunkBytes ?? DEFAULT_PHASE_ONE_LIMITS.maximumResourceChunkBytes;
  }
  get metrics() {
    return {
      currentReadBufferBytes: this.#currentReadBufferBytes,
      highWaterReadBufferBytes: this.#highWaterReadBufferBytes,
      openResources: this.#resources.size,
      callsInFlight: this.#callsById.size
    };
  }
  async registerSource(source, scope) {
    return this.#register({ kind: "source", source, scope });
  }
  async registerSink(sink, scope) {
    return this.#register({ kind: "sink", sink, scope });
  }
  async outstanding() {
    return [...this.#resources.values()].filter(({ scope }) => scope.kind === "host").sort((left, right) => left.registrationOrder - right.registrationOrder).map(({ id }) => id);
  }
  async handle(request2) {
    const callId = request2.call.callId;
    if (this.#callsById.has(callId)) {
      return responseError(callId, pdrError(
        "resource.call-id-in-use",
        `broker call id ${callId} is already in flight`
      ));
    }
    if (request2.kind === "cancel") return this.#cancel(request2);
    if (request2.kind === "close" && !this.#resources.has(request2.id)) {
      return { kind: "ok", callId };
    }
    const entry = this.#resources.get(request2.id);
    if (entry === void 0) {
      return responseError(callId, pdrError(
        "resource.unknown-id",
        `resource ${request2.id} is not open`
      ));
    }
    if (entry.readGrant && request2.kind !== "release-read" && request2.call.readGrantId !== entry.readGrant.id) {
      return responseError(callId, pdrError("resource.delegated", "source is exclusively delegated to " + entry.readGrant.operationId));
    }
    if (request2.call.readGrantId !== void 0 && request2.call.readGrantId !== entry.readGrant?.id) {
      return responseError(callId, pdrError("resource.stale-grant", "read delegation is unavailable"));
    }
    if (request2.kind === "read" && request2.maximumBytes > this.#maximumChunkBytes) {
      return responseError(callId, new HostResourceLimitError(
        "resource.chunk-too-large",
        "maximumResourceChunkBytes",
        this.#maximumChunkBytes,
        request2.maximumBytes,
        "resource"
      ).error);
    }
    if (request2.kind === "write" && request2.data.byteLength > this.#maximumChunkBytes) {
      return responseError(callId, new HostResourceLimitError(
        "resource.chunk-too-large",
        "maximumResourceChunkBytes",
        this.#maximumChunkBytes,
        request2.data.byteLength,
        "resource"
      ).error);
    }
    const active = this.#callByResource.get(request2.id);
    if (active !== void 0) {
      return responseError(callId, pdrError(
        "resource.call-in-flight",
        `resource ${request2.id} already has call ${active} in flight`,
        { resourceId: request2.id, holderCallId: active }
      ));
    }
    if (this.#callsById.size >= this.#maximumOutstandingCalls) {
      return responseError(callId, new HostResourceLimitError(
        "resource.outstanding-call-limit",
        "maximumOutstandingBrokerCalls",
        this.#maximumOutstandingCalls,
        this.#callsById.size + 1,
        "resource"
      ).error);
    }
    const pending = {
      cancelled: false,
      settled: false
    };
    this.#callsById.set(callId, pending);
    this.#callByResource.set(request2.id, callId);
    try {
      const response = await this.#execute(entry, request2);
      pending.settled = true;
      if (pending.cancelled && request2.kind === "read" && !entry.readGrant) {
        if (response.kind === "read") this.#stageRead(entry, response.result);
        return responseError(callId, pdrError(
          "resource.cancelled",
          `resource call ${callId} was cancelled before completion`
        ));
      }
      return response;
    } catch (cause) {
      pending.settled = true;
      if (pending.cancelled && request2.kind === "read") {
        return responseError(callId, pdrError(
          "resource.cancelled",
          `resource call ${callId} was cancelled before completion`
        ));
      }
      return responseError(callId, failure(cause, request2.kind));
    } finally {
      this.#callsById.delete(callId);
      this.#callByResource.delete(request2.id);
    }
  }
  async endOperation(sessionId, operationId) {
    this.#throwCloseFailures(await this.#closeMatching(({ scope }) => scope.kind === "operation" && scope.sessionId === sessionId && scope.operationId === operationId));
  }
  async endSession(sessionId) {
    const failures = [
      ...await this.#closeMatching(({ scope }) => scope.kind === "operation" && sameSession(scope, sessionId)),
      ...await this.#closeMatching(({ scope }) => scope.kind === "session" && sameSession(scope, sessionId))
    ];
    this.#throwCloseFailures(failures);
    return { outstandingHostResources: await this.outstanding() };
  }
  async shutdown() {
    const failures = [
      ...await this.#closeMatching(({ scope }) => scope.kind === "operation"),
      ...await this.#closeMatching(({ scope }) => scope.kind === "session")
    ];
    this.#throwCloseFailures(failures);
    return { outstandingHostResources: await this.outstanding() };
  }
  async closeResource(id) {
    const entry = this.#resources.get(id);
    if (entry === void 0) return;
    if (this.#callByResource.has(id)) {
      throw new ResourceBrokerError(pdrError(
        "resource.call-in-flight",
        `resource ${id} has a call in flight`
      ));
    }
    await this.#closeEntry(entry);
  }
  #register(options) {
    if (this.#resources.size >= this.#maximumOpenResources) {
      throw new HostResourceLimitError(
        "resource.open-limit",
        "maximumOpenResources",
        this.#maximumOpenResources,
        this.#resources.size + 1,
        "resource"
      );
    }
    const id = `resource-${this.#namespace}-${this.#nextResource++}`;
    this.#resources.set(id, {
      id,
      kind: options.kind,
      scope: options.scope,
      registrationOrder: this.#nextRegistrationOrder++,
      ...options.source === void 0 ? {} : { source: options.source },
      ...options.sink === void 0 ? {} : { sink: options.sink }
    });
    return id;
  }
  #cancel(request2) {
    const pending = this.#callsById.get(request2.targetCallId);
    if (pending !== void 0 && !pending.settled) pending.cancelled = true;
    return { kind: "ok", callId: request2.call.callId };
  }
  async #execute(entry, request2) {
    const callId = request2.call.callId;
    switch (request2.kind) {
      case "grant-write": {
        if (entry.kind !== "sink") throw new ResourceBrokerError(pdrError("resource.wrong-kind", "streamed output requires a sink"));
        if (entry.scope.kind === "operation" && entry.scope.operationId !== request2.operationId)
          throw new ResourceBrokerError(pdrError("resource.wrong-owner", "sink belongs to another operation"));
        if (typeof request2.operationId !== "string" || !request2.operationId || request2.operationId.length > 256 || !Number.isSafeInteger(request2.maximumBytes) || request2.maximumBytes < 1)
          throw new ResourceBrokerError(pdrError("resource.write-grant", "finite operation output extent required"));
        if (entry.written || entry.writeGrant) throw new ResourceBrokerError(pdrError("resource.destination-used", "streamed result requires a fresh destination"));
        entry.writeGrant = { id: callId, maximumBytes: request2.maximumBytes, submitted: 0 };
        return { kind: "write-granted", callId, grantId: callId };
      }
      case "grant-stream":
      case "grant-read": {
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError("resource.wrong-kind", "bounded input requires a source"));
        if (entry.scope.kind === "operation" && entry.scope.operationId !== request2.operationId)
          throw new ResourceBrokerError(pdrError("resource.wrong-owner", "source belongs to another operation"));
        const maximumBytes = requireNonNegativeSafeInteger2(request2.maximumBytes, "maximumBytes");
        if (request2.kind === "grant-read" && maximumBytes > 65537 || maximumBytes >= Number.MAX_SAFE_INTEGER || !request2.operationId || request2.operationId.length > 256)
          throw new ResourceBrokerError(pdrError("resource.read-grant", "bounded operation read grant required"));
        if (entry.readGrant) throw new ResourceBrokerError(pdrError("resource.delegated", "source already delegated"));
        const grant = {
          id: callId,
          operationId: request2.operationId,
          maximumBytes,
          ...request2.kind === "grant-stream" ? { streaming: true } : {},
          byteLength: entry.source.byteLength,
          seekable: entry.source.seek !== void 0,
          origin: entry.source.origin ?? "other",
          scope: entry.scope.kind
        };
        entry.readGrant = grant;
        entry.grantedReadBytes = 0;
        entry.rewound = false;
        return { kind: "read-granted", callId, grant };
      }
      case "release-read": {
        if (!entry.readGrant || entry.readGrant.id !== request2.grantId)
          throw new ResourceBrokerError(pdrError("resource.stale-grant", "read delegation is unavailable"));
        delete entry.readGrant;
        delete entry.grantedReadBytes;
        delete entry.rewound;
        delete entry.streamOffset;
        if (entry.scope.kind === "operation") await this.#closeEntry(entry, callId);
        return { kind: "ok", callId };
      }
      case "describe":
        return {
          kind: "described",
          callId,
          descriptor: entry.kind === "source" ? {
            byteLength: entry.source.byteLength,
            seekable: entry.source.seek !== void 0
          } : { byteLength: void 0, seekable: false }
        };
      case "read": {
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a source`
        ));
        const maximumBytes = requireNonNegativeSafeInteger2(request2.maximumBytes, "maximumBytes");
        if (maximumBytes === 0) throw new RangeError("maximumBytes must be greater than zero");
        if (entry.readGrant) {
          if (!entry.rewound || (entry.readGrant.streaming ? maximumBytes > 256 || maximumBytes > entry.readGrant.maximumBytes + 1 - (entry.streamOffset ?? 0) : maximumBytes > entry.readGrant.maximumBytes - entry.grantedReadBytes))
            throw new ResourceBrokerError(pdrError("resource.read-grant-exhausted", "read exceeds the reserved operation range or has no origin"));
          entry.grantedReadBytes += maximumBytes;
        }
        if (entry.bufferedRead !== void 0) {
          return { kind: "read", callId, result: this.#takeBufferedRead(entry, maximumBytes) };
        }
        const workspace = new Uint8Array(maximumBytes);
        this.#retainReadBuffer(maximumBytes);
        try {
          const result = await entry.source.read(workspace);
          const bytesRead = requireNonNegativeSafeInteger2(result.bytesRead, "bytesRead");
          if (bytesRead > maximumBytes) {
            throw new RangeError(`source reported ${bytesRead} bytes into a ${maximumBytes}-byte buffer`);
          }
          if (entry.readGrant) entry.grantedReadBytes -= maximumBytes - bytesRead;
          if (entry.readGrant?.streaming) entry.streamOffset = (entry.streamOffset ?? 0) + bytesRead;
          let data;
          if (bytesRead === maximumBytes) {
            data = workspace.buffer;
          } else {
            this.#retainReadBuffer(bytesRead);
            try {
              data = workspace.buffer.slice(0, bytesRead);
            } finally {
              this.#releaseReadBuffer(bytesRead);
            }
          }
          return { kind: "read", callId, result: { data, eof: result.eof } };
        } finally {
          this.#releaseReadBuffer(maximumBytes);
        }
      }
      case "seek":
        if (entry.kind !== "source") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a source`
        ));
        if (entry.source.seek === void 0) throw new ResourceBrokerError(pdrError(
          "resource.not-seekable",
          `resource ${entry.id} is not seekable`
        ));
        if (entry.readGrant && !entry.readGrant.streaming && (request2.offset !== 0 || entry.rewound))
          throw new ResourceBrokerError(pdrError("resource.read-origin", "bounded grant permits exactly one initial rewind"));
        if (entry.readGrant?.streaming && (!Number.isSafeInteger(request2.offset) || request2.offset < 0 || request2.offset > entry.readGrant.maximumBytes))
          throw new ResourceBrokerError(pdrError("resource.read-origin", "stream seek exceeds delegated source domain"));
        this.#discardBufferedRead(entry);
        await entry.source.seek(requireNonNegativeSafeInteger2(request2.offset, "offset"));
        if (entry.readGrant) entry.rewound = true;
        if (entry.readGrant?.streaming) entry.streamOffset = request2.offset;
        return { kind: "ok", callId };
      case "write":
        if (entry.kind !== "sink") throw new ResourceBrokerError(pdrError(
          "resource.wrong-kind",
          `resource ${entry.id} is not a sink`
        ));
        if (entry.writeGrant) {
          const g = entry.writeGrant;
          if (g.failed || request2.call.writeGrantId !== g.id || request2.data.byteLength > 256 || request2.data.byteLength > g.maximumBytes - g.submitted)
            throw new ResourceBrokerError(pdrError("resource.write-grant", "write is outside its append grant"));
          g.submitted += request2.data.byteLength;
        } else if (request2.call.writeGrantId) throw new ResourceBrokerError(pdrError("resource.stale-grant", "write grant is unavailable"));
        entry.written = true;
        try {
          await entry.sink.write(new Uint8Array(request2.data));
        } catch (cause) {
          if (entry.writeGrant) entry.writeGrant.failed = true;
          throw cause;
        }
        return { kind: "ok", callId };
      case "close":
        await this.#closeEntry(entry, callId);
        return { kind: "ok", callId };
    }
  }
  async #closeMatching(predicate) {
    const entries = [...this.#resources.values()].filter(predicate).sort((left, right) => left.registrationOrder - right.registrationOrder);
    const failures = [];
    for (const entry of entries) {
      try {
        await this.#closeEntry(entry);
      } catch (cause) {
        failures.push(cause);
      }
    }
    return failures;
  }
  #throwCloseFailures(failures) {
    if (failures.length > 0) {
      throw new AggregateError(failures, "one or more resources failed to close");
    }
  }
  async #closeEntry(entry, allowedCallId) {
    if (!this.#resources.has(entry.id)) return;
    const activeCallId = this.#callByResource.get(entry.id);
    if (activeCallId !== void 0 && activeCallId !== allowedCallId) {
      throw new ResourceBrokerError(pdrError(
        "resource.call-in-flight",
        `resource ${entry.id} has a call in flight`
      ));
    }
    await (entry.kind === "source" ? entry.source.close() : entry.sink.close());
    this.#discardBufferedRead(entry);
    this.#resources.delete(entry.id);
  }
  #stageRead(entry, result) {
    if (entry.bufferedRead !== void 0) {
      throw new Error(`resource ${entry.id} already has a buffered read`);
    }
    entry.bufferedRead = { data: result.data, eof: result.eof, offset: 0 };
    this.#retainReadBuffer(result.data.byteLength);
  }
  #takeBufferedRead(entry, maximumBytes) {
    const buffered = entry.bufferedRead;
    const remaining = buffered.data.byteLength - buffered.offset;
    const bytesRead = Math.min(remaining, maximumBytes);
    const finishesBuffer = bytesRead === remaining;
    let data;
    if (buffered.offset === 0 && finishesBuffer) {
      data = buffered.data;
    } else {
      this.#retainReadBuffer(bytesRead);
      try {
        data = buffered.data.slice(buffered.offset, buffered.offset + bytesRead);
      } finally {
        this.#releaseReadBuffer(bytesRead);
      }
    }
    buffered.offset += bytesRead;
    if (finishesBuffer) {
      this.#releaseReadBuffer(buffered.data.byteLength);
      delete entry.bufferedRead;
    }
    return { data, eof: finishesBuffer && buffered.eof };
  }
  #discardBufferedRead(entry) {
    if (entry.bufferedRead === void 0) return;
    this.#releaseReadBuffer(entry.bufferedRead.data.byteLength);
    delete entry.bufferedRead;
  }
  #retainReadBuffer(bytes) {
    this.#currentReadBufferBytes += bytes;
    this.#highWaterReadBufferBytes = Math.max(
      this.#highWaterReadBufferBytes,
      this.#currentReadBufferBytes
    );
  }
  #releaseReadBuffer(bytes) {
    this.#currentReadBufferBytes -= bytes;
  }
};
function isResourceResponse(message) {
  return message.kind === "described" || message.kind === "read-granted" || message.kind === "write-granted" || message.kind === "ok" || message.kind === "error" || message.kind === "read" && "result" in message;
}
function serveResourceRpc(endpoint, host) {
  let closed = false;
  const onMessage = ({ data }) => {
    if (closed || isResourceResponse(data)) return;
    void host.handle(data).then((response) => {
      if (closed) return;
      const transfer = response.kind === "read" ? [response.result.data] : void 0;
      endpoint.postMessage(response, transfer);
    });
  };
  endpoint.addEventListener("message", onMessage);
  endpoint.start?.();
  return {
    dispose() {
      if (closed) return;
      closed = true;
      endpoint.removeEventListener("message", onMessage);
      endpoint.close?.();
    }
  };
}

// src/session-worker-client.ts
var CAPTURE_SUPPORTED_PAYLOAD_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.supportedPayloadBytes;
var CAPTURE_MEASURED_SOURCE_CUT_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.measuredSourceCutBytes;
var CAPTURE_MEASURED_COMPLETE_BYTES = DEFAULT_CAPTURE_CAPACITY_POLICY.measuredCompleteBytes;
var DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES = 4 * 1024 * 1024;
function browserCaptureMemoryPolicy(limits) {
  const queue = limits.maximumCaptureQueueBytes;
  const aggregate = limits.maximumCaptureInMemoryBytes;
  if (!Number.isSafeInteger(queue) || queue <= 0) {
    throw new RangeError("maximumCaptureQueueBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(aggregate) || aggregate <= queue) {
    throw new RangeError("maximumCaptureInMemoryBytes must exceed maximumCaptureQueueBytes");
  }
  return Object.freeze({
    maximumQueueBytes: queue,
    maximumRetainedBytes: aggregate - queue,
    maximumAggregateBytes: aggregate
  });
}
var DEFAULT_BROWSER_CAPTURE_LIMITS = Object.freeze({
  maximumCaptureQueueBytes: DEFAULT_CAPTURE_CAPACITY_POLICY.maximumQueueBytes,
  maximumCaptureInMemoryBytes: DEFAULT_HOST_RESOURCE_LIMITS.maximumCaptureInMemoryBytes
});
var BROWSER_CAPTURE_MEMORY_POLICY = browserCaptureMemoryPolicy(DEFAULT_BROWSER_CAPTURE_LIMITS);
function browserCaptureSidecarThresholdBytes(limits) {
  return Math.min(browserCaptureMemoryPolicy(limits).maximumQueueBytes, DEFAULT_BROWSER_CAPTURE_SIDECAR_THRESHOLD_BYTES);
}
async function openBrowserSessionContext(deviceBytes, workerFactory = () => new Worker(
  new URL("./sessionWorker.js", import.meta.url),
  { type: "module", name: "protodriver-device-session" }
), captureLimits = DEFAULT_BROWSER_CAPTURE_LIMITS) {
  browserCaptureMemoryPolicy(captureLimits);
  const sessionId = crypto.randomUUID();
  const worker = workerFactory();
  const sessionChannel = new MessageChannel();
  const resourceChannel = new MessageChannel();
  const captureChannel = new MessageChannel();
  const resources = new ResourceBrokerHost();
  const captureDestinations = new CaptureDestinationRegistry();
  const resourceService = serveResourceRpc(resourceChannel.port1, resources);
  const captureService = serveCaptureDestinationRpc(captureChannel.port1, captureDestinations, sessionId);
  const adapter = new PostMessageSessionRpcAdapter(sessionChannel.port1);
  const loaded2 = await new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.kind !== "bootstrap-ready" && data.kind !== "bootstrap-error") return;
      worker.removeEventListener("message", onMessage);
      if (data.kind === "bootstrap-error") reject(new BrowserBootstrapError(data.error));
      else resolve(data.loaded);
    };
    const onError = (event) => {
      adapter.workerLost(new Error(`session worker failed: ${event.message}`));
      reject(new Error(`session worker failed: ${event.message}`));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({
      kind: "bootstrap",
      authoredAcquisition: { kind: "permission-broker-v1" },
      deviceBytes: Uint8Array.from(deviceBytes),
      sessionId,
      sessionPort: sessionChannel.port2,
      resourcePort: resourceChannel.port2,
      capturePort: captureChannel.port2,
      captureLimits
    }, [sessionChannel.port2, resourceChannel.port2, captureChannel.port2]);
  }).catch((cause) => {
    resourceService.dispose();
    captureService.dispose();
    worker.terminate();
    throw cause;
  });
  const client = new DeviceSessionRpcClient(adapter);
  return {
    sessionId,
    loaded: loaded2,
    client,
    resources,
    captureDestinations,
    registerResource(resource) {
      const scope = { kind: "session", sessionId };
      return "read" in resource ? resources.registerSource(resource, scope) : resources.registerSink(resource, scope);
    },
    registerCaptureDestination(destination) {
      return captureDestinations.register(destination, sessionId);
    },
    async close() {
      await client.close();
      captureService.dispose();
      resourceService.dispose();
      worker.terminate();
    }
  };
}
var BrowserBootstrapError = class extends Error {
  error;
  constructor(error) {
    super(error.message);
    this.name = "BrowserBootstrapError";
    this.error = error;
  }
};
var MemoryByteSink = class {
  #chunks = [];
  #reserve;
  #length = 0;
  #closed = false;
  constructor(reserve) {
    this.#reserve = reserve;
  }
  async write(data) {
    if (this.#closed) throw new Error("capture part is closed");
    this.#reserve(data.byteLength);
    this.#chunks.push(Uint8Array.from(data));
    this.#length += data.byteLength;
  }
  async close() {
    this.#closed = true;
  }
  bytes() {
    const bytes = new Uint8Array(this.#length);
    let offset = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
};
var BrowserMemoryCaptureDestination = class {
  #resources;
  #sessionId;
  #parts = /* @__PURE__ */ new Map();
  #committed = false;
  #maximumRetainedBytes;
  #retainedBytes = 0;
  constructor(resources, sessionId, limits = DEFAULT_BROWSER_CAPTURE_LIMITS) {
    this.#resources = resources;
    this.#sessionId = sessionId;
    this.#maximumRetainedBytes = browserCaptureMemoryPolicy(limits).maximumRetainedBytes;
  }
  async openPart(name) {
    assertCapturePartName(name);
    const sink = new MemoryByteSink((bytes) => {
      if (bytes > this.#maximumRetainedBytes - this.#retainedBytes) {
        throw new Error("browser capture exceeds maximumCaptureInMemoryBytes after reserving maximumCaptureQueueBytes");
      }
      this.#retainedBytes += bytes;
    });
    this.#parts.set(name, sink);
    return this.#resources.registerSink(sink, { kind: "session", sessionId: this.#sessionId });
  }
  async commit() {
    this.#committed = true;
  }
  async abort(_error) {
    this.#committed = false;
  }
  retainedBytes() {
    return this.#retainedBytes;
  }
  bytes(name = "session.pdcap") {
    if (!this.#committed) throw new Error("capture destination is not committed");
    const part = this.#parts.get(name);
    if (part === void 0) throw new Error(`capture part ${name} does not exist`);
    return part.bytes();
  }
};

// src/webusb-filter.ts
function usbFilterMatches(filter, device) {
  return matchesOptional(filter.vendorId, device.vendorId) && matchesOptional(filter.productId, device.productId) && (filter.usbClass === null || filter.usbClass === void 0 || usbClasses(device).has(filter.usbClass));
}
function usbClasses(device) {
  const result = /* @__PURE__ */ new Set();
  if (device.deviceClass !== 0) result.add(device.deviceClass);
  for (const configuration of device.configurations ?? []) {
    for (const usbInterface of configuration.interfaces) {
      for (const alternate of usbInterface.alternates) result.add(alternate.interfaceClass);
    }
  }
  return result;
}
function matchesOptional(expected, actual) {
  return expected === null || expected === void 0 || expected === actual;
}

// ../../packages/control-model/src/authored.ts
function requireAuthoredOutput(model, outcome, destinationId, bytes) {
  const r = outcome.resourceResult;
  if (outcome.outcome !== "completed" || outcome.result !== null || !r || r.destinationId !== destinationId || r.kind !== model.kind || r.content !== model.content || r.mediaType !== model.mediaType || r.suggestedExtension !== model.suggestedExtension || r.byteLength !== bytes || bytes < model.minimumBytes || bytes > model.maximumBytes) throw new Error("declared operation output did not complete with its resource receipt: " + JSON.stringify(outcome));
}
function authoredStateLabel(cell) {
  return cell.quality === "unknown" ? "Unknown (not observed)" : cell.quality === "stale" ? "Stale" : cell.quality === "invalid" ? "Invalid" : "Current";
}

// ../../packages/control-model/src/exact-decimal.ts
function parseExactDecimal(source) {
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(source);
  if (match === null) return null;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1e3) return null;
  const fraction = match[3] ?? "";
  let coefficient = BigInt(`${match[1] === "-" ? "-" : ""}${match[2]}${fraction}`);
  let decimalPlaces = fraction.length - exponent;
  if (decimalPlaces < 0) {
    coefficient *= 10n ** BigInt(-decimalPlaces);
    decimalPlaces = 0;
  }
  return { coefficient, decimalPlaces };
}
function divideExactDecimal(value, divisor) {
  let numerator = value.coefficient;
  let denominator = 10n ** BigInt(value.decimalPlaces) * divisor;
  const common = greatestCommonDivisor(numerator < 0n ? -numerator : numerator, denominator);
  numerator /= common;
  denominator /= common;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n) {
    throw new Error("exact human-unit scaling requires a terminating decimal denominator containing only factors 2 and 5");
  }
  const places = Math.max(twos, fives);
  numerator *= 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
  return formatExactDecimal({ coefficient: numerator, decimalPlaces: places });
}
function greatestCommonDivisor(left, right) {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left === 0n ? 1n : left;
}
function formatExactDecimal(value) {
  const negative = value.coefficient < 0n;
  const magnitude = (negative ? -value.coefficient : value.coefficient).toString(10);
  if (value.decimalPlaces === 0) return `${negative ? "-" : ""}${magnitude}`;
  const padded = magnitude.padStart(value.decimalPlaces + 1, "0");
  const split = padded.length - value.decimalPlaces;
  const fraction = padded.slice(split).replace(/0+$/u, "");
  const number = fraction.length === 0 ? padded.slice(0, split) : `${padded.slice(0, split)}.${fraction}`;
  return `${negative && number !== "0" ? "-" : ""}${number}`;
}

// ../../packages/control-model/src/index.ts
function stringifyGeneratedPublicJson(value) {
  return JSON.stringify(value, (_key, member) => {
    if (member instanceof Uint8Array) {
      return { type: "bytes", encoding: "base64", value: base64(member) };
    }
    if (typeof member === "bigint") {
      return { type: member < 0n ? "i64" : "u64", value: member.toString(10) };
    }
    if (member instanceof Set) return [...member].sort();
    return member;
  });
}
function formatGeneratedHumanUnitValue(decimalValue, unit) {
  const parsed = parseExactDecimal(decimalValue);
  if (parsed === null) return `${decimalValue} ${unit.id}`;
  const scale = humanUnitScale(parsed, unit.id);
  const scaled = divideExactDecimal(parsed, scale.divisor);
  return `${scaled} ${scale.unit}`;
}
var MAXIMUM_INLINE_RESULT_BYTES = 8;
function formatGeneratedHumanBytes(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_INLINE_RESULT_BYTES) {
    return formatGeneratedHumanUnitValue(String(bytes.byteLength), { kind: "fixed", id: "byte" });
  }
  return `hex ${[...bytes].map((octet) => octet.toString(16).padStart(2, "0")).join(" ")}`;
}
function formatGeneratedHumanBase64Bytes(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = value.length === 0 ? 0 : value.length / 4 * 3 - padding;
  if (byteLength === 0 || byteLength > MAXIMUM_INLINE_RESULT_BYTES) {
    return formatGeneratedHumanUnitValue(String(byteLength), { kind: "fixed", id: "byte" });
  }
  const decoded = atob(value);
  return formatGeneratedHumanBytes(Uint8Array.from(decoded, (member) => member.charCodeAt(0)));
}
function humanUnitScale(value, unit) {
  switch (unit) {
    case "centidegree-celsius":
      return { divisor: 100n, unit: "\xB0C" };
    case "millivolt":
      return { divisor: 1000n, unit: "V" };
    case "tenth-hertz":
      return { divisor: 10n, unit: "Hz" };
    case "microsecond":
      return { divisor: 1000000n, unit: "s" };
    case "millisecond":
      return { divisor: 1000n, unit: "s" };
    case "hertz":
      return largestMagnitudeScale(value, [
        { divisor: 1000000000000000000n, unit: "EHz" },
        { divisor: 1000000000000000n, unit: "PHz" },
        { divisor: 1000000000000n, unit: "THz" },
        { divisor: 1000000000n, unit: "GHz" },
        { divisor: 1000000n, unit: "MHz" },
        { divisor: 1000n, unit: "kHz" },
        { divisor: 1n, unit: "Hz" }
      ]);
    case "byte":
      return largestMagnitudeScale(value, [
        { divisor: 1152921504606846976n, unit: "EiB" },
        { divisor: 1125899906842624n, unit: "PiB" },
        { divisor: 1099511627776n, unit: "TiB" },
        { divisor: 1073741824n, unit: "GiB" },
        { divisor: 1048576n, unit: "MiB" },
        { divisor: 1024n, unit: "KiB" },
        { divisor: 1n, unit: "B" }
      ]);
  }
}
function largestMagnitudeScale(value, scales) {
  const magnitude = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  const denominator = 10n ** BigInt(value.decimalPlaces);
  return scales.find(({ divisor }) => magnitude >= divisor * denominator) ?? scales[scales.length - 1];
}
function base64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset];
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[(first & 3) << 4 | (second ?? 0) >> 4];
    encoded += second === void 0 ? "=" : alphabet[(second & 15) << 2 | (third ?? 0) >> 6];
    encoded += third === void 0 ? "=" : alphabet[third & 63];
  }
  return encoded;
}

// ../../packages/generated-web/src/authored-output.ts
async function collectAuthoredOutput(client, operation, args, register, observe = {}) {
  const model = operation.result;
  if (model.kind !== "file" && model.kind !== "resource") throw new Error("operation has no declared resource result");
  const chunks = [];
  let bytes = 0, closed = false;
  const id = await register({ async write(data) {
    if (closed || bytes + data.length > model.maximumBytes) throw new Error("output sink bound exceeded");
    chunks.push(new Uint8Array(data));
    bytes += data.length;
  }, async close() {
    closed = true;
  } });
  const handle = await client.startOperation({ operation: operation.id, arguments: args, resultDestinationId: id });
  observe.accepted?.(handle.operationId);
  const outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  requireAuthoredOutput(model, outcome, id, bytes);
  if (!closed) throw new Error("output receipt preceded sink close");
  const blob = new Blob(chunks, { type: model.mediaType });
  return { outcome, blob, download(documentApi = document, urls = URL) {
    const url = urls.createObjectURL(blob);
    try {
      const anchor = documentApi.createElement("a");
      anchor.href = url;
      anchor.download = "protodriver-result." + (model.suggestedExtension ?? "bin");
      anchor.click();
    } finally {
      urls.revokeObjectURL(url);
    }
  } };
}

// ../../packages/generated-web/src/authored-input.ts
var AuthoredFileByteSource = class {
  origin = "file";
  byteLength;
  #file;
  #offset = 0;
  #closed = false;
  constructor(file) {
    this.#file = file;
    this.byteLength = file.size;
  }
  async read(into) {
    if (this.#closed) throw new Error("file source is closed");
    const bytes = new Uint8Array(await this.#file.slice(this.#offset, this.#offset + into.length).arrayBuffer());
    into.set(bytes);
    this.#offset += bytes.length;
    return { bytesRead: bytes.length, eof: this.#offset === this.byteLength };
  }
  async seek(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength) throw new RangeError("file origin out of range");
    this.#offset = offset;
  }
  async close() {
    this.#closed = true;
  }
};
async function registerAuthoredFileArgument(operation, name, file, register) {
  if (!["byte-source", "stream-source"].includes(operation.arguments[name]?.kind ?? "")) throw new Error("argument is not a declared file source: " + name);
  const source = new AuthoredFileByteSource(file);
  try {
    return { argument: { kind: "resource", id: await register(source) }, close: () => source.close() };
  } catch (cause) {
    await source.close();
    throw cause;
  }
}

// ../../packages/generated-web/src/index.ts
function renderAuthoredResult(model, value, path = "$.result") {
  if (model === null) return "";
  if (model.kind === "leaf") return escapeHtml(formatResultValue(model.value, value, path));
  if (model.kind === "array") {
    if (!Array.isArray(value)) throw new Error("authored result array required at " + path);
    return '<ol class="authored-result-array">' + value.map((item, i) => "<li>" + renderAuthoredResult(model.item, item, path + "[" + i + "]") + "</li>").join("") + "</ol>";
  }
  if (!isObjectRecord(value)) throw new Error("authored result record required at " + path);
  if (model.kind === "variant") {
    if (value.kind !== "variant" || typeof value.tag !== "string" || !Object.hasOwn(model.variants, value.tag)) throw new Error("undeclared authored variant");
    return '<section class="authored-result-variant"><h4>' + escapeHtml(label(value.tag)) + "</h4>" + renderAuthoredResult(model.variants[value.tag], value.value, path + "." + value.tag) + "</section>";
  }
  return '<dl class="authored-result-record">' + Object.entries(model.fields).map(([key, child]) => "<dt>" + escapeHtml(label(key)) + "</dt><dd>" + renderAuthoredResult(child, value[key], path + "." + key) + "</dd>").join("") + "</dl>";
}
function escapeHtml(value) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}
function label(value) {
  return value.replace(/[_-]+/gu, " ").replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
}
function formatResultValue(model, value, path) {
  if (value === void 0) return "Not observed";
  switch (model.kind) {
    case "scalar":
      return formatScalarWithUnit(value, model.unit, path);
    case "bytes":
      return formatBytes(value, path);
    case "member": {
      if (typeof value !== "string") return unrenderableValue(model.kind, path);
      const member = model.members.find(({ name }) => name === value);
      if (member === void 0) throw new Error(`browser renderer has no declared member ${JSON.stringify(value)} at ${path}`);
      return member.label ?? label(member.name);
    }
    case "flags": {
      const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : void 0;
      if (values === void 0 || values.some((member) => typeof member !== "string")) return unrenderableValue(model.kind, path);
      if (values.length === 0) return "None";
      return values.map((name) => {
        const member = model.members.find((candidate) => candidate.name === name);
        if (member === void 0) throw new Error(`browser renderer has no declared flag ${JSON.stringify(name)} at ${path}`);
        return member.label ?? label(member.name);
      }).join(", ");
    }
    case "packed-bcd": {
      const tagged = taggedKind(value, path);
      if (tagged.kind === "value") return formatScalarWithUnit(tagged.value, model.unit, `${path}.value`);
      if (tagged.kind === "special" && typeof tagged.name === "string") {
        const special = model.specialValues.find(({ name }) => name === tagged.name);
        if (special === void 0) throw new Error(`browser renderer has no declared special value ${JSON.stringify(tagged.name)} at ${path}`);
        return special.label ?? label(special.name);
      }
      return unknownRendererKind("result value", path, tagged.kind);
    }
    case "variant": {
      const tagged = taggedKind(value, path);
      const variant = model.variants.find(({ name }) => name === tagged.kind);
      if (variant === void 0) return unknownRendererKind("result variant", path, tagged.kind);
      if (!("fields" in tagged) || !isObjectRecord(tagged.fields)) return unrenderableValue(model.kind, path);
      const fields = tagged.fields;
      const title = variant.label ?? label(variant.name);
      if (variant.fields.length === 0) return title;
      return `${title} \u2014 ${variant.fields.map((field) => `${field.label ?? label(field.name)}: ${formatResultValue(field.value, fields[field.name], `${path}.fields.${field.name}`)}`).join(", ")}`;
    }
  }
}
function formatScalar(value, path) {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length === 0 ? "Empty text" : value;
  if (isObjectRecord(value) && "type" in value && "value" in value && typeof value.value === "string") {
    if (value.type === "u64" || value.type === "i64" || value.type === "decimal") return value.value;
    if (value.type === "bytes") {
      return formatGeneratedHumanUnitValue(String(base64ByteLength(value.value)), { kind: "fixed", id: "byte" });
    }
    return unknownRendererKind("public scalar", path, String(value.type));
  }
  if (isObjectRecord(value) && value.kind === "decimal" && typeof value.value === "number" && (value.suffix === null || typeof value.suffix === "string")) {
    return `${value.value}${value.suffix ?? ""}`;
  }
  if (isObjectRecord(value) && typeof value.kind === "string") {
    return unknownRendererKind("result value", path, value.kind);
  }
  return unrenderableValue("scalar", path);
}
function formatScalarWithUnit(value, unit, path) {
  if (unit === null) return formatScalar(value, path);
  const decimal = decimalValueText(value);
  if (decimal === null) return unrenderableValue("numeric scalar", path);
  return formatGeneratedHumanUnitValue(decimal, unit);
}
function decimalValueText(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return value.toString(10);
  if (isObjectRecord(value) && (value.type === "u64" || value.type === "i64" || value.type === "decimal") && typeof value.value === "string") return value.value;
  return null;
}
function formatBytes(value, path) {
  if (value instanceof Uint8Array) {
    return formatGeneratedHumanBytes(value);
  }
  if (isObjectRecord(value) && value.type === "bytes" && value.encoding === "base64" && typeof value.value === "string") {
    return formatGeneratedHumanBase64Bytes(value.value);
  }
  return unrenderableValue("bytes", path);
}
function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length === 0 ? 0 : value.length / 4 * 3 - padding;
}
function taggedKind(value, path) {
  if (!isObjectRecord(value) || typeof value.kind !== "string") return unrenderableValue("tagged", path);
  return value;
}
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}
function unrenderableValue(kind, path) {
  throw new Error(`browser renderer cannot render ${kind} value at ${path}`);
}
function unknownRendererKind(subject, path, kind) {
  throw new Error(`browser renderer has no ${subject} kind ${JSON.stringify(kind)} at ${path}`);
}

// src/file-result.ts
function downloadAuthoredFileResult(model, value, documentApi = document, objectUrls = URL) {
  const url = objectUrls.createObjectURL(value);
  try {
    const anchor = documentApi.createElement("a");
    anchor.href = url;
    anchor.download = `protodriver-result.${model.suggestedExtension}`;
    anchor.click();
  } finally {
    objectUrls.revokeObjectURL(url);
  }
}
var BrowserFilePreviewOwner = class {
  #objectUrls;
  #ownedUrl;
  constructor(objectUrls = URL) {
    this.#objectUrls = objectUrls;
  }
  show(value, elements) {
    this.release();
    const url = this.#objectUrls.createObjectURL(value);
    this.#ownedUrl = url;
    elements.image.hidden = true;
    elements.status.textContent = "Preview loading.";
    elements.image.onload = () => {
      if (this.#ownedUrl !== url) return;
      elements.image.hidden = false;
      elements.status.textContent = "Preview available.";
    };
    elements.image.onerror = () => {
      if (this.#ownedUrl !== url) return;
      this.release();
      elements.image.hidden = true;
      elements.status.textContent = "Preview unavailable. The original bytes can still be saved.";
    };
    elements.image.src = url;
  }
  release() {
    if (this.#ownedUrl === void 0) return;
    this.#objectUrls.revokeObjectURL(this.#ownedUrl);
    this.#ownedUrl = void 0;
  }
};
function installBrowserFileResult(model, value, elements, previewOwner, documentApi = document, objectUrls = URL) {
  elements.save.addEventListener("click", () => {
    downloadAuthoredFileResult(model, value, documentApi, objectUrls);
  });
  previewOwner.show(value, elements);
}

// src/authored-risk.ts
function authoredRiskPresentation(operation) {
  return {
    articleClass: `operation risk-${operation.risk}`,
    badge: operation.risk === "read-only" ? null : `Risk: ${operation.risk.replace(/-/gu, " ")}`,
    repeatability: operation.repeatability === "safe-to-repeat" ? "Safe to repeat" : "Not repeatable"
  };
}

// src/authored-argument.ts
var MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var SOURCE_KINDS = /* @__PURE__ */ new Set(["byte-source", "stream-source"]);
function authoredArgumentControl(declaration) {
  const shared = {
    ...declaration.label === void 0 ? {} : { label: declaration.label },
    ...declaration.description === void 0 ? {} : { description: declaration.description }
  };
  if (SOURCE_KINDS.has(declaration.kind)) {
    const source = declaration;
    return { kind: "file", minimumBytes: source.minimumBytes, maximumBytes: source.maximumBytes, ...shared };
  }
  return { kind: "value", type: declaration, ...shared };
}
function authoredArgumentField(control) {
  if (control.kind === "file") {
    return {
      kind: "file",
      minimumBytes: control.minimumBytes ?? 0,
      maximumBytes: control.maximumBytes ?? Number.MAX_SAFE_INTEGER
    };
  }
  const type = control.type;
  if (type === void 0) throw new Error("a value argument declared no type");
  switch (type.kind) {
    case "boolean":
      return { kind: "checkbox" };
    case "enum":
      return { kind: "select", members: type.members ?? [] };
    case "flags":
      return { kind: "flags", members: [...type.members ?? []].sort() };
    case "integer":
      if (type.widthBits === 64) return { kind: "text", placeholder: "whole number" };
      return {
        kind: "number",
        step: "1",
        ...type.minimum === void 0 ? {} : { minimum: type.minimum },
        ...type.maximum === void 0 ? {} : { maximum: type.maximum }
      };
    case "float":
      return {
        kind: "number",
        step: "any",
        ...type.minimum === void 0 ? {} : { minimum: type.minimum },
        ...type.maximum === void 0 ? {} : { maximum: type.maximum }
      };
    case "decimal":
      return { kind: "text", placeholder: "21.50" };
    case "bytes":
      return { kind: "text", placeholder: "41 54 0d 0a" };
    case "string":
      return {
        kind: "text",
        ...type.minimumLength === void 0 ? {} : { minimumLength: type.minimumLength },
        ...type.maximumLength === void 0 ? {} : { maximumLength: type.maximumLength }
      };
    default:
      return { kind: "text", placeholder: `JSON ${type.kind}` };
  }
}
function authoredArgumentHint(control) {
  if (control.kind === "file") {
    const maximum = control.maximumBytes;
    if (maximum === void 0 || maximum >= Number.MAX_SAFE_INTEGER) return void 0;
    return `${(control.minimumBytes ?? 0).toLocaleString()} to ${maximum.toLocaleString()} bytes.`;
  }
  const type = control.type;
  if (type === void 0) return void 0;
  switch (type.kind) {
    case "integer":
      if (type.minimum !== void 0 && type.maximum !== void 0) {
        return `Whole number, ${type.minimum.toLocaleString()} to ${type.maximum.toLocaleString()}.`;
      }
      return type.widthBits === 64 ? "Whole number, up to 64 bits." : "Whole number.";
    case "decimal":
      return "Exact decimal, written the way the device states it.";
    case "bytes":
      return "Hexadecimal bytes, spaces optional.";
    case "string":
      if (type.maximumLength !== void 0) return `Text, up to ${type.maximumLength} characters.`;
      return void 0;
    case "flags":
      return "Choose any combination.";
    case "boolean":
    case "enum":
    case "float":
      return void 0;
    default:
      return `A JSON ${type.kind}, exactly as the device declares it.`;
  }
}
function authoredArgumentValue(control, raw) {
  const type = control.type;
  if (control.kind === "file" || type === void 0) {
    throw new Error("a file argument carries no public value");
  }
  switch (type.kind) {
    case "boolean":
      if (typeof raw !== "boolean") throw new Error("expected a checked state");
      return raw;
    case "flags": {
      if (!Array.isArray(raw)) throw new Error("expected the chosen flag names");
      return Object.freeze([...raw].sort());
    }
    case "enum":
      return requireChosen(raw);
    case "string":
      return requireText(raw);
    case "integer":
      return publicInteger(requireText(raw).trim(), type);
    case "float": {
      const value = Number(requireChosen(raw));
      if (!Number.isFinite(value)) throw new Error("expected a finite number");
      return value;
    }
    case "decimal": {
      const text = requireText(raw).trim();
      if (!/^-?\d+(?:\.\d+)?$/u.test(text)) throw new Error("expected a decimal such as 21.50");
      return { type: "decimal", value: text };
    }
    case "bytes":
      return { type: "bytes", encoding: "base64", value: encodeBase64(parseHexBytes(requireText(raw))) };
    default: {
      const text = requireText(raw).trim();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`expected a JSON ${type.kind}`);
      }
    }
  }
}
function requireText(raw) {
  if (typeof raw !== "string") throw new Error("expected typed text");
  return raw;
}
function requireChosen(raw) {
  const text = requireText(raw).trim();
  if (text.length === 0) throw new Error("expected a value");
  return text;
}
function publicInteger(text, type) {
  if (!/^-?\d+$/u.test(text)) throw new Error("expected a whole number");
  const value = BigInt(text);
  if (value >= -MAX_SAFE && value <= MAX_SAFE) return Number(value);
  return { type: type.signed === true ? "i64" : "u64", value: value.toString(10) };
}
function parseHexBytes(text) {
  const digits = text.replace(/[\s_:]+/gu, "");
  if (digits.length % 2 !== 0) throw new Error("expected an even number of hex digits");
  if (digits.length > 0 && !/^[0-9a-fA-F]+$/u.test(digits)) throw new Error("expected hexadecimal digits");
  const bytes = new Uint8Array(digits.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
function encodeBase64(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
    output += BASE64[a >> 2] + BASE64[(a & 3) << 4 | (b ?? 0) >> 4];
    output += b === void 0 ? "=" : BASE64[(b & 15) << 2 | (c ?? 0) >> 6];
    output += c === void 0 ? "=" : BASE64[c & 63];
  }
  return output;
}

// src/authored-controls.ts
async function runAuthoredOperationWithOneResume(client, request2, accepted = () => {
}) {
  let handle = await client.startOperation(request2);
  accepted(handle.operationId);
  let outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  if (outcome.outcome !== "resume-required") return { outcome, resumeCount: 0 };
  if (!outcome.authoredCause) throw new Error("resume-required outcome omitted its authored cause");
  const receipt = outcome.transferReceipt;
  const receiptRecord = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : void 0;
  const checkpointId = typeof receiptRecord?.checkpointId === "string" ? receiptRecord.checkpointId : void 0;
  if (!checkpointId) throw new Error("resume-required outcome omitted its checkpoint identity");
  const inspection = await client.inspectTransferCheckpoint(checkpointId);
  if (inspection.assurance !== "verified") {
    throw new Error("automatic resume requires verified device identity; explicit operator consent is required");
  }
  handle = await client.resumeTransfer({ ...request2, checkpointId });
  accepted(handle.operationId);
  outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  return { outcome, resumeCount: 1 };
}
var RESULT_SUMMARY = {
  none: "no result",
  value: "returns a value",
  resource: "returns bytes",
  file: "returns a file"
};
function installAuthoredControls(root, loaded2, context, initiallyConnected = false) {
  const filePreviewOwner = new BrowserFilePreviewOwner();
  root.replaceChildren();
  const header = document.createElement("header");
  header.className = "authored-heading";
  const heading = document.createElement("h1");
  heading.textContent = loaded2.model.displayName ?? loaded2.model.id;
  header.append(heading);
  if (loaded2.model.displayName !== void 0) {
    const identifier = document.createElement("p");
    identifier.className = "mono muted";
    identifier.textContent = loaded2.model.id;
    header.append(identifier);
  }
  if (loaded2.model.description !== void 0) {
    const description = document.createElement("p");
    description.className = "authored-description";
    description.textContent = loaded2.model.description;
    header.append(description);
  }
  const limitation = document.createElement("p");
  limitation.className = "muted";
  limitation.textContent = loaded2.hostGrant ? `Connected by the host through ${loaded2.hostGrant.modeId} / ${loaded2.hostGrant.profileId}.` : "Connect above before running a task. This package speaks the protocol; the host opens the connection.";
  header.append(limitation);
  root.append(header);
  let connected2 = initiallyConnected, running = false;
  const active = /* @__PURE__ */ new Map();
  context.client.subscribe((event) => {
    if (event.kind === "operation-progress") {
      const view = active.get(event.operationId);
      if (view !== void 0) {
        view.progress.textContent = `Module-reported progress: ${event.phase} \xB7 ${event.completed}${event.total === void 0 ? "" : ` / ${event.total}`}`;
      }
      return;
    }
    if (event.kind === "transfer-progress") {
      const view = active.get(event.operationId);
      if (view !== void 0) view.progress.textContent = `Host-counted transfer progress: ${event.phase}`;
      return;
    }
    if (event.kind === "operation-end") {
      const view = active.get(event.result.operationId);
      if (view !== void 0) view.cancel.disabled = true;
      return;
    }
    if (event.kind !== "state-cells") return;
    for (const [cell, snapshot] of Object.entries(event.changed)) {
      const view = root.querySelector(`[data-authored-state-cell="${CSS.escape(cell)}"]`);
      const control = loaded2.model.state[cell]?.valueControl;
      if (view === null || control === void 0) continue;
      view.replaceChildren(stateCellHeading(cell, authoredStateLabel(snapshot)));
      if (snapshot.value !== void 0) {
        const value = document.createElement("p");
        value.className = "state-value";
        value.innerHTML = renderAuthoredResult(control, snapshot.value);
        view.append(value);
      }
    }
  });
  const tasks = document.createElement("section");
  tasks.className = "authored-tasks";
  const tasksHeading = document.createElement("h2");
  tasksHeading.textContent = loaded2.model.operations.length === 1 ? "Task" : "Tasks";
  tasks.append(tasksHeading);
  const buttons = [];
  for (const operation of loaded2.model.operations) {
    const risk = authoredRiskPresentation(operation);
    const article = document.createElement("article");
    article.className = risk.articleClass;
    article.dataset.authoredOperation = operation.id;
    const operationHeading = document.createElement("div");
    operationHeading.className = "operation-heading";
    const title = document.createElement("h3");
    title.textContent = operation.title;
    operationHeading.append(title);
    if (risk.badge !== null) {
      const badge = document.createElement("span");
      badge.className = "risk-badge";
      badge.textContent = risk.badge;
      operationHeading.append(badge);
    }
    article.append(operationHeading);
    const policy = document.createElement("p");
    policy.className = "operation-policy";
    policy.textContent = [
      risk.repeatability,
      RESULT_SUMMARY[operation.result.kind] ?? operation.result.kind
    ].join(" \xB7 ");
    article.append(policy);
    if (operation.description !== void 0) {
      const description = document.createElement("p");
      description.className = "authored-description";
      description.textContent = operation.description;
      article.append(description);
    }
    const form = document.createElement("form");
    const fields = /* @__PURE__ */ new Map();
    const argumentFields = document.createElement("div");
    argumentFields.className = "argument-fields";
    for (const [name, declaration] of Object.entries(operation.arguments)) {
      argumentFields.append(buildArgument(name, authoredArgumentControl(declaration), fields));
    }
    if (fields.size > 0) form.append(argumentFields);
    const run = document.createElement("button");
    run.type = "submit";
    run.textContent = "Run";
    const permitted = loaded2.hostGrant !== null && operation.availability.modes.includes(loaded2.hostGrant.modeId) && operation.availability.profiles.includes(loaded2.hostGrant.profileId);
    run.disabled = !permitted;
    buttons.push(run);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.dataset.cancelOperation = "";
    cancel.textContent = "Cancel";
    cancel.disabled = true;
    cancel.addEventListener("click", () => {
      const operationId = [...active.entries()].find(([, view]) => view.cancel === cancel)?.[0];
      if (operationId !== void 0) void context.client.cancelOperation(operationId);
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(run, cancel);
    form.append(actions);
    const progress = document.createElement("p");
    progress.dataset.operationProgress = "";
    progress.className = "muted";
    progress.textContent = "No module-reported progress.";
    progress.hidden = true;
    const output = document.createElement("div");
    output.setAttribute("role", "status");
    output.className = "operation-result muted";
    output.textContent = "Not run in this session.";
    const fileResult = document.createElement("div");
    fileResult.dataset.fileResult = "";
    form.append(progress, output);
    if (operation.result.kind === "file") form.append(fileResult);
    article.append(form);
    tasks.append(article);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (running || !permitted) return;
      running = true;
      const disabled = buttons.map((button2) => button2.disabled);
      buttons.forEach((button2) => {
        button2.disabled = true;
      });
      output.classList.remove("task-error", "muted");
      output.replaceChildren();
      progress.hidden = false;
      progress.textContent = "Running.";
      void (async () => {
        const sources = [];
        try {
          const args = {};
          for (const [name, view] of fields) {
            if (view.file !== void 0) {
              const file = view.file.files?.[0];
              if (!file) throw new Error("select a file for " + name);
              const source = await registerAuthoredFileArgument(operation, name, file, (resource) => context.registerResource(resource));
              sources.push(source);
              args[name] = source.argument;
            } else {
              args[name] = { kind: "value", value: readArgument(name, view) };
            }
          }
          if (!connected2) {
            await context.client.connect({ mode: loaded2.hostGrant.modeId });
            connected2 = true;
          }
          if (operation.result.kind === "resource" || operation.result.kind === "file") {
            const result = await collectAuthoredOutput(context.client, operation, args, (resource) => context.registerResource(resource), {
              accepted: (operationId) => {
                active.set(operationId, { progress, cancel });
                cancel.disabled = false;
              }
            });
            output.textContent = `${result.blob.size.toLocaleString()} bytes saved`;
            result.download();
            if (operation.result.kind === "file") {
              const save = document.createElement("button");
              save.type = "button";
              save.dataset.saveFile = "";
              save.className = "secondary";
              save.textContent = `Save .${operation.result.suggestedExtension ?? "bin"}`;
              const status = document.createElement("p");
              status.dataset.filePreviewStatus = "";
              status.className = "muted";
              status.textContent = "Preview pending.";
              const image = document.createElement("img");
              image.dataset.filePreview = "";
              image.alt = `Generated ${operation.title} preview`;
              image.hidden = true;
              fileResult.replaceChildren(save, status, image);
              installBrowserFileResult(operation.result, result.blob, { save, status, image }, filePreviewOwner);
            }
          } else {
            const { outcome, resumeCount } = await runAuthoredOperationWithOneResume(
              context.client,
              { operation: operation.id, arguments: args },
              (operationId) => {
                active.set(operationId, { progress, cancel });
                cancel.disabled = false;
              }
            );
            if (outcome.outcome !== "completed") throw new Error(stringifyGeneratedPublicJson(outcome));
            output.dataset.hostResumeCount = String(resumeCount);
            output.innerHTML = operation.resultControl === null ? "Completed" : renderAuthoredResult(operation.resultControl, outcome.result);
          }
        } catch (cause) {
          output.classList.add("task-error");
          output.textContent = cause instanceof Error ? cause.message : String(cause);
        } finally {
          for (const [operationId, view] of active) if (view.cancel === cancel) active.delete(operationId);
          cancel.disabled = true;
          for (const source of sources) await source.close();
          running = false;
          buttons.forEach((button2, i) => {
            button2.disabled = disabled[i];
          });
        }
      })();
    });
  }
  root.append(tasks);
  const cells = Object.keys(loaded2.model.state).sort();
  if (cells.length > 0) {
    const state = document.createElement("section");
    state.className = "authored-state";
    const stateHeading = document.createElement("h2");
    stateHeading.textContent = "State";
    state.append(stateHeading);
    const grid = document.createElement("div");
    grid.className = "generated-state";
    for (const cell of cells) {
      const view = document.createElement("div");
      view.className = "state-cell";
      view.dataset.authoredStateCell = cell;
      view.append(stateCellHeading(cell, "Unknown (not observed)"));
      grid.append(view);
    }
    state.append(grid);
    root.append(state);
  }
}
function stateCellHeading(cell, quality) {
  const fragment = document.createDocumentFragment();
  const name = document.createElement("h3");
  name.textContent = cell;
  const label2 = document.createElement("p");
  label2.className = "state-quality muted";
  label2.textContent = quality;
  fragment.append(name, label2);
  return fragment;
}
function readArgument(name, view) {
  try {
    return authoredArgumentValue(view.control, view.read());
  } catch (cause) {
    throw new Error(`${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
function buildArgument(name, control, fields) {
  const field = authoredArgumentField(control);
  const wrapper = document.createElement("div");
  wrapper.className = "argument-field";
  const caption = control.label ?? name;
  if (field.kind === "flags") {
    const group = document.createElement("fieldset");
    group.className = "flag-group";
    const legend = document.createElement("legend");
    legend.textContent = caption;
    group.append(legend);
    const choices = document.createElement("div");
    choices.className = "flag-choices";
    const boxes = [];
    for (const member of field.members) {
      const label2 = document.createElement("label");
      label2.className = "boolean-value";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = name;
      box.value = member;
      label2.append(box, member);
      choices.append(label2);
      boxes.push(box);
    }
    group.append(choices);
    wrapper.append(group);
    fields.set(name, { control, read: () => boxes.filter((box) => box.checked).map((box) => box.value) });
  } else if (field.kind === "checkbox") {
    const label2 = document.createElement("label");
    label2.className = "boolean-value";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = name;
    label2.append(box, caption);
    wrapper.append(label2);
    fields.set(name, { control, read: () => box.checked });
  } else {
    const label2 = document.createElement("label");
    label2.textContent = caption;
    if (field.kind === "select") {
      const select = document.createElement("select");
      select.name = name;
      select.required = true;
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a value";
      select.append(placeholder);
      for (const member of field.members) {
        const option = document.createElement("option");
        option.value = member;
        option.textContent = member;
        select.append(option);
      }
      label2.append(select);
      fields.set(name, { control, read: () => select.value });
    } else {
      const input2 = document.createElement("input");
      input2.name = name;
      input2.required = true;
      if (field.kind === "file") {
        input2.type = "file";
        fields.set(name, { control, read: () => "", file: input2 });
      } else if (field.kind === "number") {
        input2.type = "number";
        input2.step = field.step;
        if (field.minimum !== void 0) input2.min = String(field.minimum);
        if (field.maximum !== void 0) input2.max = String(field.maximum);
        fields.set(name, { control, read: () => input2.value });
      } else {
        input2.type = "text";
        if (field.placeholder !== void 0) input2.placeholder = field.placeholder;
        if (field.minimumLength !== void 0) input2.minLength = field.minimumLength;
        if (field.maximumLength !== void 0) input2.maxLength = field.maximumLength;
        fields.set(name, { control, read: () => input2.value });
      }
      label2.append(input2);
    }
    wrapper.append(label2);
  }
  const help = control.description ?? authoredArgumentHint(control);
  if (help !== void 0) {
    const note = document.createElement("p");
    note.className = "input-help";
    note.textContent = help;
    wrapper.append(note);
  }
  return wrapper;
}

// src/package-catalog.ts
async function installPackageCatalog(view) {
  const requestedUrl = new URL("catalog.json", view.baseURI).href;
  let response;
  try {
    response = await view.fetcher(requestedUrl);
  } catch {
    return;
  }
  if (!response.ok) return;
  const catalogUrl = response.url || requestedUrl;
  let entries;
  try {
    entries = parseCatalog(await response.json(), catalogUrl);
  } catch (cause) {
    view.onCatalogError(new Error(`Package catalog ${catalogUrl} is invalid: ${cause instanceof Error ? cause.message : String(cause)}`));
    return;
  }
  if (entries.length === 0) return;
  view.select.replaceChildren(...entries.map((entry) => {
    const option = view.document.createElement("option");
    option.textContent = entry.name;
    return option;
  }));
  view.select.selectedIndex = -1;
  view.select.disabled = false;
  view.region.hidden = false;
  async function loadSelected() {
    const entry = entries[view.select.selectedIndex];
    if (entry === void 0) return;
    try {
      view.beforeLoad();
    } catch (cause) {
      view.onEntryError(cause);
      return;
    }
    try {
      const host = entry.url.host;
      let packageResponse;
      try {
        packageResponse = await view.fetcher(entry.url.href);
      } catch {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: browser refused the request or blocked its response`);
      }
      if (!packageResponse.ok) {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: HTTP ${packageResponse.status}`);
      }
      let bytes;
      try {
        bytes = await packageResponse.arrayBuffer();
      } catch {
        throw new Error(`Package ${JSON.stringify(entry.name)} from ${host}: browser refused to read the response`);
      }
      await view.loadBytes(new Uint8Array(bytes));
    } catch (cause) {
      view.onEntryError(cause);
    } finally {
      view.afterLoad();
    }
  }
  view.select.addEventListener("change", () => {
    void loadSelected();
  });
}
function parseCatalog(value, catalogUrl) {
  if (!record(value) || !Array.isArray(value.packages)) throw new Error("packages must be an array");
  return Object.freeze(value.packages.map((raw, index) => {
    if (!record(raw) || typeof raw.name !== "string" || raw.name.length === 0 || typeof raw.url !== "string" || raw.url.length === 0) {
      throw new Error(`packages[${index}] requires non-empty name and url strings`);
    }
    return Object.freeze({ name: raw.name, url: new URL(raw.url, catalogUrl) });
  }));
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/package-loading.ts
async function loadAndRememberPackage(bytes, dependencies) {
  const admitted = await dependencies.loadDeviceBytes(bytes);
  if (admitted.admission.kind !== "pdpkg") return;
  try {
    const id = await dependencies.remember(bytes);
    await dependencies.refreshRemembered(id);
    dependencies.setRememberedStatus(`Remembered as package ${id}.`);
  } catch (cause) {
    dependencies.reportRememberError(cause);
  }
}

// src/main.ts
var connectionState = element("state");
var support = element("support");
var identity = element("identity");
var packageInput = input("package-file");
var catalogRegion = element("catalog-packages");
var catalogSelect = selectElement("catalog-package");
var storedPackageSelect = selectElement("stored-package");
var storedPackageStatus = element("stored-package-status");
var storedPackageLoadButton = button("stored-package-load");
var storedPackageRemoveButton = button("stored-package-remove");
var modeSelect = selectElement("mode");
var profileSelect = selectElement("profile");
var candidatesView = element("candidates");
var connectButton = button("connect");
var disconnectButton = button("disconnect");
var exportButton = button("export");
var captureMemoryInput = input("capture-memory-bytes");
var captureQueueInput = input("capture-queue-bytes");
var pauseButton = button("pause");
var generatedView = element("generated-controls");
var terminalStatus = element("terminal-status");
var terminalContent = element("terminal-content");
var terminalOpenButton = button("terminal-open");
var terminalExitButton = button("terminal-exit");
var terminalWriteForm = element("terminal-write");
var terminalBytesInput = input("terminal-bytes");
var terminalSendButton = button("terminal-send");
var terminalOutput = element("terminal-output");
var hexView = element("hex");
var dropsView = element("drops");
var protocolStatus = element("protocol-status");
var protocolContent = element("protocol-content");
var errorPanel = element("error-panel");
var errorMessage = element("error-message");
var errorView = element("error");
var workspacePanel = element("workspace");
var serial = navigator.serial;
var usb = navigator.usb;
var packageStore = new BrowserPackageStore(indexedDB);
var loaded;
var sessionContext;
var sessionEvents;
var diagnosticEvents;
var connected = false;
var activeModeId;
var activeProfileId;
var activeGrant;
var rawTerminalActive = false;
var rawTerminalId;
var rawTerminalExitRequirement;
var lastCapture;
var activeCapture;
var sessionCaptureLimits;
var renderedHex = new HexWindow();
var paused = false;
var pendingDiagnosticBatch;
installBrowserReleaseHooks({
  window,
  release: () => {
    if (!connected) return;
    void requireClient().disconnect("browser lifecycle release").catch(() => {
    });
  }
});
packageInput.addEventListener("change", () => void loadSelectedPackage());
storedPackageSelect.addEventListener("change", () => updateStoredPackageButtons());
storedPackageLoadButton.addEventListener("click", () => void loadStoredPackage());
storedPackageRemoveButton.addEventListener("click", () => void removeStoredPackage());
modeSelect.addEventListener("change", () => {
  populateProfiles();
  updateConnectButton();
  renderControls();
  renderRawTerminal();
});
profileSelect.addEventListener("change", () => {
  updateConnectButton();
  renderControls();
  renderRawTerminal();
});
connectButton.addEventListener("click", () => void grantAndConnect());
disconnectButton.addEventListener("click", () => void disconnect());
exportButton.addEventListener("click", exportCapture);
pauseButton.addEventListener("click", togglePause);
terminalOpenButton.addEventListener("click", () => void openRawTerminal().catch(showError));
terminalExitButton.addEventListener("click", () => void exitRawTerminal().catch(showError));
terminalWriteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendRawTerminalBytes().catch(showError);
});
captureMemoryInput.addEventListener("change", () => void resetForCaptureSettings());
captureQueueInput.addEventListener("change", () => void resetForCaptureSettings());
function acceptSessionEvent(event) {
  if (event.kind === "mode-maintenance") {
    support.textContent = event.status === "released-idle" ? `Mode maintenance stopped after declared idle; the next task will re-enter ${event.modeId}.` : `Mode ${event.modeId} re-entered; ${event.operation} maintenance is active.`;
    renderControls();
    return;
  }
  if (event.kind === "raw-terminal-bytes") {
    appendTerminalLine(`rx ${event.sequence} @ ${event.tUs} us  ${hexBytes(event.bytes)}`);
    return;
  }
  if (event.kind !== "connection-close") return;
  connected = false;
  rawTerminalActive = false;
  rawTerminalExitRequirement = void 0;
  activeModeId = void 0;
  activeProfileId = void 0;
  setConnected(false);
  support.textContent = `Connection ended: ${event.reason}.`;
  if (event.error !== void 0) showError({ error: event.error });
}
support.textContent = "Load a device package to get its controls.";
captureMemoryInput.value = String(DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureInMemoryBytes);
captureQueueInput.value = String(DEFAULT_BROWSER_CAPTURE_LIMITS.maximumCaptureQueueBytes);
setConnected(false);
void refreshStoredPackages().catch(showError);
void installPackageCatalog({
  baseURI: document.baseURI,
  region: catalogRegion,
  select: catalogSelect,
  document,
  fetcher: (url) => fetch(url),
  beforeLoad: () => {
    if (connected) throw new Error("disconnect before loading another device");
    clearError();
    setBusy(true, "loading package");
  },
  afterLoad: () => setBusy(false, "disconnected"),
  loadBytes: loadAndRememberPackage2,
  onCatalogError: showError,
  onEntryError: (cause) => {
    if (!connected) clearLoadedDevice();
    showError(cause);
  }
}).catch(showError);
async function loadSelectedPackage() {
  const file = packageInput.files?.[0];
  if (file === void 0) return;
  if (connected) {
    showError(new Error("disconnect before loading another device"));
    return;
  }
  clearError();
  setBusy(true, "loading package");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await loadAndRememberPackage2(bytes);
  } catch (cause) {
    clearLoadedDevice();
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}
async function loadAndRememberPackage2(bytes) {
  await loadAndRememberPackage(bytes, {
    loadDeviceBytes,
    remember: (value) => packageStore.add(value),
    refreshRemembered: refreshStoredPackages,
    setRememberedStatus: (message) => {
      storedPackageStatus.textContent = message;
    },
    reportRememberError: showError
  });
}
async function loadStoredPackage() {
  if (connected) {
    showError(new Error("disconnect before loading another device"));
    return;
  }
  const id = selectedStoredPackageId();
  clearError();
  setBusy(true, "loading package");
  storedPackageStatus.textContent = `Loading package ${id}.`;
  try {
    const bytes = await packageStore.read(id);
    if (bytes === null) throw new Error(`stored package ${id} no longer exists`);
    const admitted = await loadDeviceBytes(bytes);
    if (admitted.admission.kind !== "pdpkg") {
      throw new Error(`stored package ${id} did not contain a pdpkg archive`);
    }
    storedPackageStatus.textContent = `Package ${id} loaded.`;
  } catch (cause) {
    clearLoadedDevice();
    storedPackageStatus.textContent = `Package ${id} could not be loaded.`;
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}
async function removeStoredPackage() {
  const id = selectedStoredPackageId();
  clearError();
  setBusy(true, "forgetting package");
  try {
    await packageStore.remove(id);
    await refreshStoredPackages();
    storedPackageStatus.textContent = `Forgot package ${id}.`;
  } catch (cause) {
    showError(cause);
  } finally {
    setBusy(false, "disconnected");
  }
}
async function loadDeviceBytes(bytes) {
  sessionEvents?.dispose();
  diagnosticEvents?.dispose();
  await sessionContext?.close();
  const captureLimits = selectedBrowserCaptureLimits();
  const context = await openBrowserSessionContext(bytes, void 0, captureLimits);
  sessionContext = context;
  sessionCaptureLimits = captureLimits;
  await context.client.attach(`browser-main-${crypto.randomUUID()}`);
  sessionEvents = context.client.subscribe(acceptSessionEvent);
  diagnosticEvents = context.client.subscribeDiagnostics(acceptDiagnostics);
  const admitted = context.loaded;
  loaded = admitted;
  generatedView.replaceChildren();
  delete generatedView.dataset.authored;
  activeGrant = void 0;
  populateModes();
  renderControls();
  renderRawTerminal();
  support.textContent = `${admitted.authored.model.displayName ?? admitted.authored.model.id} loaded. ${admitted.authored.hostGrant ? "The host supplied its connection." : "Choose a mode and connection profile, then connect."}`;
  return admitted;
}
function clearLoadedDevice() {
  loaded = void 0;
  sessionCaptureLimits = void 0;
  generatedView.replaceChildren();
  renderRawTerminal();
}
async function refreshStoredPackages(preferredId) {
  const packages = await packageStore.list();
  storedPackageSelect.replaceChildren();
  if (packages.length === 0) {
    appendOption(storedPackageSelect, "", "Nothing remembered yet");
    storedPackageStatus.textContent = "Loading a package from a file also remembers it here.";
  } else {
    for (const stored of packages) {
      appendOption(
        storedPackageSelect,
        String(stored.id),
        `Package ${stored.id} \xB7 ${stored.byteLength.toLocaleString()} bytes`
      );
    }
    const selected = preferredId !== void 0 && packages.some(({ id }) => id === preferredId) ? preferredId : packages[0].id;
    storedPackageSelect.value = String(selected);
    storedPackageStatus.textContent = `${count(packages.length, "package")} remembered.`;
  }
  updateStoredPackageButtons();
}
function selectedStoredPackageId() {
  const id = Number(storedPackageSelect.value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("select a stored package first");
  return id;
}
function updateStoredPackageButtons(busy = false) {
  const available = storedPackageSelect.value.length > 0;
  storedPackageSelect.disabled = busy || connected || !available;
  storedPackageLoadButton.disabled = busy || connected || !available;
  storedPackageRemoveButton.disabled = busy || connected || !available;
}
function populateModes() {
  const current = requireLoaded();
  modeSelect.replaceChildren();
  if (current.authored.model.modes.length > 1) appendOption(modeSelect, "", "Choose a mode");
  for (const modeId of current.authored.model.modes) {
    appendOption(
      modeSelect,
      modeId,
      current.authored.model.modePresentation?.[modeId]?.label ?? displayLabel(modeId)
    );
  }
  populateProfiles();
}
function populateProfiles() {
  const current = requireLoaded();
  profileSelect.replaceChildren();
  if (modeSelect.value.length === 0) return;
  for (const profile of current.profiles.filter(({ modeId }) => modeId === modeSelect.value)) {
    appendOption(
      profileSelect,
      profile.profileId,
      `${displayLabel(profile.profileId)} \xB7 ${profile.transport}${profile.supported ? "" : " \xB7 unsupported"}`
    );
  }
}
async function grantAndConnect() {
  if (connected) return;
  const profile = selectedProfile();
  clearError();
  if (!profile.supported) {
    support.textContent = `${profile.transport} is unsupported by this host.`;
    renderControls();
    return;
  }
  try {
    if (profile.transport === "serial") {
      if (serial === void 0) throw new Error("Web Serial is unavailable");
      const port = await serial.requestPort({
        filters: profile.acquisitionFilters.map((filter) => ({
          ...filter.vendorId === void 0 ? {} : { usbVendorId: filter.vendorId },
          ...filter.productId === void 0 ? {} : { usbProductId: filter.productId }
        }))
      });
      const info = port.getInfo();
      activeGrant = browserGrant(profile.acquisitionFilters.map((filter) => (filter.vendorId === void 0 || filter.vendorId === info.usbVendorId) && (filter.productId === void 0 || filter.productId === info.usbProductId)));
    } else {
      if (usb === void 0) throw new Error("WebUSB is unavailable");
      const device = await usb.requestDevice({
        filters: profile.acquisitionFilters.map((filter) => ({
          ...filter.vendorId === void 0 ? {} : { vendorId: filter.vendorId },
          ...filter.productId === void 0 ? {} : { productId: filter.productId },
          ...filter.usbClass === void 0 ? {} : { classCode: filter.usbClass }
        }))
      });
      activeGrant = browserGrant(profile.acquisitionFilters.map((filter) => usbFilterMatches(filter, device)));
    }
    const candidates = (await requireClient().resolveCandidates({
      mode: profile.modeId,
      profile: profile.profileId,
      grant: activeGrant
    })).filter(({ matchedProfileId }) => matchedProfileId === profile.profileId);
    if (candidates.length === 1) await connectCandidate(candidates[0].candidateId, profile);
    else renderCandidates(candidates, profile);
  } catch (cause) {
    showError(cause);
  }
}
async function connectCandidate(candidateId, profile) {
  setBusy(true, "connecting");
  clearError();
  clearCandidates();
  let opened = false;
  try {
    const candidate = (await requireClient().resolveCandidates({
      mode: profile.modeId,
      profile: profile.profileId,
      ...activeGrant === void 0 ? {} : { grant: activeGrant }
    })).find((value) => value.candidateId === candidateId && value.matchedProfileId === profile.profileId);
    if (candidate === void 0) throw new Error(`candidate ${candidateId} is no longer authorized`);
    let resolveCaptureIssued;
    const captureIssued = new Promise((resolve) => {
      resolveCaptureIssued = resolve;
    });
    const capturePromise = beginMemoryCapture(resolveCaptureIssued);
    await Promise.race([captureIssued, capturePromise]);
    const connectPromise = requireClient().connect({
      mode: profile.modeId,
      profile: profile.profileId,
      candidateId: candidate.candidateId,
      ...activeGrant === void 0 ? {} : { grant: activeGrant }
    });
    const [, result] = await Promise.all([capturePromise, connectPromise]);
    if (result.kind === "selection-required") {
      await retainActiveCapture();
      renderCandidates(result.candidates, profile);
      setConnected(false);
      return;
    }
    opened = true;
    connected = true;
    activeModeId = result.modeId;
    activeProfileId = result.profileId;
    if (loaded !== void 0) {
      loaded = { ...loaded, authored: {
        ...loaded.authored,
        hostGrant: { modeId: result.modeId, profileId: result.profileId }
      } };
      delete generatedView.dataset.authored;
    }
    identity.textContent = identityText(candidate.identity);
    setConnected(true);
    renderRawTerminal();
    support.textContent = `Connected through ${displayLabel(result.modeId)} / ${displayLabel(result.profileId)}.`;
  } catch (cause) {
    await retainActiveCapture().catch(() => void 0);
    if (opened) await requireClient().disconnect("post-connect browser setup failed").catch(() => void 0);
    connected = false;
    rawTerminalActive = false;
    rawTerminalExitRequirement = void 0;
    setConnected(false);
    showError(cause);
  }
}
async function beginMemoryCapture(requestIssued = () => {
}) {
  const context = requireSessionContext();
  const limits = requireSessionCaptureLimits();
  const destination = new BrowserMemoryCaptureDestination(
    context.resources,
    context.sessionId,
    limits
  );
  const destinationId = await context.registerCaptureDestination(destination);
  try {
    const pending = context.client.startCapture(destinationId, {
      sidecarThresholdBytes: browserCaptureSidecarThresholdBytes(limits)
    });
    requestIssued();
    const captureId = await pending;
    activeCapture = { captureId, destination, destinationId };
  } catch (cause) {
    await context.captureDestinations.release(destinationId);
    throw cause;
  }
}
async function disconnect() {
  if (!connected) return;
  setBusy(true, "disconnecting");
  try {
    await retainActiveCapture();
    await requireClient().disconnect("operator disconnect");
    connected = false;
    activeModeId = void 0;
    activeProfileId = void 0;
    activeGrant = void 0;
    setConnected(false);
    support.textContent = "Disconnected. The browser still remembers permission for this device.";
  } catch (cause) {
    showError(cause);
  }
}
async function retainActiveCapture() {
  const capture = activeCapture;
  if (capture === void 0) return;
  const summary = await requireClient().stopCapture(capture.captureId);
  lastCapture = { bytes: capture.destination.bytes(), summary };
  await requireSessionContext().captureDestinations.release(capture.destinationId);
  activeCapture = void 0;
  exportButton.disabled = false;
}
function renderControls() {
  workspacePanel.hidden = loaded === void 0;
  if (loaded === void 0) {
    generatedView.replaceChildren();
    return;
  }
  if (!generatedView.dataset.authored) {
    installAuthoredControls(generatedView, loaded.authored, sessionContext, connected);
    generatedView.dataset.authored = "true";
  }
}
function renderCandidates(candidates, profile) {
  clearCandidates();
  for (const candidate of candidates) {
    const candidateButton = document.createElement("button");
    candidateButton.type = "button";
    candidateButton.className = "secondary";
    candidateButton.textContent = (candidate.ambiguousWith?.length ?? 0) === 0 ? candidate.displayName : `${candidate.displayName} \xB7 ambiguous with ${candidate.ambiguousWith.join(", ")}`;
    candidateButton.addEventListener("click", () => void connectCandidate(candidate.candidateId, profile));
    candidatesView.append(candidateButton);
  }
  support.textContent = candidates.length === 0 ? "The device you picked does not match this connection profile." : `${count(candidates.length, "device")} matched. Choose which one to connect.`;
}
function acceptDiagnostics(batch) {
  if (paused) {
    pendingDiagnosticBatch = batch;
    return;
  }
  renderDiagnosticRecords(batch.records, batch.dropped);
}
function renderDiagnosticRecords(records, dropped) {
  renderProtocolTools();
  let text = "";
  for (const record2 of records) text = renderedHex.append(record2);
  if (text.length > 0) {
    hexView.textContent = text;
    hexView.scrollTop = hexView.scrollHeight;
  }
  dropsView.textContent = dropped.records === 0 ? "No diagnostic loss." : `${dropped.records} records / ${dropped.bytes} bytes dropped, ${dropped.firstUs}..${dropped.lastUs} \xB5s.`;
}
function togglePause() {
  paused = !paused;
  pauseButton.textContent = paused ? "Resume" : "Pause";
  if (paused) return;
  const pending = pendingDiagnosticBatch;
  pendingDiagnosticBatch = void 0;
  if (pending !== void 0) {
    renderDiagnosticRecords(pending.records, pending.dropped);
  }
}
function exportCapture() {
  const capture = lastCapture;
  if (capture === void 0) return;
  const url = URL.createObjectURL(new Blob([capture.bytes], { type: "application/x-ndjson" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${capture.summary.captureId}.pdcap`;
  anchor.click();
  URL.revokeObjectURL(url);
}
function selectedProfile() {
  const profile = requireLoaded().profiles.find(({ modeId, profileId }) => modeId === modeSelect.value && profileId === profileSelect.value);
  if (profile === void 0) throw new Error("select a declared connection profile");
  return profile;
}
function renderRawTerminal() {
  if (loaded === void 0) {
    terminalContent.hidden = true;
    terminalStatus.textContent = "Load a device package to determine terminal availability.";
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  const profile = loaded.profiles.find(({ modeId, profileId }) => modeId === (activeModeId ?? modeSelect.value) && profileId === (activeProfileId ?? profileSelect.value));
  if (profile === void 0) {
    terminalContent.hidden = true;
    terminalStatus.textContent = "Select a connection profile.";
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  if (profile.rawTerminal.kind === "unavailable") {
    terminalContent.hidden = true;
    terminalStatus.textContent = `Unavailable: ${profile.rawTerminal.reason}`;
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
    return;
  }
  terminalContent.hidden = false;
  if (rawTerminalActive) {
    terminalStatus.textContent = rawTerminalExitRequirement?.message ?? "Raw terminal owns the declared byte-stream channel.";
  } else {
    terminalStatus.textContent = connected ? `Available on declared byte-stream channel ${profile.rawTerminal.channelId}.` : `Raw terminal will use declared byte-stream channel ${profile.rawTerminal.channelId} after connection.`;
  }
  terminalOpenButton.disabled = !connected || rawTerminalActive;
  terminalExitButton.disabled = !rawTerminalActive;
  terminalBytesInput.disabled = !rawTerminalActive;
  terminalSendButton.disabled = !rawTerminalActive;
}
async function openRawTerminal() {
  if (!connected || rawTerminalActive) throw new Error("raw terminal cannot open in the current session state");
  clearError();
  const subscriptionId = sessionEvents?.subscriptionId;
  if (subscriptionId === void 0) throw new Error("session event subscription is unavailable");
  const opened = await requireClient().openRawTerminal(subscriptionId);
  rawTerminalActive = true;
  rawTerminalId = opened.terminalId;
  rawTerminalExitRequirement = opened.exitRequirement;
  terminalOutput.textContent = "";
  renderControls();
  renderRawTerminal();
  return opened;
}
async function exitRawTerminal() {
  if (!rawTerminalActive || rawTerminalExitRequirement === void 0) return;
  if (rawTerminalExitRequirement.kind === "reconnect-required" && !window.confirm(`${rawTerminalExitRequirement.message} Continue?`)) return;
  if (rawTerminalId === void 0) throw new Error("raw terminal id is unavailable");
  const result = await requireClient().exitRawTerminal(rawTerminalId);
  rawTerminalActive = false;
  rawTerminalId = void 0;
  rawTerminalExitRequirement = void 0;
  appendTerminalLine(result.kind === "recovered" ? `${result.recovery.strategy} recovery re-established the mode` : "reconnect re-established the mode");
  renderControls();
  renderRawTerminal();
}
async function sendRawTerminalBytes() {
  if (!rawTerminalActive) throw new Error("raw terminal is not open");
  const bytes = parseHexBytes2(terminalBytesInput.value);
  if (rawTerminalId === void 0) throw new Error("raw terminal id is unavailable");
  const receipt = await requireClient().writeRawTerminal(rawTerminalId, bytes);
  appendTerminalLine(`tx ${receipt.atSequence}  ${hexBytes(bytes)}  [${receipt.outcome.kind}]`);
  terminalBytesInput.value = "";
  if (receipt.outcome.kind !== "accepted-by-platform") {
    throw new Error(`raw terminal write was ${receipt.outcome.kind}`);
  }
}
function parseHexBytes2(value) {
  const compact = value.replace(/\s+/gu, "");
  if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(compact)) {
    throw new Error("raw terminal bytes must be one or more complete hexadecimal octets");
  }
  return Uint8Array.from(compact.match(/../gu).map((octet) => Number.parseInt(octet, 16)));
}
function hexBytes(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}
function appendTerminalLine(line) {
  const maximumCharacters = 64 * 1024;
  const next = `${terminalOutput.textContent ?? ""}${line}
`;
  terminalOutput.textContent = next.length <= maximumCharacters ? next : next.slice(next.length - maximumCharacters);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}
function setConnected(value) {
  connectionState.textContent = value ? "connected" : "disconnected";
  connectionState.classList.toggle("connected", value);
  packageInput.disabled = value;
  catalogSelect.disabled = value || catalogSelect.options.length === 0;
  modeSelect.disabled = value;
  profileSelect.disabled = value;
  captureMemoryInput.disabled = value;
  captureQueueInput.disabled = value;
  connectButton.disabled = value || loaded === void 0 || profileSelect.value.length === 0;
  disconnectButton.disabled = !value;
  pauseButton.disabled = !value;
  identity.hidden = !value;
  updateStoredPackageButtons();
  renderControls();
  renderRawTerminal();
  renderProtocolTools();
}
function renderProtocolTools() {
  const available = connected || lastCapture !== void 0;
  protocolContent.hidden = !available;
  pauseButton.hidden = !available;
  protocolStatus.textContent = available ? connected ? "Live protocol bytes from the active session." : "Protocol bytes remain available from the retained session capture." : "Unavailable until a session is active or a retained capture exists.";
}
function setBusy(busy, label2) {
  connectionState.textContent = label2;
  packageInput.disabled = busy || connected;
  catalogSelect.disabled = busy || connected || catalogSelect.options.length === 0;
  modeSelect.disabled = busy || connected || loaded === void 0;
  profileSelect.disabled = busy || connected || loaded === void 0;
  captureMemoryInput.disabled = busy || connected;
  captureQueueInput.disabled = busy || connected;
  connectButton.disabled = busy || connected || loaded === void 0 || profileSelect.value.length === 0;
  disconnectButton.disabled = busy || !connected;
  updateStoredPackageButtons(busy);
  if (busy) {
    terminalOpenButton.disabled = true;
    terminalExitButton.disabled = true;
    terminalBytesInput.disabled = true;
    terminalSendButton.disabled = true;
  } else {
    renderRawTerminal();
  }
}
function updateConnectButton() {
  connectButton.disabled = connected || loaded === void 0 || profileSelect.value.length === 0;
}
function showError(cause) {
  const error = errorObject(cause);
  errorPanel.hidden = false;
  errorMessage.textContent = errorText(error);
  errorView.textContent = JSON.stringify(error, null, 2);
}
function errorText(error) {
  const reported = error;
  if (typeof reported.message === "string" && reported.message.length > 0) return reported.message;
  if (typeof reported.code === "string" && reported.code.length > 0) return reported.code;
  return "The request failed without a reported cause.";
}
function clearError() {
  errorPanel.hidden = true;
  errorMessage.textContent = "";
  errorView.textContent = "";
}
function errorObject(cause) {
  if (cause instanceof SessionRpcError) return cause.error;
  if (typeof cause === "object" && cause !== null && "error" in cause) return cause.error;
  return { code: "web.failed", message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), retryability: "no" };
}
function requireSessionContext() {
  if (sessionContext === void 0) throw new Error("load a device before using the session");
  return sessionContext;
}
function requireClient() {
  return requireSessionContext().client;
}
function selectedBrowserCaptureLimits() {
  const maximumCaptureInMemoryBytes = Number(captureMemoryInput.value);
  const maximumCaptureQueueBytes = Number(captureQueueInput.value);
  if (!Number.isSafeInteger(maximumCaptureQueueBytes) || maximumCaptureQueueBytes <= 0) {
    throw new RangeError("maximum capture queue bytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maximumCaptureInMemoryBytes) || maximumCaptureInMemoryBytes <= maximumCaptureQueueBytes) {
    throw new RangeError("capture memory bytes must be an integer greater than maximum capture queue bytes");
  }
  return Object.freeze({ maximumCaptureQueueBytes, maximumCaptureInMemoryBytes });
}
function requireSessionCaptureLimits() {
  if (sessionCaptureLimits === void 0) throw new Error("capture limits are unavailable until a device is loaded");
  return sessionCaptureLimits;
}
async function resetForCaptureSettings() {
  if (connected) return;
  try {
    selectedBrowserCaptureLimits();
    sessionEvents?.dispose();
    diagnosticEvents?.dispose();
    await sessionContext?.close();
    sessionContext = void 0;
    clearLoadedDevice();
    packageInput.value = "";
    support.textContent = "Capture limits changed. Load the package again to apply them.";
  } catch (cause) {
    showError(cause);
  }
}
function browserGrant(matches) {
  const matchedFilters = matches.flatMap((matched, index) => matched ? [index] : []);
  if (matchedFilters.length === 0) {
    throw new Error("the granted device does not match any requested profile filter");
  }
  return {
    grantId: crypto.randomUUID(),
    matchedFilters: Object.freeze(matchedFilters)
  };
}
function requireLoaded() {
  if (loaded === void 0) throw new Error("load a device package first");
  return loaded;
}
function identityText(value) {
  const ids = value.vendorId === void 0 || value.productId === void 0 ? value.transport : `${value.vendorId.toString(16).padStart(4, "0")}:${value.productId.toString(16).padStart(4, "0")}`;
  return [value.productName, ids, value.serialNumber].filter((member) => member !== void 0).join(" \xB7 ");
}
function appendOption(target, value, label2) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label2;
  target.append(option);
}
function displayLabel(value) {
  return value.replace(/[_-]+/gu, " ");
}
function count(total, noun) {
  return `${total} ${noun}${total === 1 ? "" : "s"}`;
}
function clearCandidates() {
  candidatesView.replaceChildren();
}
function element(id) {
  return required(document.getElementById(id), `#${id}`);
}
function button(id) {
  return required(document.querySelector(`#${id}`), `#${id}`);
}
function input(id) {
  return required(document.querySelector(`#${id}`), `#${id}`);
}
function selectElement(id) {
  return required(document.querySelector(`#${id}`), `#${id}`);
}
function required(value, name) {
  if (value === null || value === void 0) throw new Error(`${name} is missing`);
  return value;
}
