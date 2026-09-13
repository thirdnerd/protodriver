import { VirtualClock } from "../clock.ts";
import { MockTransport } from "../../packages/transport-mock/src/index.ts";

// Entry replies and silent OK are specified by device-2-protocol sections 4/10,
// not retained hardware evidence. The interactive exchange is supplied from
// the digest-checked retained excerpt. Never derive a reply from a Lua output.
export function exchanges(mode, retained) {
  const bytes = value => [...new TextEncoder().encode(value)];
  const identity = "D2-LABS,D2-MON,1234ABCD,1.0\r\n";
  return mode === "interactive" ? [
    { tx: bytes("\r\n"), rx: [bytes("\r\nOK\r\n")] },
    { tx: bytes("*IDN?\r\n"), rx: [bytes("*IDN?\r\n" + identity)] }, retained,
  ] : [
    { tx: bytes("*IDN?\r\n"), rx: [bytes(identity)] },
    { tx: bytes("CONF:RATE 100\r\n"), rx: [bytes("OK\r\n")] },
  ];
}
export function nativeOptions(modeId, profileId, stimulus, observe = () => {}) {
  const clock = new VirtualClock(); let index = 0;
  return { clock, modeId, profileId, channelId: "main", helpers: {},
    async open() {
      observe({ kind: "native-open" });
      const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId, profileId });
      const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), write = lease.write.bind(lease);
        lease.write = async bytes => {
          observe({ kind: "write", bytes: [...bytes] });
          const expected = stimulus[index++];
          if (!expected || JSON.stringify([...bytes]) !== JSON.stringify(expected.tx)) throw new Error("write disagrees with independent stimulus at exchange " + index);
          const receipt = await write(bytes);
          for (const range of expected.rx) channel.enqueueReceived(Uint8Array.from(range));
          return receipt;
        };
        return lease;
      };
      return connection;
    },
  };
}
