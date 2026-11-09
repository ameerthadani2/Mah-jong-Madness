/** The tap-to-discard pill's retirement (./tapHint.ts), kept in AsyncStorage and shared by the table. */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TapHintStore, tapHintVisible } from './tapHint';

const store = new TapHintStore(AsyncStorage);
const subscribe = (l: () => void) => store.subscribe(l);
const get = () => store.get();

/** Whether the tutorial pill still shows, and the call that counts a hand discard. */
export function useTapHint(): { show: boolean; discarded: () => void } {
  const n = useSyncExternalStore(subscribe, get, get);
  return { show: tapHintVisible(n), discarded: () => store.discarded() };
}
