import { Fragment, useMemo } from 'react';
import {
  Egg,
  Info,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { describePokeApiError, type LevelUpMove, type PokemonDetail } from '@renderer/api/pokeapi';
import {
  Button,
  EmptyState,
  Field,
  NumberField,
  Panel,
  Select,
  Skeleton,
  Slider,
  Tooltip,
  TypeBadge,
  type SelectItem,
} from '@renderer/components/ui';
import type { GameDef, RiskSeverity } from '@renderer/data/schema';
import { titleCase } from '@renderer/lib/format';
import {
  getMove,
  MOVESET_SIZE,
  moveName,
  predictWildMoveset,
  resolveVersionGroup,
  versionGroupLabel,
  wildMoveLevelRanges,
} from '@renderer/lib/moveset';
import { oddsEngine } from '@renderer/lib/oddsData';
import { analyzeRisk, type RiskContext, type RiskFlag } from '@renderer/lib/risk';
import type { VarietyRef } from '@renderer/lib/species';
import { LIMITS } from '@shared/defaults';
import {
  addsEggMoves,
  buildLearnsetRows,
  buildRiskTimeline,
  formatLevelRanges,
  isBreedingMethod,
  riskVerdict,
  upcomingAdvice,
  type LearnsetState,
  type RiskSegment,
} from './helpers';
import styles from './EncounterAnalysis.module.css';
import { GameEncounters } from './GameEncounters';

const GAME_OPTIONS: readonly SelectItem[] = oddsEngine.gamesByGeneration().map((group) => ({
  label: `Generation ${group.generation}`,
  options: group.games.map((game) => ({
    value: game.id,
    label: game.name,
    meta: game.shortName,
    keywords: game.shortName,
  })),
}));

const SEVERITY_LABELS: Record<RiskSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const STATE_LABELS: Record<LearnsetState, string> = {
  current: 'In moveset',
  replaced: 'Replaced',
  upcoming: 'Later',
};

const { min: MIN_LEVEL, max: MAX_LEVEL } = LIMITS.targetLevel;

function learnedAt(level: number): string {
  return level === 0 ? 'Evolution' : `Lv. ${level}`;
}

// ───────────────────────────── Move card ─────────────────────────────

interface MoveCardProps {
  move: LevelUpMove;
  risk: RiskFlag | null;
  /** Levels at which the move is part of the wild moveset, e.g. `Lv. 26–46`. */
  carried: string | null;
}

function MoveCard({ move, risk, carried }: MoveCardProps) {
  const info = getMove(move.slug);
  const name = risk?.name ?? info?.name ?? moveName(move.slug);
  return (
    <article className={styles.move} data-risk={risk?.severity} aria-label={name}>
      <header className={styles.moveHead}>
        <h4 className={styles.moveName}>{name}</h4>
        <span className={styles.moveLevel}>{learnedAt(move.level)}</span>
      </header>
      {info ? (
        <>
          <div className={styles.moveMeta}>
            <TypeBadge type={info.type} size="sm" />
            <span className={styles.moveClass}>{titleCase(info.class)}</span>
          </div>
          <dl className={styles.moveStats}>
            <div>
              <dt>Power</dt>
              <dd>{info.power ?? '—'}</dd>
            </div>
            <div>
              <dt>Accuracy</dt>
              <dd>{info.accuracy === null ? '—' : `${info.accuracy}%`}</dd>
            </div>
            <div>
              <dt>PP</dt>
              <dd>{info.pp ?? '—'}</dd>
            </div>
          </dl>
        </>
      ) : (
        <p className={styles.quiet}>Not in the bundled move index.</p>
      )}
      {risk ? (
        <div className={styles.moveRisk}>
          <p className={styles.riskLine}>
            <TriangleAlert aria-hidden="true" />
            <span className={styles.riskTag}>{SEVERITY_LABELS[risk.severity]} risk</span>
            <span>{risk.category.label}</span>
          </p>
          <p>{risk.move.reason}</p>
          {risk.move.counter ? (
            <p className={styles.counter}>
              <strong>Counter</strong> {risk.move.counter}
            </p>
          ) : null}
          {carried ? <p className={styles.quiet}>In the wild moveset at {carried}.</p> : null}
          {risk.move.detail ? (
            <details className={styles.mechanics}>
              <summary>Mechanics</summary>
              <p>{risk.move.detail}</p>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ───────────────────────────── Timeline ─────────────────────────────

interface RiskTimelineProps {
  segments: readonly RiskSegment[];
  level: number;
  onLevelChange: (level: number) => void;
}

/** Levels 1–100 as one strip, coloured by the worst risk move carried at each level. */
function RiskTimeline({ segments, level, onLevelChange }: RiskTimelineProps) {
  return (
    <div className={styles.timeline}>
      <div className={styles.track} role="group" aria-label="Risk by wild level">
        {segments.map((segment) => {
          const inside = level >= segment.from && level <= segment.to;
          const range = formatLevelRanges([segment]);
          const text = `${range}: ${riskVerdict(segment.level).label}${
            segment.moves.length > 0 ? ` — ${segment.moves.join(', ')}` : ''
          }`;
          return (
            <Tooltip key={segment.from} content={text} decorative>
              <button
                type="button"
                className={styles.segment}
                data-risk={segment.level}
                aria-label={text}
                aria-pressed={inside}
                style={{ flexGrow: segment.to - segment.from + 1 }}
                onClick={() => {
                  if (!inside) onLevelChange(segment.from);
                }}
              />
            </Tooltip>
          );
        })}
        <span className={styles.marker} style={{ left: `${level - 0.5}%` }} aria-hidden="true" />
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>1</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
    </div>
  );
}

// ───────────────────────────── Panel ─────────────────────────────

export interface EncounterAnalysisProps {
  variety: VarietyRef;
  /** Movepool source; undefined while loading or when PokeAPI is unreachable. */
  pokemon: PokemonDetail | undefined;
  loading: boolean;
  /** Why `pokemon` is missing, when it is not simply loading. */
  error: unknown;
  onRetry: () => void;
  level: number;
  onLevelChange: (level: number) => void;
  /** The level is stored on the active hunt (this Pokémon is its target). */
  levelSaved: boolean;
  /** Game whose learnset and mechanics are analysed. */
  game: GameDef;
  /** Game of the active hunt; null without one. */
  huntGameId: string | null;
  /** Switch the analysed game; null returns to the hunt's game. */
  onGameChange: (gameId: string | null) => void;
  /** Hunting method of the active hunt while `game` is the hunt's game; null otherwise. */
  methodId: string | null;
}

/**
 * The point of the Target view: what a wild Pokémon knows at a level, which of
 * those moves can cost the hunter the encounter, and how that changes as the
 * level goes up.
 */
export function EncounterAnalysis({
  variety,
  pokemon,
  loading,
  error,
  onRetry,
  level,
  onLevelChange,
  levelSaved,
  game,
  huntGameId,
  onGameChange,
  methodId,
}: EncounterAnalysisProps) {
  const name = variety.form?.name ?? variety.species.name;
  const types = pokemon?.types ?? variety.form?.types ?? variety.species.types;
  const generation = game.generation;
  const context = useMemo<RiskContext>(() => ({ types, generation }), [types, generation]);

  const resolved = useMemo(
    () => (pokemon ? resolveVersionGroup(pokemon, game.versionGroups) : null),
    [pokemon, game],
  );
  const versionGroup = resolved?.versionGroup ?? null;
  const eggMethod = methodId !== null && addsEggMoves(methodId);

  const model = useMemo(() => {
    if (!pokemon || versionGroup === null) return null;
    const prediction = predictWildMoveset(pokemon, versionGroup, level);
    const analysis = analyzeRisk({
      ...context,
      moveset: prediction.moves,
      known: prediction.known,
      upcoming: prediction.upcoming,
      alternates: prediction.alternates,
      eggMoves: eggMethod ? pokemon.moves[versionGroup]?.other.egg : undefined,
    });
    const carried = new Map<string, string>();
    for (const flag of [...analysis.flags, ...analysis.upcoming]) {
      const ranges = wildMoveLevelRanges(pokemon, versionGroup, flag.slug);
      if (ranges.length > 0) carried.set(flag.slug, formatLevelRanges(ranges));
    }
    return {
      prediction,
      analysis,
      carried,
      risks: new Map(analysis.moveset.map((entry) => [entry.slug, entry.risk])),
      rows: buildLearnsetRows(prediction, context),
    };
  }, [pokemon, versionGroup, level, context, eggMethod]);

  // Independent of the level, so dragging the slider does not rebuild it.
  const timeline = useMemo(
    () => (pokemon ? buildRiskTimeline(pokemon, versionGroup, context) : []),
    [pokemon, versionGroup, context],
  );

  const overridden = huntGameId !== null && game.id !== huntGameId;
  const method = methodId ? oddsEngine.getMethod(game.id, methodId) : undefined;
  const riskLevel = model?.analysis.level;

  return (
    <Panel
      title="Encounter analysis"
      subtitle={`What a wild ${name} knows at this level — and what can go wrong`}
      icon={<Radar />}
      accent={riskLevel === 'critical' ? 'danger' : riskLevel === 'none' ? 'teal' : 'none'}
      className={styles.encounter}
      bodyClassName={styles.body}
    >
      <div className={styles.controls}>
        <div className={styles.levelControl}>
          <Field label="Wild level" hint={levelSaved ? 'Saved to the hunt' : 'Preview only'}>
            <NumberField
              value={level}
              onChange={onLevelChange}
              min={MIN_LEVEL}
              max={MAX_LEVEL}
              width={4}
            />
          </Field>
          <Slider
            aria-label="Wild level"
            className={styles.levelSlider}
            value={level}
            onChange={onLevelChange}
            min={MIN_LEVEL}
            max={MAX_LEVEL}
            showValue={false}
            formatValue={(value) => `Level ${value}`}
          />
        </div>
        <Field
          label="Game"
          className={styles.gameControl}
          hint={
            huntGameId === null
              ? 'No active hunt — pick any game'
              : overridden
                ? 'Analysis only; the hunt keeps its own game'
                : 'From the active hunt'
          }
          trailing={
            overridden ? (
              <button type="button" className={styles.reset} onClick={() => onGameChange(null)}>
                Use hunt’s game
              </button>
            ) : undefined
          }
        >
          <Select options={GAME_OPTIONS} value={game.id} onChange={(id) => onGameChange(id)} />
        </Field>
      </div>

      {method && isBreedingMethod(method.id) ? (
        <p className={styles.note} data-tone="info">
          <Egg aria-hidden="true" />
          <span>
            This hunt uses {method.name}: hatchlings never battle, so the moves below only matter
            when you meet {name} in the wild.
          </span>
        </p>
      ) : null}

      <GameEncounters
        gameId={game.id}
        gameName={game.name}
        pokemonId={variety.form?.pokemonId ?? variety.species.id}
        name={name}
        level={level}
        onLevelChange={onLevelChange}
      />

      {loading ? (
        <div className={styles.loading} aria-busy="true" aria-label="Loading learnset">
          <Skeleton shape="block" height={104} />
          <div className={styles.moves}>
            {Array.from({ length: MOVESET_SIZE }, (_, index) => (
              <Skeleton key={index} shape="block" height={112} />
            ))}
          </div>
        </div>
      ) : !pokemon ? (
        <EmptyState
          size="sm"
          tone="danger"
          icon={<WifiOff />}
          title="Learnset unavailable"
          description={`${describePokeApiError(error)} The moveset prediction needs this Pokémon's learnset once; it is cached afterwards.`}
          action={
            <Button size="sm" leadingIcon={<RefreshCw />} onClick={onRetry}>
              Try again
            </Button>
          }
        />
      ) : !model ? (
        <EmptyState
          size="sm"
          icon={<Info />}
          title="No level-up data"
          description={`PokeAPI lists no level-up learnset for ${name} in any game, so its wild moveset cannot be predicted.`}
        />
      ) : (
        <>
          {resolved?.fallback ? (
            <p className={styles.note} data-tone="warn">
              <TriangleAlert aria-hidden="true" />
              <span>
                No level-up data for {game.name}; showing {versionGroupLabel(versionGroup ?? '')}{' '}
                instead. {name} may not exist in that game, so treat levels and moves as a guide.
              </span>
            </p>
          ) : null}

          <section className={styles.banner} data-risk={model.analysis.level}>
            <div className={styles.bannerHead} role="status">
              <span className={styles.bannerIcon} aria-hidden="true">
                {model.analysis.level === 'none' ? <ShieldCheck /> : <ShieldAlert />}
              </span>
              <div>
                <p className={styles.bannerLabel}>
                  {model.analysis.level === 'none'
                    ? 'Clear'
                    : `${riskVerdict(model.analysis.level).label} risk`}{' '}
                  · Lv. {model.prediction.level}
                </p>
                <h3 className={styles.bannerTitle}>{riskVerdict(model.analysis.level).title}</h3>
              </div>
            </div>

            {model.analysis.flags.length > 0 ? (
              <ul className={styles.bannerList}>
                {model.analysis.flags.map((flag) => (
                  <li key={flag.slug} data-risk={flag.severity}>
                    <strong>{flag.name}</strong> — {flag.move.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.bannerText}>
                None of the moves it carries at Lv. {model.prediction.level} can end the encounter
                on its own.
              </p>
            )}

            {model.analysis.possible.length > 0 ? (
              <ul className={styles.bannerList} data-kind="possible">
                {model.analysis.possible.map((flag) => (
                  <li key={`${flag.status}:${flag.slug}`} data-risk={flag.severity}>
                    {flag.text}
                  </li>
                ))}
              </ul>
            ) : null}

            {model.analysis.tips.length > 0 ? (
              <div className={styles.tips}>
                <h4 className={styles.tipsTitle}>Countermeasures</h4>
                <ul>
                  {model.analysis.tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {model.analysis.level === 'none' && model.analysis.upcoming[0] ? (
              <p className={styles.bannerText}>{upcomingAdvice(model.analysis.upcoming[0])}</p>
            ) : null}
          </section>

          <section aria-label="Predicted wild moveset">
            <h3 className={styles.heading}>
              Predicted moveset <span>Lv. {model.prediction.level}</span>
            </h3>
            <div className={styles.moves}>
              {model.prediction.moves.map((move) => (
                <MoveCard
                  key={move.slug}
                  move={move}
                  risk={model.risks.get(move.slug) ?? null}
                  carried={model.carried.get(move.slug) ?? null}
                />
              ))}
              {Array.from({ length: MOVESET_SIZE - model.prediction.moves.length }, (_, index) => (
                <div key={`empty-${index}`} className={styles.emptySlot}>
                  Empty slot
                </div>
              ))}
            </div>
            {model.prediction.alternates.length > 0 ? (
              <p className={styles.quiet}>
                Learned at the same level, so it may know one of these instead:{' '}
                {model.prediction.alternates.map((move) => moveName(move.slug)).join(', ')}.
              </p>
            ) : null}
          </section>

          <section aria-label="Risk by level">
            <h3 className={styles.heading}>
              Risk by level <span>select a band to jump there</span>
            </h3>
            <RiskTimeline segments={timeline} level={level} onLevelChange={onLevelChange} />
          </section>

          <div className={styles.columns}>
            <section aria-label="Upcoming threats">
              <h3 className={styles.heading}>Upcoming threats</h3>
              {model.analysis.upcoming.length === 0 ? (
                <p className={styles.quiet}>
                  No new risk moves are learned above Lv. {model.prediction.level}.
                </p>
              ) : (
                <ul className={styles.threats}>
                  {model.analysis.upcoming.map((flag) => (
                    <li key={flag.slug} data-risk={flag.severity}>
                      <p className={styles.riskLine}>
                        <span className={styles.riskTag}>{SEVERITY_LABELS[flag.severity]}</span>
                        <strong>{flag.name}</strong>
                        <span className={styles.threatLevel}>
                          {flag.level === null ? 'Later' : learnedAt(flag.level)}
                        </span>
                      </p>
                      <p>{upcomingAdvice(flag)}</p>
                      {model.carried.has(flag.slug) ? (
                        <p className={styles.quiet}>
                          In the wild moveset at {model.carried.get(flag.slug)}.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Level-up learnset">
              <h3 className={styles.heading}>
                Level-up learnset <span>{versionGroupLabel(versionGroup ?? '')}</span>
              </h3>
              <ol className={styles.learnset}>
                {model.rows.map((row, index) => {
                  const info = getMove(row.slug);
                  const firstUpcoming =
                    row.state === 'upcoming' && model.rows[index - 1]?.state !== 'upcoming';
                  return (
                    <Fragment key={row.key}>
                      {firstUpcoming ? (
                        <li className={styles.levelMarker}>
                          Lv. {model.prediction.level} · wild level
                        </li>
                      ) : null}
                      <li
                        className={styles.learnRow}
                        data-state={row.state}
                        data-risk={row.risk?.severity}
                      >
                        <span className={styles.learnLevel}>
                          {row.level === 0 ? 'Evo' : row.level}
                        </span>
                        {info ? <TypeBadge type={info.type} size="dot" /> : <span />}
                        <span className={styles.learnName}>
                          {row.risk?.name ?? info?.name ?? moveName(row.slug)}
                        </span>
                        {row.risk ? (
                          <span className={styles.riskTag}>
                            {SEVERITY_LABELS[row.risk.severity]}
                          </span>
                        ) : null}
                        <span className={styles.learnState}>{STATE_LABELS[row.state]}</span>
                      </li>
                    </Fragment>
                  );
                })}
                {model.prediction.upcoming.length === 0 ? (
                  <li className={styles.levelMarker}>
                    Lv. {model.prediction.level} · wild level — nothing new above
                  </li>
                ) : null}
              </ol>
            </section>
          </div>

          <p className={styles.footnote}>
            Prediction: the four most recent level-up moves at or below the level, the rule the
            main-series games use for wild Pokémon. Static and legendary encounters, raid bosses,
            Totem and alpha Pokémon can carry scripted movesets
            {eggMethod ? '; this hunting method can also add an Egg Move' : ''}. Power, accuracy and
            PP are current-generation values.
          </p>
        </>
      )}
    </Panel>
  );
}
