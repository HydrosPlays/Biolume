/**
 * Formulas for the `custom` models of `oddsMethods.json` — the three methods
 * too irregular for the declarative roll / fixed / table models.
 *
 * Each one is implemented from the `spec` pseudo-code stored on the method's
 * model, step for step, and is pinned by that method's checkpoints in
 * `oddsData.test.ts`. Constants come from `model.params` where the data
 * provides them (the literal next to each `param()` call is the spec's value).
 *
 * `oddsData.ts` calls {@link registerCustomFormulas} so every engine — the
 * app's default one and the fresh ones the conformance test builds — sees them.
 */
import { cumulativeProbability } from './probability';
import {
  BASE_ROLL_LABEL,
  SHINY_CHARM_LABEL,
  registerFormula,
  type FormulaContext,
  type OddsBreakdownRow,
  type OddsFormula,
} from './odds';

/** A whole, non-negative count from a number input (inputs arrive normalised; this guards direct calls). */
function wholeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function clampChance(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** The value of the first tier whose `min` the count reaches (`tiers` sorted highest first), else `fallback`. */
function firstTier<T>(
  tiers: readonly (readonly [min: number, value: T])[],
  count: number,
  fallback: T,
): T {
  for (const [min, value] of tiers) {
    if (count >= min) return value;
  }
  return fallback;
}

function baseRows(context: FormulaContext, baseLabel = BASE_ROLL_LABEL): OddsBreakdownRow[] {
  const rows: OddsBreakdownRow[] = [{ kind: 'base', label: baseLabel, rolls: 1 }];
  if (context.charmRolls > 0) {
    rows.push({ kind: 'charm', label: SHINY_CHARM_LABEL, rolls: context.charmRolls });
  }
  return rows;
}

// ───────────────────────────── ORAS — DexNav ─────────────────────────────

/**
 * The DexNav's forced-Shiny target for a Search Level (spec step 2) — the
 * chance of one check is `ceil(target / 100) / 10000`.
 */
export function dexNavTarget(searchLevel: number): number {
  if (searchLevel > 200) return searchLevel + 600;
  if (searchLevel > 100) return 2 * searchLevel + 400;
  return 6 * searchLevel;
}

/**
 * `oras-dexnav`: every hidden Pokémon gets a number of independent forced-Shiny
 * checks whose chance grows with the Search Level; when they all fail it is
 * rolled like any wild Pokémon.
 */
export const orasDexNav: OddsFormula = (context) => {
  const searchLevel = Math.min(999, wholeCount(context.number('searchLevel')));
  const chain = wholeCount(context.number('chain'));

  // 1. Position in the 100-encounter cycle: this is encounter c + 1 of it.
  const cycle = Math.max(1, context.param('chainCycle', 100));
  const c = chain % cycle;

  // 2–3. Target value and the chance of a single check.
  const pCheck = clampChance(
    Math.ceil(dexNavTarget(searchLevel) / 100) / context.param('checkRange', 10_000),
  );

  // 4. Checks before the boost.
  const baseChecks = context.param('baseChecks', 1);
  const charmChecks = context.charmApplied ? context.param('charmChecks', 2) : 0;
  const isFiftieth = c === cycle / 2 - 1; // c == 49
  const isHundredth = c === cycle - 1; // c == 99
  const milestoneChecks = isFiftieth
    ? context.param('chain50Checks', 5)
    : isHundredth
      ? context.param('chain100Checks', 10)
      : 0;
  const n = baseChecks + charmChecks + milestoneChecks;

  // 5. The +4 boost: certain on every 5th encounter of the cycle, else a 4 % chance.
  const boostChecks = context.param('boostChecks', 4);
  const boostEvery = Math.max(1, context.param('boostEvery', 5));
  const boostChance = clampChance(context.param('randomBoostChance', 0.04));
  const boostGuaranteed = c > 0 && (c + 1) % boostEvery === 0;
  const forced = (checks: number): number => cumulativeProbability(pCheck, checks);
  const pForced = boostGuaranteed
    ? forced(n + boostChecks)
    : boostChance * forced(n + boostChecks) + (1 - boostChance) * forced(n);

  // 6. The natural rolls of an ordinary wild Pokémon.
  const denominator = context.param('denominator', context.denominator);
  const pNatural = context.rollsToProbability(1 + context.charmRolls, denominator);

  // 7. Forced first, natural only when every check failed.
  const perPokemon = pForced + (1 - pForced) * pNatural;

  const breakdown = baseRows(context, 'Natural roll');
  if (pCheck > 0) {
    const check = { unit: 'check', perRoll: pCheck } as const;
    breakdown.push({
      kind: 'bonus',
      label: `Forced-Shiny check (Search Level ${searchLevel})`,
      rolls: baseChecks,
      input: 'searchLevel',
      ...check,
    });
    if (charmChecks > 0) {
      breakdown.push({
        kind: 'charm',
        label: `${SHINY_CHARM_LABEL} checks`,
        rolls: charmChecks,
        ...check,
      });
    }
    if (milestoneChecks > 0) {
      breakdown.push({
        kind: 'bonus',
        label: isFiftieth ? '50th chained encounter' : '100th chained encounter',
        rolls: milestoneChecks,
        input: 'chain',
        ...check,
      });
    }
    const boost: OddsBreakdownRow = {
      kind: 'bonus',
      label: boostGuaranteed ? `Every ${boostEvery}th chained encounter` : 'Random boost',
      rolls: boostChecks,
      input: 'chain',
      ...check,
    };
    if (!boostGuaranteed) boost.chance = boostChance;
    if (boostGuaranteed || boostChance > 0) breakdown.push(boost);
  }

  // No single roll count describes a mix of 1/4096 rolls and percentage checks.
  return { perPokemon, rolls: null, breakdown };
};

// ───────────────────────────── SwSh — chain fishing ─────────────────────────────

/** `[Number Battled, [Brilliant chance in ‰, bonus rolls of a Brilliant spawn]]`, highest tier first (spec step 1). */
const BRILLIANT_TIERS: readonly (readonly [number, readonly [permille: number, rolls: number]])[] =
  [
    [500, [30, 6]],
    [300, [30, 5]],
    [200, [30, 4]],
    [100, [30, 3]],
    [50, [25, 2]],
    [20, [20, 1]],
    [1, [15, 1]],
  ];

/** `[fishing streak, ‰ added to the Brilliant chance]`, highest tier first (spec step 2). */
const FISHING_STREAK_TIERS: readonly (readonly [number, number])[] = [
  [25, 250],
  [15, 100],
  [7, 50],
  [3, 20],
];

/**
 * `swsh-brilliant-fishing`: a fishing streak raises the chance that the spawn
 * is Brilliant; only Brilliant spawns get the Number Battled bonus rolls. The
 * result is the average over both outcomes.
 */
export const swshBrilliantFishing: OddsFormula = (context) => {
  const defeated = wholeCount(context.number('defeated'));
  const chain = wholeCount(context.number('chain'));

  // 1–2. Tier look-ups.
  const [brilliantPermille, bonusRolls] = firstTier(BRILLIANT_TIERS, defeated, [0, 0] as const);
  const chainPermille = firstTier(FISHING_STREAK_TIERS, chain, 0);

  // 3. With nothing battled the Brilliant check is skipped entirely.
  const brilliantChance =
    defeated >= 1 ? clampChance((brilliantPermille + chainPermille) / 1000) : 0;

  // 4–6. Rolls of a normal and of a Brilliant spawn.
  const denominator = context.param('denominator', context.denominator);
  const charmRolls = context.charmApplied ? context.param('charmRolls', context.charmRolls) : 0;
  const baseRolls = 1 + charmRolls;
  const pNormal = context.rollsToProbability(baseRolls, denominator);
  const pBrilliant = context.rollsToProbability(baseRolls + bonusRolls, denominator);

  // 7. Average per fishing encounter.
  const perPokemon = (1 - brilliantChance) * pNormal + brilliantChance * pBrilliant;

  const breakdown: OddsBreakdownRow[] = [{ kind: 'base', label: BASE_ROLL_LABEL, rolls: 1 }];
  if (charmRolls > 0)
    breakdown.push({ kind: 'charm', label: SHINY_CHARM_LABEL, rolls: charmRolls });
  if (bonusRolls > 0 && brilliantChance > 0) {
    breakdown.push({
      kind: 'bonus',
      label: 'Brilliant aura (Number Battled)',
      rolls: bonusRolls,
      chance: brilliantChance,
      input: 'defeated',
    });
  }
  return { perPokemon, rolls: baseRolls + brilliantChance * bonusRolls, breakdown };
};

// ───────────────────────────── SV — boosted event outbreak ─────────────────────────────

const SPARKLING_ROLLS: Readonly<Record<string, number>> = { none: 0, lv1: 1, lv2: 2, lv3: 3 };

/**
 * `sv-event-outbreak`: a flat event check comes first; only when it fails does
 * the game make the normal outbreak rolls.
 */
export const svEventOutbreak: OddsFormula = (context) => {
  const defeated = wholeCount(context.number('defeated'));
  const sparkling = context.select('sparkling');
  const eventChance = clampChance(context.param('eventChance', 0.005));

  // 1–4. The same rolls as a regular outbreak.
  const outbreakRolls = defeated >= 60 ? 2 : defeated >= 30 ? 1 : 0;
  const sparklingRolls = Object.hasOwn(SPARKLING_ROLLS, sparkling)
    ? (SPARKLING_ROLLS[sparkling] ?? 0)
    : 0;
  const rolls = 1 + outbreakRolls + sparklingRolls + context.charmRolls;

  // 5–6. Event check first, the rolls only when it fails.
  const pNormal = context.rollsToProbability(rolls);
  const perPokemon = eventChance + (1 - eventChance) * pNormal;

  const breakdown: OddsBreakdownRow[] = [
    { kind: 'bonus', label: 'Event Shiny check', rolls: 1, unit: 'check', perRoll: eventChance },
    ...baseRows(context),
  ];
  if (outbreakRolls > 0) {
    breakdown.push({
      kind: 'bonus',
      label: `Outbreak clears (${defeated >= 60 ? '60+' : '30+'})`,
      rolls: outbreakRolls,
      input: 'defeated',
    });
  }
  if (sparklingRolls > 0) {
    breakdown.push({
      kind: 'bonus',
      label: `Sparkling Power Lv. ${sparklingRolls}`,
      rolls: sparklingRolls,
      input: 'sparkling',
    });
  }
  return { perPokemon, rolls, breakdown };
};

// ───────────────────────────── Registry ─────────────────────────────

/** Every custom formula the bundled data names, by formula id. */
export const CUSTOM_FORMULAS: Readonly<Record<string, OddsFormula>> = {
  'oras-dexnav': orasDexNav,
  'swsh-brilliant-fishing': swshBrilliantFishing,
  'sv-event-outbreak': svEventOutbreak,
};

/** Registers {@link CUSTOM_FORMULAS} for every engine. Safe to call more than once. */
export function registerCustomFormulas(): void {
  for (const [id, formula] of Object.entries(CUSTOM_FORMULAS)) registerFormula(id, formula);
}
