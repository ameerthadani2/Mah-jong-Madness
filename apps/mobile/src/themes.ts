/**
 * Table cosmetics: felt + tile skins. Purely visual, never affects play.
 * These are the first monetisable surface (see docs/MONETISATION.md): the
 * first two are free, the rest are marked premium for the shop to gate later.
 */
import React from 'react';
import { t } from './i18n';

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

/** Emote ids, drawn by components/Emotes.tsx. */
export const EMOTES = ['thumbs', 'lol', 'wow', 'cry', 'fire', 'love', 'zzz', 'hu'];
/** Quick-chat ids; the text (`table.quickChat.<id>`) is sent in the sender's language. */
export const QUICK_CHATS = ['nice', 'sorry', 'gg', 'hurry', 'goodHand', 'dealtIn', 'oneMore', 'faster'] as const;
export type QuickChatId = (typeof QUICK_CHATS)[number];

export function quickChatText(id: QuickChatId): string {
  return t(`table.quickChat.${id}`);
}
