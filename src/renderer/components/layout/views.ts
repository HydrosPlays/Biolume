import {
  ChartSpline,
  Crosshair,
  Radar,
  Sandwich,
  ScrollText,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { VIEW_IDS, type ViewId } from '@shared/ipc';

export interface ViewMeta {
  id: ViewId;
  /** Sidebar label. */
  label: string;
  /** What the view is for — sidebar tooltip and loading text. */
  hint: string;
  icon: LucideIcon;
  /** 1-based position: Ctrl+<n> opens the view. */
  shortcutDigit: number;
}

const META: Record<ViewId, Omit<ViewMeta, 'id' | 'shortcutDigit'>> = {
  hunt: { label: 'Hunt', hint: 'Counter and phase tracker', icon: Radar },
  target: { label: 'Target', hint: 'Species search and encounter analysis', icon: Crosshair },
  odds: { label: 'Odds', hint: 'Hunting methods and probability curves', icon: ChartSpline },
  sandwich: { label: 'Sandwiches', hint: 'Scarlet / Violet sandwich recipes', icon: Sandwich },
  log: { label: 'Log', hint: 'Sessions, phases, export and import', icon: ScrollText },
  settings: {
    label: 'Settings',
    hint: 'Hotkeys, audio, overlay and data',
    icon: SlidersHorizontal,
  },
};

/** The main window's views in sidebar (and Ctrl+1..6) order. */
export const VIEWS: readonly ViewMeta[] = VIEW_IDS.map((id, index) => ({
  id,
  shortcutDigit: index + 1,
  ...META[id],
}));

export function getViewMeta(id: ViewId): ViewMeta {
  return { id, shortcutDigit: VIEW_IDS.indexOf(id) + 1, ...META[id] };
}
