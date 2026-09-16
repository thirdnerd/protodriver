import type {
  UsbEndpointSpeed,
  UsbEndpointTransferType,
  UsbProfilePolicy,
  UsbProfilePolicyDiagnostic,
} from "@protodriver/contracts";

export interface UsbEndpointDescriptorEvidence {
  /** Complete USB endpoint address, including the direction bit. */
  readonly address: number;
  readonly direction: "input" | "output";
  readonly transferType: UsbEndpointTransferType;
  readonly maximumPacketBytes: number;
}

export interface UsbProfileDescriptorEvidence {
  readonly configurationValue: number;
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly endpoints: readonly UsbEndpointDescriptorEvidence[];
}

export interface ValidatedUsbEndpoint {
  readonly channelIndex: number;
  readonly channelId: string;
  readonly direction: "input" | "output";
  readonly endpointNumber: number;
  readonly address: number;
  readonly transferType: UsbEndpointTransferType;
  readonly maximumPacketBytes: number;
}

export interface ValidatedUsbProfilePolicy {
  readonly speedEvidence: UsbNegotiatedSpeedEvidence;
  readonly matchingDeclaredSpeeds: readonly UsbEndpointSpeed[];
  readonly endpoints: readonly ValidatedUsbEndpoint[];
}

export type UsbNegotiatedSpeedEvidence =
  | { readonly kind: "reported"; readonly speed: UsbEndpointSpeed }
  | { readonly kind: "unreported" };

/** Native input settlement is one live endpoint packet; stream containment is separate. */
export function nativeUsbInRequestBytes(
  endpoint: Pick<ValidatedUsbEndpoint, "transferType" | "maximumPacketBytes">,
): number {
  return endpoint.maximumPacketBytes;
}

export class UsbProfilePolicyError extends Error {
  readonly responsibility = "definition" as const;
  readonly diagnostic: UsbProfilePolicyDiagnostic;

  constructor(diagnostic: UsbProfilePolicyDiagnostic) {
    super(diagnostic.message);
    this.name = "UsbProfilePolicyError";
    this.diagnostic = diagnostic;
  }
}

/** Validate the complete declared policy without inventing live descriptor evidence. */
export function validateUsbProfilePolicyDeclaration(
  profile: UsbProfilePolicy,
  declarationPath = "$open.profile",
): void {
  validateProfileHeader(profile, declarationPath);
  const channelIds = new Set<string>();
  const addresses = new Set<number>();
  for (const [channelIndex, channel] of profile.channels.entries()) {
    const channelPath = `${declarationPath}.channels[${channelIndex}]`;
    validateChannel(channel, channelPath, channelIds);
    if (channel.input !== null) {
      validateEndpointDeclaration(channel.input, "input", `${channelPath}.input`, addresses);
    }
    if (channel.output !== null) {
      validateEndpointDeclaration(channel.output, "output", `${channelPath}.output`, addresses);
    }
  }
}

/**
 * Fail closed against both the declaration and the selected live alternate.
 * Adapters assemble descriptor evidence before claiming the interface, so an
 * invalid profile cannot touch the authoritative byte paths.
 */
export function validateUsbProfilePolicy(
  profile: UsbProfilePolicy,
  speedEvidence: UsbNegotiatedSpeedEvidence,
  descriptor: UsbProfileDescriptorEvidence,
  declarationPath = "$open.profile",
): ValidatedUsbProfilePolicy {
  validateProfileHeader(profile, declarationPath);

  if ((profile.configurationValue !== "preserve-active"
      && descriptor.configurationValue !== profile.configurationValue)
    || descriptor.interfaceNumber !== profile.interfaceNumber
    || descriptor.alternateSetting !== profile.alternateSetting) {
    fail(
      "transport.usb.endpoint-descriptor-mismatch",
      declarationPath,
      "selected USB configuration, interface, and alternate descriptor must equal the profile",
    );
  }

  const channelIds = new Set<string>();
  const addresses = new Set<number>();
  const validated: ValidatedUsbEndpoint[] = [];
  let matchingDeclaredSpeeds = new Set<UsbEndpointSpeed>(["full", "high"]);
  for (const [channelIndex, channel] of profile.channels.entries()) {
    const channelPath = `${declarationPath}.channels[${channelIndex}]`;
    validateChannel(channel, channelPath, channelIds);
    if (channel.input !== null) {
      const result = validateEndpoint({
        endpoint: channel.input,
        direction: "input",
        channelIndex,
        channelId: channel.id,
        speedEvidence,
        descriptor,
        addresses,
        declarationPath: `${channelPath}.input`,
      });
      validated.push(result.endpoint);
      matchingDeclaredSpeeds = intersection(matchingDeclaredSpeeds, result.matchingDeclaredSpeeds);
    }
    if (channel.output !== null) {
      const result = validateEndpoint({
        endpoint: channel.output,
        direction: "output",
        channelIndex,
        channelId: channel.id,
        speedEvidence,
        descriptor,
        addresses,
        declarationPath: `${channelPath}.output`,
      });
      validated.push(result.endpoint);
      matchingDeclaredSpeeds = intersection(matchingDeclaredSpeeds, result.matchingDeclaredSpeeds);
    }
  }
  if (matchingDeclaredSpeeds.size === 0) {
    fail(
      "transport.usb.no-common-packet-size-speed",
      declarationPath,
      "live USB endpoint packet sizes must share at least one declared speed key across the profile",
    );
  }
  return Object.freeze({
    speedEvidence,
    matchingDeclaredSpeeds: Object.freeze([...matchingDeclaredSpeeds]),
    endpoints: Object.freeze(validated),
  });
}

