/**
 * Short room and club codes that players can read out loud, and opaque peer
 * ids. All are generated from the platform's secure random source.
 */
import { randomHex } from '@mjm/engine';

/** 32 characters, leaving out I, O, 0 and 1 because they are easily confused. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random source that returns `bytes` bytes as hex, two characters per byte. Injected in tests. */
export type HexSource = (bytes: number) => string;

/**
 * Map random bytes to code characters. Because 256 is a multiple of 32,
 * `byte & 31` selects every character with the same probability, so there is no modulo bias.
 */
export function codeFromHex(hex: string, len: number): string {
  let code = '';
  for (let i = 0; i < len; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Not enough random bytes for a code');
    code += CODE_ALPHABET[byte & 31];
  }
  return code;
}

/** Returns a new code of `len` characters for which `taken` returns false. */
export function uniqueCode(taken: (code: string) => boolean, len = 6, hex: HexSource = randomHex): string {
  for (;;) {
    const code = codeFromHex(hex(len), len);
    if (!taken(code)) return code;
  }
}
