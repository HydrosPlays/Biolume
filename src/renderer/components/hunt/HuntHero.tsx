import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Minus, Pencil, Plus, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { LIMITS } from '@shared/defaults';
import type { Hunt } from '@shared/types';
import {
  Badge,
  Button,
  Chip,
  cx,
  IconButton,
  NumberField,
  Panel,
  parseNumberInput,
  Sprite,
  Tooltip,
  TypeBadge,
} from '@renderer/components/ui';
import { navigate } from '@renderer/hooks/useView';
import { formatCount } from '@renderer/lib/format';
import type { OddsResult } from '@renderer/lib/odds';
import { actions, useAppStore, useLastChange, useSettings, useUiStore } from '@renderer/store';
import { resetPhaseCount } from './huntActions';
import {
  countChangeDirection,
  countGlyphUnits,
  heroSpriteSources,
  type HuntStats,
} from './huntStats';
import { ShinyFoundButton } from './ShinyFoundButton';
import styles from './hunt.module.css';

interface CountEditorProps {
  value: number;
  /** A valid number was entered; `viaKeyboard` is false when the field simply lost focus. */
  onCommit: (next: number, viaKeyboard: boolean) => void;
  onCancel: () => void;
}

/** The numeral, editable in place: Enter or blur commits, Escape reverts. */
function CountEditor({ value, onCommit, onCancel }: CountEditorProps) {
  const [text, setText] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Enter is followed by a blur as the field unmounts; only the first of the two counts. */
  const settled = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (viaKeyboard: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      onCancel();
      return;
    }
    const next = Math.min(Math.max(Math.round(parsed), LIMITS.count.min), LIMITS.count.max);
    onCommit(next, viaKeyboard);
  };

  return (
    <input
      ref={inputRef}
      className={styles.countInput}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      aria-label="Encounters in this phase"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          settled.current = true;
          onCancel();
        }
      }}
      onBlur={() => commit(false)}
    />
  );
}

export interface HuntHeroProps {
  hunt: Hunt;
  odds: OddsResult | null;
  stats: HuntStats;
  onRename: () => void;
}

/**
 * The counter itself: the target's shiny, the count, and the controls that
 * change it. Every count change — whatever window or hotkey caused it — arrives
 * as `lastChange` and replays the ripple and the digit tick.
 */
