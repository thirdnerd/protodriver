import type { AuthoredDescription, AuthoredPollPolicy, AuthoredPollRefresh, Clock, Disposable, OperationId, OperationResult, PublicValue } from "@protodriver/contracts";

export const DEFAULT_AUTHORED_POLL_POLICY: AuthoredPollPolicy = Object.freeze({
  burst: 4, refillEveryMs: 1000, minimumIntervalMs: 1000, maximumPlans: 4,
});
export interface PollPlan extends AuthoredPollRefresh { readonly id: string; readonly cells: readonly string[]; readonly releaseAfterIdleMs?: number }
export interface RequiredPollGrant {
  readonly minimumIntervalMs: number;
  readonly maximumNominalPollsPerSecond: number;
}
const refuse = (message: string): never => { throw Object.assign(new Error(message), { code: "authored.poll.unavailable" }); };
function validateHostPolicy(policy: AuthoredPollPolicy): void {
  if (Object.keys(policy).sort().join(",") !== "burst,maximumPlans,minimumIntervalMs,refillEveryMs"
    || Object.values(policy).some(n => !Number.isSafeInteger(n) || n < 1 || n > 2147483647)) refuse("finite positive bounded host policy required");
}
export function pollPlans(description: AuthoredDescription): PollPlan[] {
  const plans = new Map<string, PollPlan>();
  const references = [
    ...Object.entries(description.state ?? {}).map(([cell, { refresh }]) => ({ cell, refresh })),
    ...(description.maintenance ?? []).map(refresh => ({ cell: undefined, refresh })),
  ];
  for (const { cell, refresh } of references) {
    if (!refresh || typeof refresh === "string") continue;
    const id = refresh.mode + "/" + refresh.operation, old = plans.get(id);
    const locks = [...refresh.suspendWhileLocksHeld].sort();
    if (old && (old.intervalMs !== refresh.intervalMs || old.failureBackoffMs !== refresh.failureBackoffMs
      || old.maximumInterTransactionGapMs !== refresh.maximumInterTransactionGapMs
      || old.timing?.kind !== refresh.timing?.kind || old.timing?.activity !== refresh.timing?.activity
      || JSON.stringify(old.suspendWhileLocksHeld) !== JSON.stringify(locks))) refuse("coalesced refresh policies disagree: " + id);
    const releaseAfterIdleMs = description.operations.find(op => op.id === refresh.operation)?.releaseAfterIdleMs;
    plans.set(id, { ...refresh, ...(releaseAfterIdleMs === undefined ? {} : { releaseAfterIdleMs }), id, suspendWhileLocksHeld: locks, cells: [...(old?.cells ?? []), ...(cell === undefined ? [] : [cell])] });
  }
  return [...plans.values()];
}
/** Derive a bounded exception policy only from admitted, explained cadence. */
export function grantRequiredPollPlans(plans: readonly PollPlan[], ordinary: AuthoredPollPolicy,
  grant: RequiredPollGrant): AuthoredPollPolicy {
  validateHostPolicy(ordinary);
  if (Object.keys(grant).sort().join(",") !== "maximumNominalPollsPerSecond,minimumIntervalMs"
    || !Number.isSafeInteger(grant.minimumIntervalMs) || grant.minimumIntervalMs < 1 || grant.minimumIntervalMs > 2147483647
    || !Number.isSafeInteger(grant.maximumNominalPollsPerSecond) || grant.maximumNominalPollsPerSecond < 1
    || grant.maximumNominalPollsPerSecond > 1000)
    refuse("finite positive required-cadence grant required");
  const short = plans.filter(plan => plan.intervalMs < ordinary.minimumIntervalMs);
  if (!short.length) return ordinary;
  if (short.some(plan => plan.maximumInterTransactionGapMs === undefined
    || plan.intervalMs >= plan.maximumInterTransactionGapMs)) refuse("short poll lacks a consistent maximum inter-transaction gap");
  if (short.some(plan => plan.intervalMs < grant.minimumIntervalMs)) refuse("required poll interval below host grant");
  const rate = plans.reduce((sum, plan) => sum + 1000 / plan.intervalMs, 0);
  if (rate > grant.maximumNominalPollsPerSecond) refuse("required poll population exceeds host cadence grant");
  const policy = Object.freeze({ ...ordinary,
    minimumIntervalMs: Math.min(ordinary.minimumIntervalMs, ...short.map(plan => plan.intervalMs)),
    refillEveryMs: Math.min(ordinary.refillEveryMs, Math.max(1, Math.floor(1000 / rate))),
  });
  grantPollPlans(plans, policy);
  return policy;
}
export function grantPollPlans(plans: readonly PollPlan[], policy: AuthoredPollPolicy | null): AuthoredPollPolicy | null {
  if (!policy) { if (plans.length) refuse("host has not granted periodic work"); return null; }
  validateHostPolicy(policy);
  if (plans.length > policy.maximumPlans || plans.length > policy.burst) refuse("poll population exceeds host plan/burst grant");
  if (plans.some(plan => plan.intervalMs < policy.minimumIntervalMs)) refuse("poll interval below host minimum");
  if (plans.reduce((rate, plan) => rate + 1 / plan.intervalMs, 0) > 1 / policy.refillEveryMs)
    refuse("nominal poll population exceeds session refill grant");
  return Object.freeze({ ...policy });
}

