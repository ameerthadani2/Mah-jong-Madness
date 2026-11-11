import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { ageSyncDone, isBirthYearLocked, sendBirthYear, syncBirthYear, type AgeSyncServer } from './ageSync';

/** A game server that keeps the first birth year it is given (docs/API.md: the year is write-once). */
function server(onFile: number | null, opts: { offline?: boolean } = {}) {
  const calls: string[] = [];
  const api: AgeSyncServer = {
    birthYearOnFile: async () => {
      calls.push('GET /api/me');
      if (opts.offline) throw new ApiError('Could not reach the game server', 'auth_unreachable');
      return onFile;
    },
    sendBirthYear: async (year) => {
      calls.push(`PATCH birthYear ${year}`);
      if (opts.offline) throw new ApiError('Could not reach the game server', 'auth_unreachable');
      if (onFile !== null && onFile !== year) throw new ApiError('The birth year cannot be changed', 'birth_year_locked', 409);
      onFile = year;
    },
  };
  return { api, calls, year: () => onFile };
}

describe('sending the birth year to the server', () => {
  it('sends the year when the account has none', async () => {
    const s = server(null);
    expect(await syncBirthYear(s.api, 1990)).toBe('sent');
    expect(s.calls).toEqual(['GET /api/me', 'PATCH birthYear 1990']);
    expect(s.year()).toBe(1990);
  });

  it('sends nothing when the account already has a year, the same or another', async () => {
    for (const onFile of [1990, 2012]) {
      const s = server(onFile);
      expect(await syncBirthYear(s.api, 1990)).toBe('on_file');
      expect(s.calls).toEqual(['GET /api/me']);
      expect(s.year()).toBe(onFile);
    }
  });

  it('leaves the answer unsent when the server cannot be reached, so a later visit tries again', async () => {
    const s = server(null, { offline: true });
    const result = await syncBirthYear(s.api, 1990);
    expect(result).toBe('failed');
    expect(ageSyncDone(result)).toBe(false);
    expect(s.calls).toEqual(['GET /api/me']);
  });

  it('after age_missing sends the year at once, without asking first', async () => {
    const s = server(null);
    expect(await sendBirthYear(s.api, 1990)).toBe('sent');
    expect(s.calls).toEqual(['PATCH birthYear 1990']);
  });

  it('treats birth_year_locked as already on file: done, not something to send again', async () => {
    const s = server(2012);
    const result = await sendBirthYear(s.api, 1990);
    expect(result).toBe('on_file');
    expect(ageSyncDone(result)).toBe(true);
    expect(s.year()).toBe(2012);
    expect(isBirthYearLocked(new ApiError('locked', 'birth_year_locked', 409))).toBe(true);
    expect(isBirthYearLocked(new ApiError('no', 'name_not_allowed', 400))).toBe(false);
  });

  it('a failed send after age_missing is reported as failed', async () => {
    const s = server(null, { offline: true });
    expect(await sendBirthYear(s.api, 1990)).toBe('failed');
  });
});