export function HuntHero({ hunt, odds, stats, onRename }: HuntHeroProps) {
  const settings = useSettings();
  const lastChange = useLastChange();
  const openPhaseDialog = useUiStore((state) => state.openPhaseDialog);
  // A change that predates this mount (the view was just opened) must not replay its animation.
  const [seenAtMount] = useState(() => useAppStore.getState().lastChange);
  const [editing, setEditing] = useState(false);
  const countButtonRef = useRef<HTMLButtonElement | null>(null);
  const refocusCount = useRef(false);

  useEffect(() => {
    if (!editing && refocusCount.current) {
      refocusCount.current = false;
      countButtonRef.current?.focus();
    }
  }, [editing]);

  const fresh = lastChange !== null && lastChange !== seenAtMount && lastChange.huntId === hunt.id;
  const direction = fresh ? countChangeDirection(lastChange.change) : null;
  const pulseKey = direction === null || lastChange === null ? 'idle' : `${lastChange.at}`;

  const { bindings } = settings.hotkeys;
  const target = hunt.target;
  const countText = formatCount(hunt.count);
  const perEncounter = odds?.pokemonPerEncounter ?? 1;

  const setStep = (next: number): void => {
    if (next !== hunt.step) void actions.updateHunt(hunt.id, { step: next });
  };

  const finishEdit = (viaKeyboard: boolean): void => {
    refocusCount.current = viaKeyboard;
    setEditing(false);
  };

  return (
    <Panel accent="cyan" padding="none" aria-label="Counter">
      <div className={styles.heroBody}>
        <div className={styles.targetCol}>
          <Tooltip
            content={target ? 'Open the Target view' : 'Choose a Pokémon in the Target view'}
            placement="bottom"
            delay={600}
          >
            <button type="button" className={styles.target} onClick={() => navigate('target')}>
              <span className={styles.stage} data-empty={target ? undefined : ''}>
                <span className={styles.aura} aria-hidden="true" />
                <Sprite
                  className={styles.float}
                  src={heroSpriteSources(target)}
                  alt={target ? `Shiny ${target.name}` : 'No target chosen'}
                  size={124}
                  shiny={target !== null}
                  pixelated={false}
                  loading="eager"
                />
              </span>
              <span className={styles.targetName}>{target?.name ?? 'No target yet'}</span>
              <span className={styles.targetMeta}>
                {target
                  ? target.types.map((type) => <TypeBadge key={type} type={type} size="sm" />)
                  : 'Pick a Pokémon to hunt'}
              </span>
            </button>
          </Tooltip>
          <div className={styles.heroActions}>
            <Tooltip
              content="A shiny appeared that is not your target"
              shortcut={bindings.logPhase[0]}
              placement="bottom"
            >
              <Button
                variant="rare"
                fullWidth
                leadingIcon={<Sparkles />}
                onClick={() => openPhaseDialog({ huntId: hunt.id })}
              >
                Log phase
              </Button>
            </Tooltip>
            <ShinyFoundButton hunt={hunt} />
          </div>
        </div>

        <div className={styles.counter}>
          <div className={styles.nameRow}>
            <h2 className={styles.huntName} title={hunt.name}>
              {hunt.name}
            </h2>
            <IconButton label="Rename hunt" size="sm" onClick={onRename}>
              <Pencil />
            </IconButton>
          </div>
          <div className={styles.phaseLine}>
            <Badge tone="violet" variant="outline" size="sm">
              Phase {formatCount(stats.phaseNumber)}
            </Badge>
            <span className="eyebrow">Encounters this phase</span>
          </div>

          <div
            className={styles.countWrap}
            style={{ '--units': countGlyphUnits(countText) } as CSSProperties}
          >
            {direction !== null ? (
              <span
                key={pulseKey}
                className={styles.halo}
                data-direction={direction}
                aria-hidden="true"
              />
            ) : null}
            {editing ? (
              <CountEditor
                value={hunt.count}
                onCommit={(next, viaKeyboard) => {
                  finishEdit(viaKeyboard);
                  if (next !== hunt.count) void actions.setCount(hunt.id, next);
                }}
                onCancel={() => finishEdit(true)}
              />
            ) : (
              <Tooltip content="Click to set the count exactly" placement="bottom" delay={700}>
                <button
                  ref={countButtonRef}
                  type="button"
                  className={styles.count}
                  aria-label={`${countText} encounters this phase. Edit the count`}
                  onClick={() => setEditing(true)}
                >
                  <span
                    key={pulseKey}
                    className={cx(
                      styles.countValue,
                      direction === 'up' && styles.tickUp,
                      direction === 'down' && styles.tickDown,
                    )}
                  >
                    {countText}
                  </span>
                </button>
              </Tooltip>
            )}
          </div>

          <p className={styles.totalLine}>
            <strong>{formatCount(stats.total)}</strong> total
            {stats.phasesLogged > 0
              ? ` across ${formatCount(stats.phaseNumber)} phases`
              : ' · no phases yet'}
          </p>

          <div className={styles.controls}>
            <IconButton
              label={`Subtract ${formatCount(hunt.step)}`}
              variant="secondary"
              size="lg"
              shortcut={bindings.decrement[0]}
              disabled={hunt.count === 0}
              onClick={() => void actions.decrementHunt(hunt)}
            >
              <Minus />
            </IconButton>
            <span className={styles.tapWrap}>
              {direction !== null ? (
                <span
                  key={pulseKey}
                  className={cx(styles.ripple, 'bl-ripple')}
                  data-direction={direction}
                  aria-hidden="true"
                />
              ) : null}
              <Tooltip content="Count encounter" shortcut={bindings.increment[0]} decorative>
                <button
                  type="button"
                  className={styles.tap}
                  aria-label="Count encounter"
                  onClick={() => void actions.incrementHunt(hunt)}
                >
                  <Plus aria-hidden="true" />
                  {hunt.step > 1 ? (
                    <span className={styles.tapStep} aria-hidden="true">
                      +{formatCount(hunt.step)}
                    </span>
                  ) : null}
                </button>
              </Tooltip>
            </span>
            <IconButton
              label="Undo last change"
              variant="secondary"
              size="lg"
              shortcut={bindings.undo[0]}
              onClick={() => void actions.undoHunt(hunt.id)}
            >
              <Undo2 />
            </IconButton>
          </div>

          <div className={styles.stepRow}>
            <span className="eyebrow">Step</span>
            <Chip size="sm" selected={hunt.step === 1} onClick={() => setStep(1)}>
              ×1
            </Chip>
            <Chip
              size="sm"
              selected={hunt.step === 5}
              title="Five per count — Horde Encounters"
              onClick={() => setStep(5)}
            >
              ×5
            </Chip>
            <NumberField
              size="sm"
              value={hunt.step}
              min={LIMITS.step.min}
              max={LIMITS.step.max}
              width={5}
              wheel={false}
              aria-label="Encounters added per count"
              onChange={setStep}
            />
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<RotateCcw />}
              disabled={hunt.count === 0}
              onClick={() => void resetPhaseCount(hunt)}
            >
              Reset phase count
            </Button>
          </div>
          {perEncounter > 1 && hunt.step > 1 ? (
            <p className={styles.stepHint}>
              The odds of {odds?.method.name ?? 'this method'} already cover {perEncounter} Pokémon
              per encounter — with step ×{formatCount(hunt.step)} every press counts{' '}
              {formatCount(hunt.step)} of them.
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
