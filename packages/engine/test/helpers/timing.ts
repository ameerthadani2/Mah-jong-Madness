/**
 * Wall-clock bounds in tests catch an order-of-magnitude slowdown; they are not benchmarks. Coverage
 * instrumentation makes the code run several times slower, and CI runners are slower than a laptop, so a
 * bound written for a plain local run is multiplied: by TIMING_FACTOR when it is set, otherwise by 6 under
 * coverage (`npm run coverage` sets COVERAGE=1) and by 2 on CI (GitHub Actions sets CI=true).
 */
export function timeBound(ms: number): number {
  const factor = Number(process.env.TIMING_FACTOR);
  if (Number.isFinite(factor) && factor > 0) return ms * factor;
  return ms * (process.env.COVERAGE ? 6 : 1) * (process.env.CI ? 2 : 1);
}
