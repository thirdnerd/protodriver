import type { ControlRequest } from "@protodriver/contracts";

export interface ParsedUsbControlRequest {
  readonly kind: "valid";
  readonly direction: "device-to-host" | "host-to-device";
  readonly requestType: number;
  readonly request: number;
  readonly value: number;
  readonly index: number;
  readonly length: number;
  readonly payload: Uint8Array;
}

export type UsbControlRequestParseResult = ParsedUsbControlRequest | {
  readonly kind: "invalid";
  readonly message: string;
};

/** Shared setup-packet validation for Node USB and browser WebUSB adapters. */
export function parseUsbControlRequest(request: ControlRequest): UsbControlRequestParseResult {
  const keys = Object.keys(request.parameters).sort();
  const expected = ["direction", "index", "length", "recipient", "request", "requestType", "value"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return {
      kind: "invalid",
      message: "usb.control parameters must contain exactly direction, requestType, recipient, request, value, index, and length",
    };
  }
  const {
    direction,
    requestType,
    recipient,
    request: requestCode,
    value,
    index,
    length,
  } = request.parameters;
  if (!(direction === "device-to-host" || direction === "host-to-device")
    || !(requestType === "standard" || requestType === "class" || requestType === "vendor")
    || !(recipient === "device" || recipient === "interface" || recipient === "endpoint" || recipient === "other")
    || !unsigned(requestCode, 0xff)
    || !unsigned(value, 0xffff)
    || !unsigned(index, 0xffff)
    || !unsigned(length, 0xffff)) {
    return {
      kind: "invalid",
      message: "usb.control setup fields must belong to the declared USB setup-packet domains",
    };
  }
  const payload = request.payload ?? new Uint8Array();
  if ((direction === "device-to-host" && request.payload !== undefined)
    || (direction === "host-to-device" && payload.byteLength !== length)) {
    return {
      kind: "invalid",
      message: "device-to-host control has no request payload and host-to-device payload length must equal length",
    };
  }
  const typeBits = requestType === "standard" ? 0x00 : requestType === "class" ? 0x20 : 0x40;
  const recipientBits = recipient === "device"
    ? 0x00
    : recipient === "interface" ? 0x01 : recipient === "endpoint" ? 0x02 : 0x03;
  return {
    kind: "valid",
    direction,
    requestType: (direction === "device-to-host" ? 0x80 : 0) | typeBits | recipientBits,
    request: requestCode,
    value,
    index,
    length,
    payload,
  };
}

function unsigned(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
}
