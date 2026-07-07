// SHA-1 piece verifier worker.
// Receives { id, data, expected } messages, replies with { id, ok }.
// Runs the SHA-1 hash off the main thread so high-throughput downloads don't
// block I/O event handling and the swarm choke/keepalive timers.

import { createHash } from 'node:crypto';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('piece-verifier.worker must be run as a worker_thread');
}

parentPort.on('message', (msg: { id: number; data: Buffer; expected: Buffer }) => {
  const hash = createHash('sha1').update(msg.data).digest();
  parentPort!.postMessage({ id: msg.id, ok: hash.equals(msg.expected) });
});