function validateProfileHeader(profile: UsbProfilePolicy, declarationPath: string): void {
  if (profile.kind !== "usb"
    || !(profile.configurationValue === "preserve-active"
      || usbByte(profile.configurationValue, false))
    || !usbByte(profile.interfaceNumber, true)
    || !usbByte(profile.alternateSetting, true)
    || profile.channels.length === 0) {
    fail(
      "transport.usb.invalid-profile",
      declarationPath,
      "USB profile needs a nonzero configuration, byte-sized interface and alternate values, and at least one channel",
    );
  }
}

function validateChannel(
  channel: UsbProfilePolicy["channels"][number],
  channelPath: string,
  channelIds: Set<string>,
): void {
  if (typeof channel.id !== "string" || channel.id.length === 0) {
    fail(
      "transport.usb.invalid-channel",
      `${channelPath}.id`,
      "USB channel id must be nonempty",
    );
  }
  if (channelIds.has(channel.id)) {
    fail(
      "transport.usb.duplicate-channel-id",
      `${channelPath}.id`,
      `USB channel id ${JSON.stringify(channel.id)} is declared more than once`,
    );
  }
  channelIds.add(channel.id);
  if (channel.input === null && channel.output === null) {
    fail(
      "transport.usb.invalid-channel",
      channelPath,
      "USB channel must declare an input endpoint, an output endpoint, or both",
    );
  }
}

interface EndpointLike {
  readonly endpointNumber: number;
  readonly transferType: UsbEndpointTransferType;
  readonly maximumPacketBytes: Readonly<Partial<Record<UsbEndpointSpeed, number>>>;
}

function validateEndpoint(options: {
  readonly endpoint: EndpointLike;
  readonly direction: "input" | "output";
  readonly channelIndex: number;
  readonly channelId: string;
  readonly speedEvidence: UsbNegotiatedSpeedEvidence;
  readonly descriptor: UsbProfileDescriptorEvidence;
  readonly addresses: Set<number>;
  readonly declarationPath: string;
}): {
  readonly endpoint: ValidatedUsbEndpoint;
  readonly matchingDeclaredSpeeds: ReadonlySet<UsbEndpointSpeed>;
} {
  const { endpoint, direction, declarationPath } = options;
  const { address, packetEntries } = validateEndpointDeclaration(
    endpoint,
    direction,
    declarationPath,
    options.addresses,
  );
  const live = options.descriptor.endpoints.find((candidate) => candidate.address === address);
  if (live === undefined
    || live.direction !== direction
    || live.transferType !== endpoint.transferType) {
    fail(
      "transport.usb.endpoint-descriptor-mismatch",
      declarationPath,
      `USB endpoint 0x${address.toString(16).padStart(2, "0")} must match the live direction and transfer type`,
    );
  }
  const matchingDeclaredSpeeds = options.speedEvidence.kind === "reported"
    ? new Set<UsbEndpointSpeed>([options.speedEvidence.speed])
    : new Set<UsbEndpointSpeed>(packetEntries.flatMap(([speed, bytes]) =>
        bytes === live.maximumPacketBytes ? [speed as UsbEndpointSpeed] : []));
  const maximumPacketBytes = options.speedEvidence.kind === "reported"
    ? endpoint.maximumPacketBytes[options.speedEvidence.speed]
    : live.maximumPacketBytes;
  if (options.speedEvidence.kind === "reported" && maximumPacketBytes === undefined) {
    fail(
      "transport.usb.missing-negotiated-speed",
      `${declarationPath}.maximumPacketBytes.${options.speedEvidence.speed}`,
      `USB endpoint does not declare ${options.speedEvidence.speed}-speed maximum packet bytes`,
    );
  }
  if (maximumPacketBytes !== live.maximumPacketBytes || matchingDeclaredSpeeds.size === 0) {
    const evidence = options.speedEvidence.kind === "reported"
      ? `${options.speedEvidence.speed}-speed`
      : "at least one declared speed";
    fail(
      "transport.usb.endpoint-descriptor-mismatch",
      declarationPath,
      `USB endpoint 0x${address.toString(16).padStart(2, "0")} live packet size must match ${evidence} packet size`,
    );
  }
  return {
    endpoint: Object.freeze({
      channelIndex: options.channelIndex,
      channelId: options.channelId,
      direction,
      endpointNumber: endpoint.endpointNumber,
      address,
      transferType: endpoint.transferType,
      maximumPacketBytes,
    }),
    matchingDeclaredSpeeds,
  };
}

