import { AsyncQueue } from '../src/utils/asyncQueue';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('AsyncQueue', () => {
  it('runs tasks strictly one at a time, in order', async () => {
    const queue = new AsyncQueue();
    const order: string[] = [];

    const first = queue.push(async () => {
      order.push('first:start');
      await delay(20);
      order.push('first:end');
    });

    const second = queue.push(async () => {
      order.push('second:start');
      await delay(5);
      order.push('second:end');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps draining after a task rejects', async () => {
    const queue = new AsyncQueue();

    await expect(queue.push(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.push(async () => 'ok')).resolves.toBe('ok');

    await queue.drain();
    expect(queue.size).toBe(0);
  });
});
