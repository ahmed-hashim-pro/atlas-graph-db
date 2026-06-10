import { describe, expect, it } from 'vitest';
import { WriteQueue } from '../src/write-queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WriteQueue', () => {
  it('serializes concurrent tasks in submission order', async () => {
    const q = new WriteQueue();
    const order: number[] = [];
    await Promise.all([
      q.run(async () => {
        await sleep(20);
        order.push(1);
      }),
      q.run(async () => {
        order.push(2);
      }),
      q.run(() => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates errors without poisoning the queue', async () => {
    const q = new WriteQueue();
    await expect(q.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(q.run(() => 42)).resolves.toBe(42);
  });
});
