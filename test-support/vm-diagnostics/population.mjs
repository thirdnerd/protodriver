export const cases = ["fuel", "allocation", "named", "program", "host"];
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export async function runCase(client, kind) {
  await client.attach("vm-diagnostics"); await client.connect({mode:"main"});
  const op = await client.startOperation({operation:"run",arguments:{case:{kind:"value",value:kind}}});
  const result = await client.awaitOperation(op.operationId);
  equal(result.outcome,"failed",kind+" outcome"); equal(result.result,null,kind+" no success after refusal");
  const codes = {fuel:"lua-vm.resource.fuel-exhausted",allocation:"lua-vm.resource.allocation-limit",
    named:"lua-vm.invocation.program-failure",program:"lua-vm.environment.program",host:"retained.execution-failed"};
  equal(result.error.code,codes[kind],kind+" diagnostic mapping");
  equal(result.error.retryability,["fuel","allocation"].includes(kind)?"no":"unknown",kind+" retryability");
  if (["fuel","allocation","program"].includes(kind)) {
    const details=result.error.details;
    equal(details?.phase,"dispatch",kind+" phase");
    equal(details?.vmStatus,{fuel:-18,allocation:-17,program:-7}[kind],kind+" status");
    if (!Number.isSafeInteger(details.fuelConsumed)||details.fuelConsumed<=0) throw new Error(kind+" measured fuel missing");
    if (kind==="fuel") equal(details.fuelConsumed,1000000,"D5 execution fuel consumed");
    // A fresh public request cannot make the terminated VM usable again.
    let refusal;
    try { await client.startOperation({operation:"run",arguments:{case:{kind:"value",value:"named"}}}); }
    catch (cause) { refusal=cause.error?.code; }
    equal(refusal,"retained.not-connected",kind+" sticky termination before another operation is admitted");
  }
  if (kind==="named") equal(result.error.details,{name:"fuel-exhausted",details:{origin:"author"}},"authored named failure distinct");
  if (kind==="host") equal(result.error.details,undefined,"host prose not VM evidence");
  return {case:kind,code:result.error.code,retryability:result.error.retryability,details:result.error.details??null};
}
