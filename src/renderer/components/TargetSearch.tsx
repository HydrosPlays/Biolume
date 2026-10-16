import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crosshair, Plus, RefreshCw, WifiOff } from 'lucide-react';
import { usePokemon, useSpeciesDetail } from '@renderer/api/hooks';
import { describePokeApiError } from '@renderer/api/pokeapi';
import { Badge, Button, EmptyState, Page, ScrollArea } from '@renderer/components/ui';
import { navigate } from '@renderer/hooks';
import { oddsEngine } from '@renderer/lib/oddsData';
import { findByPokemonId, toTargetRef, type VarietyRef } from '@renderer/lib/species';
import { actions, toast, useActiveHunt, useStoreReady } from '@renderer/store';
import { EncounterAnalysis } from './target/EncounterAnalysis';
import { isBreedingMethod } from './target/helpers';
import { useRecentTargets, useSpriteStyle } from './target/persisted';
import { SearchRail } from './target/SearchRail';
import { SpeciesFacts, SpeciesHero } from './target/SpeciesPanel';
import styles from './target/TargetView.module.css';

/** Wild level used until a hunt or the user says otherwise. */
const DEFAULT_LEVEL = 25;
/** Quiet period before a level change is written to the hunt (the slider fires continuously). */
const LEVEL_SAVE_DELAY_MS = 300;

/**
 * Target view — species search and encounter analysis.
 *
 * Selecting a species only PREVIEWS it; "Set as hunt target" writes it to the
 * active hunt. Until something is picked the view follows the hunt's target.
 */
