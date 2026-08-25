# Sample generated pull request

This is a verbatim example of what the agent opens on GitHub after healing **BUG #1**
(`TypeError: Cannot read properties of undefined (reading 'discount')`).

- **Branch:** `autofix/typeerror-cannot-read-properties-of-undefine-a1b2c3d4`
- **Base:** `main`
- **Labels:** `self-healing`, `automated-fix`
- **Title:** `fix: Guard against unknown coupon codes when applying a discount [TypeError]`

---

## 🤖 Automated fix

This pull request was opened by the **self-healing assistant** after it observed a failure in `buggy-backend`.
**A human must review and approve it before merge.**

### Detected error

| | |
|---|---|
| Type | `TypeError` |
| Message | Cannot read properties of undefined (reading 'discount') |
| Source | `apps/buggy-backend/src/services/cart.service.ts:79` in `CartService.applyCoupon` |
| First seen | 2026-08-25T17:24:11.482Z |
| Fingerprint | `4f9c1ad3b7e20c58` |

### Root cause

`COUPON_CATALOGUE[code]` returns `undefined` for any coupon that is not in the catalogue, and the
result is dereferenced immediately as `coupon.discount.percentage`. Cart `cart-1001` carries the
code `FESTIVE50`, which was never registered, so the lookup misses and the property access throws.

### Fix

- `apps/buggy-backend/src/services/cart.service.ts` — look the coupon up defensively, log and return a zero discount when the code is unknown instead of dereferencing `undefined`.

| Model | Confidence | Risk |
|---|---|---|
| `gpt-4o-mini` | 0.93 | low |

### Validation

| Command | Result | Exit code | Duration |
|---|---|---|---|
| `npm run --silent typecheck` | ✅ pass | 0 | 3412 ms |
| `npm run --silent test:ci` | ❌ fail | 1 | 7180 ms |

> ⚠️ The test suite is still red. Opened as a draft for human triage.

_(The remaining failure is BUG #6, the seeded tax-rounding defect, which is healed by its own
pull request.)_

### How to verify

`POST /api/cart/checkout` with `{"cartId":"cart-1001"}` should now return `200` with
`discount: 0`, and `{"cartId":"cart-1001","couponCode":"WELCOME10"}` should still apply 10%.

<details>
<summary>Unified diff</summary>

```diff
--- a/apps/buggy-backend/src/services/cart.service.ts
+++ b/apps/buggy-backend/src/services/cart.service.ts
@@ -72,11 +72,17 @@
   applyCoupon(cart: Cart, couponCode?: string): number {
     const code = couponCode ?? cart.couponCode ?? '';
     const coupon = COUPON_CATALOGUE[code];
 
-    log.debug({ cartId: cart.id, code }, 'applying coupon');
+    if (!coupon) {
+      log.warn({ cartId: cart.id, code }, 'unknown coupon code; no discount applied');
+      return 0;
+    }
+
+    log.debug({ cartId: cart.id, code }, 'applying coupon');
 
     const subtotal = this.calculateSubtotal(cart);
     return (subtotal * coupon.discount.percentage) / 100;
   }
```

</details>

<details>
<summary>Original log line</summary>

```json
{"level":"error","time":"2026-08-25T17:24:11.482Z","service":"buggy-backend","component":"error-handler","errorType":"TypeError","err":{"type":"TypeError","message":"Cannot read properties of undefined (reading 'discount')","stack":"TypeError: Cannot read properties of undefined (reading 'discount')\n    at CartService.applyCoupon (/repo/apps/buggy-backend/src/services/cart.service.ts:79:41)\n    at CartService.checkout (/repo/apps/buggy-backend/src/services/cart.service.ts:93:28)"},"errorSource":{"file":"apps/buggy-backend/src/services/cart.service.ts","function":"CartService.applyCoupon","line":79,"column":41},"sourceFile":"apps/buggy-backend/src/services/cart.service.ts","sourceFunction":"CartService.applyCoupon","sourceLine":79,"context":{"route":"POST /api/cart/checkout","requestId":"2eb65bf1-89c1-4b77-9dbd-a10dc2f30702","operation":"http.request"},"msg":"Cannot read properties of undefined (reading 'discount')"}
```

</details>

<sub>Commit `9c4e17ab` · generated at 2026-08-25T17:24:39.006Z</sub>
