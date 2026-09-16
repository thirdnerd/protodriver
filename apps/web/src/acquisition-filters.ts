interface AcquisitionFilter {
  readonly vendorId?: number;
  readonly productId?: number;
  readonly usbClass?: number;
}

export interface SerialChooserOptions {
  readonly filters?: readonly {
    readonly usbVendorId?: number;
    readonly usbProductId?: number;
  }[];
}

export interface UsbChooserOptions {
  readonly filters: readonly {
    readonly vendorId?: number;
    readonly productId?: number;
    readonly classCode?: number;
  }[];
}

/** A property-less alternative admits every serial port, which Web Serial
 * represents by omitting the filters member entirely. */
export function serialChooserFilters(filters: readonly AcquisitionFilter[]): SerialChooserOptions {
  if (filters.some(filter => filter.vendorId === undefined && filter.productId === undefined)) return {};
  return { filters: filters.map(filter => ({
    ...(filter.vendorId === undefined ? {} : { usbVendorId: filter.vendorId }),
    ...(filter.productId === undefined ? {} : { usbProductId: filter.productId }),
  })) };
}

/** A property-less alternative admits every USB device, which WebUSB
 * represents with an empty filters array. A class-only filter remains
 * specific and legal. */
export function usbChooserFilters(filters: readonly AcquisitionFilter[]): UsbChooserOptions {
  if (filters.some(filter => filter.vendorId === undefined
    && filter.productId === undefined
    && filter.usbClass === undefined)) return { filters: [] };
  return { filters: filters.map(filter => ({
    ...(filter.vendorId === undefined ? {} : { vendorId: filter.vendorId }),
    ...(filter.productId === undefined ? {} : { productId: filter.productId }),
    ...(filter.usbClass === undefined ? {} : { classCode: filter.usbClass }),
  })) };
}
