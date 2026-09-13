import { createRequire } from "node:module";

import { SerialPort } from "serialport";
import { smokeSerialExclusionNative } from "@protodriver/transport-node-serial";

const require = createRequire(import.meta.url);
const usb = require("usb") as {
  readonly getDeviceList: () => readonly unknown[];
};

const serialPorts = await SerialPort.list();
const usbDevices = usb.getDeviceList();
const ioctl = smokeSerialExclusionNative();
if (ioctl.required && (!ioctl.loaded || ioctl.invocation !== "native-error")) {
  throw new Error(`ioctl smoke did not reach the native error boundary: ${JSON.stringify(ioctl)}`);
}
if (!ioctl.required && process.platform !== "win32") {
  throw new Error(`POSIX platform unexpectedly waived ioctl: ${JSON.stringify(ioctl)}`);
}

process.stdout.write(`${JSON.stringify({
  serialport: { loaded: true, enumerated: serialPorts.length },
  usb: { loaded: true, enumerated: usbDevices.length },
  ioctl,
})}\n`);
