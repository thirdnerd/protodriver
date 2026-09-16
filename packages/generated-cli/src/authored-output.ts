import type { AuthoredOperation, DeviceSessionClient, HostByteSink, OperationArgument, OperationResult, ResourceId } from "@protodriver/contracts";
import { requireAuthoredOutput } from "@protodriver/control-model";
import { open } from "node:fs/promises";

export interface SavedAuthoredOutput {
  readonly outcome: OperationResult;
  readonly path: string;
  readonly byteLength: number;
}

/** Owning-side save: path never enters the session wire or Lua arguments. */
export async function saveAuthoredOutput(client: DeviceSessionClient, operation: AuthoredOperation,
  args: Readonly<Record<string, OperationArgument>>, path: string,
  register: (sink: HostByteSink) => Promise<ResourceId>): Promise<SavedAuthoredOutput> {
  const model = operation.result;
  if (model.kind !== "file" && model.kind !== "resource") throw new Error("operation has no declared resource result");
  if (model.kind === "file" && !path.endsWith("." + model.suggestedExtension)) throw new Error("save path does not match declared file extension");
  const file = await open(path, "wx", 0o600);
  let bytes = 0, closed = false;
  const sink: HostByteSink = { async write(data) {
    if (closed || bytes + data.length > model.maximumBytes) throw new Error("output sink bound exceeded");
    await file.writeFile(data); bytes += data.length;
  }, async close() { if (!closed) { closed = true; await file.close(); } } };
  try {
    const id = await register(sink);
    const handle = await client.startOperation({ operation: operation.id, arguments: args, resultDestinationId: id });
    const outcome = await client.awaitOperation(handle.operationId);
    await client.acknowledgeOperation(handle.operationId);
    requireAuthoredOutput(model, outcome, id, bytes);
    if (!closed) throw new Error("output receipt preceded sink close");
    return { outcome, path, byteLength: bytes };
  } finally { await sink.close(); }
}
