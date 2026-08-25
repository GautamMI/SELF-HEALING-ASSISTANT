/** A single line item inside a cart. */
export interface CartItem {
  sku: string;
  name: string;
  /** Unit price in major currency units (e.g. rupees). */
  unitPrice: number;
  quantity: number;
  /** Raw JSON string supplied by upstream integrations. */
  metadata?: string;
}

/** A cart as stored by the (in-memory) repository. */
export interface Cart {
  id: string;
  currency: string;
  items: CartItem[];
  couponCode?: string;
}

/** Result of a successful checkout calculation. */
export interface CheckoutSummary {
  cartId: string;
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

/** Result of the per-unit split calculation. */
export interface CartSplit {
  cartId: string;
  totalUnits: number;
  perUnitMinorAmount: string;
}

/** Where an error came from, resolved from the V8 stack trace. */
export interface ErrorSource {
  /** Path relative to the monorepo root, e.g. `apps/buggy-backend/src/services/cart.service.ts`. */
  file: string;
  /** Absolute path on the machine that produced the error. */
  absolutePath: string;
  /** Best-effort function/method name, e.g. `CartService.applyCoupon`. */
  function: string;
  line: number;
  column: number;
}
