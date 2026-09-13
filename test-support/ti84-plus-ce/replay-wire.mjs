import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export async function retainedWire() {
  const directory = new URL("../fixtures/ti84-ce-blue-oracle/", import.meta.url);
  const fixture = JSON.parse(await readFile(new URL("fixture.json", directory), "utf8"));
  const artifact = fixture.artifacts.wireCapture;
  const pcap = await readFile(new URL(artifact.file, directory));
  assert.equal(pcap.length, artifact.lengthBytes); assert.equal(sha256(pcap), artifact.sha256);
  assert.equal(pcap.subarray(0,4).toString("hex"), "d4c3b2a1"); assert.equal(pcap.readUInt32LE(20), 220);
  const chunks = []; let records = 0;
  for (let offset = 24; offset < pcap.length; records++) {
    assert.ok(offset + 16 <= pcap.length);
    const size = pcap.readUInt32LE(offset+8); assert.equal(size, pcap.readUInt32LE(offset+12)); offset += 16;
    assert.ok(size >= 64 && offset+size <= pcap.length);
    const packet = pcap.subarray(offset, offset+size); offset += size;
    assert.equal(packet.length, 64+packet.readUInt32LE(36));
    const s = fixture.selection;
    if (packet.readUInt16LE(12) === s.bus && packet[11] === s.deviceAddress && packet[8] === s.event
      && packet[9] === s.transferType && packet[10] === s.endpointAddress && packet.length > 64) chunks.push(packet.subarray(64));
  }
  assert.equal(records, fixture.expected.pcapRecords); assert.equal(chunks.length, fixture.expected.inboundTransfers);
  const wire = Buffer.concat(chunks);
  assert.equal(wire.length, fixture.expected.responseBytes); assert.equal(sha256(wire), fixture.expected.responseSha256);
  const frames = [];
  for (let offset = 0; offset < wire.length;) {
    const size = wire.readUInt32BE(offset)+5;
    assert.ok(size <= 1028 && offset+size <= wire.length);
    frames.push(wire.subarray(offset,offset+size)); offset += size;
  }
  assert.equal(frames.length, 155);
  return { fixture, wire, frames };
}

// Decode the *candidate* BMP independently, comparing its RGB pixels to the
// retained wire framebuffer, not to a BMP made by either product path.
export function compareImage(bmp, frames, fixture) {
  const logical = Buffer.concat(frames.slice(4).map(frame => frame.subarray(5)));
  const screen = logical.subarray(13);
  assert.equal(screen.length, fixture.expected.screenBytes); assert.equal(sha256(screen), fixture.expected.screenSha256);
  assert.equal(bmp.toString("ascii",0,2), "BM"); assert.equal(bmp.readUInt32LE(2), bmp.length);
  assert.equal(bmp.readUInt32LE(14), 40); assert.equal(bmp.readInt32LE(18), 320); assert.equal(bmp.readInt32LE(22), -240);
  assert.equal(bmp.readUInt16LE(26), 1); assert.equal(bmp.readUInt16LE(28), 16); assert.equal(bmp.readUInt32LE(30), 3);
  const offset = bmp.readUInt32LE(10), masks = [54,58,62].map(at => bmp.readUInt32LE(at));
  assert.equal(offset,66); assert.equal(bmp.length-offset,screen.length);
  function components(value, masks) {
    return masks.map(mask => { let shift=0; while (((mask>>>shift)&1)===0 && shift<32) shift++;
      assert.ok(shift<32); const maximum=mask>>>shift; return Math.round(((value&mask)>>>shift)*255/maximum); });
  }
  let pureBluePixels=0, pureRedPixels=0, differingPixels=0;
  for (let i=0;i<screen.length;i+=2) {
    const actual=components(bmp.readUInt16LE(offset+i),masks), expected=components(screen.readUInt16LE(i),[0xf800,0x07e0,0x001f]);
    if (actual.join(",")!==expected.join(",")) differingPixels++;
    if (actual.join(",")==="0,0,255") pureBluePixels++;
    if (actual.join(",")==="255,0,0") pureRedPixels++;
  }
  assert.deepEqual({pureBluePixels,pureRedPixels,differingPixels}, {pureBluePixels:fixture.expected.pureBluePixels,pureRedPixels:fixture.expected.pureRedPixels,differingPixels:0});
  return {width:320,height:240,pureBluePixels,pureRedPixels,differingPixels,sha256:sha256(bmp)};
}