export default function TargetSearch() {
  const hunt = useActiveHunt();
  const ready = useStoreReady();
  const huntId = hunt?.id ?? null;
  const targetId = hunt?.target?.pokemonId ?? null;

  const [picked, setPicked] = useState<number | null>(null);
  const previewId = picked ?? targetId;
  const variety = useMemo(
    () => (previewId === null ? null : findByPokemonId(previewId)),
    [previewId],
  );
  const speciesId = variety?.species.id ?? null;
  const isTarget = hunt !== null && previewId !== null && previewId === targetId;

  const { recents, remember, clear } = useRecentTargets();
  const [spriteStyle, setSpriteStyle] = useSpriteStyle();
  const [busy, setBusy] = useState(false);

  const pokemonQuery = usePokemon(variety ? previewId : null);
  const speciesQuery = useSpeciesDetail(speciesId);

  // ── Game context: the hunt's game unless the user looks at another one ──
  const [gameOverride, setGameOverride] = useState<string | null>(null);
  const huntGame = hunt ? oddsEngine.getGame(hunt.odds.gameId) : undefined;
  const game =
    (gameOverride === null ? undefined : oddsEngine.getGame(gameOverride)) ??
    huntGame ??
    oddsEngine.defaultGame;
  const methodId = hunt && huntGame && game.id === huntGame.id ? hunt.odds.methodId : null;
  const changeGame = (gameId: string | null) => {
    setGameOverride(gameId === null || gameId === huntGame?.id ? null : gameId);
  };

  // ── Wild level: the hunt's own level for its target, a scratch value while browsing ──
  const [browseLevel, setBrowseLevel] = useState<number | null>(null);
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const level =
    isTarget && hunt
      ? (pendingLevel ?? hunt.targetLevel)
      : (browseLevel ?? hunt?.targetLevel ?? DEFAULT_LEVEL);

  const saveTimer = useRef<number | null>(null);
  const saveJob = useRef<{ huntId: string; level: number } | null>(null);
  const flushLevel = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const job = saveJob.current;
    saveJob.current = null;
    if (!job) return;
    // The store has the new level before this settles, so dropping the local value cannot flicker.
    void actions.updateHunt(job.huntId, { targetLevel: job.level }).finally(() => {
      setPendingLevel((current) => (current === job.level ? null : current));
    });
  }, []);
  // Leaving the view must not lose a level that is still waiting to be saved.
  useEffect(() => flushLevel, [flushLevel]);

  const changeLevel = useCallback(
    (next: number) => {
      if (!isTarget || huntId === null) {
        setBrowseLevel(next);
        return;
      }
      setPendingLevel(next);
      saveJob.current = { huntId, level: next };
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flushLevel, LEVEL_SAVE_DELAY_MS);
    },
    [isTarget, huntId, flushLevel],
  );

  const select = useCallback(
    (next: VarietyRef) => {
      const id = next.form?.pokemonId ?? next.species.id;
      setPicked(id);
      remember(id);
    },
    [remember],
  );

  // A different species starts at the top of the analyzer; switching forms keeps the place.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [speciesId]);

  const assign = async () => {
    if (!variety) return;
    const target = toTargetRef(variety.species, variety.form);
    setBusy(true);
    try {
      if (hunt) {
        const previous = { target: hunt.target, targetLevel: hunt.targetLevel };
        const updated = await actions.updateHunt(hunt.id, { target, targetLevel: level });
        if (updated) {
          toast.success(`Now hunting ${target.name}`, {
            description: `Target of “${hunt.name}”, analysed at Lv. ${level}.`,
            action: { label: 'Undo', onClick: () => void actions.updateHunt(hunt.id, previous) },
          });
        }
      } else {
        const created = await actions.createHunt({
          name: `Shiny ${target.name}`,
          target,
          targetLevel: level,
          ...(gameOverride === null ? {} : { odds: oddsEngine.defaultSelection(game.id) }),
        });
        if (created) {
          toast.success(`Hunt created for ${target.name}`, {
            action: { label: 'Open counter', onClick: () => navigate('hunt') },
          });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const name = variety ? (variety.form?.name ?? variety.species.name) : null;
  const failure = pokemonQuery.error ?? speciesQuery.error;
  const retrying = pokemonQuery.isFetching || speciesQuery.isFetching;
  const retry = () => {
    if (pokemonQuery.isError) void pokemonQuery.refetch();
    if (speciesQuery.isError) void speciesQuery.refetch();
  };

  const subtitle = !ready
    ? 'Loading hunts…'
    : hunt
      ? `${hunt.name} · ${hunt.target ? `hunting ${hunt.target.name}` : 'no target yet'}`
      : 'No active hunt — search and analysis work without one';

  const action = !variety ? null : isTarget ? (
    <Badge tone="teal" icon={<Check />}>
      Current hunt target
    </Badge>
  ) : hunt ? (
    <Button
      variant="primary"
      leadingIcon={<Crosshair />}
      loading={busy}
      onClick={() => void assign()}
    >
      Set as hunt target
    </Button>
  ) : (
    <Button variant="primary" leadingIcon={<Plus />} loading={busy} onClick={() => void assign()}>
      Create hunt for {name}
    </Button>
  );

  return (
    <Page
      title="Target"
      subtitle={subtitle}
      icon={<Crosshair />}
      width="wide"
      scroll={false}
      className={styles.layout}
      actions={action}
    >
      <SearchRail
        previewId={previewId}
        targetId={targetId}
        recents={recents}
        onSelect={select}
        onClearRecents={clear}
      />

      <ScrollArea ref={scrollRef} frameClassName={styles.analyzer} className={styles.viewport}>
        {variety ? (
          <div className={styles.content}>
            {failure ? (
              <div className={styles.offline} role="status" data-tone="warn">
                <WifiOff aria-hidden="true" />
                <div className={styles.offlineText}>
                  <strong>Showing bundled data only</strong>
                  <p>
                    {describePokeApiError(failure)} Name, typing, generation and sprite addresses
                    come from the local index; stats, abilities and the learnset appear once PokeAPI
                    answers.
                  </p>
                </div>
                <Button size="sm" leadingIcon={<RefreshCw />} loading={retrying} onClick={retry}>
                  Retry
                </Button>
              </div>
            ) : null}

            <div className={styles.stack}>
              <div className={styles.hero}>
                <SpeciesHero
                  variety={variety}
                  species={speciesQuery.data}
                  speciesLoading={speciesQuery.isPending}
                  isTarget={isTarget}
                  spriteStyle={spriteStyle}
                  onSpriteStyleChange={setSpriteStyle}
                  onSelectForm={select}
                  generation={game.generation}
                />
              </div>
              <div className={styles.analysis}>
                <EncounterAnalysis
                  variety={variety}
                  pokemon={pokemonQuery.data}
                  loading={pokemonQuery.isPending}
                  error={pokemonQuery.error}
                  onRetry={retry}
                  level={level}
                  onLevelChange={changeLevel}
                  levelSaved={isTarget}
                  game={game}
                  huntGameId={huntGame?.id ?? null}
                  onGameChange={changeGame}
                  methodId={methodId}
                />
              </div>
              <div className={styles.facts}>
                <SpeciesFacts
                  pokemon={pokemonQuery.data}
                  pokemonLoading={pokemonQuery.isPending}
                  species={speciesQuery.data}
                  speciesLoading={speciesQuery.isPending}
                  generation={game.generation}
                  breeding={methodId !== null && isBreedingMethod(methodId)}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.empty}>
            <EmptyState
              icon={<Crosshair />}
              title={
                hunt && !hunt.target ? 'This hunt has no target yet' : 'Pick a species to analyse'
              }
              description="Search on the left. The analyzer predicts the four moves a wild Pokémon knows at your level and flags every one that could cost you the encounter — Explosion, Teleport, recoil and the rest."
            />
          </div>
        )}
      </ScrollArea>
    </Page>
  );
}
