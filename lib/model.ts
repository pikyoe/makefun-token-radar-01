// Token Radar's value model (radar-2): one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and
// adds pre-token protocols below the watchlist floor: the early rows the radar exists to
// find. A protocol is pre-token when its record carries no token (no market cap, no
// CoinGecko id, no symbol); the snapshot's live-token protocols are kept apart and shown
// with the market's own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures:
//
//   base       = tvl_usd x BASE_MULTIPLE                     (0.30)
//   growth     = clamp(change_7d, -50, 150) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT         (weight 1.0: a protocol growing
//                                                             20% in a week scores 20% higher)
//   stability  = 1 + STEADY_RATE x min(max(growth, 0), 20)
//                  - DROP_RATE x min(max(-growth, 0), 50)   (steady 0.001, drop 0.002:
//                                                             a protocol that bled 50% of its
//                                                             TVL in a week scores 10% lower,
//                                                             one growing steadily gains up to
//                                                             2%; the term is small on purpose,
//                                                             so a sharp drop is a discount on
//                                                             the growth term, never the story)
//   maturity   = 0.5 + min(age_days, 1460) / 1460 x 0.5      (age_days unknown: 365)
//                A protocol that has run four years with no token recorded scores twice a
//                newborn one; age matters because a long runway with no token is the radar's
//                signal that a launch, when it comes, has a large audience waiting.
//   breadth    = 1 + 0.02 x min(chains, 5)                  (a protocol live on more chains
//                                                             reaches more farmers; small term)
//   implied    = max(1, round(base x growthMult x stability x maturity x breadth))
//
// No protocol name is ever special-cased: the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  stability_steady_rate: number;
  stability_steady_cap: number;
  stability_drop_rate: number;
  stability_drop_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.3,
  growth_weight: 1.0,
  growth_floor: -50,
  growth_cap: 150,
  stability_steady_rate: 0.001,
  stability_steady_cap: 20,
  stability_drop_rate: 0.002,
  stability_drop_cap: 50,
  maturity_floor: 0.5,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.02,
  breadth_max_chains: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    stability_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, farm plan included so page and board agree exactly. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  stability_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The stability multiplier for a clamped weekly growth figure: a small premium for steady
 * growth, a larger discount for a sharp drop. Both legs are capped, so the term stays in
 * [0.90, 1.02] and can never overturn the growth term it refines.
 */