interface PlanState {
  plan: PollPlan; dueUs: number; timer?: Disposable; active?: OperationId;
  terminal?: OperationResult; last?: PublicValue;
  idleSinceUs?: number; busySinceUs?: number; resetSequence?: number; revision: number;
  deferredSinceUs?: number;
  activeGeneration?: number;
}
export interface PollHost {
  clock: Clock;
  enqueue(sequence: number, run: () => Promise<void>): Promise<void>;
  sequence(): number;
  /** Synchronous ordinary-operation admission. Debit after all refusal checks. */
  start(plan: PollPlan, debit: () => boolean): OperationId;
  observe(value: PublicValue): void;
  failed(cause: unknown): void;
  release?(): Promise<void>;
  quiescent?(): boolean;
}
/** Eligibility is not an activation. There is exactly ONE bucket here, never
 * one per plan, state cell, connection generation, task or successful entry. */
export class AuthoredPollService {
  readonly #host: PollHost;
  readonly #policy: AuthoredPollPolicy;
  readonly #states: PlanState[];
  #credit: number;
  #refilledUs: number;
  #epoch = 0;
  #enabled = false;
  #closed = false;
  #mode = "";
  #generation = -1;
  #spent = 0;
  #retired = 0;
  #historyDropped = 0;
  #operatorIdleUs: number | undefined;
  #releaseTimer: Disposable | undefined;
  #releaseDue = false;
  #released = false;
  #releasing = false;
  readonly #foreground = new Map<OperationId, number>();
  constructor(plans: readonly PollPlan[], policy: AuthoredPollPolicy, host: PollHost) {
    this.#host = host; this.#policy = policy;
    this.#credit = policy.burst; this.#refilledUs = host.clock.monotonicUs();
    this.#states = plans.map(plan => ({ plan, dueUs: 0, revision: 0 }));
  }
  get timerReservation(): number { return this.#states.length + (this.#states.some(s => s.plan.releaseAfterIdleMs !== undefined) ? 1 : 0); }
  get released(): boolean { return this.#released; }
  get releasing(): boolean { return this.#releasing; }
  get idleReleaseMode(): boolean { return this.#states.some(s => s.plan.mode === this.#mode && s.plan.releaseAfterIdleMs !== undefined); }
  get snapshot(): PublicValue {
    return { policy: { ...this.#policy }, ...(this.idleReleaseMode ? { released: this.#released, releasePending: this.#releaseDue, operatorIdleSinceUs: this.#operatorIdleUs ?? null } : {}), permitsRemaining: this.#credit, creditCalculatedAtUs: this.#refilledUs, permitsSpent: this.#spent,
      retiredResults: this.#retired, historyDropped: this.#historyDropped,
      plans: this.#states.map(s => ({ ...s.plan, cells: [...s.plan.cells], suspendWhileLocksHeld: [...s.plan.suspendWhileLocksHeld],
        nextDueUs: s.dueUs, activeOperation: s.active ?? null, last: s.last ?? null,
        ...(s.plan.timing ? this.#activity(s) : {}) })) };
  }
  #activity(s: PlanState): Record<string, PublicValue> {
    const now = this.#host.clock.monotonicUs();
    return { activity: "foreground-lifecycle", foregroundCount: this.#foreground.size,
      status: !this.#enabled ? "suspended" : this.#foreground.size ? "busy/suppressed" : s.active ? "active" : "idle",
      idleSinceUs: s.idleSinceUs ?? null, idleUs: s.idleSinceUs === undefined ? 0 : now - s.idleSinceUs,
      busyUs: s.busySinceUs === undefined ? 0 : now - s.busySinceUs,
      deferredUs: s.deferredSinceUs === undefined ? 0 : now - s.deferredSinceUs,
      resetSequence: s.resetSequence ?? null };
  }
  foregroundStarted(id: OperationId, generation: number): void {
    this.#foreground.set(id, generation);
    this.#releaseTimer?.dispose(); this.#releaseTimer = undefined;
    this.#operatorIdleUs = undefined; this.#releaseDue = false;
    for (const s of this.#states) if (s.plan.timing && s.plan.mode === this.#mode) {
      s.timer?.dispose(); delete s.timer; s.revision++;
      s.busySinceUs ??= this.#host.clock.monotonicUs();
      delete s.idleSinceUs; delete s.deferredSinceUs;
      s.resetSequence = this.#host.sequence();
      this.#observe("busy/suppressed", s, { operationId: id, ...this.#activity(s) });
    }
  }
  foregroundRetired(id: OperationId, successfulReentry = false): void {
    if (!this.#foreground.delete(id) || this.#foreground.size) return;
    if (successfulReentry) this.#released = false;
    this.#operatorIdleUs = this.#host.clock.monotonicUs(); this.#armRelease();
    for (const s of this.#states) if (s.plan.timing && s.plan.mode === this.#mode) {
      this.#resetIdle(s);
      this.#observe("idle-reset", s, { operationId: id, ...this.#activity(s) });
      this.#arm(s);
    }
  }
  operationReacquired(id: OperationId, generation: number): void {
    // A still-running foreground lifecycle operation owns the new capability
    // too; replacing its connection is not completion of that operation.
    if (this.#foreground.has(id)) this.#foreground.set(id, generation);
    // The same distinction applies to a scheduled lifecycle operation: its
    // own new capability is not a stale completion, including on failure.
    const active = this.#states.find(s => s.active === id);
    if (active) active.activeGeneration = generation;
  }
  #resetIdle(s: PlanState): void {
    s.idleSinceUs = this.#host.clock.monotonicUs();
    delete s.busySinceUs; delete s.deferredSinceUs;
    s.resetSequence = this.#host.sequence();
    s.dueUs = Math.max(s.dueUs, s.idleSinceUs + s.plan.intervalMs * 1000);
    s.revision++;
  }
  #observe(kind: string, state?: PlanState, fields: Record<string, PublicValue> = {}): void {
    this.#host.observe({ kind, generation: this.#generation, ...fields,
      ...(state ? { plan: state.plan.id, cells: [...state.plan.cells], nextDueUs: state.dueUs } : {}) });
  }
  resume(mode: string, generation: number): void {
    if (this.#closed || (this.#enabled && generation === this.#generation && mode === this.#mode)) return;
    this.pause(); this.#enabled = true; this.#generation = generation; this.#mode = mode;
    // Disposal ends the old activity domain; a late old retirement cannot
    // reset a replacement generation's idle boundary.
    for (const [id, ownerGeneration] of this.#foreground) if (ownerGeneration !== generation) this.#foreground.delete(id);
    if (!this.#foreground.size && this.#operatorIdleUs === undefined) this.#operatorIdleUs = this.#host.clock.monotonicUs();
    this.#armRelease();
    for (const s of this.#states) {
      s.dueUs = Math.max(s.dueUs, this.#host.clock.monotonicUs() + s.plan.intervalMs * 1000);
      if (s.plan.timing && !this.#foreground.size) this.#resetIdle(s);
      this.#arm(s);
    }
    this.#observe("enabled", undefined, { service: this.snapshot });
  }
  pause(): void {
    this.#enabled = false; this.#epoch++;
    this.#releaseTimer?.dispose(); this.#releaseTimer = undefined;
    for (const s of this.#states) { s.timer?.dispose(); delete s.timer; }
  }
  close(): void { this.pause(); this.#closed = true; }
  #armRelease(): void {
    this.#releaseTimer?.dispose(); this.#releaseTimer = undefined;
    const plan = this.#states.find(s => s.plan.mode === this.#mode && s.plan.releaseAfterIdleMs !== undefined)?.plan;
    if (!plan || !this.#enabled || this.#closed || this.#released || this.#foreground.size || this.#operatorIdleUs === undefined) return;
    const epoch = this.#epoch, origin = this.#operatorIdleUs;
    this.#releaseTimer = this.#host.clock.timer(Math.max(0, (origin + plan.releaseAfterIdleMs! * 1000 - this.#host.clock.monotonicUs()) / 1000), () => {
      this.#releaseTimer = undefined;
      void this.#host.enqueue(this.#host.sequence(), async () => {
        if (epoch !== this.#epoch || origin !== this.#operatorIdleUs || this.#foreground.size || this.#closed) return;
        this.#releaseDue = true;
        await this.#tryRelease();
      }).catch(cause => this.#host.failed(cause));
    });
  }
  async #tryRelease(): Promise<void> {
    if (!this.#releaseDue || this.#released || this.#releasing || this.#foreground.size || !this.#enabled
      || this.#states.some(s => s.active) || this.#host.quiescent?.() === false) return;
    this.#releasing = true;
    for (const s of this.#states) { s.timer?.dispose(); delete s.timer; }
    // State invalidation uses the same sequence queue. Do not await a queued
    // turn from inside its predecessor; the synchronous latch excludes starts.
    void Promise.resolve(this.#host.release?.()).then(() => this.#host.enqueue(this.#host.sequence(), async () => {
      if (!this.#closed) {
        this.#released = true; this.#releaseDue = false;
        this.#observe("released-idle", undefined, { service: this.snapshot });
      }
      this.#releasing = false;
    })).catch(cause => { this.#releasing = false; this.#host.failed(cause); });
  }
  settled(): void {
    if (this.#releaseDue) void this.#host.enqueue(this.#host.sequence(), () => this.#tryRelease()).catch(cause => this.#host.failed(cause));
  }
  #debit(): boolean {
    const now = this.#host.clock.monotonicUs(), period = this.#policy.refillEveryMs * 1000;
    const ticks = Math.floor((now - this.#refilledUs) / period);
    if (ticks > 0) {
      this.#credit = Math.min(this.#policy.burst, this.#credit + ticks);
      this.#refilledUs += ticks * period;
    }
    if (this.#credit < 1) return false;
    this.#credit--; this.#spent++;
    return true;
  }
  #arm(s: PlanState): void {
    if (!this.#enabled || this.#closed || this.#released || this.#releaseDue || s.active || s.plan.mode !== this.#mode || (s.plan.timing && this.#foreground.size)) return;
    const epoch = this.#epoch, revision = s.revision;
    s.timer = this.#host.clock.timer(Math.max(0, (s.dueUs - this.#host.clock.monotonicUs()) / 1000), () => {
      delete s.timer;
      const sequence = this.#host.sequence();
      void this.#host.enqueue(sequence, async () => {
        if (epoch !== this.#epoch || revision !== s.revision || !this.#enabled || this.#closed || this.#released || this.#releaseDue || s.active
          || (s.plan.timing && this.#foreground.size)) return;
        const now = this.#host.clock.monotonicUs();
        const release = this.#states.find(v => v.plan.mode === this.#mode && v.plan.releaseAfterIdleMs !== undefined);
        if (release && this.#operatorIdleUs !== undefined && now >= this.#operatorIdleUs + release.plan.releaseAfterIdleMs! * 1000) {
          this.#releaseDue = true; await this.#tryRelease(); return;
        }
        if (now < s.dueUs) { this.#arm(s); return; }
        try {
          s.active = this.#host.start(s.plan, () => this.#debit());
          s.activeGeneration = this.#generation;
          delete s.idleSinceUs; delete s.deferredSinceUs;
          this.#observe("admitted", s, { operationId: s.active, dueSequence: sequence,
            permitsRemaining: this.#credit, permitsSpent: this.#spent });
        } catch (cause) {
          const e = cause as { error?: { code?: string }; code?: string };
          s.dueUs = now + s.plan.intervalMs * 1000;
          s.deferredSinceUs ??= now;
          this.#observe("skipped", s, { dueSequence: sequence, reason: e.error?.code ?? e.code ?? String(cause),
            ...(s.plan.timing ? this.#activity(s) : {}) });
          this.#arm(s);
        }
      }).catch(cause => { if (!this.#closed) this.#host.failed(cause); });
    });
  }
  terminal(id: OperationId, result: OperationResult): void {
    const s = this.#states.find(s => s.active === id); if (!s) return;
    s.terminal = result;
    if (!s.plan.timing || s.activeGeneration === this.#generation)
      s.dueUs = Math.max(s.plan.timing ? s.dueUs : 0, this.#host.clock.monotonicUs() + (result.outcome === "completed" ? s.plan.intervalMs : s.plan.failureBackoffMs) * 1000);
    if (s.last) this.#historyDropped++;
    s.last = { operationId: id, outcome: result.outcome, ...(result.error ? { error: { ...result.error } } : {}) } as unknown as PublicValue;
    this.#observe("terminal", s, { result: result as unknown as PublicValue });
    // DO NOT clear active here: cancellation is not native settlement.
  }
  retired(id: OperationId): void {
    const s = this.#states.find(s => s.active === id); if (!s) return;
    delete s.active; delete s.terminal; this.#retired++;
    if (s.plan.timing && s.activeGeneration === this.#generation && !this.#foreground.size) this.#resetIdle(s);
    delete s.activeGeneration;
    this.#observe("retired", s, { operationId: id, retiredResults: this.#retired, historyDropped: this.#historyDropped });
    if (this.#releaseDue) void this.#host.enqueue(this.#host.sequence(), () => this.#tryRelease()).catch(cause => this.#host.failed(cause));
    this.#arm(s);
  }
}
