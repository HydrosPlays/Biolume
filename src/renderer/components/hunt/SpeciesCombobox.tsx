import { useMemo, useState } from 'react';
import { Combobox, Sprite, TypeBadge } from '@renderer/components/ui';
import { searchSpecies, type SpeciesSearchResult } from '@renderer/lib/species';
import { spriteUrl } from '@renderer/lib/sprites';
import styles from './dialogs.module.css';

export interface SpeciesComboboxProps {
  /** Text in the field (controlled). */
  value: string;
  onValueChange: (value: string) => void;
  /** A species (or one of its forms) was picked from the list. */
  onSelect: (result: SpeciesSearchResult) => void;
  /** Show shiny sprites in the results. */
  shiny?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Shown when the query matches nothing. */
  emptyMessage?: string;
  /**
   * Escape pressed while the result list is closed. Lets a dialog cancel on the
   * first Escape instead of the field clearing its text first; with the list
   * open, Escape still only closes the list.
   */
  onEscape?: () => void;
  'aria-label'?: string;
}

const RESULT_LIMIT = 8;

/** `#0280`-style National Dex number. */
export function formatDexNumber(id: number): string {
  return `#${String(id).padStart(4, '0')}`;
}

/**
 * The species a typed name refers to when nothing was picked from the list:
 * an exact name or dex-number match, otherwise null (it stays free text).
 */
export function resolveTypedSpecies(text: string): SpeciesSearchResult | null {
  if (text.trim() === '') return null;
  const best = searchSpecies(text, { limit: 1 })[0];
  if (!best) return null;
  return best.match === 'exact' || (best.match === 'dex' && best.score >= 1000) ? best : null;
}

/** Pixel sprite of a search hit, shiny or regular. */
export function resultSpriteUrl(result: SpeciesSearchResult, shiny: boolean): string | null {
  return spriteUrl(result.pokemonId, { style: 'pixel', shiny });
}

/**
 * The offline species search as a combobox: sprites, dex numbers and types in
 * the results, forms included. Free text stays in the field when nothing is
 * picked — the caller decides whether that is acceptable.
 */
export function SpeciesCombobox({
  value,
  onValueChange,
  onSelect,
  shiny = false,
  placeholder,
  autoFocus = false,
  emptyMessage = 'No Pokémon matches',
  onEscape,
  ...rest
}: SpeciesComboboxProps) {
  const items = useMemo(
    () => (value.trim() === '' ? [] : searchSpecies(value, { limit: RESULT_LIMIT })),
    [value],
  );

  return (
    <div
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape' || !onEscape) return;
        const expanded =
          event.target instanceof Element && event.target.getAttribute('aria-expanded') === 'true';
        if (expanded) return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      <Combobox<SpeciesSearchResult>
        value={value}
        onValueChange={onValueChange}
        items={items}
        getKey={(item) => String(item.pokemonId)}
        getLabel={(item) => `${item.name}, ${formatDexNumber(item.species.id)}`}
        onSelect={onSelect}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxHeight={280}
        emptyMessage={emptyMessage}
        aria-label={rest['aria-label']}
        renderItem={(item) => (
          <span className={styles.speciesOption}>
            <Sprite src={resultSpriteUrl(item, shiny)} alt="" size={34} />
            <span className={styles.speciesText}>
              <span className={styles.speciesName}>{item.name}</span>
              <span className={styles.speciesMeta}>
                {formatDexNumber(item.species.id)}
                {item.form ? ` · ${item.form.label}` : ''}
              </span>
            </span>
            <span className={styles.speciesTypes}>
              {item.types.map((type) => (
                <TypeBadge key={type} type={type} size="dot" />
              ))}
            </span>
          </span>
        )}
      />
    </div>
  );
}

export interface SpeciesFieldState {
  /** Text in the field. */
  text: string;
  /** The index entry the text stands for: the picked result, else an exact typed match, else null. */
  resolved: SpeciesSearchResult | null;
  onValueChange: (value: string) => void;
  onSelect: (result: SpeciesSearchResult) => void;
}

/**
 * State for a {@link SpeciesCombobox}: remembers the picked result (so a form
 * such as Alolan Vulpix survives) until the text is edited away from its name,
 * and falls back to an exact match on whatever was typed.
 */
export function useSpeciesField(
  initialText = '',
  onPick?: (result: SpeciesSearchResult) => void,
): SpeciesFieldState {
  const [text, setText] = useState(initialText);
  const [picked, setPicked] = useState<SpeciesSearchResult | null>(null);
  const typed = useMemo(() => resolveTypedSpecies(text), [text]);
  const stillPicked = picked !== null && picked.name === text.trim() ? picked : null;

  return {
    text,
    resolved: stillPicked ?? typed,
    onValueChange: setText,
    onSelect: (result) => {
      setPicked(result);
      setText(result.name);
      onPick?.(result);
    },
  };
}

export interface SpeciesPreviewProps {
  /** The index entry the field resolves to, if any. */
  result: SpeciesSearchResult | null;
  /** Current text of the field. */
  text: string;
  shiny?: boolean;
  /** `target` lights the card gold, `phase` violet. */
  variant: 'phase' | 'target';
  /** Line shown while the field is empty. */
  emptyLabel: string;
  /** Line shown under text that matches nothing in the index. */
  freeTextLabel: string;
}

/** What the species field currently stands for: a known Pokémon, free text, or nothing. */
export function SpeciesPreview({
  result,
  text,
  shiny = false,
  variant,
  emptyLabel,
  freeTextLabel,
}: SpeciesPreviewProps) {
  const typed = text.trim();
  return (
    <div
      className={styles.picked}
      data-matched={result ? '' : undefined}
      data-variant={variant}
      aria-live="polite"
    >
      <Sprite
        src={result ? resultSpriteUrl(result, shiny) : null}
        alt=""
        size={40}
        shiny={shiny && result !== null}
      />
      <div className={styles.pickedText}>
        <span className={styles.pickedName}>
          {result ? result.name : typed === '' ? emptyLabel : typed}
        </span>
        <span className={styles.pickedMeta}>
          {result
            ? `${formatDexNumber(result.species.id)}${result.form ? ` · ${result.form.label}` : ''}`
            : typed === ''
              ? 'Type a name or a dex number'
              : freeTextLabel}
        </span>
      </div>
      {result ? (
        <span className={styles.pickedTypes}>
          {result.types.map((type) => (
            <TypeBadge key={type} type={type} size="sm" />
          ))}
        </span>
      ) : null}
    </div>
  );
}
