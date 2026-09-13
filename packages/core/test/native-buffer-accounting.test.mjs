import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeHelperData } from '../src/native-helper.ts';
import { CanonicalSizeAccounting } from '../src/limits.ts';

test('buffer reservation has exact canonical capacity without repeated metadata encoding', t => {
  const sizes = new CanonicalSizeAccounting();
  const overhead = 8 + sizes.rpcMessageBytes({ id: 1, capacity: 0, usedLength: 0 });
  assert.equal(overhead, 84);
  let encodedUnits = 0;
  const encode = TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype, 'encode', function(value = '') {
    encodedUnits += value.length;
    return encode.call(this, value);
  });
  for (const capacity of [0, 1, 256, 65536, Number.MAX_SAFE_INTEGER - overhead - 8]) {
    const data = new NativeHelperData(8 + overhead + capacity);
    for (let i = 0; i < 32; i++) {
      const held = data.reserve(capacity, i % 2 ? 0 : capacity);
      assert.throws(() => data.reserve(0), e => e.error?.code === 'retained.helper-data-exhausted');
      held.release(); held.release();
    }
    assert.throws(() => new NativeHelperData(8 + overhead + capacity - 1).reserve(capacity),
      e => e.error?.code === 'retained.helper-data-exhausted');
  }
  // Work-population bound, not elapsed time: a fixed record may be encoded
  // once, but its text work cannot grow with reservations or their capacities.
  assert.ok(encodedUnits <= 20, `fixed metadata encoded ${encodedUnits} UTF-16 units`);
  // Arbitrary frame contents still pay their actual size, including UTF-8.
  const frame = { text: 'é😀' };
  const bytes = sizes.rpcMessageBytes(frame);
  const data = new NativeHelperData(8 + bytes);
  const held = data.frame(frame);
  assert.throws(() => data.frame({}), e => e.error?.code === 'retained.helper-data-exhausted');
  held.release();
  assert.throws(() => new NativeHelperData(7 + bytes).frame(frame),
    e => e.error?.code === 'retained.helper-data-exhausted');
  assert.ok(encodedUnits > 20, 'dynamic frame content must still be measured');
});
