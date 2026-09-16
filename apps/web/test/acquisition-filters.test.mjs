import assert from "node:assert/strict";
import test from "node:test";
import { serialChooserFilters, usbChooserFilters } from "../src/acquisition-filters.ts";

// An acquisition filter list is a disjunction: a candidate matching any member is
// acceptable. A member carrying no constrainable property therefore means "anything
// is acceptable", and the chooser must be given no filters at all rather than an
// empty filter object, which Web Serial and WebUSB both reject as malformed.

test("serial keeps specific filters and maps only the ids the platform names", () => {
  assert.deepEqual(serialChooserFilters([{transport:"serial",vendorId:0x1234}]),
    {filters:[{usbVendorId:0x1234}]});
  assert.deepEqual(serialChooserFilters([{transport:"serial",vendorId:0x1234,productId:0x5678}]),
    {filters:[{usbVendorId:0x1234,usbProductId:0x5678}]});
});

test("a property-less serial filter offers every port instead of sending an empty filter", () => {
  const options = serialChooserFilters([{transport:"serial"}]);
  assert.equal(Object.hasOwn(options,"filters"), false, "omit filters entirely; an empty filter object is malformed");
});

test("a broad serial filter beside a narrow one still offers every port", () => {
  const options = serialChooserFilters([{transport:"serial"},{transport:"serial",vendorId:0x1234}]);
  assert.equal(Object.hasOwn(options,"filters"), false, "dropping the broad member would narrow a declaration that accepts anything");
});

test("usb keeps a class-only filter, which is legal and specific", () => {
  assert.deepEqual(usbChooserFilters([{transport:"usb",usbClass:0xff}]),
    {filters:[{classCode:0xff}]});
  assert.deepEqual(usbChooserFilters([{transport:"usb",vendorId:0x1234,usbClass:0xff}]),
    {filters:[{vendorId:0x1234,classCode:0xff}]});
});

test("a property-less usb filter offers every device, alone or beside a narrow one", () => {
  assert.deepEqual(usbChooserFilters([{transport:"usb"}]), {filters:[]});
  assert.deepEqual(usbChooserFilters([{transport:"usb"},{transport:"usb",vendorId:0x1234}]), {filters:[]});
});
