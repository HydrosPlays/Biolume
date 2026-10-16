import { useMemo, useState } from 'react';
import { ChartSpline, Crosshair, Leaf, ListChecks, Sandwich, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Page,
  Panel,
  SegmentedControl,
  TypeBadge,
  toast,
  type SegmentedOption,
} from '@renderer/components/ui';
import { navigate } from '@renderer/hooks';
import { formatOdds, titleCase } from '@renderer/lib/format';
import { oddsEngine, sandwichData } from '@renderer/lib/oddsData';
import { actions, useActiveHunt } from '@renderer/store';
import { SourceLinks } from './odds/SourceLinks';
import { RecipeCard } from './sandwich/RecipeCard';
import {
  HERBA_ORDER,
  MEAL_TYPES,
  filterRecipes,
  isMealType,
  preselectedType,
  sparklingOdds,
  withSparklingLv3,
  type MealType,
  type SandwichGoal,
} from './sandwich/sandwich';
import styles from './sandwich/Sandwich.module.css';

const GOALS: readonly SegmentedOption<SandwichGoal>[] = [
  { value: 'sparkling', label: 'Sparkling Power Lv. 3', icon: <Sparkles /> },
  { value: 'encounter', label: 'Encounter only · no Herba', icon: <Leaf /> },
];

/** Notes shown before "Show all": the ones every hunter needs (duration, type restriction, what is excluded). */
const NOTES_PREVIEW = 4;

/** What Sparkling Power does to the odds, computed once from the bundled SV data. */
const SPARKLING_ODDS = sparklingOdds(oddsEngine);

/**
 * Sandwiches view — Scarlet / Violet recipes for shiny hunting, filtered by
 * the Pokémon type to hunt and by whether Herba Mystica is on the table.
 */
