export const UI_SCALE_OPTIONS = [1, 1.25, 1.5, 1.75, 2] as const;

/** Keep the interface reachable even if older local preferences lack a scale. */
export function interfaceScale(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(2, Math.max(1, value))
    : 1;
}
