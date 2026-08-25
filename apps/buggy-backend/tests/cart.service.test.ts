import { CartService, CartNotFoundError, TAX_RATE } from '../src/services/cart.service';
import { CartRepository } from '../src/services/cart.repository';
import type { PricingClient } from '../src/services/pricing.client';
import type { Cart } from '../src/types';

const buildCart = (overrides: Partial<Cart> = {}): Cart => ({
  id: 'cart-test',
  currency: 'INR',
  items: [
    { sku: 'SKU-A', name: 'Item A', unitPrice: 100.5, quantity: 2, metadata: '{"gift":false}' },
    { sku: 'SKU-B', name: 'Item B', unitPrice: 49.25, quantity: 1, metadata: '{"gift":true}' },
  ],
  ...overrides,
});

/** Fully mocked pricing dependency - no network is touched by the suite. */
const createPricingMock = (): jest.Mocked<Pick<PricingClient, 'fetchLivePrices'>> => ({
  fetchLivePrices: jest.fn(),
});

const createService = (cart: Cart, pricing = createPricingMock()) => {
  const repository = new CartRepository();
  jest.spyOn(repository, 'findById').mockImplementation((id) => (id === cart.id ? cart : undefined));
  return { service: new CartService(repository, pricing as unknown as PricingClient), pricing, repository };
};

describe('CartService', () => {
  describe('calculateSubtotal', () => {
    it('sums unit price multiplied by quantity', () => {
      const cart = buildCart();
      const { service } = createService(cart);

      expect(service.calculateSubtotal(cart)).toBeCloseTo(250.25, 2);
    });

    it('returns zero for an empty cart', () => {
      const cart = buildCart({ items: [] });
      const { service } = createService(cart);

      expect(service.calculateSubtotal(cart)).toBe(0);
    });
  });

  describe('checkout', () => {
    it('throws CartNotFoundError for an unknown cart id', () => {
      const { service } = createService(buildCart());

      expect(() => service.checkout('does-not-exist')).toThrow(CartNotFoundError);
    });

    /**
     * ❌ INTENTIONALLY FAILING TEST (defect: BUG #6)
     *
     * Tax must be rounded to two decimal places. `CartService.checkout`
     * currently uses `Math.round`, collapsing 40.55 down to 41 whole units.
     * The custom Jest reporter mirrors this failure into logs/error.log so the
     * self-healing agent can pick it up like any other error event.
     */
    it('rounds tax to two decimal places', () => {
      const cart = buildCart({ couponCode: 'WELCOME10' });
      const { service } = createService(cart);

      const subtotal = service.calculateSubtotal(cart);
      const discount = subtotal * 0.1;
      const expectedTax = Number(((subtotal - discount) * TAX_RATE).toFixed(2));

      const summary = service.checkout(cart.id, 'WELCOME10');

      expect(summary.tax).toBeCloseTo(expectedTax, 2);
    });
  });

  describe('refreshLivePricing', () => {
    it('maps a well-formed pricing payload', async () => {
      const cart = buildCart();
      const pricing = createPricingMock();
      pricing.fetchLivePrices.mockResolvedValue({
        status: 'ok',
        prices: [
          { sku: 'SKU-A', amount: 99 },
          { sku: 'SKU-B', amount: 45 },
        ],
      });

      const { service } = createService(cart, pricing);

      await expect(service.refreshLivePricing(cart.id)).resolves.toEqual([
        { sku: 'SKU-A', amount: 99 },
        { sku: 'SKU-B', amount: 45 },
      ]);
      expect(pricing.fetchLivePrices).toHaveBeenCalledWith(cart.id);
    });
  });

  describe('reserveInventory', () => {
    it('reserves through the regional provider', () => {
      const cart = buildCart();
      const { service } = createService(cart);

      expect(service.reserveInventory(cart.id, 'IN')).toEqual([
        { sku: 'SKU-A', reservationId: 'IN-SKU-A-2' },
        { sku: 'SKU-B', reservationId: 'IN-SKU-B-1' },
      ]);
    });
  });
});
