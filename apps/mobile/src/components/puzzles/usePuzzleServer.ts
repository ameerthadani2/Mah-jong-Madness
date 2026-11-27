/**
 * The puzzle routes bound to this device's server and session, and the server's puzzle rating as
 * every puzzle surface shows it (src/logic/puzzleSync.ts holds the rules; this only wires React).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { httpBase } from '../../api/http';
import { puzzlesApi, type PuzzleContext } from '../../api/puzzles';
import { useApp } from '../../app-state';
import { useAuth } from '../../auth/AuthProvider';
import { serverRating, shouldReadRating, shownRating, type PuzzleServer, type ServerRatingView } from '../../logic/puzzleSync';

/** The server calls with this session, or null when the device has no session (puzzles then play locally, unranked). */
export function usePuzzleServer(): { server: PuzzleServer | null; userId: string | null } {
  const app = useApp();
  const auth = useAuth();
  const hasSession = auth.client.snapshot().hasSession && !auth.banned;
  const userId = auth.user?.id ?? null;
  const server = useMemo<PuzzleServer | null>(() => {
    if (!hasSession) return null;
    const ctx: PuzzleContext = { base: httpBase(app.signalUrl), auth: auth.client };
    return {
      startDaily: (date) => puzzlesApi.startDaily(ctx, date),
      finishDaily: (id, answer) => puzzlesApi.finishDaily(ctx, id, answer),
      startRush: () => puzzlesApi.startRush(ctx),
      answerRush: (id, index, answer) => puzzlesApi.answerRush(ctx, id, index, answer),
      finishRush: (id) => puzzlesApi.finishRush(ctx, id),
      getPuzzleRating: () => puzzlesApi.getPuzzleRating(ctx),
      openReview: (hand) => puzzlesApi.openReview(ctx, hand),
    };
  }, [hasSession, app.signalUrl, auth.client]);
  return { server, userId };
}

/**
 * The server's rating for the signed-in account (null until it is read, or without a session),
 * read when a puzzle surface opens unless a fresh copy is already held. With `read` false it only
 * shows a copy already held (Home shows the rating without asking the server each time it opens).
 */
export function useServerRating(read = true): ServerRatingView | null {
  const { server, userId } = usePuzzleServer();
  const view = useSyncExternalStore(serverRating.subscribe, serverRating.get, serverRating.get);
  useEffect(() => {
    if (!read || !server || !userId || !shouldReadRating(serverRating.forUser(userId), Date.now())) return;
    let live = true;
    server
      .getPuzzleRating()
      .then((r) => {
        // A submission that landed meanwhile is newer than this read.
        if (live && shouldReadRating(serverRating.forUser(userId), Date.now())) serverRating.read(userId, r, Date.now());
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [read, server, userId]);
  return server && view && userId && view.userId === userId ? view : null;
}

/** The rating to show: the server's when it was read, else the device's (`shownRating`). */
export function useShownRating(local: number, localChange: number | null, read = true) {
  return shownRating(local, localChange, useServerRating(read));
}
