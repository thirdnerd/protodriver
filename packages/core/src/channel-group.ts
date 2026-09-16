import type { AuthoredChannelRoles, ByteChannel, ChannelLease, DeviceConnection, PdrFailureResponsibility } from "@protodriver/contracts";

function refused(code: string, message: string, details?: { failures: string[] }, responsibility: PdrFailureResponsibility = "operation"): Error {
  return Object.assign(new Error(message), { error: { code, message, responsibility, retryability: "no", ...(details ? { details } : {}) } });
}
/** Atomic, at most three distinct physical leases. No native object enters Lua. */
export class ChannelGroup {
  readonly inputs: ReadonlyArray<{ channel: ByteChannel; lease: ChannelLease }>;
  readonly request: { channel: ByteChannel; lease: ChannelLease };
  readonly #members: Array<{ channel: ByteChannel; lease: ChannelLease }>;
  #released = false;
  private constructor(members: Array<{ channel: ByteChannel; lease: ChannelLease }>, roles: AuthoredChannelRoles) {
    this.#members = members;
    this.request = members.find(m => m.channel.id === roles.request)!;
    this.inputs = members.filter(m => m.channel.id === roles.response || m.channel.id === roles.event);
  }
  static async acquire(connection: DeviceConnection, roles: AuthoredChannelRoles, live: () => void,
    iteration: () => void = () => {}): Promise<ChannelGroup> {
    const selected: ByteChannel[] = [];
    for (const role of ["request", "response", "event"] as const) {
      iteration(); live();
      const id = roles[role];
      if (typeof id !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(id))
        throw refused("retained.channel-unavailable", "invalid channel for role " + role, undefined, "definition");
      let channel: ByteChannel | undefined;
      for (const candidate of connection.channels) { iteration(); if (candidate.id === id) { channel = candidate; break; } }
      if (!channel) throw refused("retained.channel-unavailable", "role " + role + " channel " + id + " is unavailable");
      const direction = role === "request" ? "out" : "in";
      if (channel.direction !== direction && channel.direction !== "duplex")
        throw refused("retained.channel-direction", "role " + role + " channel " + id + " has no " + (direction === "in" ? "input" : "output") + " endpoint", undefined, "definition");
      if (!selected.includes(channel)) selected.push(channel);
    }
    const acquired: Array<{ channel: ByteChannel; lease: ChannelLease }> = [];
    try {
      for (const channel of selected) { iteration(); live(); const lease = await channel.acquire("protocol"); acquired.push({ channel, lease }); live(); }
      return new ChannelGroup(acquired, roles);
    } catch (cause) {
      try { await ChannelGroup.releaseAll(acquired); }
      catch (cleanup) { throw refused("retained.channel-rollback-failed", String(cause), { failures: [String(cleanup)] }); }
      throw cause;
    }
  }
  private static async releaseAll(members: Array<{ lease: ChannelLease }>): Promise<void> {
    const failures: string[] = [];
    for (let i = members.length - 1; i >= 0; i--) {
      try { await members[i]!.lease.release(); } catch (cause) { failures.push(String(cause).slice(0, 512)); }
    }
    if (failures.length) throw refused("retained.channel-release-failed", "not all channel leases were released", { failures });
  }
  async release(): Promise<void> {
    if (this.#released) return; this.#released = true;
    await ChannelGroup.releaseAll(this.#members);
  }
}
