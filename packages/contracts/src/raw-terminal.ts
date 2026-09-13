/** Clone-safe raw-terminal vocabulary for the session RPC boundary. */

import type { Brand } from "./brand.js";

export type RawTerminalId = Brand<string, "RawTerminalId">;
export type RawTerminalRecoveryStrategy = "reconnect" | "flush-and-sync";

export type RawTerminalExitRequirement =
  | {
      readonly kind: "declared-recovery";
      readonly strategy: RawTerminalRecoveryStrategy;
      readonly message: string;
    }
  | {
      readonly kind: "reconnect-required";
      readonly message: string;
    };

export interface RawTerminalRecoveryResult {
  readonly kind: "recovered";
  readonly strategy: RawTerminalRecoveryStrategy;
  readonly connectionReplaced: boolean;
  readonly discardedBytes: number;
}

export type RawTerminalExitResult =
  | {
      readonly kind: "reestablishment-required";
      readonly refusal: "retained.protocol-reestablishment-required";
    }
  | {
      readonly kind: "recovered";
      readonly recovery: RawTerminalRecoveryResult;
    }
  | {
      readonly kind: "reconnected";
    };

/** Clone-safe handle DTO. The live raw-terminal session remains on the owner side. */
export interface RawTerminalHandle {
  readonly terminalId: RawTerminalId;
  readonly exitRequirement: RawTerminalExitRequirement;
}
