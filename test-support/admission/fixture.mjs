import { RealClock } from "../../packages/core/src/clock.ts";
import { MockTransport } from "../../packages/transport-mock/src/index.ts";

// Only the granted native acquisition is a fixture. Source admission, binding,
// VM, execution, result validation, capture and all three RPC services are product.
export function nativeOptions(observe) {
  const clock = new RealClock();
  return { clock, modeId: "main", profileId: "serial", channelId: "main", helpers: {},
    usbControl: { available: false, limitation: "serial transport" },
    async open() {
      observe({ kind: "native-open" });
      const connection = new MockTransport(clock).openConnection({ identity: { transport: "mock", stableKeyAssurance: "none" }, modeId: "main", profileId: "serial" });
      connection.control = async request => { observe({ kind: "native-control", request }); return { settled: "completed", atSequence: clock.nextSequence() }; };
      const channel = connection.channel("main"), acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), write = lease.write.bind(lease);
        lease.write = async bytes => { observe({ kind: "write", value: new TextDecoder().decode(bytes) }); return write(bytes); };
        return lease;
      };
      return connection;
    },
  };
}
