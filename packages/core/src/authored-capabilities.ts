/** Capability names are declaration syntax; availability remains a host-context decision. */
export const AUTHORED_CAPABILITY_NAMES = Object.freeze([
  "usb.control",
  "channel.read",
  "channel.write",
  "channel.write-via",
  "mailbox",
  "timer",
  "clock.observe",
  "expiry.observe",
  "input.retirement",
  "operation.deadline",
  "transfer.checkpoint",
  "transfer.cleanup",
  "state.poll",
  "connection.lifecycle",
] as const);

export type AuthoredCapabilityName = typeof AUTHORED_CAPABILITY_NAMES[number];