export function stabilityMultiplier(growthPct: number, model: ModelConstants): number {
  const steady = Math.min(Math.max(growthPct, 0), model.stability_steady_cap) * model.stability_steady_rate;
  const drop = Math.min(Math.max(-growthPct, 0), model.stability_drop_cap) * model.stability_drop_rate;
  return 1 + steady - drop;
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; stabilityMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const stabilityMult = stabilityMultiplier(growthPct, model);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + model.breadth_per_chain * Math.min(protocol.chains.length, model.breadth_max_chains);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * stabilityMult * maturityMult * breadthMult));
  return { implied, growthPct, growthMult, stabilityMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const { implied, growthPct, growthMult, stabilityMult, maturityMult, breadthMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, growthPct, growthMult, stabilityMult, maturityMult, breadthMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.slug ? -1 : a.p.slug > b.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      stability_multiplier: round4(s.stabilityMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The core farming action for a protocol's category, naming the concrete move, the asset and
 * the chain. Categories are matched by substring, longest match first, so a protocol's own
 * record — never its name — picks the plan. The amounts come from capitalFor, the chain from
 * the protocol's own chains list.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('leveraged farm')) return `Deposit $${capital} of USDC into ${name}'s leveraged farm on ${chain}, borrow against it once at under 50% loan-to-value, and re-supply the borrowed funds to the same farm.`;
  if (c.includes('uncollateralized lend')) return `Open a $${capital} uncollateralized credit line on ${name} (${chain}), draw half of it in USDC, and repay it in full before the term ends.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name}'s lending pool on ${chain}, then borrow 40% of the deposit in ETH and hold both sides of the position.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking pool')) return `Stake $${capital} of ETH through ${name} on ${chain}, hold the liquid staking receipt token, and restake that receipt with one of its operators.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Add $${capital} of liquidity to ${name}'s deepest USDC-ETH pool on ${chain} in a tight range around the current price, and keep the LP position open.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s highest-TVL auto-compounding vault on ${chain} and let the vault re-invest the yield.`;
  if (c.includes('farm')) return `Deposit $${capital} into ${name}'s farm on ${chain}, stake the LP tokens it issues, and claim the farm rewards weekly.`;
  if (c.includes('basis trading') || c.includes('derivative') || c.includes('perpetual')) return `Post $${capital} of USDC as margin on ${name} (${chain}) and open one small delta-neutral trade: long the perpetual, short the same amount on a spot venue.`;
  if (c.includes('options')) return `Sell one covered call through ${name}'s options vault on ${chain} with $${capital} of collateral, and let the vault manage the strike.`;
  if (c.includes('synthetics')) return `Mint $${capital} of synthetic assets on ${name} (${chain}) against USDC collateral and hold the minted position.`;
  if (c.includes('prediction')) return `Fund ${name} with $${capital} and take one position in an open prediction market, then hold it until the market resolves.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain}, pick the curator with the longest track record, and hold the vault shares.`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset ${name} issues on ${chain} against USDC collateral, and hold the minted stablecoins.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing tokenized asset on ${chain} and hold it to accrue the underlying yield.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} for a protocol you already use, and keep the policy active for the full term.`;
  if (c.includes('launchpad')) return `Stake $${capital} of USDC in ${name}'s launchpad pool on ${chain} to qualify for allocations, and join one upcoming launch.`;
  if (c.includes('indexes')) return `Buy $${capital} of ${name}'s index token on ${chain} and hold the basket for the full hold period.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC into ${chain} with ${name}, then put the bridged funds to work in its app instead of bridging straight back.`;
  if (c.includes('nft marketplace')) return `List one NFT for sale on ${name} (${chain}) and make one purchase through its marketplace to register as an active trader.`;
  if (c.includes('payments')) return `Pay $${capital} through ${name} on ${chain} for a real purchase, and keep the receipt as proof of usage.`;
  if (c.includes('interest rate')) return `Lock $${capital} into ${name}'s fixed-rate market on ${chain} for the shortest available term.`;
  if (c.includes('token locker')) return `Lock $${capital} of tokens in ${name}'s locker on ${chain} for the minimum term it offers.`;
  if (c.includes('governance')) return `Deposit $${capital} into ${name}'s governance vault on ${chain} and vote on one live proposal.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * The follow-on action: a second concrete move in the same category, so the plan is a
 * sequence rather than one deposit. It mirrors actionFor's categories, and falls back to a
 * second chain or a weekly qualifying action when the category names no second move.
 */
function followUpFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('leveraged farm')) return `Repay a quarter of the borrow, then borrow again the same week, so the wallet shows repeated borrow-and-repay activity on ${name}.`;
  if (c.includes('dex') || c.includes('liquidity manager')) return `Move half the liquidity into a second ${name} pool on ${chain} with a different pair, so the wallet holds two active LP positions.`;
  if (c.includes('restak') || c.includes('liquid staking') || c.includes('staking pool')) return `Delegate the restaked position to a second operator on ${name} and claim the restaking rewards once, keeping the receipt token staked.`;
  if (c.includes('basis trading') || c.includes('derivative') || c.includes('perpetual')) return `Close the hedge when funding flips, then re-open it at the new rate, so the position stays delta-neutral across a funding cycle.`;
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('farm')) return `Move a third of the deposit into a second ${name} vault on ${chain} and compare the two vaults' yields weekly.`;
  if (c.includes('bridge')) return `Bridge $${Math.round(capital / 2)} of the funds back through ${name} on a different route, so the wallet shows two-way bridge volume.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Split the deposit across a second ${name} vault run by a different curator, keeping both shares for the full hold.`;
  if (secondChain !== null) return `Repeat the core position with about $${Math.round(capital / 2)} on ${secondChain} as well, so the wallet shows activity on two chains.`;
  return `Do one qualifying action each week on ${chain}, such as a deposit, a swap, a borrow or a vote.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list
 * of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const followUp = followUpFor(p, capital, chain);
  // Only the second-chain repeat moves fresh capital; every other follow-on re-uses the
  // position the core action already funded, so it costs gas alone.
  const followUpCost = followUp.startsWith('Repeat the core position')
    ? `about $${Math.round(capital / 2)} of extra capital and $3 of gas`
    : 'about $3 of gas';
  return [
    {
      text: `Set up a fresh wallet that holds only the farming funds, and store its seed phrase offline on paper.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital plus about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: followUp,
      cost: followUpCost,
      time: '20 minutes',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity spans more than one snapshot window.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the protocol's own points or rewards page once a week and claim only from the link that page publishes.`,
      cost: 'no fee to check, and never pay anyone to claim',
      time: '10 minutes a week',
    },
    {
      text: `Log the wallet, the dates and every transaction hash, so the position can be repeated or unwound cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, farm plan included. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    stability_multiplier: row.model.stability_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, new Set(snapshot.watchlist))),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
