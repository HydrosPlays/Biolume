import { useMemo, useState } from 'react';
import { ChartSpline, Radar, Sandwich } from 'lucide-react';
import { huntTotal, type OddsSelection } from '@shared/types';
import {
  Badge,
  Button,
  Page,
  Panel,
  SegmentedControl,
  Skeleton,
  type SegmentedOption,
} from '@renderer/components/ui';
import { navigate } from '@renderer/hooks';
import { formatCount, formatOdds, formatPercent } from '@renderer/lib/format';
import { oddsEngine } from '@renderer/lib/oddsData';
import { useSessions, useStoreReady } from '@renderer/store';
import { BinomialPanel } from './odds/BinomialPanel';
import { MethodNotes } from './odds/MethodNotes';
import { MethodSetup } from './odds/MethodSetup';
import { MilestonesTable } from './odds/MilestonesTable';
import {
  CHART_MILESTONES,
  buildCurveModel,
  chainBaseSelection,
  chainPlateau,
  chainRamp,
  paceFromSessions,
  type CurveMode,
} from './odds/model';
import { ProbabilityChart } from './odds/ProbabilityChart';
import { ResultHero } from './odds/ResultHero';
import { useOddsSelection } from './odds/useOddsSelection';
import styles from './odds/Odds.module.css';

const CURVE_MODES: readonly SegmentedOption<CurveMode>[] = [
  { value: 'constant', label: 'Current odds' },
  { value: 'chain', label: 'Chain builds as you go' },
];

/**
 * Odds view — the hunting-method calculator. Bound to the active hunt's odds
 * selection (edits are saved to the hunt); a standalone calculator otherwise.
 */
