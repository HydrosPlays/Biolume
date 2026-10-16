import { useId, useMemo } from 'react';
import { SlidersHorizontal, Sparkles } from 'lucide-react';
import type { OddsInputValue, OddsSelection } from '@shared/types';
import type {
  GameDef,
  MethodDef,
  MethodInput,
  NumberInput,
  SelectInput,
} from '@renderer/data/schema';
import {
  Button,
  Field,
  NumberField,
  Panel,
  SegmentedControl,
  Select,
  Slider,
  Toggle,
  Tooltip,
  type SelectGroup,
  type SelectOption,
} from '@renderer/components/ui';
import { formatCount, formatOdds } from '@renderer/lib/format';
import { oddsEngine } from '@renderer/lib/oddsData';
import { charmBlockedReason, selectionForGame, selectionForMethod, shortPlatform } from './model';
import styles from './Odds.module.css';

type Change = (next: OddsSelection, options?: { debounce?: boolean }) => void;

/** Games grouped by generation, newest first — static for the lifetime of the app. */
const GAME_OPTIONS: readonly SelectGroup[] = oddsEngine.gamesByGeneration().map((group) => ({
  label: `Generation ${group.generation}`,
  options: group.games.map((game) => ({
    value: game.id,
    label: game.name,
    meta: `${shortPlatform(game.platform)} · ${game.releaseYear}`,
    keywords: game.shortName,
  })),
}));

/** A select input short enough to show every option at once. */
function fitsSegments(input: SelectInput): boolean {
  return input.options.length <= 4 && input.options.every((option) => option.label.length <= 12);
}

interface SelectInputControlProps {
  input: SelectInput;
  value: string;
  onChange: (value: string) => void;
}

function SelectInputControl({ input, value, onChange }: SelectInputControlProps) {
  const selected = input.options.find((option) => option.id === value);
  if (fitsSegments(input)) {
    return (
      <Field label={input.label} hint={selected?.description ?? input.description}>
        <SegmentedControl
          size="sm"
          fullWidth
          value={value}
          onChange={onChange}
          options={input.options.map((option) => ({ value: option.id, label: option.label }))}
        />
      </Field>
    );
  }
  return (
    <Field label={input.label} hint={input.description}>
      <Select
        value={value}
        onChange={onChange}
        options={input.options.map((option) => {
          const item: SelectOption = { value: option.id, label: option.label };
          if (option.description) item.description = option.description;
          return item;
        })}
      />
    </Field>
  );
}

interface NumberInputControlProps {
  input: NumberInput;
  value: number;
  /** The active hunt's current-phase count, for the chain shortcut; null with no active hunt. */
  phaseCount: number | null;
  /** Chain value after which the odds stop changing, when there is one. */
  plateau: number | null;
  onChange: (value: number, options?: { debounce?: boolean }) => void;
  onCommit: () => void;
}

function NumberInputControl({
  input,
  value,
  phaseCount,
  plateau,
  onChange,
  onCommit,
}: NumberInputControlProps) {
  const sliderId = useId();
  const min = Math.min(input.min, input.max);
  const max = Math.max(input.min, input.max);
  const isChain = input.chain === true;
  const sliderMax = isChain && plateau !== null ? Math.max(plateau, min + 1) : max;
  const hint =
    isChain && plateau !== null ? (
      <>
        {input.description}{' '}
        <span className={styles.hintStrong}>The odds stop changing at {formatCount(plateau)}.</span>
      </>
    ) : (
      input.description
    );

  const shortcut = isChain ? (
    <Tooltip
      content={
        phaseCount === null
          ? 'Start or select a hunt to copy its count here.'
          : 'Sets the chain to the encounters counted in the current phase.'
      }
    >
      <span>
        <Button
          size="sm"
          variant="ghost"
          disabled={phaseCount === null}
          onClick={() => {
            if (phaseCount !== null) onChange(phaseCount);
          }}
        >
          {phaseCount === null
            ? 'Use current count'
            : `Use current count (${formatCount(phaseCount)})`}
        </Button>
      </span>
    </Tooltip>
  ) : undefined;

  return (
    <Field label={input.label} hint={hint} trailing={shortcut}>
      <div className={styles.numberRow}>
        <NumberField
          value={value}
          min={min}
          max={max}
          step={input.step ?? 1}
          suffix={input.unit}
          format={formatCount}
          onChange={(next) => onChange(next, { debounce: true })}
        />
        {isChain ? (
          <Slider
            id={sliderId}
            className={styles.numberSlider}
            aria-label={`${input.label} slider`}
            value={Math.min(value, sliderMax)}
            min={min}
            max={sliderMax}
            step={input.step ?? 1}
            showValue={false}
            tone="violet"
            onChange={(next) => onChange(next, { debounce: true })}
            onCommit={onCommit}
          />
        ) : null}
      </div>
    </Field>
  );
}

