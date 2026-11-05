/** Mean of the saved review accuracies (0–100), rounded; null before the first review. */
export function rollingAccuracy(accuracies: readonly number[]): number | null {
  const valid = accuracies.filter((a) => Number.isFinite(a));
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((sum, a) => sum + a, 0) / valid.length);
}
