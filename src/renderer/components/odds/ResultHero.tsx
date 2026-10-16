import { ArrowUpRight, TriangleAlert } from 'lucide-react';
import { Badge, Button, Panel } from '@renderer/components/ui';
import {
  formatCount,
  formatOdds,
  formatOddsDenominator,
  formatPercent,
} from '@renderer/lib/format';
import type { OddsBreakdownRow, OddsDescription } from '@renderer/lib/odds';
import styles from './Odds.module.css';

/** `3` → `3`, `2.68` → `2.68`: roll counts are whole unless chance-gated bonuses average in. */
export function formatRolls(rolls: number): string {
  return Number.isInteger(rolls) ? String(rolls) : rolls.toFixed(2).replace(/0$/, '');
}

/** "×3 better than full odds", with one decimal while it matters. */
export function formatMultiplier(multiplier: number): string {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return '—';
  const text =
    multiplier >= 100 ? multiplier.toFixed(0) : multiplier.toFixed(1).replace(/\.0$/, '');
  return `×${text}`;
}

function rowAmount(row: OddsBreakdownRow): string {
  const unit = row.unit ?? 'roll';
  const amount = `${row.kind === 'base' ? '' : '+'}${formatRolls(row.rolls)} ${unit}${row.rolls === 1 ? '' : 's'}`;
  return row.perRoll === undefined ? amount : `${amount} at ${formatPercent(row.perRoll)}`;
}

export interface ResultHeroProps {
  description: OddsDescription;
  /** Switches the selection to the method's best case. */
  onApplyBest: () => void;
}

/** The headline result: "1 in N", what it means per encounter, how it compares, and where the rolls come from. */
export function ResultHero({ description, onApplyBest }: ResultHeroProps) {
  const { result, multiplier, best, atBest } = description;
  const { game, method } = result;
  const boosted = multiplier > 1.005;
  const reduced = multiplier < 0.995;
  const denominator = formatOddsDenominator(result.perEncounter);

  return (
    <Panel
      className={styles.hero}
      accent={boosted ? 'violet' : 'cyan'}
      padding="lg"
      aria-label="Shiny odds"
    >
      <div className={styles.heroMain}>
        <p className="eyebrow">
          {game.shortName} · {method.name}
        </p>
        <p className={styles.oneIn} data-boosted={boosted || undefined}>
          <span className={styles.oneInPrefix}>1 in</span>
          <span className={styles.oneInValue}>{denominator}</span>
        </p>
        <p className={styles.heroSub}>
          <span className={styles.heroPercent}>{formatPercent(result.perEncounter)}</span> per
          encounter
          {Number.isFinite(description.expectedEncounters) ? (
            <> · {formatCount(description.expectedEncounters)} encounters on average</>
          ) : null}
        </p>
        {result.pokemonPerEncounter > 1 ? (
          <p className={styles.heroNote}>
            {result.pokemonPerEncounter} Pokémon per encounter — each one is{' '}
            {formatOdds(result.perPokemon)}.
          </p>
        ) : null}
      </div>

      <div className={styles.heroSide}>
        {boosted ? (
          <Badge tone="violet" variant="soft">
            {formatMultiplier(multiplier)} better than full odds
          </Badge>
        ) : reduced ? (
          <Badge tone="warn" variant="soft">
            {formatMultiplier(multiplier)} of full odds
          </Badge>
        ) : (
          <Badge tone="neutral" variant="outline">
            Full odds
          </Badge>
        )}
        {result.charmApplied ? (
          <Badge tone="shiny" variant="outline">
            Shiny Charm on
          </Badge>
        ) : null}
        <p className={styles.heroBase}>
          Full odds 1 in {formatCount(game.baseDenominator)}
          {atBest && result.valid && boosted ? ' · best case for this method' : ''}
        </p>
        {atBest ? null : (
          <Button
            size="sm"
            variant="ghost"
            trailingIcon={<ArrowUpRight />}
            onClick={onApplyBest}
            title="Switch every setting to the value that gives the best odds"
          >
            Best case {formatOdds(best.perEncounter)}
          </Button>
        )}
      </div>

      {result.warnings.length > 0 ? (
        <ul className={styles.warnings} role="status">
          {result.warnings.map((warning) => (
            <li key={warning}>
              <TriangleAlert aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <section className={styles.breakdown} aria-label="Roll breakdown">
        <h3 className="eyebrow">Roll breakdown</h3>
        {result.breakdown.length > 0 ? (
          <>
            <ul className={styles.rolls}>
              {result.breakdown.map((row) => (
                <li key={`${row.kind}-${row.label}`} data-kind={row.kind}>
                  <span className={styles.rollLabel}>{row.label}</span>
                  {row.chance !== undefined ? (
                    <span className={styles.rollChance}>
                      {formatPercent(row.chance)} of encounters
                    </span>
                  ) : null}
                  <span className={styles.rollAmount}>{rowAmount(row)}</span>
                </li>
              ))}
            </ul>
            {result.rolls !== null && result.denominator !== null ? (
              <p className={styles.rollTotal}>
                <span>{Number.isInteger(result.rolls) ? 'Total' : 'Average'}</span>
                <span className={styles.rollAmount}>
                  {formatRolls(result.rolls)} roll{result.rolls === 1 ? '' : 's'} at 1 in{' '}
                  {formatCount(result.denominator)}
                </span>
              </p>
            ) : null}
          </>
        ) : (
          <p className={styles.muted}>
            {result.valid
              ? 'This method uses odds fixed by the game rather than extra rolls, so there is nothing to break down.'
              : 'The breakdown is unavailable while the method cannot be evaluated.'}
          </p>
        )}
      </section>
    </Panel>
  );
}
