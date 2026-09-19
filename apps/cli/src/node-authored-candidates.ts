import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type {
  AuthoredConnectionProfile,
  CandidateId,
  DeviceConnection,
  PhysicalDeviceIdentity,
  SerializableCandidate,
} from "@protodriver/contracts";
import { RealClock } from "@protodriver/core/clock";
import type { UsbNegotiatedSpeedEvidence } from "@protodriver/core/usb-profile";
import { listNodeSerialPorts, NodeSerialTransport } from "@protodriver/transport-node-serial";
import { NodeUsbTransport, type NodeUsbDevice } from "@protodriver/transport-node-usb";

export interface SelectedAuthoredCandidate {
  readonly candidate: SerializableCandidate;
  open(): Promise<DeviceConnection>;
}

interface NativeUsbDevice extends NodeUsbDevice {
  readonly busNumber: number;
  readonly portNumbers: readonly number[];
  readonly deviceDescriptor: {
    readonly idVendor: number;
    readonly idProduct: number;
    readonly bDeviceClass: number;
    readonly iProduct: number;
    readonly iSerialNumber: number;
  };
  readonly configDescriptor: (NodeUsbDevice["configDescriptor"] & {
    readonly interfaces: readonly (readonly {
      readonly bInterfaceClass: number;
      readonly bInterfaceNumber: number;
      readonly bAlternateSetting: number;
      readonly endpoints: readonly {
        readonly bEndpointAddress: number;
        readonly bmAttributes: number;
        readonly wMaxPacketSize: number;
      }[];
    }[])[];
  }) | undefined;
}

const require = createRequire(import.meta.url);
const getDeviceList = (require("usb") as {
  readonly getDeviceList: () => readonly NativeUsbDevice[];
}).getDeviceList;

export type SerialProfile = Extract<AuthoredConnectionProfile, { readonly transport: { readonly kind: "serial" } }> & {
  readonly id: string;
};
type UsbProfile = Extract<AuthoredConnectionProfile, { readonly transport: { readonly kind: "usb" } }> & {
  readonly id: string;
};

export async function listNodeAuthoredCandidates(
  profile: AuthoredConnectionProfile & { readonly id: string },
  modeId: string,
  clock: RealClock,
): Promise<SelectedAuthoredCandidate[]> {
  if (isSerialProfile(profile)) {
    if (profile.channels[0].id !== "main") {
      throw new Error("authored.acquisition.refused: Node serial supports only the main channel; use an explicit host-supplied grant");
    }
    return serialCandidates(profile, modeId, clock);
  }
  return usbCandidates(profile, modeId, clock);
}

async function serialCandidates(
  profile: SerialProfile,
  modeId: string,
  clock: RealClock,
): Promise<SelectedAuthoredCandidate[]> {
  const transport = new NodeSerialTransport({ clock });
  const ports = await listNodeSerialPorts();
  return ports.flatMap((port) => {
    if (!profile.acquisitionFilters.some((filter) => serialFilterMatches(filter, port))) return [];
    const candidateId = `serial:${port.path}` as CandidateId;
    const vendorId = parseHexId(port.vendorId);
    const productId = parseHexId(port.productId);
    const identity: PhysicalDeviceIdentity = {
      transport: "serial",
      ...(vendorId === undefined ? {} : { vendorId }),
      ...(productId === undefined ? {} : { productId }),
      ...(port.manufacturer === undefined ? {} : { manufacturerName: port.manufacturer }),
      ...(port.serialNumber === undefined ? {} : { serialNumber: port.serialNumber }),
      portPath: port.path,
      stableKeyAssurance: port.serialNumber === undefined ? "path-derived" : "serial-number",
      stableKey: port.serialNumber ?? port.path,
    };
    return [{
      candidate: {
        candidateId,
        identity,
        displayName: `${port.manufacturer ?? "USB serial"} at ${port.path}`,
        matchedProfileId: profile.id,
      },
      open: () => transport.open({
        path: port.path,
        profileId: profile.id,
        modeId,
        identity,
        line: profile.transport,
        lifecycle: profile.lifecycle,
        protocolDuplex: profile.channels[0].protocolDuplex,
      }),
    }];
  });
}

/** Explicit Node host grant. Package data never supplies this path. */
export function nodeSerialPathCandidate(
  profile: SerialProfile,
  modeId: string,
  clock: RealClock,
  path: string,
  transport: Pick<NodeSerialTransport, "open"> = new NodeSerialTransport({ clock }),
): SelectedAuthoredCandidate {
  if (profile.channels[0].id !== "main") {
    throw new Error("authored.acquisition.refused: Node serial supports only the main channel; use an explicit host-supplied grant");
  }
  const identity: PhysicalDeviceIdentity = {
    transport: "serial",
    portPath: path,
    stableKeyAssurance: "path-derived",
    stableKey: path,
  };
  return {
    candidate: {
      candidateId: `serial:${path}` as CandidateId,
      identity,
      displayName: `Operator-selected serial path ${path}`,
      matchedProfileId: profile.id,
    },
    open: () => transport.open({
      path,
      profileId: profile.id,
      modeId,
      identity,
      line: profile.transport,
      lifecycle: profile.lifecycle,
      protocolDuplex: profile.channels[0].protocolDuplex,
    }),
  };
}

