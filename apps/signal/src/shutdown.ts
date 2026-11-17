/**
 * The process's stop on SIGTERM or SIGINT (src/main.ts): close the server (its final write of
 * every table), then the analytics, error reporting and database, and give the exit code. The
 * code is 0 only when the final write reached the store: a snapshot that was not saved (a hung
 * database, say) exits 1, so the platform sees the failure rather than a clean stop.
 */
import type { CloseResult } from './server';

export interface ShutdownSteps {
  server: { closeAndReport(): Promise<CloseResult> };
  /** Run in order after the server closed, whatever its final write did (analytics, Sentry, the database). */
  after: Array<() => Promise<unknown> | unknown>;
  error?: (line: string) => void;
}

/** Stop everything in order; resolves to the exit code (never rejects). */
export async function shutdown(steps: ShutdownSteps): Promise<number> {
  const error = steps.error ?? ((line: string) => console.error(line));
  let code = 0;
  try {
    const { written } = await steps.server.closeAndReport();
    if (!written) {
      error('[signal] shutdown: the final table snapshot was not saved; exiting with an error');
      code = 1;
    }
  } catch (e) {
    error(`[signal] shutdown error ${(e as Error).message}`);
    code = 1;
  }
  for (const step of steps.after) {
    try {
      await step();
    } catch (e) {
      error(`[signal] shutdown error ${(e as Error).message}`);
      code = 1;
    }
  }
  return code;
}
