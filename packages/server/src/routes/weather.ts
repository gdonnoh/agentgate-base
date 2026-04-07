import { Hono } from "hono";
import { config } from "../config";

const router = new Hono();

const CONDITIONS = ["Clear", "Partly Cloudy", "Overcast", "Light Rain", "Sunny", "Foggy", "Windy"];
const ICONS = ["☀️", "⛅", "☁️", "🌧️", "🌞", "🌫️", "💨"];

function fakeWeather(city: string) {
  // Deterministic-ish based on city name so same city = same result
  const seed = city.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const condIdx = seed % CONDITIONS.length;
  return {
    city: city.charAt(0).toUpperCase() + city.slice(1),
    temperature_c: 15 + (seed % 20),
    temperature_f: Math.round((15 + (seed % 20)) * 9 / 5 + 32),
    humidity_pct: 40 + (seed % 50),
    wind_kmh: 5 + (seed % 30),
    condition: CONDITIONS[condIdx],
    icon: ICONS[condIdx],
    uv_index: 1 + (seed % 10),
    visibility_km: 5 + (seed % 20),
    timestamp: new Date().toISOString(),
  };
}

router.get("/:city", (c) => {
  const city = c.req.param("city");
  const weather = fakeWeather(city);

  return c.json({
    ...weather,
    sponsored_by: config.publisherAddress,
    agent_verified: true,
    payment: "~$0.01 in HBAR",
    network: "Hedera Testnet (eip155:296)",
  });
});

export default router;
