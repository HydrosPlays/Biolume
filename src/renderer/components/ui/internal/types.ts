/** Height scale shared by every control: 28 / 34 / 42 px. */
export type ControlSize = 'sm' | 'md' | 'lg';

/**
 * Colour families (see `styles/tones.css`). `accent` / `teal` mark interaction
 * and health, `violet` / `magenta` rare or special states, `shiny` is reserved
 * for shinies; `ok` / `warn` / `danger` / `info` are status colours.
 */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'teal'
  | 'violet'
  | 'magenta'
  | 'shiny'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'info';
