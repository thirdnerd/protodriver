import { NativeHelperData, nativeFault } from "./native-helper.ts";
import { InputRetirementIndex, type InputCustodyAccount } from "./input-retirement.ts";

export interface InputWorkFunding {
  work(): number;
  reserve(units: number): void;
  charge(units: number): void;
  spend(units: number): void;
  release(units: number): void;
}

/** The existing external-input account, created at observation instead of at
 * handler dispatch. Binding moves its counter into the first activation; it
 * does not copy spent work or give the activation another allowance. */
export class InputWorkAccount {
  readonly #data: NativeHelperData;
  readonly #maximum: number;
  readonly #storage: { release(): void };
  #work = 0;
  #reserved = 0;
  #bound = false;
  #closed = false;
  #closing = false;
  #publication = false;
  #pendingPublication = false;
  #native = false;
  #nativeStorage: { release(): void } | undefined;
  #deferred = false;
  #interpretations = 0;
  #custody: { index: InputRetirementIndex; sequence: number } | undefined;
  #custodyHeld = false;
  #nativeCustody: { dispose(): void } | undefined;
  readonly #funding: InputWorkFunding | undefined;
  remaining: number;
  consumed?: () => void;
  disposed?: () => void;
  constructor(data: NativeHelperData, maximum: number, bytes: number, ranges: boolean, funding?: InputWorkFunding) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(bytes) || bytes < 1)
      throw nativeFault("retained.work-exhausted", "input account requires positive safe bounds");
    this.#data = data; this.#maximum = maximum;
    this.#funding = funding;
    this.remaining = ranges ? bytes : 0;
    // Per octet: consumption, descriptor release, interpreting-consumer
    // release, and (for entry's inherited children) delivery release. Entry's
    // own interpretation and the four publication/disposal slots are fixed.
    // Withheld from ordinary work, not extra fuel.
    this.#reserved = (ranges ? bytes * (funding ? 4 : 3) : 0) + (funding && ranges ? 5 : 4);
    const publicationWork = 2 + Math.ceil(bytes / 256);
    if (!Number.isSafeInteger(this.#reserved) || this.#reserved + publicationWork > maximum)
      throw nativeFault("retained.work-exhausted", "input custody terminal work cannot be funded before publication");
    funding?.reserve(this.#reserved);
    try { this.#storage = data.reserve(128); }
    catch (cause) { funding?.release(this.#reserved); throw cause; }
    try { this.charge(publicationWork); } // frame, map insertion and bounded native copy
    catch (cause) { this.#storage.release(); funding?.release(this.#reserved); throw cause; }
  }
  get work(): number { return this.#funding?.work() ?? this.#work; }
  get inherited(): boolean { return this.#funding !== undefined; }
  get closed(): boolean { return this.#closed; }
  /** The AVL has its own raw/active predicate. Its account borrows this
   * observation's work; neither index construction nor subdivision mints fuel.
   * Three terminal visits per byte plus an AVL safe-integer-universe runway:
   * consumption, consuming interpretation, dispatched interpretation; entry
   * and publication have fixed overhead. No authored watches use this account. */
  custodyAccount(): InputCustodyAccount {
    const units = 3 * this.remaining + 512;
    if (this.#custodyHeld || this.#closing || this.#work + this.#reserved + units > this.#maximum)
      throw nativeFault("retained.work-exhausted", "input index disposal cannot fit original account");
    this.#funding?.reserve(units); this.#reserved += units; this.#custodyHeld = true;
    let left = units, terminal = false, closed = false;
    const spend = () => {
      if (closed || !left) throw new Error("input index terminal reserve underestimated");
      this.#terminal(); left--;
    };
    return {
      iteration: () => { if (terminal) spend(); else this.charge(1); },
      terminalIteration: spend,
      reserve: bytes => { const held = this.#data.reserve(bytes); return { dispose: () => held.release() }; },
      retire: () => { terminal = true; },
      close: () => {
        if (closed) return; closed = true;
        this.#reserved -= left; this.#funding?.release(left); left = 0;
        this.#custodyHeld = false; this.#finishClose();
      },
    };
  }
  attachCustody(index: InputRetirementIndex, sequence: number): void {
    this.#custody = { index, sequence };
    if (this.#native) this.#nativeCustody = this.retainCustody();
  }
  retainCustody(): { dispose(): void } | undefined {
    const c = this.#custody;
    return c && !c.index.closed ? c.index.retain(c.sequence) : undefined;
  }
  charge(units: number): void {
    if (this.#closing || this.#closed || !Number.isSafeInteger(units) || units < 0 || this.#work + this.#reserved + units > this.#maximum)
      throw nativeFault("retained.work-exhausted", "original input account exhausted");
    this.#funding?.charge(units); this.#work += units;
  }
  bind(owner: { work: number; reservedWork?: number }): void {
    if (this.#funding || this.#bound || this.#closing || this.#closed || owner.work || owner.reservedWork)
      throw new Error("input work account cannot be rebound or combined with another grant");
    this.#bound = true;
    Object.defineProperties(owner, {
      work: { enumerable: true, get: () => this.#work, set: (n: number) => {
        if (this.#closing || this.#closed) throw new Error("finalized input account changed"); this.#work = n;
      } },
      reservedWork: { enumerable: true, get: () => this.#reserved, set: (n: number) => {
        if (this.#closing || this.#closed) throw new Error("finalized input reservation changed"); this.#reserved = n;
      } },
    });
  }
  #terminal(): void {
    if (this.#closed || this.#reserved < 1) throw new Error("input custody terminal reserve underestimated");
    this.#funding?.spend(1); this.#reserved--; this.#work++;
  }
  nativeBegin(capacity = 0): void {
    if (this.#native) throw new Error("native input custody already held");
    this.charge(1); this.#nativeStorage = this.#data.reserve(capacity + 128); this.#native = true;
  }
  nativeEnd(): void {
    if (!this.#native) return;
    this.#terminal(); this.#nativeStorage?.release(); this.#nativeStorage = undefined;
    this.#nativeCustody?.dispose(); this.#nativeCustody = undefined;
    this.#native = false; this.#finishClose();
  }
  interpretation(): { release(): void } {
    this.charge(1); const storage = this.#data.reserve(64); this.#interpretations++;
    let live = true;
    return { release: () => {
      if (!live) return;
      this.#terminal(); live = false; storage.release(); this.#interpretations--; this.#finishClose();
    } };
  }
  deferred(capacity: number): { release(): void } {
    if (this.#deferred) throw new Error("input already deferred");
    this.charge(1); const hold = this.#data.reserve(capacity); this.#deferred = true;
    let custody: { dispose(): void } | undefined;
    try { custody = this.retainCustody(); }
    catch (cause) { this.#terminal(); hold.release(); this.#deferred = false; this.#finishClose(); throw cause; }
    let live = true;
    return { release: () => { if (!live) return; this.#terminal(); hold.release(); live = false; this.#deferred = false; custody?.dispose(); this.#finishClose(); } };
  }
  descriptor(): { release(): void } {
    this.charge(1);
    const hold = this.#data.reserve(64); let live = true;
    return { release: () => { if (live) { this.#terminal(); live = false; hold.release(); } } };
  }
  /** One queued group publication for this original observation. Its release
   * is prepaid even when revocation has removed ordinary authority. */
  publication(capacity: number): { release(): void } {
    if (this.#publication) throw new Error("input observation already has a publication frame");
    this.charge(1);
    const hold = this.#data.reserve(capacity);
    this.#publication = true; this.#pendingPublication = true;
    let custody: { dispose(): void } | undefined;
    try { custody = this.retainCustody(); }
    catch (cause) { this.#terminal(); hold.release(); this.#pendingPublication = false; this.#finishClose(); throw cause; }
    let live = true;
    return { release: () => {
      if (!live) return;
      this.#terminal(); hold.release(); live = false; this.#pendingPublication = false;
      custody?.dispose();
      this.#finishClose();
    } };
  }
  consume(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.remaining)
      throw new Error("input work custody consumption exceeds its original source");
    this.#terminal(); this.remaining -= bytes;
    if (this.#custody && !this.#custody.index.closed) this.#custody.index.consume(this.#custody.sequence, bytes);
    if (!this.remaining) this.consumed?.();
  }
  revoke(): void {
    const bytes = this.remaining; this.remaining = 0;
    // Actual discard (including a failed native copy) ends raw custody. A
    // revoked cut is already closed; a native promise can still hold its
    // independent dependency until receipt-finally.
    if (bytes && this.#custody && !this.#custody.index.closed) this.#custody.index.consume(this.#custody.sequence, bytes);
  }
  close(): void {
    if (this.#closed) return;
    if (this.remaining) throw new Error("input account still owns an unconsumed raw prefix");
    this.#closing = true; this.#finishClose();
  }
  #finishClose(): void {
    if (!this.#closing || this.#closed || this.#pendingPublication || this.#native || this.#deferred || this.#interpretations || this.#custodyHeld) return;
    this.#terminal(); this.#storage.release(); this.#funding?.release(this.#reserved); this.#reserved = 0; this.#closed = true;
    delete this.consumed;
    const disposed = this.disposed; delete this.disposed; disposed?.();
  }
}

interface Range { source: InputWorkAccount; bytes: number; storage: { release(): void }; next?: Range | undefined }
/** Only the changed raw prefix is visited. Older entry/broker custody is a
 * scalar gap, not certification: this partial inventory cannot grant B9. */
export class InputWorkRanges {
  #head: Range | undefined;
  #tail: Range | undefined;
  #gap: number;
  constructor(legacyGap: number) { this.#gap = legacyGap; }
  append(source: InputWorkAccount, bytes: number): void {
    const storage = source.descriptor(), node: Range = { source, bytes, storage };
    if (this.#tail) this.#tail.next = node; else this.#head = node;
    this.#tail = node;
  }
  consume(bytes: number, retain?: (source: InputWorkAccount) => void): void {
    const gap = Math.min(bytes, this.#gap); this.#gap -= gap; bytes -= gap;
    while (bytes) {
      const node = this.#head;
      if (!node) throw new Error("input work prefix inventory is incomplete");
      retain?.(node.source);
      const n = Math.min(bytes, node.bytes); bytes -= n; node.bytes -= n;
      if (!node.bytes) {
        this.#head = node.next; node.next = undefined;
        if (!this.#head) this.#tail = undefined;
        node.storage.release();
      }
      node.source.consume(n);
    }
  }
  close(): void {
    while (this.#head) {
      const node = this.#head; this.#head = node.next; node.next = undefined;
      node.storage.release(); node.source.consume(node.bytes);
    }
    this.#tail = undefined; this.#gap = 0;
  }
}
