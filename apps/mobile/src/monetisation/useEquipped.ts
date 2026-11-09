/**
 * The equipped cosmetics (./equipped.ts), shared by every screen without a provider: a small
 * store kept in AsyncStorage (`mjm.equipped`), read once at start-up. `useEquipped()` gives the
 * stored choice; `useOwnedEquipped()` gives only what the current wallet owns, which is what the
 * table, the avatar and the Shop should show.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../app-state';
import { equip, equippedFor, NOTHING_EQUIPPED, readEquipped, type Equipped, type EquipSlot } from './equipped';
import type { Wallet } from './wallet';

const KEY = 'mjm.equipped';
let current: Equipped = NOTHING_EQUIPPED;
const listeners = new Set<() => void>();

const emit = () => {
  for (const l of listeners) l();
};

let loaded = false;
function load(): void {
  if (loaded) return;
  loaded = true;
  void AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      current = readEquipped(JSON.parse(raw));
      emit();
    })
    .catch(() => undefined);
}

function subscribe(l: () => void): () => void {
  load();
  listeners.add(l);
  return () => listeners.delete(l);
}

const snapshot = () => current;

/** The stored choice (not checked against the wallet). */
export function useEquipped(): Equipped {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** What is in use for the current wallet. */
export function useOwnedEquipped(): Equipped {
  const app = useApp();
  return equippedFor(useEquipped(), app.wallet);
}

/** Put an owned item on, or go back to the default with null; saved on the device. */
export function setEquipped(slot: EquipSlot, id: string | null, wallet: Wallet): void {
  const next = equip(current, slot, id, wallet);
  if (next === current) return;
  current = next;
  emit();
  void AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => undefined);
}
