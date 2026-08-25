import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { cartService, CartNotFoundError } from '../services/cart.service';
import { cartRepository } from '../services/cart.repository';
import { asyncHandler } from '../utils/asyncHandler';

export const cartRouter = Router();

const CheckoutBodySchema = z.object({
  cartId: z.string().min(1),
  couponCode: z.string().min(1).optional(),
});

/** Lists the seeded carts - handy while recording the demo. */
cartRouter.get('/', (_req, res) => {
  res.json({ carts: cartRepository.list() });
});

/** BUG #1 (+ BUG #6 tax rounding) - POST /api/cart/checkout */
cartRouter.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const body = CheckoutBodySchema.parse(req.body ?? {});
    res.json(cartService.checkout(body.cartId, body.couponCode));
  }),
);

/** BUG #2 - GET /api/cart/:cartId/split */
cartRouter.get(
  '/:cartId/split',
  asyncHandler(async (req, res) => {
    res.json(cartService.splitPerUnit(req.params.cartId));
  }),
);

/** BUG #3 - GET /api/cart/:cartId/pricing */
cartRouter.get(
  '/:cartId/pricing',
  asyncHandler(async (req, res) => {
    res.json({ prices: await cartService.refreshLivePricing(req.params.cartId) });
  }),
);

/** BUG #4 - GET /api/cart/:cartId/metadata */
cartRouter.get(
  '/:cartId/metadata',
  asyncHandler(async (req, res) => {
    res.json({ metadata: cartService.readItemMetadata(req.params.cartId) });
  }),
);

/** BUG #5 - POST /api/cart/:cartId/reserve */
cartRouter.post(
  '/:cartId/reserve',
  asyncHandler(async (req, res) => {
    const region = z.string().min(2).default('US').parse(req.body?.region ?? 'US');
    res.json({ reservations: cartService.reserveInventory(req.params.cartId, region) });
  }),
);

/** Cart-scoped 404 mapping so "not found" never masquerades as a 500. */
const cartNotFoundHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof CartNotFoundError) {
    res.status(404).json({ error: { type: err.name, message: err.message } });
    return;
  }
  next(err);
};

cartRouter.use(cartNotFoundHandler);
