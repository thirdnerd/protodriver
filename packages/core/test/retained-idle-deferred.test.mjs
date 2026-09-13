import assert from 'node:assert/strict';
import test from 'node:test';
import { RetainedSessionRpcServer } from '../src/retained-session.ts';
import { RetainedMailbox } from '../src/retained-mailbox.ts';
import { DeviceSessionRpcClient, DirectSessionRpcAdapter } from '../src/rpc.ts';
import { VirtualClock } from '../../../test-support/clock.ts';
import { MockTransport } from '../../transport-mock/src/index.ts';

async function fixture(t, options = {}) {
  const clock = new VirtualClock(), converted = [], observed = [];
  let channel, failConversion = false;
  const server = new RetainedSessionRpcServer({ platform:'node', clock,
    logicalDevice:'idle', modeId:'m', profileId:'p', channelId:'main', operations:['one','three','fill'],
    helpers:{}, resourceBroker:{}, captureDestinationAdapter:{},
    ...options,
    execution:{ async register(){}, async retire(){}, async close(){}, async dispatch(id, input) {
      const [kind,,operation] = input.split('|');
      return {consumed:1,value:kind === 'start' ? operation === 'fill' ? {kind:'wait-fill',count:2,timers:[]}
        : {kind:'read',maximum:operation === 'one' ? 1 : 3}
        : {kind:'result',value:input.slice(input.indexOf('|',input.indexOf('|')+1)+1)}};
    } },
    async open() {
      const connection = new MockTransport(clock).openConnection({identity:{transport:'mock',stableKeyAssurance:'none'},modeId:'m',profileId:'p'});
      channel = connection.channel('main'); const acquire = channel.acquire.bind(channel);
      channel.acquire = async (...args) => {
        const lease = await acquire(...args), incoming = lease.incoming.bind(lease);
        lease.incoming = async function*() {
          for await (const chunk of incoming()) {
            const slice = chunk.bytes.subarray.bind(chunk.bytes);
            chunk.bytes.subarray = (...args) => {
              if (failConversion) throw new Error('controlled conversion refusal');
              converted.push([...slice(...args)]); return slice(...args);
            };
            yield chunk;
            observed.shift()?.resolve();
          }
        };
        return lease;
      };
      return connection;
    },
  });
  const client = new DeviceSessionRpcClient(new DirectSessionRpcAdapter(server));
  t.after(async()=>{await client.disconnect();await client.close();});
  await client.attach('D3');
  const sub = client.subscribe(event => {
    if (event.kind === 'connection-close') for (const gate of observed.splice(0)) gate.reject(new Error(JSON.stringify(event)));
  });
  t.after(()=>sub.dispose());
  await client.connect({mode:'m'});
  return {client,converted,setFailure(value){failConversion=value;},
    async inject(value) { const gate=Promise.withResolvers(); observed.push(gate); channel.enqueueReceived(Buffer.from(value)); await gate.promise; },
    async read(operation='three') { const {operationId}=await client.startOperation({operation,arguments:{}});
      const result=await client.awaitOperation(operationId); await client.acknowledgeOperation(operationId); return result; },
  };
}
test('D3 does not inspect idle payloads; separate native ranges retain their order', {timeout:5000}, async t => {
  const h=await fixture(t); await h.inject('a'); await h.inject('bc');
  assert.deepEqual(h.converted,[]);
  assert.equal((await h.read()).result,'a');
  assert.equal((await h.read()).result,'bc');
  assert.deepEqual(h.converted,[[97],[98,99]]);
});
test('D3 converted prefix precedes an idle raw tail', {timeout:5000}, async t => {
  const h=await fixture(t); await h.inject('abc');
  assert.equal((await h.read('one')).result,'a');
  await h.inject('de'); assert.deepEqual(h.converted,[[97,98,99]]);
  assert.equal((await h.read()).result,'bc');
  assert.equal((await h.read()).result,'de');
});
test('ingress capacity tracks the actual remaining text after consumption and later append', {timeout:5000}, async t => {
  const reserve = RetainedMailbox.prototype.reserveInput;
  RetainedMailbox.prototype.reserveInput = function(value,ranges,bytes,fill) {
    assert.equal(bytes,new TextEncoder().encode(value).length,'capacity must follow remaining bytes, not historical arrivals');
    return reserve.call(this,value,ranges,bytes,fill);
  };
  t.after(()=>{RetainedMailbox.prototype.reserveInput=reserve;});
  const h=await fixture(t);await h.inject('abc');assert.equal((await h.read('one')).result,'a');
  await h.inject('de');assert.equal((await h.read()).result,'bc');assert.equal((await h.read()).result,'de');
  await h.inject('f');assert.equal((await h.read()).result,'f');
  await h.inject('xy');assert.equal((await h.read('fill')).result,'receive:xy');
  await h.inject('zz');assert.equal((await h.read('fill')).result,'receive:zz');
});
test('D3 conversion refusal does not consume the retained range', {timeout:5000}, async t => {
  const h=await fixture(t); await h.inject('abc'); h.setFailure(true);
  assert.equal((await h.read()).outcome,'failed'); assert.deepEqual(h.converted,[]);
  h.setFailure(false); assert.equal((await h.read()).result,'abc');
});
test('D3 raw capacity shares the existing byte and item bounds and releases on clear', () => {
  const m=new RetainedMailbox(), limit=16*1024*1024;
  assert.equal(m.reserve('existing',new Uint8Array(1024),0),true);
  const available=limit-m.reservedBytes-128;
  assert.equal(m.retainRaw(available,0),true);
  assert.equal(m.retainRaw(0,0),false);
  m.releaseRaw(available); assert.equal(m.retainRaw(available,0),true);
  m.clear(); assert.equal(m.reservedBytes,8); assert.equal(m.reservedItems,0);
  for(let i=0;i<1024;i++) assert.equal(m.retainRaw(0,0),true);
  assert.equal(m.retainRaw(0,0),false);
});
test('D3 counts the retained backing store, not only a short view', () => {
  const m=new RetainedMailbox(), view=new Uint8Array(8*1024*1024).subarray(0,1);
  assert.equal(m.retainRaw(view.buffer.byteLength,0),true);
  assert.equal(m.retainRaw(view.buffer.byteLength,0),false);
});
test('D3 retained input conversion spends the consuming operation, not an idle grant', {timeout:5000}, async t => {
  const payload = 'abc' + 'x'.repeat(256 * 1024 - 3);
  const funded = await fixture(t, { maximumEffectWork: 20000 });
  await funded.inject(payload); assert.deepEqual(funded.converted, []);
  assert.equal((await funded.read()).result, 'abc');
  const exhausted = await fixture(t, { maximumEffectWork: 5000 });
  await exhausted.inject(payload); assert.deepEqual(exhausted.converted, []);
  const result = await exhausted.read();
  assert.equal(result.error?.code, 'retained.work-exhausted');
  assert.equal(result.result, null);
  assert.ok(exhausted.converted.length > 0, 'must reach conversion, not refuse at operation preparation');
  assert.ok(exhausted.converted.length < 1024, 'must refuse before completing the native conversion');
});
