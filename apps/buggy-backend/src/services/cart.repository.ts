import type { Cart } from '../types';

/**
 * Deliberately tiny in-memory store. The point of Application 1 is to fail in
 * realistic ways, not to persist anything.
 */
const carts = new Map<string, Cart>([
  [
    'cart-1001',
    {
      id: 'cart-1001',
      currency: 'INR',
      couponCode: 'FESTIVE50',
      items: [
        { sku: 'SKU-KEYB-01', name: 'Mechanical Keyboard', unitPrice: 4599.5, quantity: 1, metadata: '{"gift":true}' },
        { sku: 'SKU-MOUSE-02', name: 'Wireless Mouse', unitPrice: 1250.25, quantity: 2, metadata: '{"gift":false}' },
      ],
    },
  ],
  ['cart-empty', { id: 'cart-empty', currency: 'INR', items: [] }],
  [
    'cart-badmeta',
    {
      id: 'cart-badmeta',
      currency: 'INR',
      items: [
        // Upstream integration sends a single-quoted, trailing-comma payload.
        { sku: 'SKU-HUB-03', name: 'USB-C Hub', unitPrice: 2199, quantity: 1, metadata: "{'giftWrap': true,}" },
      ],
    },
  ],
]);

export class CartRepository {
  findById(cartId: string): Cart | undefined {
    return carts.get(cartId);
  }

  list(): Cart[] {
    return [...carts.values()];
  }

  save(cart: Cart): Cart {
    carts.set(cart.id, cart);
    return cart;
  }
}

export const cartRepository = new CartRepository();
