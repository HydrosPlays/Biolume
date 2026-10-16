import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { SearchX, X } from 'lucide-react';
import { usePrefetchTarget } from '@renderer/api/hooks';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  IconButton,
  Kbd,
  ScrollArea,
  SearchInput,
  Select,
  Sprite,
  TypeBadge,
  type SelectOption,
} from '@renderer/components/ui';
import { isEditableTarget } from '@renderer/hooks';
import { titleCase } from '@renderer/lib/format';
import {
  findByPokemonId,
  GENERATIONS,
  POKEMON_TYPES,
  searchSpecies,
  type SpeciesSearchResult,
  type VarietyRef,
} from '@renderer/lib/species';
import { spriteCandidates } from '@renderer/lib/sprites';
import { formatDex } from './helpers';
import styles from './SearchRail.module.css';

/** Results rendered at once; "Show more" extends the list by the same amount. */
const PAGE_SIZE = 60;
/** How long the pointer must rest on a result before its data is fetched ahead. */
const PREFETCH_DWELL_MS = 160;
/** Rows jumped by PageUp / PageDown. */
const PAGE_JUMP = 8;

const ALL = 'all';

const GENERATION_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: 'All gens', keywords: 'any generation' },
  ...GENERATIONS.map((generation) => ({
    value: String(generation),
    label: `Gen ${generation}`,
    keywords: `generation ${generation}`,
  })),
];

const TYPE_OPTIONS: readonly SelectOption[] = [
  { value: ALL, label: 'All types' },
  ...POKEMON_TYPES.map((type) => ({
    value: type,
    label: titleCase(type),
    icon: <TypeBadge type={type} size="dot" />,
  })),
];

export interface SearchRailProps {
  /** `pokemon` id shown in the analyzer. */
  previewId: number | null;
  /** `pokemon` id of the active hunt's target. */
  targetId: number | null;
  /** Recently previewed `pokemon` ids, newest first. */
  recents: readonly number[];
  onSelect: (variety: VarietyRef) => void;
  onClearRecents: () => void;
}

/**
 * Instant species search over the bundled index. The text field owns the
 * keyboard (↑ ↓ PageUp PageDown move, Enter previews, Esc clears, then leaves
 * the field); the list follows it through `aria-activedescendant`.
 */
