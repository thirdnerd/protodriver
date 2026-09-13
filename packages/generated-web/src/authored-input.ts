import type { AuthoredOperation, HostByteSource, ResourceId } from "@protodriver/contracts";

/** Host-local File snapshot. Neither File nor source methods enter RPC. */
export class AuthoredFileByteSource implements HostByteSource {
  readonly origin = "file" as const;
  readonly byteLength: number;
  readonly #file: File;
  #offset = 0;
  #closed = false;
  constructor(file: File) { this.#file = file; this.byteLength = file.size; }
  async read(into: Uint8Array) {
    if (this.#closed) throw new Error("file source is closed");
    const bytes = new Uint8Array(await this.#file.slice(this.#offset, this.#offset + into.length).arrayBuffer());
    into.set(bytes); this.#offset += bytes.length;
    return { bytesRead: bytes.length, eof: this.#offset === this.byteLength };
  }
  async seek(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.byteLength) throw new RangeError("file origin out of range");
    this.#offset = offset;
  }
  async close() { this.#closed = true; }
}
export async function registerAuthoredFileArgument(operation: AuthoredOperation, name: string, file: File,
  register: (source: HostByteSource) => Promise<ResourceId>) {
  if (!["byte-source", "stream-source"].includes(operation.arguments[name]?.kind ?? "")) throw new Error("argument is not a declared file source: " + name);
  const source = new AuthoredFileByteSource(file);
  try { return { argument: { kind: "resource" as const, id: await register(source) }, close: () => source.close() }; }
  catch (cause) { await source.close(); throw cause; }
}
