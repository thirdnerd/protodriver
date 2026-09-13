export function splitEvoCollectedFrames(wire) {
  const frames = [];
  for (let offset = 0; offset < wire.byteLength;) {
    if (wire[offset] !== 0x01) throw new Error(`Evo fixture frame at ${offset} has no SOH`);
    const lengthOctet = wire[offset + 1];
    let frameLength;
    if (lengthOctet === 0x20) {
      const high = wire[offset + 4];
      const low = wire[offset + 5];
      if (high === undefined || low === undefined) throw new Error(`Evo fixture long frame at ${offset} is truncated`);
      frameLength = (high - 0x20) * 95 + (low - 0x20) + 8;
    } else if (lengthOctet !== undefined && lengthOctet >= 0x23) {
      frameLength = lengthOctet - 0x23 + 6;
    } else {
      throw new Error(`Evo fixture frame at ${offset} has reserved length ${String(lengthOctet)}`);
    }
    const end = offset + frameLength;
    if (end > wire.byteLength) throw new Error(`Evo fixture frame at ${offset} exceeds retained input`);
    if (wire[end - 1] !== 0x0d) throw new Error(`Evo fixture frame at ${offset} has no CR terminator`);
    frames.push(Uint8Array.from(wire.subarray(offset, end)));
    offset = end;
  }
  if (frames.length === 0) throw new Error("Evo collected-frame fixture is empty");
  return Object.freeze(frames);
}

export function summarizeEvoCollectedFrames(frames) {
  const lengths = frames.map((frame) => frame.byteLength);
  return Object.freeze({
    count: frames.length,
    framedBytes: lengths.reduce((total, length) => total + length, 0),
    minimumFrameBytes: Math.min(...lengths),
    maximumFrameBytes: Math.max(...lengths),
    commands: frames.map((frame) => String.fromCharCode(frame[3])).join(""),
  });
}
