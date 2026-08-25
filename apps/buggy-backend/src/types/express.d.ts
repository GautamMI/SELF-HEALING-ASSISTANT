import 'express';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id attached by the requestContext middleware. */
      requestId: string;
      /** High-resolution start time used to compute request duration. */
      startedAt: bigint;
    }
  }
}

export {};
