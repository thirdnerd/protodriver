import type { AuthoredOperation, DeviceSessionClient, HostByteSink, OperationArgument, ResourceId } from "@protodriver/contracts";
import { requireAuthoredOutput } from "@protodriver/control-model";

/** Browser-owned bounded destination. No Blob, picker or DOM object crosses RPC. */
export async function collectAuthoredOutput(client: DeviceSessionClient, operation: AuthoredOperation,
  args: Readonly<Record<string, OperationArgument>>, register: (sink: HostByteSink) => Promise<ResourceId>,
  observe: { readonly accepted?: (operationId: import("@protodriver/contracts").OperationId) => void } = {}) {
  const model = operation.result;
  if (model.kind !== "file" && model.kind !== "resource") throw new Error("operation has no declared resource result");
  const chunks: Uint8Array[] = []; let bytes = 0, closed = false;
  const id = await register({ async write(data) {
    if (closed || bytes + data.length > model.maximumBytes) throw new Error("output sink bound exceeded");
    chunks.push(new Uint8Array(data)); bytes += data.length;
  }, async close() { closed = true; } });
  const handle = await client.startOperation({ operation: operation.id, arguments: args, resultDestinationId: id });
  observe.accepted?.(handle.operationId);
  const outcome = await client.awaitOperation(handle.operationId);
  await client.acknowledgeOperation(handle.operationId);
  requireAuthoredOutput(model, outcome, id, bytes);
  if (!closed) throw new Error("output receipt preceded sink close");
  const blob = new Blob(chunks, { type: model.mediaType });
  return { outcome, blob, download(documentApi: Pick<Document, "createElement"> = document, urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL) {
    const url = urls.createObjectURL(blob);
    try { const anchor = documentApi.createElement("a"); anchor.href = url;
      anchor.download = "protodriver-result." + (model.suggestedExtension ?? "bin"); anchor.click(); }
    finally { urls.revokeObjectURL(url); }
  } };
}
