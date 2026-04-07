/**
 * LocalFacilitatorClient
 *
 * Wraps the real x402.org facilitator for Base Sepolia.
 * All verify/settle calls are delegated to the real facilitator.
 */

import { HTTPFacilitatorClient } from "@x402/core/http";

const BASE_SEPOLIA = "eip155:84532";

const SUPPORTED_KINDS = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: BASE_SEPOLIA },
  ],
};

const REAL_FACILITATOR_URL = "https://www.x402.org/facilitator";

export class LocalFacilitatorClient {
  private realClient: HTTPFacilitatorClient;

  constructor() {
    this.realClient = new HTTPFacilitatorClient({ url: REAL_FACILITATOR_URL });
  }

  /**
   * Return supported kinds for Base Sepolia.
   */
  async getSupported(): Promise<typeof SUPPORTED_KINDS> {
    return SUPPORTED_KINDS;
  }

  /**
   * Verify payment via x402.org real facilitator.
   */
  async verify(paymentPayload: any, paymentRequirements: any): Promise<any> {
    return this.realClient.verify(paymentPayload, paymentRequirements);
  }

  /**
   * Settle payment via x402.org real facilitator.
   */
  async settle(paymentPayload: any, paymentRequirements: any): Promise<any> {
    return this.realClient.settle(paymentPayload, paymentRequirements);
  }
}
