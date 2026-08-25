import request from 'supertest';
import { createApp } from '../src/index';

const app = createApp();

describe('cart routes', () => {
  it('exposes a health probe', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('returns a stable error envelope with the resolved source location', async () => {
    // cart-1001 carries the unknown coupon FESTIVE50 -> BUG #1.
    const response = await request(app).post('/api/cart/checkout').send({ cartId: 'cart-1001' }).expect(500);

    expect(response.body.error.type).toBe('TypeError');
    expect(response.body.error.source.file).toContain('apps/buggy-backend/src/services/cart.service.ts');
    expect(response.body.error.source.function).toContain('applyCoupon');
  });

  it('returns 404 for unknown routes', async () => {
    await request(app).get('/api/nope').expect(404);
  });
});