function validateEndpointDeclaration(
  endpoint: EndpointLike,
  direction: "input" | "output",
  declarationPath: string,
  addresses: Set<number>,
): { readonly address: number; readonly packetEntries: readonly [string, number][] } {
  if (!Number.isInteger(endpoint.endpointNumber)
    || endpoint.endpointNumber < 1
    || endpoint.endpointNumber > 15
    || !(endpoint.transferType === "bulk" || endpoint.transferType === "interrupt")) {
    fail(
      "transport.usb.invalid-endpoint",
      declarationPath,
      "USB endpoint needs number 1 through 15 and a supported transfer type",
    );
  }
  const packetEntries = Object.entries(endpoint.maximumPacketBytes) as [string, number][];
  if (packetEntries.length === 0) {
    fail(
      "transport.usb.empty-packet-size-record",
      `${declarationPath}.maximumPacketBytes`,
      "USB endpoint packet-size record must contain at least one negotiated speed",
    );
  }
  for (const [speed, bytes] of packetEntries) {
    if (!(speed === "full" || speed === "high")
      || !Number.isSafeInteger(bytes)
      || bytes <= 0
      || bytes > 0xffff) {
      fail(
        "transport.usb.invalid-endpoint",
        `${declarationPath}.maximumPacketBytes.${speed}`,
        "USB endpoint packet size must be a positive 16-bit integer keyed by full or high speed",
      );
    }
    if (!legalPacketSize(endpoint.transferType, speed, bytes)) {
      fail(
        "transport.usb.illegal-packet-size",
        `${declarationPath}.maximumPacketBytes.${speed}`,
        `${speed}-speed ${endpoint.transferType} endpoint cannot declare ${bytes} maximum packet bytes`,
      );
    }
  }
  const address = endpoint.endpointNumber | (direction === "input" ? 0x80 : 0);
  if (addresses.has(address)) {
    fail(
      "transport.usb.duplicate-endpoint-address",
      declarationPath,
      `USB endpoint address 0x${address.toString(16).padStart(2, "0")} is declared more than once`,
    );
  }
  addresses.add(address);
  return { address, packetEntries };
}

function intersection(
  left: ReadonlySet<UsbEndpointSpeed>,
  right: ReadonlySet<UsbEndpointSpeed>,
): Set<UsbEndpointSpeed> {
  return new Set([...left].filter((speed) => right.has(speed)));
}

function usbByte(value: number, zeroAllowed: boolean): boolean {
  return Number.isInteger(value) && value >= (zeroAllowed ? 0 : 1) && value <= 0xff;
}

function legalPacketSize(
  transferType: UsbEndpointTransferType,
  speed: UsbEndpointSpeed,
  bytes: number,
): boolean {
  if (transferType === "bulk") {
    return speed === "full"
      ? bytes === 8 || bytes === 16 || bytes === 32 || bytes === 64
      : bytes === 512;
  }
  return speed === "full" ? bytes <= 64 : bytes <= 1024;
}

function fail(
  code: UsbProfilePolicyDiagnostic["code"],
  declarationPath: string,
  message: string,
): never {
  throw new UsbProfilePolicyError({ code, declarationPath, message });
}
