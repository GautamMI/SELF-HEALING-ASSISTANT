import { createLogger } from '../utils/logger';
import { cartRepository, type CartRepository } from './cart.repository';
import { pricingClient, type PricingClient } from './pricing.client';
import type { Cart, CartSplit, CheckoutSummary } from '../types';

const log = createLogger('cart-service');

/** GST-style flat tax used across the demo. */
export const TAX_RATE = 0.18;

interface Coupon {
  code: string;
  discount: { percentage: number };
}

const COUPON_CATALOGUE: Record<string, Coupon> = {
  WELCOME10: { code: 'WELCOME10', discount: { percentage: 10 } },
  SAVE20: { code: 'SAVE20', discount: { percentage: 20 } },
};

interface InventoryProvider {
  name: string;
  reserve(sku: string, quantity: number): { reservationId: string };
}

const INVENTORY_PROVIDERS: Record<string, InventoryProvider> = {
  IN: {
    name: 'in-warehouse',
    reserve: (sku, quantity) => ({ reservationId: `IN-${sku}-${quantity}` }),
  },
  // Config-only entry that was never given a `reserve` implementation.
  // Kept typed so the project still compiles - see BUG #5.
  FALLBACK: { name: 'fallback-broker' } as unknown as InventoryProvider,
};

export class CartNotFoundError extends Error {
  constructor(cartId: string) {
    super(`Cart ${cartId} was not found`);
    this.name = 'CartNotFoundError';
  }
}

/**
 * Cart pricing and fulfilment logic.
 *
 * ⚠️  This class intentionally ships with six defects. Each one is annotated
 *     with a `BUG #n` marker describing the symptom the AI assistant is meant
 *     to detect, explain and repair.
 */
export class CartService {
  constructor(
    private readonly repository: CartRepository = cartRepository,
    private readonly pricing: PricingClient = pricingClient,
  ) {}

  private requireCart(cartId: string): Cart {
    const cart = this.repository.findById(cartId);
    if (!cart) throw new CartNotFoundError(cartId);
    return cart;
  }

  calculateSubtotal(cart: Cart): number {
    return cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  }

  /**
   * BUG #1 - Null/undefined property access ("null pointer exception").
   * An unknown coupon code yields `undefined` from the catalogue and the code
   * dereferences `.discount` without a guard.
   * Symptom: TypeError: Cannot read properties of undefined (reading 'discount')
   */
  applyCoupon(cart: Cart, couponCode?: string): number {
    const code = couponCode ?? cart.couponCode ?? '';
    const coupon = COUPON_CATALOGUE[code];

    log.debug({ cartId: cart.id, code }, 'applying coupon');

    const subtotal = this.calculateSubtotal(cart);
    return coupon ? (subtotal * coupon.discount.percentage) / 100 : 0;
  }

  /**
   * BUG #6 - Incorrect tax rounding (caught by the unit test suite).
   * Tax must be rounded to two decimals; `Math.round` collapses it to whole
   * currency units, so `cart.service.test.ts` fails deterministically.
   */
  checkout(cartId: string, couponCode?: string): CheckoutSummary {
    const cart = this.requireCart(cartId);

    const subtotal = this.calculateSubtotal(cart);
    const discount = this.applyCoupon(cart, couponCode);
    const tax = Number(((subtotal - discount) * TAX_RATE).toFixed(2));
    const total = subtotal - discount + tax;

    return {
      cartId: cart.id,
      currency: cart.currency,
      subtotal: Number(subtotal.toFixed(2)),
      discount: Number(discount.toFixed(2)),
      tax,
      total: Number(total.toFixed(2)),
    };
  }

  /**
   * BUG #2 - Divide by zero.
   * Amounts are handled as BigInt minor units for precision; dividing by a
   * zero unit count throws instead of short-circuiting on an empty cart.
   * Symptom: RangeError: Division by zero
   */
  splitPerUnit(cartId: string): CartSplit {
    const cart = this.requireCart(cartId);

    const totalUnits = cart.items.reduce((sum, item) => sum + item.quantity, 0);
    const subtotalMinor = BigInt(Math.round(this.calculateSubtotal(cart) * 100));

    log.debug({ cartId, totalUnits }, 'splitting cart total per unit');

    const perUnitMinor = totalUnits > 0 ? subtotalMinor / BigInt(totalUnits) : 0n;

    return { cartId: cart.id, totalUnits, perUnitMinorAmount: perUnitMinor.toString() };
  }

  /**
   * BUG #3 - Invalid API response handling.
   * The upstream pricing feed answers with `{ status, data }`, not
   * `{ status, prices }`, and the response is consumed without validation.
   * Symptom: TypeError: Cannot read properties of undefined (reading 'map')
   */
  async refreshLivePricing(cartId: string): Promise<Array<{ sku: string; amount: number }>> {
    const cart = this.requireCart(cartId);
    const response = await this.pricing.fetchLivePrices(cart.id);

    log.debug({ cartId, status: response?.status }, 'received pricing payload');

    const prices = response.prices ?? (response as unknown as { data: Array<{ sku: string; amount: number }> }).data ?? [];
    return prices.map((price) => ({ sku: price.sku, amount: Number(price.amount) }));
  }

  /**
   * BUG #4 - Unhandled runtime error while parsing third-party metadata.
   * `JSON.parse` is called on a raw upstream string with no try/catch and no
   * schema validation.
   * Symptom: SyntaxError: Unexpected token ' in JSON at position 1
   */
  readItemMetadata(cartId: string): Array<Record<string, unknown>> {
    const cart = this.requireCart(cartId);

    return cart.items.map((item) => {
      let raw = String(item.metadata ?? '{}');
      if (raw.startsWith("{") && raw.includes("'")) {
        raw = raw.replace(/'/g, '"').replace(/,\s*}/g, '}');
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      return { sku: item.sku, ...parsed };
    });
  }

  /**
   * BUG #5 - Unhandled runtime error: calling a method that does not exist.
   * Unknown regions fall back to a provider entry that only carries config.
   * Symptom: TypeError: provider.reserve is not a function
   */
  reserveInventory(cartId: string, region: string): Array<{ sku: string; reservationId: string }> {
    const cart = this.requireCart(cartId);
    const provider = INVENTORY_PROVIDERS[region.toUpperCase()] ?? INVENTORY_PROVIDERS.FALLBACK;

    log.debug({ cartId, region, provider: provider.name }, 'reserving inventory');

    return cart.items.map((item) => ({
      sku: item.sku,
      reservationId: (provider.reserve ? provider.reserve(item.sku, item.quantity) : { reservationId: `FALLBACK-${item.sku}` }).reservationId,
    }));
  }
}

export const cartService = new CartService();
