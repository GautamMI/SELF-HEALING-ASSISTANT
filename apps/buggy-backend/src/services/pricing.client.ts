import axios, { type AxiosInstance } from 'axios';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('pricing-client');

/** The contract we *believe* the pricing service honours. */
export interface PricingApiResponse {
  status: string;
  prices: Array<{ sku: string; amount: number }>;
}

export class PricingClient {
  private readonly http: AxiosInstance;

  constructor(http?: AxiosInstance) {
    this.http =
      http ??
      axios.create({
        timeout: config.pricing.timeoutMs,
        headers: { accept: 'application/json' },
        validateStatus: (status) => status < 500,
      });
  }

  /**
   * Fetches live prices. Note that the response is returned *unvalidated* -
   * see BUG #3 in `cart.service.ts`.
   */
  async fetchLivePrices(cartId: string): Promise<PricingApiResponse> {
    log.debug({ cartId, url: config.pricing.url }, 'requesting live prices');
    const response = await this.http.get<PricingApiResponse>(config.pricing.url, { params: { cartId } });
    return response.data;
  }
}

export const pricingClient = new PricingClient();