export function SearchRail({
  previewId,
  targetId,
  recents,
  onSelect,
  onClearRecents,
}: SearchRailProps) {
  const [query, setQuery] = useState('');
  const [generation, setGeneration] = useState(ALL);
  const [type, setType] = useState(ALL);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prefetchTimer = useRef<number | null>(null);
  const listId = useId();
  const prefetch = usePrefetchTarget();

  // The index is in memory and a query is one pass over it — search on every keystroke.
  const found = useMemo(
    () =>
      searchSpecies(query, {
        limit: limit + 1,
        generation: generation === ALL ? null : Number(generation),
        type: type === ALL ? null : type,
      }),
    [query, generation, type, limit],
  );
  const hasMore = found.length > limit;
  const results = hasMore ? found.slice(0, limit) : found;
  const activeIndex = Math.min(active, Math.max(0, results.length - 1));
  const filtered = generation !== ALL || type !== ALL;
  const optionId = useCallback((index: number) => `${listId}-option-${index}`, [listId]);

  const restart = () => {
    setActive(0);
    setLimit(PAGE_SIZE);
  };

  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current !== null) {
      window.clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
    }
  }, []);
  useEffect(() => cancelPrefetch, [cancelPrefetch]);

  const warm = (hit: SpeciesSearchResult) => {
    cancelPrefetch();
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      prefetch({ pokemonId: hit.pokemonId, speciesId: hit.species.id });
    }, PREFETCH_DWELL_MS);
  };

  const choose = (hit: SpeciesSearchResult, index: number) => {
    cancelPrefetch();
    setActive(index);
    onSelect({ species: hit.species, form: hit.form });
  };

  // Keep the highlighted row in view; a new query starts again from the top.
  useEffect(() => {
    const option = document.getElementById(optionId(activeIndex));
    if (option && typeof option.scrollIntoView === 'function') {
      option.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, optionId, query, generation, type]);

  // "/" jumps to the search field from anywhere in the view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const last = results.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(last, index)));
    };
    switch (event.key) {
      case 'ArrowDown':
        move(activeIndex + 1);
        break;
      case 'ArrowUp':
        move(activeIndex - 1);
        break;
      case 'PageDown':
        move(activeIndex + PAGE_JUMP);
        break;
      case 'PageUp':
        move(activeIndex - PAGE_JUMP);
        break;
      case 'Enter': {
        const hit = results[activeIndex];
        if (hit) {
          event.preventDefault();
          choose(hit, activeIndex);
        }
        break;
      }
      case 'Escape':
        // With text in the field the SearchInput clears it; a second press leaves the field.
        if (query === '') event.currentTarget.blur();
        break;
      default:
    }
  };

  const recentEntries = recents.flatMap((id) => {
    const variety = findByPokemonId(id);
    return variety ? [{ id, variety }] : [];
  });

  const summary =
    results.length === 0
      ? 'No matches'
      : query.trim() === ''
        ? filtered
          ? `${results.length}${hasMore ? '+' : ''} in dex order`
          : 'National Dex order'
        : results[0]?.match === 'fuzzy'
          ? 'Closest matches'
          : `${results.length}${hasMore ? '+' : ''} ${results.length === 1 ? 'match' : 'matches'}`;

  return (
    <aside className={styles.rail} aria-label="Species search">
      <SearchInput
        ref={inputRef}
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          restart();
        }}
        onKeyDown={onKeyDown}
        placeholder="Name or dex number"
        role="combobox"
        aria-label="Search species"
        aria-autocomplete="list"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={results.length > 0 ? optionId(activeIndex) : undefined}
      />

      <div className={styles.filters}>
        <Select
          size="sm"
          aria-label="Generation filter"
          options={GENERATION_OPTIONS}
          value={generation}
          onChange={(value) => {
            setGeneration(value);
            restart();
          }}
        />
        <Select
          size="sm"
          aria-label="Type filter"
          options={TYPE_OPTIONS}
          value={type}
          onChange={(value) => {
            setType(value);
            restart();
          }}
        />
      </div>

      <div className={styles.meta}>
        <span aria-live="polite">{summary}</span>
        <span className={styles.keys} aria-hidden="true">
          <Kbd size="sm">↑</Kbd>
          <Kbd size="sm">↓</Kbd>
          <Kbd size="sm">Enter</Kbd>
        </span>
      </div>

      <ScrollArea frameClassName={styles.resultsFrame} className={styles.results}>
        <ul id={listId} role="listbox" aria-label="Species results" className={styles.list}>
          {results.map((hit, index) => (
            <li
              key={hit.pokemonId}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              aria-current={hit.pokemonId === previewId ? 'true' : undefined}
              aria-label={`${hit.name}, ${formatDex(hit.species.id)}, ${hit.types
                .map(titleCase)
                .join(' and ')}, generation ${hit.species.gen}`}
              className={styles.option}
              data-active={index === activeIndex || undefined}
              data-current={hit.pokemonId === previewId || undefined}
              data-form={hit.form !== null || undefined}
              onClick={() => choose(hit, index)}
              onMouseEnter={() => warm(hit)}
              onMouseLeave={cancelPrefetch}
            >
              <Sprite
                src={spriteCandidates(hit.pokemonId, { style: 'pixel' })}
                alt=""
                size={40}
                className={styles.optionSprite}
              />
              <span className={styles.optionBody}>
                <span className={styles.optionTop}>
                  <span className={styles.optionName}>{hit.name}</span>
                  <span className={styles.optionDex}>{formatDex(hit.species.id)}</span>
                </span>
                <span className={styles.optionBottom}>
                  {hit.types.map((slug) => (
                    <TypeBadge key={slug} type={slug} size="sm" />
                  ))}
                  <span className={styles.optionGen}>Gen {hit.species.gen}</span>
                  {hit.pokemonId === targetId ? (
                    <Badge tone="teal" size="sm" className={styles.optionTarget}>
                      Target
                    </Badge>
                  ) : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
        {results.length === 0 ? (
          <EmptyState
            size="sm"
            icon={<SearchX />}
            title="No species match"
            description={
              filtered
                ? 'Nothing fits that search within the current filters.'
                : 'Try a different spelling, or a National Dex number.'
            }
            action={
              filtered ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setGeneration(ALL);
                    setType(ALL);
                    restart();
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {hasMore ? (
          <div className={styles.more}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLimit((value) => value + PAGE_SIZE)}
            >
              Show more
            </Button>
          </div>
        ) : null}
      </ScrollArea>

      {recentEntries.length > 0 ? (
        <section className={styles.recents} aria-label="Recent targets">
          <div className={styles.recentsHead}>
            <span className="eyebrow">Recent targets</span>
            <IconButton label="Clear recent targets" size="sm" onClick={onClearRecents}>
              <X />
            </IconButton>
          </div>
          <div className={styles.recentChips}>
            {recentEntries.map(({ id, variety }) => (
              <Chip
                key={id}
                size="sm"
                selected={id === previewId}
                icon={<Sprite src={spriteCandidates(id, { style: 'pixel' })} alt="" size={18} />}
                onClick={() => onSelect(variety)}
              >
                {variety.form?.name ?? variety.species.name}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
}