function serialFilterMatches(
  filter: { readonly vendorId?: number; readonly productId?: number },
  port: { readonly vendorId?: string | undefined; readonly productId?: string | undefined },
): boolean {
  return (filter.vendorId === undefined || filter.vendorId === parseHexId(port.vendorId))
    && (filter.productId === undefined || filter.productId === parseHexId(port.productId));
}

export function isSerialProfile(
  profile: AuthoredConnectionProfile & { readonly id: string },
): profile is SerialProfile {
  return profile.transport.kind === "serial";
}

async function usbCandidates(
  profile: UsbProfile,
  modeId: string,
  clock: RealClock,
): Promise<SelectedAuthoredCandidate[]> {
  const transport = new NodeUsbTransport({ clock });
  const result: SelectedAuthoredCandidate[] = [];
  for (const device of getDeviceList()) {
    if (!profile.acquisitionFilters.some((filter) => usbFilterMatches(filter, device))) continue;
    const topology = `${device.busNumber}-${device.portNumbers.join(".")}`;
    const hostEvidence = await readNodeUsbCandidateHostEvidence(process.platform, topology);
    const { productName, serialNumber, speedEvidence, portPath } = hostEvidence;
    const candidateId = `usb:${topology}` as CandidateId;
    const identity = {
      transport: "usb",
      vendorId: device.deviceDescriptor.idVendor,
      productId: device.deviceDescriptor.idProduct,
      ...(productName === undefined ? {} : { productName }),
      ...(serialNumber === undefined ? {} : { serialNumber }),
      portPath,
      usbInterface: profile.transport.interfaceNumber,
      ...(speedEvidence.kind === "reported" ? { usbSpeed: speedEvidence.speed } : {}),
      stableKeyAssurance: serialNumber === undefined ? "path-derived" : "serial-number",
      stableKey: serialNumber ?? topology,
    } as const;
    result.push({
      candidate: {
        candidateId,
        identity,
        displayName: `${productName ?? "USB device"} ${hexId(identity.vendorId)}:${hexId(identity.productId)} at ${topology}`,
        matchedProfileId: profile.id,
      },
      open: () => transport.open({
        device,
        profileId: profile.id,
        modeId,
        identity,
        speedEvidence,
        profile: profile.transport,
        ...(profile.requiredProductName === undefined ? {} : { requiredProductName: profile.requiredProductName }),
      }),
    });
  }
  return result;
}

function usbFilterMatches(
  filter: { readonly vendorId?: number; readonly productId?: number; readonly usbClass?: number },
  device: NativeUsbDevice,
): boolean {
  const descriptor = device.deviceDescriptor;
  return (filter.vendorId === undefined || filter.vendorId === descriptor.idVendor)
    && (filter.productId === undefined || filter.productId === descriptor.idProduct)
    && (filter.usbClass === undefined || candidateUsbClasses(device).has(filter.usbClass));
}

function candidateUsbClasses(device: NativeUsbDevice): ReadonlySet<number> {
  const classes = new Set<number>();
  if (device.deviceDescriptor.bDeviceClass !== 0) classes.add(device.deviceDescriptor.bDeviceClass);
  for (const alternates of device.configDescriptor?.interfaces ?? []) {
    for (const alternate of alternates) classes.add(alternate.bInterfaceClass);
  }
  return classes;
}

function parseHexId(value: string | undefined): number | undefined {
  return value !== undefined && /^[0-9a-f]{4}$/iu.test(value) ? Number.parseInt(value, 16) : undefined;
}

function hexId(value: number): string { return value.toString(16).padStart(4, "0"); }

async function optionalSysfsText(root: string, name: string): Promise<string | undefined> {
  try { return (await readFile(`${root}/${name}`, "utf8")).trim(); } catch { return undefined; }
}

export interface NodeUsbCandidateHostEvidence {
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly portPath: string;
  readonly speedEvidence: UsbNegotiatedSpeedEvidence;
}

export async function readNodeUsbCandidateHostEvidence(
  hostPlatform: NodeJS.Platform,
  topology: string,
  readSysfsText: typeof optionalSysfsText = optionalSysfsText,
): Promise<NodeUsbCandidateHostEvidence> {
  if (hostPlatform !== "linux") {
    return { portPath: `usb:${topology}`, speedEvidence: { kind: "unreported" } };
  }
  const sysfsRoot = `/sys/bus/usb/devices/${topology}`;
  const [productName, speedText, serialNumber] = await Promise.all([
    readSysfsText(sysfsRoot, "product"),
    readSysfsText(sysfsRoot, "speed"),
    readSysfsText(sysfsRoot, "serial"),
  ]);
  return {
    ...(productName === undefined ? {} : { productName }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    portPath: sysfsRoot,
    speedEvidence: usbSpeedEvidenceFromSysfs(speedText),
  };
}

export function usbSpeedEvidenceFromSysfs(value: string | undefined): UsbNegotiatedSpeedEvidence {
  switch (value) {
    case undefined: return { kind: "unreported" };
    case "12": return { kind: "reported", speed: "full" };
    case "480": return { kind: "reported", speed: "high" };
    default: throw new Error(`USB candidate speed ${JSON.stringify(value)} from sysfs is unsupported`);
  }
}
