/**
 * Biolume UI kit — every primitive the views are built from.
 *
 *   import { Button, Page, Panel, Select, toast } from '@renderer/components/ui';
 *
 * All components are styled with CSS Modules on top of the design tokens
 * (`styles/tokens.css`) and are accessible by default: real buttons and
 * inputs, visible focus, ARIA roles, full keyboard operability.
 */

// Surfaces & layout
export { Page, type PageProps } from './Page';
export {
  Card,
  Panel,
  type CardProps,
  type PanelProps,
  type SurfaceAccent,
  type SurfacePadding,
} from './Panel';
export { Divider, type DividerProps } from './Divider';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea';
export { EmptyState, type EmptyStateProps } from './EmptyState';

// Actions
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { IconButton, type IconButtonProps, type IconButtonVariant } from './IconButton';

// Form controls
export {
  Field,
  useFieldControl,
  type FieldControlInput,
  type FieldControlProps,
  type FieldProps,
} from './Field';
export { TextField, type TextFieldProps } from './TextField';
export { TextArea, type TextAreaProps } from './TextArea';
export { NumberField, parseNumberInput, type NumberFieldProps } from './NumberField';
export {
  Select,
  type SelectGroup,
  type SelectItem,
  type SelectOption,
  type SelectProps,
} from './Select';
export {
  Combobox,
  SearchInput,
  type ComboboxItemState,
  type ComboboxProps,
  type SearchInputProps,
} from './Combobox';
export { Checkbox, Toggle, type CheckboxProps, type ToggleProps } from './Toggle';
export { Slider, type SliderProps } from './Slider';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedOption,
} from './SegmentedControl';
export { TabPanel, Tabs, type TabItem, type TabPanelProps, type TabsProps } from './Tabs';

// Overlays & feedback
export { Modal, type ModalProps } from './Modal';
export { confirm, ConfirmHost, type ConfirmOptions } from './confirm';
export { Tooltip, type TooltipProps } from './Tooltip';
export { ToastRegion } from './Toast';
export {
  toast,
  type ToastAction,
  type ToastItem,
  type ToastOptions,
  type ToastTone,
} from '@renderer/store/uiStore';
export { Spinner, type SpinnerProps } from './Spinner';
export { Skeleton, type SkeletonProps } from './Skeleton';

// Data display
export {
  Badge,
  Chip,
  POKEMON_TYPES,
  TypeBadge,
  typeColor,
  type BadgeProps,
  type ChipProps,
  type PokemonType,
  type TypeBadgeProps,
} from './Badge';
export { Kbd, type KbdProps } from './Kbd';
export { Sprite, type SpriteProps } from './Sprite';
export { ProgressRing, StatBar, type ProgressRingProps, type StatBarProps } from './Meters';

// Building blocks for custom widgets (chart tooltips, bespoke popovers)
export { cx, type ClassValue } from './internal/cx';
export { getFocusable, mergeRefs } from './internal/dom';
export { Portal } from './internal/Portal';
export {
  computePosition,
  useAnchoredPosition,
  type Align,
  type AnchoredPositionOptions,
  type Placement,
  type PositionInput,
  type PositionResult,
} from './internal/position';
export type { ControlSize, Tone } from './internal/types';
