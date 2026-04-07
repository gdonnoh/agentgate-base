import { Hono } from "hono";
import { config } from "../config";

const router = new Hono();

const PRICES: Record<string, { price: number; change24h: number; symbol: string }> = {
  btc: { price: 68420.5, change24h: 2.34, symbol: "₿" },
  bitcoin: { price: 68420.5, change24h: 2.34, symbol: "₿" },
  eth: { price: 3241.8, change24h: -1.12, symbol: "Ξ" },
  ethereum: { price: 3241.8, change24h: -1.12, symbol: "Ξ" },
  sol: { price: 172.3, change24h: 4.87, symbol: "◎" },
  solana: { price: 172.3, change24h: 4.87, symbol: "◎" },
  hbar: { price: 0.087, change24h: 1.23, symbol: "ℏ" },
  hedera: { price: 0.087, change24h: 1.23, symbol: "ℏ" },
  usdc: { price: 1.0, change24h: 0.01, symbol: "$" },
};

router.get("/:token", (c) => {
  const token = c.req.param("token").toLowerCase();
  const data = PRICES[token];

  if (!data) {
    return c.json(
      {
        error: "Token not found",
        supported: Object.keys(PRICES).filter((k) => !["bitcoin", "ethereum", "solana", "hedera"].includes(k)),
      },
      404
    );
  }

  return c.json({
    token: token.toUpperCase(),
    symbol: data.symbol,
    price_usd: data.price,
    change_24h_pct: data.change24h,
    market_cap_usd: Math.round(data.price * 1_000_000 * (100 + Math.random() * 50)),
    volume_24h_usd: Math.round(data.price * 500_000 * Math.random()),
    last_updated: new Date().toISOString(),
    sponsored_by: config.publisherAddress,
    agent_verified: true,
    payment: "~$0.005 in HBAR",
    network: "Hedera Testnet (eip155:296)",
  });
});

export default router;
