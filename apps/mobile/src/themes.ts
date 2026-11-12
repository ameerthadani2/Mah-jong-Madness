/**
 * Table cosmetics: felt + tile skins, and the emotes. Purely visual, never affects play.
 * The first three felts are free; the premium ones are bought with diamonds in the Shop
 * (docs/MONETISATION.md). A premium felt may carry a code-drawn pattern
 * (components/FeltPattern.tsx), drawn wherever the felt is.
 */
import React from 'react';
import { FREE_EMOTE_IDS, QUICK_CHAT_IDS, type QuickChatId } from '@mjm/net';
import { t } from './i18n';
import type { FeltPatternId } from './monetisation/cosmetics';

export { EMOTE_PACKS, PACK_EMOTE_IDS, packOfEmote, type EmotePackId, type PackEmoteId } from './monetisation/cosmetics';

export interface TableTheme {
  id: string;
  name: string;
  nameZh: string;
  felt: string;
  feltDark: string;
  feltLight: string;
  tileFace: string;
  tileEdge: string;
  tileBack: string;
  accent: string;
  premium: boolean;
  /** Optional wood-rail override (defaults to the house oak). */
  rail?: { light: string; mid: string; edge: string; deep: string; stud: string };
  /** Optional pattern printed on the felt, in `patternColor` (default: white) at low opacity. */
  pattern?: FeltPatternId;
  patternColor?: string;
}

export const TABLE_THEMES: TableTheme[] = [
  { id: 'classic', name: 'Classic Felt', nameZh: '經典綠', felt: '#2F9E6A', feltDark: '#1E7A4F', feltLight: '#3DB57D', tileFace: '#FFF9EE', tileEdge: '#D9C7A6', tileBack: '#1E7A4F', accent: '#FFC53D', premium: false },
  { id: 'deep', name: 'Deep Green', nameZh: '墨綠', felt: '#0b3d2e', feltDark: '#072a20', feltLight: '#145c45', tileFace: '#f6f1e4', tileEdge: '#d9d0bb', tileBack: '#2f6b55', accent: '#e3b341', premium: false },
  { id: 'midnight', name: 'Midnight Blue', nameZh: '午夜藍', felt: '#122a4a', feltDark: '#0b1b31', feltLight: '#1f3f6b', tileFace: '#f7f4ec', tileEdge: '#d6d0c2', tileBack: '#3b5a88', accent: '#ffcc5c', premium: false },
  { id: 'nightmarket', name: 'Night Market', nameZh: '夜市霓虹', felt: '#2a0f3a', feltDark: '#1a0826', feltLight: '#45195f', tileFace: '#fff7fb', tileEdge: '#e6cfe0', tileBack: '#7a2d9c', accent: '#ff5fa2', premium: true },
  { id: 'bamboo', name: 'Bamboo Garden', nameZh: '竹林', felt: '#3e5a1f', feltDark: '#2a3f13', feltLight: '#5a7d2f', tileFace: '#fbf8ea', tileEdge: '#dfd8bd', tileBack: '#6e8f3c', accent: '#f4d35e', premium: true },
  {
    id: 'jade',
    name: 'Jade Parlour',
    nameZh: '翡翠廳',
    felt: '#127556',
    feltDark: '#063A2B',
    feltLight: '#2AA57C',
    tileFace: '#FFF8E7',
    tileEdge: '#C9AE7A',
    tileBack: '#0C5A45',
    accent: '#F4C04E',
    premium: true,
    rail: { light: '#7B4A2B', mid: '#4A2716', edge: '#26120A', deep: '#1A0C06', stud: '#F4C04E' },
  },
  { id: 'imperial', name: 'Imperial Red', nameZh: '宮廷紅', felt: '#6b1414', feltDark: '#4a0d0d', feltLight: '#8f2020', tileFace: '#fff9ee', tileEdge: '#e3d6bd', tileBack: '#a63a3a', accent: '#ffd26a', premium: true },
  { id: 'lantern', name: 'Lantern Festival', nameZh: '元宵燈會', felt: '#7a1f12', feltDark: '#4f120a', feltLight: '#a8321e', tileFace: '#fff8ec', tileEdge: '#e6d2b0', tileBack: '#c4452c', accent: '#ffcf4a', premium: true, pattern: 'lanterns', patternColor: '#ffcf4a' },
  { id: 'teahouse', name: 'Teahouse', nameZh: '老茶館', felt: '#5b3a24', feltDark: '#3b2416', feltLight: '#7a5236', tileFace: '#fffaf0', tileEdge: '#e2cfae', tileBack: '#8b5a36', accent: '#e9c27a', premium: true, pattern: 'lattice', patternColor: '#f3d9a6' },
  { id: 'oceanwave', name: 'Ocean Wave', nameZh: '海浪', felt: '#124a6b', feltDark: '#0a2f46', feltLight: '#1d6a94', tileFace: '#f7fbff', tileEdge: '#cfdbe6', tileBack: '#2c7fb0', accent: '#7fe3ff', premium: true, pattern: 'waves' },
  { id: 'plumblossom', name: 'Plum Blossom', nameZh: '梅花', felt: '#6b2a4a', feltDark: '#461a30', feltLight: '#8f3d64', tileFace: '#fff8fb', tileEdge: '#ead3df', tileBack: '#b0507e', accent: '#ffd1e6', premium: true, pattern: 'blossoms', patternColor: '#ffd1e6' },
  { id: 'cloud', name: 'Lucky Clouds', nameZh: '祥雲', felt: '#17635f', feltDark: '#0d403d', feltLight: '#23827d', tileFace: '#fffbee', tileEdge: '#dfd6bb', tileBack: '#2a9a93', accent: '#ffe08a', premium: true, pattern: 'clouds', patternColor: '#ffe08a' },
  { id: 'starlight', name: 'Starlit Night', nameZh: '星夜', felt: '#1a1f4a', feltDark: '#0f1230', feltLight: '#2b3270', tileFace: '#f8f7ff', tileEdge: '#d4d2e6', tileBack: '#3d4796', accent: '#ffe46b', premium: true, pattern: 'stars', patternColor: '#ffe46b' },
  { id: 'porcelain', name: 'Blue Porcelain', nameZh: '青花瓷', felt: '#1f3f7a', feltDark: '#132852', feltLight: '#2f5aa6', tileFace: '#ffffff', tileEdge: '#d5deee', tileBack: '#3b6cc4', accent: '#e8f0ff', premium: true, pattern: 'fretwork', patternColor: '#e8f0ff' },
  {
    id: 'dragonscale',
    name: 'Dragon Scale',
    nameZh: '龍鱗',
    felt: '#0f5a3a',
    feltDark: '#083822',
    feltLight: '#1a7d52',
    tileFace: '#fffaea',
    tileEdge: '#e0d3ad',
    tileBack: '#1f8a5a',
    accent: '#f4c04e',
    premium: true,
    pattern: 'scales',
    patternColor: '#f4c04e',
    rail: { light: '#7B4A2B', mid: '#4A2716', edge: '#26120A', deep: '#1A0C06', stud: '#F4C04E' },
  },
];

