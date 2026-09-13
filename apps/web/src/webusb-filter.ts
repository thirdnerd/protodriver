export interface WebUsbFilter {
  readonly vendorId?: number | null;
  readonly productId?: number | null;
  readonly usbClass?: number | null;
}

export interface WebUsbFilterDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceClass: number;
  readonly configurations?: readonly {
    readonly interfaces: readonly {
      readonly alternates: readonly { readonly interfaceClass: number }[];
    }[];
  }[];
}

/** Match WebUSB's device-level or per-interface class semantics after a grant. */
export function usbFilterMatches(filter: WebUsbFilter, device: WebUsbFilterDevice): boolean {
  return matchesOptional(filter.vendorId, device.vendorId)
    && matchesOptional(filter.productId, device.productId)
    && (filter.usbClass === null
      || filter.usbClass === undefined
      || usbClasses(device).has(filter.usbClass));
}

export function usbClasses(device: WebUsbFilterDevice): ReadonlySet<number> {
  const result = new Set<number>();
  if (device.deviceClass !== 0) result.add(device.deviceClass);
  for (const configuration of device.configurations ?? []) {
    for (const usbInterface of configuration.interfaces) {
      for (const alternate of usbInterface.alternates) result.add(alternate.interfaceClass);
    }
  }
  return result;
}

function matchesOptional(expected: number | null | undefined, actual: number): boolean {
  return expected === null || expected === undefined || expected === actual;
}