export interface MethodSetupProps {
  game: GameDef;
  method: MethodDef;
  selection: OddsSelection;
  /** The active hunt's current-phase count; null for the standalone calculator. */
  phaseCount: number | null;
  /** Chain value after which the odds stop changing, when the method has a chain input. */
  chainPlateau: number | null;
  onChange: Change;
  /** Writes a debounced edit immediately (slider released). */
  onFlush: () => void;
}

/** Game and method pickers, the method's own inputs rendered from its definition, and the Shiny Charm. */
export function MethodSetup({
  game,
  method,
  selection,
  phaseCount,
  chainPlateau,
  onChange,
  onFlush,
}: MethodSetupProps) {
  const methodOptions = useMemo<SelectOption[]>(
    () =>
      game.methods.map((entry) => {
        const best = oddsEngine.bestCase(oddsEngine.defaultSelection(game.id, entry.id));
        return {
          value: entry.id,
          label: entry.name,
          description: entry.summary,
          meta: <span className={styles.optionOdds}>{formatOdds(best.perEncounter)}</span>,
        };
      }),
    [game],
  );

  const setInput = (id: string, value: OddsInputValue, options?: { debounce?: boolean }): void => {
    onChange(oddsEngine.updateSelection(selection, { inputs: { [id]: value } }), options);
  };

  const charmBlocked = charmBlockedReason(game, method);
  const charmRolls = game.shinyCharmRolls ?? 0;

  const renderInput = (input: MethodInput) => {
    const value = selection.inputs[input.id];
    switch (input.kind) {
      case 'toggle':
        return (
          <Toggle
            key={input.id}
            trailing
            checked={value === true}
            onChange={(checked) => setInput(input.id, checked)}
            label={input.label}
            description={input.description}
          />
        );
      case 'select':
        return (
          <SelectInputControl
            key={input.id}
            input={input}
            value={typeof value === 'string' ? value : input.default}
            onChange={(next) => setInput(input.id, next)}
          />
        );
      case 'number':
        return (
          <NumberInputControl
            key={input.id}
            input={input}
            value={typeof value === 'number' ? value : input.default}
            phaseCount={phaseCount}
            plateau={input.chain === true ? chainPlateau : null}
            onChange={(next, options) => setInput(input.id, next, options)}
            onCommit={onFlush}
          />
        );
    }
  };

  return (
    <Panel title="Method" icon={<SlidersHorizontal />} className={styles.setup}>
      <div className={styles.stack}>
        <Field label="Game title">
          <Select
            options={GAME_OPTIONS}
            value={game.id}
            onChange={(gameId) => onChange(selectionForGame(oddsEngine, selection, gameId))}
            maxHeight={380}
          />
        </Field>

        <Field label="Hunting method" hint={method.summary}>
          <Select
            options={methodOptions}
            value={method.id}
            onChange={(methodId) => onChange(selectionForMethod(oddsEngine, selection, methodId))}
            maxHeight={380}
          />
        </Field>

        {method.inputs.length > 0 ? (
          <div className={styles.inputs} role="group" aria-label={`${method.name} settings`}>
            {method.inputs.map(renderInput)}
          </div>
        ) : null}

        <div className={styles.charm} data-blocked={charmBlocked !== null || undefined}>
          <Toggle
            trailing
            checked={charmBlocked === null && selection.shinyCharm}
            disabled={charmBlocked !== null}
            onChange={(shinyCharm) =>
              onChange(oddsEngine.updateSelection(selection, { shinyCharm }))
            }
            label={
              <span className={styles.charmLabel}>
                <Sparkles aria-hidden="true" />
                Shiny Charm
              </span>
            }
            description={
              charmBlocked ??
              `Adds ${charmRolls} extra shiny roll${charmRolls === 1 ? '' : 's'} in ${game.shortName}.`
            }
          />
        </div>
      </div>
    </Panel>
  );
}