export const DEFAULT_TABLE_THEME = TABLE_THEMES[0];

export function themeById(id: string | undefined): TableTheme {
  return TABLE_THEMES.find((t) => t.id === id) ?? DEFAULT_TABLE_THEME;
}

/** The theme's display name in the current locale (`table.themes.<id>`), falling back to its English name. */
export function themeName(theme: TableTheme): string {
  return t(`table.themes.${theme.id}`, { defaultValue: theme.name });
}

export const TableThemeContext = React.createContext<TableTheme>(DEFAULT_TABLE_THEME);

/**
 * The free emote ids, drawn by components/Emotes.tsx; the paid packs are `EMOTE_PACKS`
 * (components/EmotePacks.tsx). The ids are the ones the table relays (@mjm/net tabletext.ts).
 */
export const EMOTES: readonly string[] = FREE_EMOTE_IDS;
/**
 * Quick-chat ids (@mjm/net tabletext.ts). Only the id travels: each player reads the phrase
 * (`table.quickChat.<id>`) in their own language, and there is no free text at the table.
 */
export const QUICK_CHATS = QUICK_CHAT_IDS;
export type { QuickChatId };
/** What arrives at the table is shown only when it is one of these ids (a quick phrase, or an emote this app draws). */
export { isQuickChatId, isTableEmoteId } from '@mjm/net';

export function quickChatText(id: QuickChatId): string {
  return t(`table.quickChat.${id}`);
}

/** An emote's name in the reader's language (`table.emoteName.<id>`), for screen readers: never the internal id. */
export function emoteName(id: string, translate: (key: string) => string = t): string {
  return translate(`table.emoteName.${id}`);
}
