// SPDX-License-Identifier: AGPL-3.0-only
// Local extension; its copyright is not assigned to Signal Messenger.
/* oxlint-disable signal-desktop/enforce-license-comments */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { Proto } from '@signalapp/mock-server';
import { renderPanel, tamperEnvelope } from './local-attack-lab.node.ts';

void test('tampering changes only ciphertext and leaves the original reusable', () => {
  const envelope = {
    ...Proto.Envelope.decode(Buffer.alloc(0)),
    type: Proto.Envelope.Type.DOUBLE_RATCHET,
    sourceDeviceId: 1,
    clientTimestamp: 123456n,
    serverTimestamp: 123457n,
    content: Buffer.from([10, 20, 30, 40]),
  };
  const original = Buffer.from(Proto.Envelope.encode(envelope));
  const snapshot = Buffer.from(original);
  const modified = Proto.Envelope.decode(tamperEnvelope(original));
  assert.deepEqual(original, snapshot);
  assert.deepEqual(
    Buffer.from(modified.content ?? []),
    Buffer.from([10, 20, 30, 41])
  );
  assert.deepEqual(
    { ...modified, content: null },
    { ...Proto.Envelope.decode(original), content: null }
  );
});

void test('missing ciphertext is rejected without emitting a corrupt envelope', () => {
  const empty = Buffer.from(
    Proto.Envelope.encode(Proto.Envelope.decode(Buffer.alloc(0)))
  );
  assert.throws(() => tamperEnvelope(empty), /暗号文がありません/);
});

void test('the delivered HTML contains syntactically valid browser JavaScript', () => {
  const html = renderPanel('a'.repeat(48));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'the panel must include its button handlers');
  assert.doesNotThrow(() => new Script(script));
});
