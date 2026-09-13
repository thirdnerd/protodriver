// Implements PROTOCOL.md independently of the Lua source. Host fault modes
// perturb replies after this parser has handled a request; no corpus/module
// source or constants are imported here.
const encoder = new TextEncoder();
const decoder = new TextDecoder("ascii", { fatal: true });

export class DemoThermostatSimulator {
  #sequence = 0;
  #temperature = 2150;
  #target = 2200;
  scenario;

  constructor(scenario = "normal") {
    this.scenario = scenario;
  }

  answer(bytes) {
    const request = decoder.decode(bytes);
    if (!request.endsWith("\r") || request.indexOf("\r") !== request.length - 1) return [];
    const command = request.slice(0, -1);
    let reply;
    if (command === "ID?") {
      reply = this.scenario === "wrong-identity"
        ? "ID OTHER-THERMOSTAT 1" : "ID DEMOBENCH-THERMOSTAT 1";
    } else if (command === "STATUS?") {
      this.#sequence = this.#sequence === 2147483647 ? 1 : this.#sequence + 1;
      reply = `STATUS ${this.#sequence} ${this.#temperature} ${this.#target} ${this.#temperature < this.#target ? "on" : "off"}`;
      if (this.scenario === "malformed") reply = "STATUS 01 2150 bad on";
      if (this.scenario === "silent") return [];
      if (this.scenario === "overlong") reply = "STATUS " + "9".repeat(65);
    } else {
      const set = /^SET (0|[1-9][0-9]*)$/.exec(command);
      if (!set) return [];
      const value = Number(set[1]);
      if (!Number.isSafeInteger(value) || value < 500 || value > 3500) reply = "ERR RANGE";
      else if (this.scenario === "unexpected-range-refusal") reply = "ERR RANGE";
      else { this.#target = value; reply = `SET-OK ${value}`; }
    }
    const data = encoder.encode(`${reply}\r`);
    return this.scenario === "fragmented"
      ? [...data].map((byte) => Uint8Array.of(byte))
      : [data];
  }
}
