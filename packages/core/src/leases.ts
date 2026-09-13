import type {
  ChannelId,
  ChannelLeaseHolder,
  ChannelMode,
} from "@protodriver/contracts";

/** Typed local failure for an exclusive channel acquisition. */
export class ChannelLeaseConflictError extends Error {
  readonly channelId: ChannelId;
  readonly requestedMode: ChannelMode;
  readonly holder: ChannelLeaseHolder;

  constructor(requestedMode: ChannelMode, holder: ChannelLeaseHolder) {
    super(
      `channel ${holder.channelId} is held by ${holder.mode} since `
        + `${holder.acquiredAtMonotonicUs} us (sequence ${holder.acquiredAtSequence}); `
        + `cannot acquire ${requestedMode}`,
    );
    this.name = "ChannelLeaseConflictError";
    this.channelId = holder.channelId;
    this.requestedMode = requestedMode;
    this.holder = holder;
  }
}