export default function OddsEngine() {
  const ready = useStoreReady();
  const { hunt, selection, change, flush } = useOddsSelection();
  const sessions = useSessions();
  const [curveMode, setCurveMode] = useState<CurveMode>('constant');

  const description = useMemo(() => oddsEngine.describeOdds(selection), [selection]);
  const { result, chainInput, baseProbability } = description;
  const { game, method } = result;
  const total = hunt ? huntTotal(hunt) : null;

  // The chain ramp depends on everything except the chain value itself, so it
  // is keyed on the selection with the chain reset: dragging the chain slider
  // re-uses it instead of re-evaluating the whole chain every frame.
  const rampKey = chainInput
    ? JSON.stringify(chainBaseSelection(result.selection, chainInput))
    : null;
  const ramp = useMemo(() => {
    if (rampKey === null) return null;
    const base = JSON.parse(rampKey) as OddsSelection;
    const input = oddsEngine.chainInput(base);
    return input ? chainRamp(oddsEngine, base, input) : null;
  }, [rampKey]);
  const plateau = useMemo(
    () => (ramp && chainInput ? chainPlateau(ramp, chainInput) : null),
    [ramp, chainInput],
  );

  const chainCurve = curveMode === 'chain' && ramp !== null;
  const model = useMemo(
    () =>
      buildCurveModel({
        perEncounter: result.perEncounter,
        baseProbability,
        ramp: chainCurve ? ramp : null,
        total: total ?? 0,
      }),
    [result.perEncounter, baseProbability, chainCurve, ramp, total],
  );

  const markers = useMemo(
    () =>
      CHART_MILESTONES.map((probability) => ({
        probability,
        encounters: model.encountersFor(probability),
      })),
    [model],
  );
  const position = useMemo(
    () =>
      total !== null && total > 0
        ? { encounters: total, probability: model.probabilityAt(total) }
        : null,
    [model, total],
  );
  const pace = useMemo(() => paceFromSessions(sessions, hunt?.id ?? null), [sessions, hunt?.id]);

  const summary = useMemo(() => {
    const [half, ninety, almost] = markers;
    const lead = chainCurve
      ? `Building a ${method.name} chain from scratch`
      : `At ${formatOdds(result.perEncounter)} per encounter`;
    const spread =
      half && ninety && almost && Number.isFinite(almost.encounters)
        ? `${lead}, half of all hunts are over within ${formatCount(half.encounters)} encounters, 90 % within ${formatCount(ninety.encounters)} and 99 % within ${formatCount(almost.encounters)}.`
        : `${lead}, a shiny can never appear.`;
    if (!position || !hunt) return spread;
    return `${spread} ${hunt.name} is at ${formatCount(position.encounters)} encounters: ${formatPercent(position.probability)} of hunters would have found their shiny by now.`;
  }, [markers, chainCurve, method.name, result.perEncounter, position, hunt]);

  const expected = description.expectedEncounters;
  const followsHunt = total !== null && total > 0;
  const binomialDefault = followsHunt
    ? total
    : Number.isFinite(expected)
      ? Math.round(expected)
      : 0;

  const hasSparkling = game.id === 'sv' && method.inputs.some((input) => input.id === 'sparkling');

  if (!ready) {
    return (
      <Page title="Odds" subtitle="Loading your hunts…" icon={<ChartSpline />} width="wide">
        <div className={styles.loading} aria-busy="true" aria-label="Loading the odds calculator">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      </Page>
    );
  }

  return (
    <Page
      title="Odds"
      subtitle={
        hunt
          ? `Bound to ${hunt.name} — changes are saved to the hunt`
          : 'Standalone calculator — nothing here is saved to a hunt'
      }
      icon={<ChartSpline />}
      width="wide"
      actions={
        <>
          {hunt ? (
            <Badge tone="teal" dot="pulse">
              Active hunt
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Radar />}
              onClick={() => navigate('hunt')}
            >
              Start a hunt
            </Button>
          )}
          {hasSparkling ? (
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<Sandwich />}
              onClick={() => navigate('sandwich')}
            >
              Sandwich recipes
            </Button>
          ) : null}
        </>
      }
    >
      <div className={styles.container}>
        <div className={styles.layout}>
          <div className={styles.side}>
            <MethodSetup
              game={game}
              method={method}
              selection={result.selection}
              phaseCount={hunt ? hunt.count : null}
              chainPlateau={plateau}
              onChange={change}
              onFlush={flush}
            />
            <MethodNotes method={method} />
          </div>

          <div className={styles.main}>
            <ResultHero
              description={description}
              onApplyBest={() => change(description.best.selection)}
            />

            <Panel
              className={styles.curve}
              title="Probability curve"
              subtitle="Chance of at least one shiny by encounter"
              icon={<ChartSpline />}
              actions={
                chainInput ? (
                  <SegmentedControl
                    size="sm"
                    aria-label="Curve model"
                    options={CURVE_MODES}
                    value={curveMode}
                    onChange={setCurveMode}
                  />
                ) : undefined
              }
            >
              <ProbabilityChart
                curve={model.curve}
                comparison={model.comparison}
                maxN={model.maxN}
                probabilityAt={model.probabilityAt}
                comparisonAt={model.comparisonAt}
                markers={markers}
                position={position}
                label={`Cumulative shiny probability for ${method.name} in ${game.name}`}
                summary={summary}
                seriesLabel={chainCurve ? `${method.name} (chain)` : method.name}
                comparisonLabel={`Full odds (1 in ${formatCount(game.baseDenominator)})`}
              />
              {chainInput ? (
                <p className={styles.curveNote}>
                  {chainCurve
                    ? `Models a ${chainInput.label.toLowerCase()} that starts at ${formatCount(Math.min(chainInput.min, chainInput.max))} and grows by one with every encounter until the odds stop improving.`
                    : `Every encounter is counted at today's odds (${chainInput.label.toLowerCase()} of ${formatCount(Number(result.inputs[chainInput.id] ?? 0))}). Switch to “Chain builds as you go” to model the chain from its start.`}
                </p>
              ) : null}
            </Panel>

            <div className={styles.pair}>
              <MilestonesTable model={model} total={total} pace={pace} />
              <BinomialPanel
                perEncounter={result.perEncounter}
                defaultEncounters={binomialDefault}
                defaultLabel={followsHunt ? 'the hunt total' : 'the average hunt length'}
              />
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
