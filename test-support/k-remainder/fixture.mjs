import { VirtualClock } from "../clock.ts";
import { MockTransport } from "../../packages/transport-mock/src/index.ts";

export function nativeOptions(observe = () => {}) {
  const clock = new VirtualClock();
  return { clock, modeId: "main", profileId: "serial", channelId: "main", helpers: {},
    async open() {
      observe({ kind: "native-open" });
      const c = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
      const channel = c.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), write = lease.write.bind(lease);
        lease.write = async bytes => {
          const value = new TextDecoder().decode(bytes); observe({ kind: "write", value });
          if (value === "ADVANCE") await clock.advance(11000);
          if (value === "ADVANCE-DAY") await clock.advance(2 * 86400000 * 1000);
          return write(bytes);
        };
        return lease;
      };
      return c;
    } };
}
