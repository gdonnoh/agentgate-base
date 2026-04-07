/**
 * agentkit.ts
 *
 * Shared AgentKit (WorldID) validation utility.
 * Used by both the enrichAgentKit middleware (for /api/weather, /api/prices)
 * and the proxy route (for endpoints that require WorldID).
 */

import {
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  createAgentBookVerifier,
} from "@worldcoin/agentkit";

const agentBook = createAgentBookVerifier();

export interface AgentKitResult {
  valid: boolean;
  address?: string;
  humanId?: string;
  error?: string;
}

/**
 * Validate an agentkit header and check AgentBook membership.
 * Returns { valid, address, humanId } on success, { valid: false, error } on failure.
 */
export async function validateAgentKitHeader(
  agentkitHeader: string,
  requestUrl?: string | undefined
): Promise<AgentKitResult> {
  try {
    const payload = parseAgentkitHeader(agentkitHeader);
    const validation = await validateAgentkitMessage(payload, requestUrl as string);
    if (!validation.valid) {
      return { valid: false, error: `Invalid AgentKit proof: ${validation.error}` };
    }

    const verification = await verifyAgentkitSignature(payload);
    if (!verification.valid || !verification.address) {
      return { valid: false, error: `AgentKit signature invalid: ${verification.error}` };
    }

    const humanId = await agentBook.lookupHuman(verification.address, payload.chainId);
    return {
      valid: true,
      address: verification.address,
      humanId: humanId || undefined,
    };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}
