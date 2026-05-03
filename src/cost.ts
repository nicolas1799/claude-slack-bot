import { saveCost, loadAllCosts, type PersistedCost } from "./firestore.js";

export interface CostRecord {
  totalUsd: number;
  turnCount: number;
  lastTurnUsd: number;
  lastTurnAt: number;
}

const costs = new Map<string, CostRecord>();
let bootTotalUsd = 0;
const bootStart = Date.now();

export async function hydrateCosts(): Promise<void> {
  const persisted = await loadAllCosts();
  for (const [k, v] of persisted) {
    costs.set(k, {
      totalUsd: v.totalUsd,
      turnCount: v.turnCount,
      lastTurnUsd: v.lastTurnUsd,
      lastTurnAt: v.lastTurnAt,
    });
  }
  console.log(`[firestore] Hydrated ${costs.size} cost records`);
}

export function recordTurnCost(key: string, usd: number): void {
  if (!Number.isFinite(usd) || usd <= 0) return;
  const cur = costs.get(key) || { totalUsd: 0, turnCount: 0, lastTurnUsd: 0, lastTurnAt: 0 };
  cur.totalUsd += usd;
  cur.turnCount += 1;
  cur.lastTurnUsd = usd;
  cur.lastTurnAt = Date.now();
  costs.set(key, cur);
  bootTotalUsd += usd;
  const persisted: PersistedCost = { ...cur };
  saveCost(key, persisted);
}

export function getCostFor(key: string): CostRecord | undefined {
  return costs.get(key);
}

export function getCostSummary() {
  let total = 0;
  let turns = 0;
  for (const v of costs.values()) {
    total += v.totalUsd;
    turns += v.turnCount;
  }
  return {
    total_usd: +total.toFixed(4),
    total_turns: turns,
    conversations: costs.size,
    boot_total_usd: +bootTotalUsd.toFixed(4),
    boot_uptime_sec: Math.floor((Date.now() - bootStart) / 1000),
  };
}

export function getTopCostConversations(limit: number) {
  return Array.from(costs.entries())
    .map(([key, v]) => ({
      key,
      total_usd: +v.totalUsd.toFixed(4),
      turns: v.turnCount,
      last_turn_usd: +v.lastTurnUsd.toFixed(4),
      last_turn_at: new Date(v.lastTurnAt).toISOString(),
    }))
    .sort((a, b) => b.total_usd - a.total_usd)
    .slice(0, limit);
}
