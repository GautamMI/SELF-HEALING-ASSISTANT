/* eslint-disable no-console */
/**
 * Demo driver: fires one request per intentional defect so the whole set of
 * error events lands in logs/error.log in a predictable order.
 *
 *   npm run trigger:bugs            # all bugs
 *   npm run trigger:bugs -- 2 4     # only bugs 2 and 4
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4000';

interface Scenario {
  id: number;
  label: string;
  request: () => Promise<Response>;
}

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const scenarios: Scenario[] = [
  { id: 1, label: 'Null property access (unknown coupon)', request: () => post('/api/cart/checkout', { cartId: 'cart-1001' }) },
  { id: 2, label: 'Divide by zero (empty cart split)', request: () => fetch(`${BASE_URL}/api/cart/cart-empty/split`) },
  { id: 3, label: 'Invalid API response handling', request: () => fetch(`${BASE_URL}/api/cart/cart-1001/pricing`) },
  { id: 4, label: 'Runtime error: malformed JSON metadata', request: () => fetch(`${BASE_URL}/api/cart/cart-badmeta/metadata`) },
  { id: 5, label: 'Runtime error: provider.reserve is not a function', request: () => post('/api/cart/cart-1001/reserve', { region: 'EU' }) },
];

const selected = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const main = async (): Promise<void> => {
  const queue = selected.length > 0 ? scenarios.filter((scenario) => selected.includes(scenario.id)) : scenarios;

  for (const scenario of queue) {
    try {
      const response = await scenario.request();
      const body = (await response.json()) as { error?: { type?: string; message?: string } };
      console.log(`BUG #${scenario.id} ${scenario.label} -> HTTP ${response.status} ${body.error?.type ?? 'OK'}`);
    } catch (error) {
      console.error(`BUG #${scenario.id} could not be triggered:`, (error as Error).message);
    }
    // Space the requests out so the agent's dedup window is easy to observe.
    await sleep(1500);
  }

  console.log('\nDone. Tail apps/buggy-backend/logs/error.log to see the structured events.');
};

void main();
