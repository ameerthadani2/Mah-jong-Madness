/**
 * "Report player" (POST /api/reports). The reason list is fixed so moderation can triage;
 * the optional note is trimmed and capped. Pure, so the payload rules are unit-tested.
 */
export const REPORT_REASONS = ['cheating', 'collusion', 'abuse', 'name', 'stalling', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_NOTE_MAX = 500;

export interface ReportPayload {
  reportedUserId: string;
  reason: ReportReason;
  note?: string;
  roomCode?: string;
  clubCode?: string;
}

/** Who is being reported, and where (the table and club give moderators the logs to read). */
export interface ReportTarget {
  userId: string;
  name: string;
  roomCode?: string;
  clubCode?: string;
}

export function isReportReason(v: unknown): v is ReportReason {
  return typeof v === 'string' && (REPORT_REASONS as readonly string[]).includes(v);
}

/** The request body, or null when it cannot be sent (no reason, no target, or reporting yourself). */
export function buildReport(target: ReportTarget, reason: ReportReason | null, note: string, reporterId: string | null): ReportPayload | null {
  if (!isReportReason(reason) || !target.userId || target.userId === reporterId) return null;
  const text = note.trim().slice(0, REPORT_NOTE_MAX);
  return {
    reportedUserId: target.userId,
    reason,
    ...(text ? { note: text } : {}),
    ...(target.roomCode ? { roomCode: target.roomCode } : {}),
    ...(target.clubCode ? { clubCode: target.clubCode } : {}),
  };
}
