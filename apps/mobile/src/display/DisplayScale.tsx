/**
 * Display scale for the app: the saved tile and text sizes (./store.ts, under its own AsyncStorage key) and the
 * OS text size, offered through a context. Components read it with useDisplayScale(); without a provider they
 * get Normal sizes, so galleries and tests need nothing.
 */
import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { PixelRatio, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_DISPLAY_SCALE, effectiveTextScale, osFontScale, textFactor, type DisplayScale, type TextScale, type TileScale } from './scale';
import { DisplayScaleStore } from './store';

export const displayScale = new DisplayScaleStore(AsyncStorage);

export interface DisplayScaleValue extends DisplayScale {
  /** The OS text size (1 when unknown). */
  osScale: number;
  /** What the player sees: their text choice, floored at the OS size. */
  effectiveText: number;
  /** Extra multiplier for font sizes on top of the OS scale React Native already applies. */
  fontFactor: number;
  setTileScale: (v: TileScale) => void;
  setTextScale: (v: TextScale) => void;
}

const defaults: DisplayScaleValue = {
  ...DEFAULT_DISPLAY_SCALE,
  osScale: 1,
  effectiveText: 1,
  fontFactor: 1,
  setTileScale: (v) => void displayScale.set({ tileScale: v }),
  setTextScale: (v) => void displayScale.set({ textScale: v }),
};

const DisplayScaleContext = createContext<DisplayScaleValue>(defaults);

function readOsScale(): number {
  try {
    return osFontScale(PixelRatio.getFontScale());
  } catch {
    return 1;
  }
}

export function DisplayScaleProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => void displayScale.load(), []);
  const saved = useSyncExternalStore(
    (l) => displayScale.subscribe(l),
    () => displayScale.get(),
    () => displayScale.get(),
  );
  // The OS text size can change while the app is open; React Native reports that as a dimensions change, which
  // re-renders this provider and re-reads PixelRatio.getFontScale().
  useWindowDimensions();
  const os = readOsScale();
  const value = useMemo<DisplayScaleValue>(
    () => ({ ...defaults, ...saved, osScale: os, effectiveText: effectiveTextScale(saved.textScale, os), fontFactor: textFactor(saved.textScale, os) }),
    [saved, os],
  );
  return <DisplayScaleContext.Provider value={value}>{children}</DisplayScaleContext.Provider>;
}

export function useDisplayScale(): DisplayScaleValue {
  return useContext(DisplayScaleContext);
}
