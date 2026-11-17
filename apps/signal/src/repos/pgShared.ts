/**
 * What the Postgres repositories (pg.ts and the pg*.ts modules beside it) share: the transaction runner's type, the
 * uuid check and the conversions between JavaScript values and column values.
 */
import type { Queryable } from '../db';

export type Tx = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const toDate = (ms: number | null | undefined): Date | null => (ms === null || ms === undefined ? null : new Date(ms));
export const toMs = (d: Date | null): number | null => (d === null ? null : d.getTime());
export const toNum = (v: string | number | null): number | null => (v === null ? null : Number(v));
export const json = (v: unknown): string => JSON.stringify(v ?? null);
