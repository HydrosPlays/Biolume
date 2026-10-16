import { useState } from 'react';
import { Dices, RotateCcw } from 'lucide-react';
import { Button, Field, NumberField, Panel, StatBar, type Tone } from '@renderer/components/ui';
import { formatCount, formatPercent } from '@renderer/lib/format';
import { binomialAtLeast, binomialPmf } from '@renderer/lib/probability';
import styles from './Odds.module.css';

/** Upper bound of the editable encounter count. */
const MAX_ENCOUNTERS = 100_000_000;

export interface BinomialOutcome {
  label: string;
  probability: number;
  tone: Tone;
}

/** P(exactly 0 / 1 / 2) and P(3 or more) shinies in `encounters` tries at constant odds. */
export function binomialOutcomes(encounters: number, perEncounter: number): BinomialOutcome[] {
  return [
    { label: 'None', probability: binomialPmf(encounters, 0, perEncounter), tone: 'neutral' },
    { label: 'Exactly 1', probability: binomialPmf(encounters, 1, perEncounter), tone: 'teal' },
    { label: 'Exactly 2', probability: binomialPmf(encounters, 2, perEncounter), tone: 'violet' },
    {
      label: '3 or more',
      probability: binomialAtLeast(encounters, 3, perEncounter),
      tone: 'magenta',
    },
  ];
}

/** Expected shinies with sensible precision: `0.37`, `12.4`, `180`. */
export function formatExpected(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 100) return formatCount(value);
  return value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

export interface BinomialPanelProps {
  /** Per-encounter odds of the current selection. */
  perEncounter: number;
  /** Encounter count shown until the user types their own: the hunt total, or the odds denominator. */
  defaultEncounters: number;
  /** What the default stands for, e.g. "the hunt total". */
  defaultLabel: string;
}

/** How many shinies to expect in N encounters: the binomial distribution, as bars. */
export function BinomialPanel({
  perEncounter,
  defaultEncounters,
  defaultLabel,
}: BinomialPanelProps) {
  // Null follows the default (and keeps following it as the hunt total grows).
  const [custom, setCustom] = useState<number | null>(null);
  const encounters = custom ?? defaultEncounters;
  const outcomes = binomialOutcomes(encounters, perEncounter);
  const expected = encounters * perEncounter;

  return (
    <Panel
      title="Shinies in N encounters"
      subtitle="Binomial distribution at the current odds"
      icon={<Dices />}
    >
      <div className={styles.stack}>
        <Field
          label="Encounters (N)"
          hint={custom === null ? `Following ${defaultLabel}.` : undefined}
          trailing={
            custom !== null ? (
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<RotateCcw />}
                onClick={() => setCustom(null)}
              >
                Use {defaultLabel}
              </Button>
            ) : undefined
          }
        >
          <NumberField
            value={encounters}
            min={0}
            max={MAX_ENCOUNTERS}
            step={1}
            largeStep={100}
            format={formatCount}
            width={12}
            onChange={(value) => setCustom(value === defaultEncounters ? null : value)}
          />
        </Field>

        <div
          className={styles.bars}
          role="group"
          aria-label="Probability of each number of shinies"
        >
          {outcomes.map((outcome) => (
            <StatBar
              key={outcome.label}
              label={outcome.label}
              aria-label={`${outcome.label}: ${formatPercent(outcome.probability)}`}
              value={outcome.probability}
              max={1}
              tone={outcome.tone}
              valueLabel={formatPercent(outcome.probability)}
            />
          ))}
        </div>

        <dl className={styles.facts}>
          <div>
            <dt>Expected shinies</dt>
            <dd>{formatExpected(expected)}</dd>
          </div>
          <div>
            <dt>At least one</dt>
            <dd>{formatPercent(1 - (outcomes[0]?.probability ?? 1))}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