export default function SandwichHelper() {
  const hunt = useActiveHunt();
  const target = hunt?.target ?? null;
  const suggested = preselectedType(target);

  // `undefined` follows the active hunt's target; null is an explicit "all types".
  const [picked, setPicked] = useState<MealType | null | undefined>(undefined);
  const [goal, setGoal] = useState<SandwichGoal>('sparkling');
  const [allNotes, setAllNotes] = useState(false);
  const type = picked === undefined ? suggested : picked;
  const followsTarget = picked === undefined && suggested !== null;

  const recipes = useMemo(() => filterRecipes(sandwichData.recipes, type, goal), [type, goal]);
  const neededHerba = useMemo(() => {
    const needed = new Set<string>();
    for (const recipe of recipes) {
      for (const id of HERBA_ORDER) if ((recipe.herba[id] ?? 0) > 0) needed.add(id);
    }
    return needed;
  }, [recipes]);

  const otherTargetTypes = (target?.types ?? [])
    .map((entry) => entry.toLowerCase())
    .filter((entry): entry is MealType => isMealType(entry) && entry !== type);

  const sparklingPatch = hunt ? withSparklingLv3(oddsEngine, hunt.odds) : null;
  const applySparkling = async (): Promise<void> => {
    if (!hunt || !sparklingPatch) return;
    const saved = await actions.updateHunt(hunt.id, { odds: sparklingPatch });
    if (saved) {
      toast.success('Sparkling Power Lv. 3 applied', {
        description: `${hunt.name} now counts the sandwich's extra shiny rolls.`,
      });
    }
  };

  const notes = allNotes ? sandwichData.notes : sandwichData.notes.slice(0, NOTES_PREVIEW);
  const hiddenNotes = sandwichData.notes.length - NOTES_PREVIEW;

  return (
    <Page
      title="Sandwiches"
      subtitle="Scarlet / Violet meal powers for shiny hunting"
      icon={<Sandwich />}
      actions={
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<ChartSpline />}
          onClick={() => navigate('odds')}
        >
          Open Odds
        </Button>
      }
    >
      <div className={styles.container}>
        <div className={styles.view}>
          {/* ── How it works + link into the odds engine ── */}
          <Panel
            className={styles.intro}
            title="How sandwiches help"
            icon={<Sparkles />}
            accent="shiny"
          >
            <p className={styles.summary}>{sandwichData.summary}</p>
            <div className={styles.oddsLink}>
              <div className={styles.oddsText}>
                <p className={styles.oddsLead}>
                  Sparkling Power adds shiny rolls
                  {SPARKLING_ODDS?.extraRolls
                    ? ` — Lv. 3 gives ${SPARKLING_ODDS.extraRolls} extra per Pokémon of the meal's type.`
                    : '.'}
                </p>
                {SPARKLING_ODDS ? (
                  <dl className={styles.oddsFacts}>
                    <div>
                      <dt>No sandwich</dt>
                      <dd>{formatOdds(SPARKLING_ODDS.base)}</dd>
                    </div>
                    <div data-lit>
                      <dt>Sparkling Lv. 3</dt>
                      <dd>{formatOdds(SPARKLING_ODDS.sparkling)}</dd>
                    </div>
                    <div data-lit>
                      <dt>+ Shiny Charm</dt>
                      <dd>{formatOdds(SPARKLING_ODDS.sparklingCharm)}</dd>
                    </div>
                  </dl>
                ) : null}
                <p className={styles.oddsHint}>
                  In the Odds view, pick Scarlet / Violet and set <em>Sparkling Power</em> on the
                  method to see the curve and milestones with the sandwich active.
                </p>
              </div>
              <div className={styles.oddsActions}>
                <Button
                  variant="primary"
                  leadingIcon={<ChartSpline />}
                  onClick={() => navigate('odds')}
                >
                  See it in Odds
                </Button>
                {hunt && sparklingPatch ? (
                  <Button
                    variant="shiny"
                    leadingIcon={<Sparkles />}
                    onClick={() => void applySparkling()}
                  >
                    Set Lv. 3 on {hunt.name}
                  </Button>
                ) : null}
              </div>
            </div>
          </Panel>

          {/* ── Filters ── */}
          <Panel className={styles.filters} title="Find a recipe" icon={<Crosshair />}>
            <div className={styles.filterRow}>
              <span className={styles.filterLabel} id="sandwich-goal-label">
                Goal
              </span>
              <SegmentedControl
                aria-labelledby="sandwich-goal-label"
                options={GOALS}
                value={goal}
                onChange={setGoal}
              />
            </div>
            <div className={styles.filterRow}>
              <span className={styles.filterLabel} id="sandwich-type-label">
                Pokémon type
              </span>
              <div className={styles.types} role="group" aria-labelledby="sandwich-type-label">
                <Chip selected={type === null} onClick={() => setPicked(null)}>
                  All types
                </Chip>
                {MEAL_TYPES.map((entry) => (
                  <TypeBadge
                    key={entry}
                    type={entry}
                    selected={type === entry}
                    onClick={() => setPicked(entry)}
                  />
                ))}
              </div>
            </div>
            <p className={styles.preselect} role="status">
              {followsTarget && target && type ? (
                <>
                  <Badge tone="teal" size="sm" dot>
                    Preselected
                  </Badge>
                  <span>
                    {titleCase(type)} is the primary type of your target, {target.name}.
                    {otherTargetTypes.length > 0
                      ? ` It is also ${otherTargetTypes.map(titleCase).join(' / ')}-type — a sandwich of either type boosts it.`
                      : ''}
                  </span>
                </>
              ) : hunt && !target ? (
                <span>Set a target on {hunt.name} and its primary type is preselected here.</span>
              ) : !hunt ? (
                <span>
                  Pick the type of the Pokémon you are hunting. With an active hunt, its
                  target&rsquo;s type is preselected.
                </span>
              ) : picked !== undefined && suggested !== null && type !== suggested ? (
                <Button size="sm" variant="ghost" onClick={() => setPicked(undefined)}>
                  Back to {target?.name ?? 'the target'}&rsquo;s type ({titleCase(suggested)})
                </Button>
              ) : (
                <span>Sandwich powers only affect Pokémon of the meal&rsquo;s type.</span>
              )}
            </p>
          </Panel>

          {/* ── Recipes ── */}
          <section className={styles.results} aria-label="Recipes">
            <header className={styles.resultsHead}>
              <h2 className={styles.resultsTitle}>
                {type ? `${titleCase(type)} recipes` : 'All recipes'}
                <span className={styles.resultsCount}>{recipes.length}</span>
              </h2>
              <p className={styles.resultsHint}>
                {goal === 'sparkling'
                  ? 'Sparkling, Title and Encounter Power — needs Herba Mystica.'
                  : 'Encounter Power without Herba Mystica: isolates a type, adds no shiny rolls.'}
              </p>
            </header>
            {recipes.length > 0 ? (
              <div className={styles.grid}>
                {recipes.map((recipe) => (
                  <RecipeCard key={recipe.id} recipe={recipe} herba={sandwichData.herba} />
                ))}
              </div>
            ) : (
              <EmptyState
                size="sm"
                icon={<Sandwich />}
                title="No recipe for this combination"
                description="The bundled table has no sandwich for this type and goal. Try the other goal or another type."
                action={
                  <Button size="sm" onClick={() => setPicked(null)}>
                    Show all types
                  </Button>
                }
              />
            )}
          </section>

          {/* ── Reference ── */}
          <div className={styles.reference}>
            <Panel title="Where Herba Mystica comes from" icon={<Leaf />}>
              <ul className={styles.herbaLegend}>
                {sandwichData.herba.map((entry) => {
                  const needed = neededHerba.has(entry.id);
                  return (
                    <li key={entry.id} data-herba={entry.id}>
                      <details open={needed}>
                        <summary>
                          <span className={styles.herbaDot} aria-hidden="true" />
                          <span className={styles.herbaName}>{entry.name}</span>
                          {needed ? (
                            <Badge tone="violet" size="sm" variant="outline">
                              Used above
                            </Badge>
                          ) : null}
                        </summary>
                        <p>{entry.source}</p>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel title="Good to know" icon={<ListChecks />}>
              <ul className={styles.notes} id="sandwich-notes">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              {hiddenNotes > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className={styles.notesToggle}
                  aria-expanded={allNotes}
                  aria-controls="sandwich-notes"
                  onClick={() => setAllNotes((open) => !open)}
                >
                  {allNotes ? 'Show fewer notes' : `Show all ${sandwichData.notes.length} notes`}
                </Button>
              ) : null}
              <details className={styles.sources}>
                <summary>Sources ({sandwichData.sources.length})</summary>
                <SourceLinks sources={sandwichData.sources} label="Sandwich data sources" />
              </details>
            </Panel>
          </div>
        </div>
      </div>
    </Page>
  );
}
