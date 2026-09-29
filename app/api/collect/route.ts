import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/src/lib/supabaseAdmin";

type PolymarketMarket = {
  id: string;
  question?: string;
  description?: string;
  slug?: string;
  active?: boolean;
  volume?: string | number;
  liquidity?: string | number;
  outcomePrices?: string | string[];
};

function parseYesProbability(outcomePrices: PolymarketMarket["outcomePrices"]) {
  if (!outcomePrices) return null;

  let prices: string[];

  if (Array.isArray(outcomePrices)) {
    prices = outcomePrices;
  } else {
    try {
      prices = JSON.parse(outcomePrices);
    } catch {
      return null;
    }
  }

  const yesPrice = Number(prices[0]);

  if (!Number.isFinite(yesPrice)) return null;

  return yesPrice;
}

export async function GET() {
  try {
    const response = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&offset=0",
      {
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(`Polymarket API failed: ${response.status}`);
    }

    const markets: PolymarketMarket[] = await response.json();

    let savedMarkets = 0;
    let savedSnapshots = 0;
    const errors: string[] = [];

    for (const market of markets) {
      if (!market.id || !market.question) continue;

      const probability = parseYesProbability(market.outcomePrices);

      if (probability === null) continue;

      const { data: savedMarket, error: marketError } =
        await supabaseAdmin
          .from("markets")
          .upsert(
            {
              source: "polymarket",
              source_market_id: market.id,
              title: market.question,
              description: market.description ?? null,
              status: market.active ? "active" : "inactive",
              current_probability: probability,
              volume: Number(market.volume ?? 0),
              liquidity: Number(market.liquidity ?? 0),
              source_url: market.slug
                ? `https://polymarket.com/event/${market.slug}`
                : null,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "source_market_id",
            }
          )
          .select("id")
          .single();

      if (marketError || !savedMarket) {
        errors.push(
          `Market ${market.id}: ${marketError?.message ?? "unknown error"}`
        );
        continue;
      }

      savedMarkets++;

      const { error: snapshotError } = await supabaseAdmin
        .from("market_snapshots")
        .insert({
          market_id: savedMarket.id,
          probability,
          volume: Number(market.volume ?? 0),
          liquidity: Number(market.liquidity ?? 0),
          recorded_at: new Date().toISOString(),
        });

      if (snapshotError) {
        errors.push(
          `Snapshot ${market.id}: ${snapshotError.message}`
        );
        continue;
      }

      savedSnapshots++;
    }

    return NextResponse.json({
      ok: true,
      markets_received: markets.length,
      markets_saved: savedMarkets,
      snapshots_saved: savedSnapshots,
      errors: errors.slice(0, 10),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown collector error",
      },
      {
        status: 500,
      }
    );
  }
}