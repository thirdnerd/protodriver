import type { Disposable } from "@protodriver/contracts";
import { NativeHelperData } from "./native-helper.ts";
import { DEFAULT_RETAINED_EFFECT_WORK } from "@protodriver/lua-vm/retained";

/** Trusted-host accounting port for the predecessor. It uses the native data
 * aggregate and input-work policy, not a new allowance per subdivision/query.
 * Authored callers must supply their existing activation account instead. */
export class ProtocolCustodyAccounts {
  readonly #data = new NativeHelperData();
  readonly #terminal: number;
  work = 0;
  opened = 0;
  closed = 0;
  constructor(maximumSimultaneous: number) {
    this.#terminal = 512 + Math.min(maximumSimultaneous, Math.floor(this.#data.maximum / 192));
    if (!Number.isSafeInteger(this.#terminal) || this.#terminal >= DEFAULT_RETAINED_EFFECT_WORK)
      throw new Error("input.retirement.terminal-work-unavailable");
  }
  open(): InputCustodyAccount {
    let work = 1, terminal = false, closed = false;
    let reserved = 0;
    interface Held { release(): void; previous?: Held | undefined; next?: Held | undefined; live: boolean }
    let head: Held | undefined;
    // Work for AVL removal (safe-integer key universe) and the bounded watches
    // attached to one observation is reserved before insertion, not at return.
    const storage = this.#data.reserve(128);
    this.opened++; this.work++;
    return {
      iteration: () => {
        if (closed || work + reserved + 1 > (terminal ? DEFAULT_RETAINED_EFFECT_WORK : DEFAULT_RETAINED_EFFECT_WORK - this.#terminal))
          throw new Error("input.retirement.work-exhausted");
        work++; this.work++;
      },
      reserve: bytes => {
        if (closed) throw new Error("input.retirement.account-closed");
        if (work + reserved + this.#terminal + 3 > DEFAULT_RETAINED_EFFECT_WORK)
          throw new Error("input.retirement.work-exhausted");
        const storage = this.#data.reserve(bytes + 64);
        // Prepay both the reservation unlink and its containing custody
        // range's disposal visit. Revocation may free the reservation before
        // the containing range is unlinked; that later visit is already paid
        // and must not mutate the finalized source account.
        reserved += 2; work++; this.work++;
        const held: Held = { release: () => storage.release(), next: head, live: true };
        if (head) head.previous = held;
        head = held;
        return { dispose: () => {
          if (!held.live) return;
          held.live = false; reserved -= 2; work += 2; this.work += 2;
          if (held.previous) held.previous.next = held.next; else head = held.next;
          if (held.next) held.next.previous = held.previous;
          held.previous = undefined; held.next = undefined; held.release();
        } };
      },
      retire: () => { terminal = true; },
      close: () => {
        if (closed) return;
        closed = true; work++; this.work++;
        while (head) {
          const held = head; head = held.next; held.live = false;
          held.previous = undefined; held.next = undefined;
          reserved -= 2; work += 2; this.work += 2; held.release();
        }
        this.closed++; storage.release();
      },
    };
  }
}

/** One account per original physical observation. The owner must reserve its
 * terminal runway before register returns; later custody retirement is not a
 * new external event or a new work grant. No account is created for a slice. */
export interface InputCustodyAccount {
  iteration(): void;
  /** A custody-ending visit spends work withheld at original observation. */
  terminalIteration?(): void;
  reserve(bytes: number): Disposable;
  close(): void;
  /** Switch to already reserved terminal work; never create another grant. */
  retire?(): void;
}
interface Node {
  readonly sequence: number;
  remaining: number;
  active: number;
  height: number;
  left: Node | undefined;
  right: Node | undefined;
  readonly account: InputCustodyAccount;
  readonly storage: Disposable;
  readonly watches: Set<Watch>;
  readonly dependencies: Set<Disposable>;
}
interface Watch {
  readonly from: number;
  readonly before: number;
  readonly ready: () => void;
  readonly iteration: () => void;
  readonly storage: Disposable;
  node?: Node;
  live: boolean;
}
const height = (node?: Node): number => node?.height ?? 0;

/** Shared B9 predicate. Keys are original observations, not delivery/handler
 * sequences. An AVL index makes interval lookup and updates logarithmic even
 * with an ancient held observation and arbitrarily many later retirements.
 * Raw-byte custody and active interpretation dependencies end independently. */
export class InputRetirementIndex {
  #root: Node | undefined;
  readonly #nodes = new Map<number, Node>();
  #closed = false;
  readonly #account: (sequence: number, bytes: number) => InputCustodyAccount;
  constructor(account: (sequence: number, bytes: number) => InputCustodyAccount) {
    this.#account = account;
  }
  get size(): number { return this.#nodes.size; }
  get closed(): boolean { return this.#closed; }
  has(sequence: number): boolean { return !this.#closed && this.#nodes.has(sequence); }
  /** Host custody containers charge structural work to the original input,
   * including before iterator publication. These are not authored grants. */
  account(sequence: number): InputCustodyAccount {
    this.#live();
    const node = this.#nodes.get(sequence);
    if (!node) throw new Error("input.retirement.unknown-observation");
    return node.account;
  }
  #live(): void { if (this.#closed) throw new Error("input.retirement.revoked"); }
  register(sequence: number, bytes: number): void {
    this.#live();
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(bytes) || bytes < 1 || this.#nodes.has(sequence))
      throw new Error("input.retirement.invalid-observation");
    const account = this.#account(sequence, bytes);
    let storage: Disposable | undefined;
    try {
      storage = account.reserve(192);
      const node: Node = { sequence, remaining: bytes, active: 0, height: 1, left: undefined, right: undefined, account, storage, watches: new Set(), dependencies: new Set() };
      this.#root = this.#insert(this.#root, node);
      this.#nodes.set(sequence, node);
    } catch (cause) { storage?.dispose(); account.close(); throw cause; }
  }
  #update(node: Node): Node { node.height = 1 + Math.max(height(node.left), height(node.right)); return node; }
  #left(node: Node): Node {
    const top = node.right!; node.right = top.left; top.left = this.#update(node); return this.#update(top);
  }
  #right(node: Node): Node {
    const top = node.left!; node.left = top.right; top.right = this.#update(node); return this.#update(top);
  }
  #balance(node: Node): Node {
    this.#update(node);
    if (height(node.left) - height(node.right) > 1) {
      if (height(node.left!.right) > height(node.left!.left)) node.left = this.#left(node.left!);
      return this.#right(node);
    }
    if (height(node.right) - height(node.left) > 1) {
      if (height(node.right!.left) > height(node.right!.right)) node.right = this.#right(node.right!);
      return this.#left(node);
    }
    return node;
  }
  #insert(root: Node | undefined, node: Node): Node {
    node.account.iteration();
    if (!root) return node;
    if (node.sequence < root.sequence) root.left = this.#insert(root.left, node);
    else root.right = this.#insert(root.right, node);
    return this.#balance(root);
  }
  #remove(root: Node, sequence: number, iteration: () => void): Node | undefined {
    iteration();
    if (sequence < root.sequence) root.left = this.#remove(root.left!, sequence, iteration);
    else if (sequence > root.sequence) root.right = this.#remove(root.right!, sequence, iteration);
    else {
      if (!root.left) return root.right;
      if (!root.right) return root.left;
      let next = root.right;
      while (next.left) { iteration(); next = next.left; }
      root.right = this.#remove(root.right, next.sequence, iteration);
      next.left = root.left; next.right = root.right; root = next;
    }
    return this.#balance(root);
  }
  #first(from: number, before: number, iteration: () => void): Node | undefined {
    this.#live();
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(before) || before <= from)
      throw new Error("input.retirement.invalid-interval");
    let node = this.#root, candidate: Node | undefined;
    while (node) {
      iteration();
      if (node.sequence < from) node = node.right;
      else { candidate = node; node = node.left; }
    }
    return candidate && candidate.sequence < before ? candidate : undefined;
  }
  retired(from: number, before: number, iteration: () => void): boolean {
    return this.#first(from, before, iteration) === undefined;
  }
  /** Host-only change-driven reconciliation. A watch attaches to one witness,
   * not to every input in its interval. Unrelated arrivals never visit it.
   * Its caller accounts each recheck and bounds the watch population. */
  watch(from: number, before: number, ready: () => void,
    iteration: () => void, reserve: (bytes: number) => Disposable): Disposable {
    const storage = reserve(128), watch: Watch = { from, before, ready, iteration, storage, live: true };
    try { this.#place(watch); }
    catch (cause) { this.#cancelWatch(watch); throw cause; }
    return { dispose: () => this.#cancelWatch(watch) };
  }
  #cancelWatch(watch: Watch): void {
    watch.node?.watches.delete(watch); delete watch.node;
    if (watch.live) { watch.live = false; watch.storage.dispose(); }
  }
  #place(watch: Watch): void {
    if (!watch.live) return;
    watch.iteration();
    const node = this.#first(watch.from, watch.before, watch.iteration);
    if (node) { node.watches.add(watch); watch.node = node; }
    else { watch.live = false; delete watch.node; watch.storage.dispose(); watch.ready(); }
  }
  retain(sequence: number): Disposable {
    this.#live();
    let node = this.#nodes.get(sequence);
    if (!node) throw new Error("input.retirement.unknown-observation");
    node.account.iteration();
    if (!Number.isSafeInteger(node.active + 1)) throw new Error("input.retirement.dependency-exhausted");
    const storage = node.account.reserve(64);
    node.dependencies.add(storage);
    node.active++;
    return { dispose: () => {
      const held = node; node = undefined;
      if (!held) return;
      if (this.#closed) return;
      held.dependencies.delete(storage); storage.dispose();
      (held.account.terminalIteration ?? held.account.iteration)(); held.active--; this.#retire(held);
    } };
  }
  consume(sequence: number, bytes: number): void {
    this.#live();
    const node = this.#nodes.get(sequence);
    if (!node || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > node.remaining)
      throw new Error("input.retirement.invalid-consumption");
    (node.account.terminalIteration ?? node.account.iteration)(); node.remaining -= bytes; this.#retire(node);
  }
  #retire(node: Node): void {
    if (node.remaining || node.active) return;
    node.account.retire?.();
    this.#root = this.#remove(this.#root!, node.sequence, () => node.account.iteration());
    this.#nodes.delete(node.sequence);
    node.left = undefined; node.right = undefined;
    // Each watch is removed before its callback/recheck. Reentrancy cannot
    // traverse a stale Set or retire the same issuance twice.
    let failed = false, failure: unknown;
    try {
      while (node.watches.size) {
        const watch = node.watches.values().next().value!;
        node.watches.delete(watch); delete watch.node;
        try { node.account.iteration(); this.#place(watch); }
        catch (cause) {
          this.#cancelWatch(watch);
          if (!failed) { failed = true; failure = cause; }
        }
      }
    } finally { try { node.storage.dispose(); } finally { node.account.close(); } }
    if (failed) throw failure;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failed = false, failure: unknown;
    const attempt = (action: () => void) => {
      try { action(); } catch (cause) { if (!failed) { failed = true; failure = cause; } }
    };
    for (const node of this.#nodes.values()) {
      attempt(() => node.account.retire?.());
      attempt(() => node.account.iteration());
      for (const dependency of node.dependencies) {
        attempt(() => (node.account.terminalIteration ?? node.account.iteration)());
        attempt(() => dependency.dispose());
      }
      node.dependencies.clear();
      for (const watch of node.watches) {
        attempt(watch.iteration); watch.live = false; delete watch.node; attempt(() => watch.storage.dispose());
      }
      node.watches.clear(); node.left = undefined; node.right = undefined;
      attempt(() => node.storage.dispose()); attempt(() => node.account.close());
    }
    this.#nodes.clear(); this.#root = undefined;
    if (failed) throw failure;
  }
}

interface CustodyRange {
  readonly sequence: number;
  bytes: number;
  readonly storage: Disposable;
  next?: CustodyRange | undefined;
}

/** Movable raw-prefix custody. Moving a whole list is O(1); taking a prefix
 * visits only ranges actually moved and splits at most one node. It never
 * recopies a growing owner's inventory on each delivery or consumption. */
export class InputCustodyRanges {
  readonly #index: InputRetirementIndex;
  #head: CustodyRange | undefined;
  #tail: CustodyRange | undefined;
  #bytes = 0;
  constructor(index: InputRetirementIndex) { this.#index = index; }
  get bytes(): number { return this.#bytes; }
  get lastSequence(): number | undefined { return this.#tail?.sequence; }
  append(sequence: number, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(this.#bytes + bytes))
      throw new Error("input.retirement.invalid-range");
    const account = this.#index.account(sequence);
    account.iteration();
    const storage = account.reserve(64);
    const node: CustodyRange = { sequence, bytes, storage };
    if (this.#tail) this.#tail.next = node; else this.#head = node;
    this.#tail = node; this.#bytes += bytes;
  }
  moveFrom(other: InputCustodyRanges): void {
    if (other === this || other.#index !== this.#index) throw new Error("input.retirement.invalid-handoff");
    if (!other.#head) return;
    this.#index.account(other.#head.sequence).iteration();
    if (!Number.isSafeInteger(this.#bytes + other.#bytes)) throw new Error("input.retirement.invalid-range");
    if (this.#tail) this.#tail.next = other.#head; else this.#head = other.#head;
    this.#tail = other.#tail; this.#bytes += other.#bytes;
    other.#head = undefined; other.#tail = undefined; other.#bytes = 0;
  }
  take(bytes: number): InputCustodyRanges {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#bytes)
      throw new Error("input.retirement.invalid-prefix");
    const result = new InputCustodyRanges(this.#index);
    // Failure revokes the connection; return ownership of any moved nodes to
    // this container so its ordinary unwind can still release their storage.
    try {
      while (bytes) {
        const node = this.#head!, account = this.#index.account(node.sequence);
        account.iteration();
        if (node.bytes > bytes) {
          result.append(node.sequence, bytes);
          node.bytes -= bytes; this.#bytes -= bytes; bytes = 0;
        } else {
          this.#head = node.next; delete node.next;
          if (!this.#head) this.#tail = undefined;
          if (result.#tail) result.#tail.next = node; else result.#head = node;
          result.#tail = node; result.#bytes += node.bytes;
          this.#bytes -= node.bytes; bytes -= node.bytes;
        }
      }
      return result;
    } catch (cause) {
      if (result.#tail) {
        result.#tail.next = this.#head; this.#head = result.#head;
        this.#tail ??= result.#tail; this.#bytes += result.#bytes;
      }
      throw cause;
    }
  }
  /** Classification/discard has ended. Revocation releases storage without
   * attempting to manufacture a successful proof on an already closed cut. */
  dispose(): void {
    let failure: unknown, failed = false;
    while (this.#head) {
      const node = this.#head;
      // The native reservation prepays this containing-range visit as well
      // as its own unlink, including when generation close ran first.
      node.storage.dispose();
      this.#head = node.next; delete node.next;
      this.#bytes -= node.bytes;
      try { if (!this.#index.closed) this.#index.consume(node.sequence, node.bytes); }
      catch (cause) { if (!failed) { failed = true; failure = cause; } }
    }
    this.#tail = undefined;
    if (failed) throw failure;
  }
}
