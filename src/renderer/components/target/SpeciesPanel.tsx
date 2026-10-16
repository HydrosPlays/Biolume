import type { CSSProperties, ReactNode } from 'react';
import { Dna, ExternalLink } from 'lucide-react';
import type { PokemonDetail, PokemonStats, SpeciesDetail } from '@renderer/api/pokeapi';
import {
  Badge,
  Button,
  Chip,
  Panel,
  SegmentedControl,
  Skeleton,
  Sprite,
  StatBar,
  Tooltip,
  TypeBadge,
  type SegmentedOption,
  type Tone,
} from '@renderer/components/ui';
import { formatCount, formatPercent, titleCase } from '@renderer/lib/format';
import type { VarietyRef } from '@renderer/lib/species';
import { spriteCandidates, type SpriteStyle } from '@renderer/lib/sprites';
import { actions } from '@renderer/store';
import {
  bulbapediaUrl,
  catchDifficulty,
  formatDex,
  genderSplit,
  hatchSteps,
  serebiiUrl,
  type CatchTier,
} from './helpers';
import styles from './SpeciesPanel.module.css';

const SPRITE_SIZE = 104;

const STYLE_OPTIONS: readonly SegmentedOption<SpriteStyle>[] = [
  { value: 'pixel', label: 'Pixel' },
  { value: 'home', label: 'HOME' },
  { value: 'artwork', label: 'Artwork' },
];

function varietyName(variety: VarietyRef): string {
  return variety.form?.name ?? variety.species.name;
}

// ───────────────────────────── Hero ─────────────────────────────

export interface SpeciesHeroProps {
  variety: VarietyRef;
  /** Species data from PokeAPI; undefined while loading or when unavailable. */
  species: SpeciesDetail | undefined;
  speciesLoading: boolean;
  /** This variety is the active hunt's target. */
  isTarget: boolean;
  spriteStyle: SpriteStyle;
  onSpriteStyleChange: (style: SpriteStyle) => void;
  onSelectForm: (variety: VarietyRef) => void;
  /** Generation of the game in context — picks the matching Serebii Pokédex. */
  generation: number;
}

