import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { celebrationFor } from './celebrate';

const won = { type: 'win' as const, wins: [{ seat: 0 }] };

describe('win celebration and avatar frame at the table', () => {
  it('plays the equipped celebration during the hold after the player’s own win', () => {
    expect(celebrationFor(won, 0, 'win.dragon', true)).toBe('win.dragon');
  });

  it('plays nothing when someone else won, after the hold, with none equipped, or on a draw', () => {
    expect(celebrationFor(won, 1, 'win.dragon', true)).toBeNull();
    expect(celebrationFor(won, 0, 'win.dragon', false)).toBeNull();
    expect(celebrationFor(won, 0, null, true)).toBeNull();
    expect(celebrationFor({ type: 'draw', wins: [] }, 0, 'win.dragon', true)).toBeNull();
    expect(celebrationFor(won, 0, 'frame.jade', true)).toBeNull();
  });

  it('mounts it over the table and puts the equipped frame on the player’s own plate and on Home', () => {
    const table = readFileSync(join(__dirname, '../../screens/TableScreen.tsx'), 'utf8');
    expect(table).toMatch(/<WinCelebration id=\{celebration\}/);
    expect(table).toMatch(/frame: seat === mySeat \? equipped\.frame : null/);
    const home = readFileSync(join(__dirname, '../../screens/HomeScreen.tsx'), 'utf8');
    expect(home.match(/AvatarPlate id=\{app\.profile\.avatar\}[^>]*frame=\{frame\}/g)?.length).toBe(2);
  });
});
