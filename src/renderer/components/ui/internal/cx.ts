export type ClassValue = string | false | null | undefined;

/** Joins truthy class names: `cx(styles.button, active && styles.active, className)`. */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