/** Identity of the previewed Pokémon: regular vs shiny, typing, flags, forms and links out. */
export function SpeciesHero({
  variety,
  species,
  speciesLoading,
  isTarget,
  spriteStyle,
  onSpriteStyleChange,
  onSelectForm,
  generation,
}: SpeciesHeroProps) {
  const { species: entry, form } = variety;
  const pokemonId = form?.pokemonId ?? entry.id;
  const name = varietyName(variety);
  const types = form?.types ?? entry.types;
  const pixelated = spriteStyle === 'pixel';

  return (
    <section className={styles.hero} aria-label={`${name} overview`}>
      <div className={styles.heroInner}>
        <div className={styles.sprites}>
          <figure className={styles.spriteCard}>
            <Sprite
              src={spriteCandidates(pokemonId, { style: spriteStyle })}
              alt={`${name}, regular colouring`}
              size={SPRITE_SIZE}
              pixelated={pixelated}
              loading="eager"
            />
            <figcaption>Regular</figcaption>
          </figure>
          <figure className={styles.spriteCard} data-shiny>
            <Sprite
              src={spriteCandidates(pokemonId, { style: spriteStyle, shiny: true })}
              alt={`${name}, shiny colouring`}
              size={SPRITE_SIZE}
              pixelated={pixelated}
              loading="eager"
              shiny
            />
            <figcaption>Shiny</figcaption>
          </figure>
        </div>

        <div className={styles.identity}>
          <p className={styles.kicker}>
            <span className={styles.dex}>{formatDex(entry.id)}</span>
            <span>Gen {entry.gen}</span>
            {species?.genus ? (
              <span>{species.genus}</span>
            ) : speciesLoading ? (
              <Skeleton width={96} />
            ) : null}
          </p>
          <h2 className={styles.name}>{name}</h2>
          <div className={styles.tags}>
            {types.map((type) => (
              <TypeBadge key={type} type={type} />
            ))}
            {isTarget ? (
              <Badge tone="teal" dot="pulse">
                Hunt target
              </Badge>
            ) : null}
            {species?.isLegendary ? <Badge tone="violet">Legendary</Badge> : null}
            {species?.isMythical ? <Badge tone="magenta">Mythical</Badge> : null}
            {species?.isBaby ? <Badge tone="info">Baby</Badge> : null}
            {species?.hasGenderDifferences ? (
              <Tooltip content="Males and females look different — compare against the right one when judging a shiny.">
                <Badge tone="neutral" variant="outline" tabIndex={0} className={styles.focusable}>
                  Gender differences
                </Badge>
              </Tooltip>
            ) : null}
          </div>

          {entry.forms.length > 0 ? (
            <div className={styles.forms} role="group" aria-label="Forms">
              <Chip
                size="sm"
                selected={form === null}
                onClick={() => onSelectForm({ species: entry, form: null })}
              >
                {entry.baseLabel ?? 'Base form'}
              </Chip>
              {entry.forms.map((option) => (
                <Chip
                  key={option.pokemonId}
                  size="sm"
                  tone="violet"
                  selected={form?.pokemonId === option.pokemonId}
                  onClick={() => onSelectForm({ species: entry, form: option })}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
          ) : null}

          <div className={styles.heroFoot}>
            <SegmentedControl
              size="sm"
              aria-label="Sprite style"
              options={STYLE_OPTIONS}
              value={spriteStyle}
              onChange={onSpriteStyleChange}
            />
            <span className={styles.links}>
              <Button
                variant="ghost"
                size="sm"
                trailingIcon={<ExternalLink />}
                onClick={() => void actions.openExternal(bulbapediaUrl(entry))}
              >
                Bulbapedia
              </Button>
              <Button
                variant="ghost"
                size="sm"
                trailingIcon={<ExternalLink />}
                onClick={() => void actions.openExternal(serebiiUrl(entry, generation))}
              >
                Serebii
              </Button>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────── Facts ─────────────────────────────

const STAT_ROWS: readonly { key: Exclude<keyof PokemonStats, 'total'>; label: string }[] = [
  { key: 'hp', label: 'HP' },
  { key: 'atk', label: 'Attack' },
  { key: 'def', label: 'Defense' },
  { key: 'spa', label: 'Sp. Atk' },
  { key: 'spd', label: 'Sp. Def' },
  { key: 'spe', label: 'Speed' },
];

/** PokeAPI egg-group slugs → the names the games use. */
const EGG_GROUP_NAMES: Record<string, string> = {
  monster: 'Monster',
  water1: 'Water 1',
  water2: 'Water 2',
  water3: 'Water 3',
  bug: 'Bug',
  flying: 'Flying',
  ground: 'Field',
  fairy: 'Fairy',
  plant: 'Grass',
  humanshape: 'Human-Like',
  mineral: 'Mineral',
  indeterminate: 'Amorphous',
  ditto: 'Ditto',
  dragon: 'Dragon',
  'no-eggs': 'No Eggs Discovered',
};

const CATCH_TONES: Record<CatchTier, Tone> = {
  'very-easy': 'teal',
  easy: 'teal',
  moderate: 'info',
  hard: 'warn',
  'very-hard': 'warn',
  brutal: 'danger',
};

interface SectionProps {
  title: string;
  /** Data has not arrived yet. */
  loading: boolean;
  /** Data is not coming (offline / error) — say so instead of leaving a hole. */
  missing: boolean;
  skeletonLines?: number;
  className?: string;
  children: ReactNode;
}

function Section({
  title,
  loading,
  missing,
  skeletonLines = 3,
  className,
  children,
}: SectionProps) {
  return (
    <div className={className}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {loading ? (
        <Skeleton lines={skeletonLines} />
      ) : missing ? (
        <p className={styles.missing}>Needs PokeAPI — not cached yet.</p>
      ) : (
        children
      )}
    </div>
  );
}

export interface SpeciesFactsProps {
  pokemon: PokemonDetail | undefined;
  pokemonLoading: boolean;
  species: SpeciesDetail | undefined;
  speciesLoading: boolean;
  /** Generation of the game in context (catch formula). */
  generation: number;
  /** The hunt hatches Eggs — bring the hatch data forward. */
  breeding: boolean;
}

/** Base stats, abilities, catching and breeding facts, and the Pokédex entry. */
export function SpeciesFacts({
  pokemon,
  pokemonLoading,
  species,
  speciesLoading,
  generation,
  breeding,
}: SpeciesFactsProps) {
  const catching = species ? catchDifficulty(species.captureRate, generation) : null;
  const gender = species ? genderSplit(species.genderRate) : null;
  const steps = species ? hatchSteps(species.hatchCounter) : null;
  const cannotBreed = species?.eggGroups.includes('no-eggs') ?? false;

  return (
    <Panel
      title="Species data"
      icon={<Dna />}
      className={styles.facts}
      bodyClassName={styles.factsGrid}
    >
      <Section
        title="Base stats"
        loading={pokemonLoading}
        missing={!pokemon}
        skeletonLines={7}
        className={styles.stats}
      >
        {pokemon ? (
          <>
            <div className={styles.statList}>
              {STAT_ROWS.map((row) => (
                <StatBar key={row.key} label={row.label} value={pokemon.stats[row.key]} />
              ))}
            </div>
            <p className={styles.total}>
              <span>Total</span>
              <span className={styles.totalValue}>{pokemon.stats.total}</span>
            </p>
          </>
        ) : null}
      </Section>

      <Section title="Abilities" loading={pokemonLoading} missing={!pokemon} skeletonLines={2}>
        {pokemon ? (
          <ul className={styles.abilities}>
            {pokemon.abilities.map((ability) => (
              <li key={`${ability.slug}:${ability.hidden}`}>
                <span>{ability.name}</span>
                {ability.hidden ? (
                  <Badge tone="violet" size="sm">
                    Hidden
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Catching" loading={speciesLoading} missing={!species}>
        {species ? (
          <div className={styles.block}>
            <p className={styles.factLine}>
              <span className={styles.factLabel}>Capture rate</span>
              <span className={styles.factValue}>{species.captureRate ?? '—'}</span>
              <span className={styles.factUnit}>/ 255</span>
              {catching ? (
                <Badge tone={CATCH_TONES[catching.tier]} size="sm">
                  {catching.label}
                </Badge>
              ) : null}
            </p>
            {catching ? (
              <>
                <p className={styles.hint}>{catching.hint}</p>
                <p className={styles.chances}>
                  <span>
                    Poké Ball, full HP <strong>≈ {formatPercent(catching.fullHp)}</strong>
                  </span>
                  <span>
                    Ultra Ball, 1 HP + asleep <strong>≈ {formatPercent(catching.prepared)}</strong>
                  </span>
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section title="Breeding" loading={speciesLoading} missing={!species}>
        {species && gender ? (
          <div className={styles.block} data-emphasis={breeding || undefined}>
            <div className={styles.gender}>
              {gender.genderless ? null : (
                <span
                  className={styles.genderBar}
                  style={{ '--male': `${gender.male * 100}%` } as CSSProperties}
                  aria-hidden="true"
                />
              )}
              <span>{gender.label}</span>
            </div>
            <p className={styles.factLine}>
              <span className={styles.factLabel}>Egg groups</span>
              <span>
                {species.eggGroups.length === 0
                  ? '—'
                  : species.eggGroups
                      .map((slug) => EGG_GROUP_NAMES[slug] ?? titleCase(slug))
                      .join(' · ')}
              </span>
            </p>
            <p className={styles.factLine}>
              <span className={styles.factLabel}>Hatch time</span>
              {cannotBreed ? (
                <span>Cannot be bred</span>
              ) : species.hatchCounter === null || steps === null ? (
                <span>—</span>
              ) : (
                <span>
                  <span className={styles.factValue}>{species.hatchCounter}</span> cycles · ≈{' '}
                  {formatCount(steps)} steps
                </span>
              )}
            </p>
            {breeding && !cannotBreed && steps !== null ? (
              <p className={styles.hint}>
                Egg hunt: a Flame Body or Magma Armor Pokémon in the party halves that to about{' '}
                {formatCount(Math.ceil(steps / 2))} steps per Egg.
              </p>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title="Pokédex"
        loading={speciesLoading}
        missing={!species}
        className={styles.dexEntry}
      >
        {species ? (
          <>
            <p className={styles.flavor}>
              {species.flavorText ?? 'No English Pokédex entry is available.'}
            </p>
            <p className={styles.dexMeta}>
              {species.flavorTextVersion ? (
                <span>{titleCase(species.flavorTextVersion)}</span>
              ) : null}
              {pokemon ? (
                <span>
                  {pokemon.height} m · {pokemon.weight} kg
                </span>
              ) : null}
              {species.growthRate ? <span>{titleCase(species.growthRate)} growth</span> : null}
            </p>
          </>
        ) : null}
      </Section>
    </Panel>
  );
}
