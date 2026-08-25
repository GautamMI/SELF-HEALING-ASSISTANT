import { Router } from 'express';

export const internalRouter = Router();

/**
 * Stub for the "pricing service". It answers with a *valid HTTP 200* but a
 * payload shaped `{ status, data }` instead of `{ status, prices }` - exactly
 * the kind of silent contract drift that BUG #3 fails to defend against.
 */
internalRouter.get('/pricing-feed', (req, res) => {
  res.json({
    status: 'ok',
    generatedAt: new Date().toISOString(),
    data: {
      cartId: req.query.cartId ?? null,
      items: [
        { sku: 'SKU-KEYB-01', amount: 4499.0 },
        { sku: 'SKU-MOUSE-02', amount: 1199.0 },
      ],
    },
  });
});
