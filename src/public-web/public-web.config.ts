import { RequestMethod } from '@nestjs/common';
import type { RouteInfo } from '@nestjs/common/interfaces';

/**
 * Pages served at the domain root, outside the global `/api` prefix: iOS reads the
 * association file only from `/.well-known/`, and shared links should be short and clean.
 * Registered as prefix exclusions in bootstrap.ts.
 */
export const PUBLIC_WEB_ROUTES: RouteInfo[] = [
  { path: '.well-known/apple-app-site-association', method: RequestMethod.GET },
  { path: 'r/event/:eventId', method: RequestMethod.GET },
  { path: 'legal/privacy', method: RequestMethod.GET },
  { path: 'legal/termini', method: RequestMethod.GET },
  { path: 'supporto', method: RequestMethod.GET },
  { path: 'support', method: RequestMethod.GET },
];

/** `<Team ID>.<bundle id>` of the iOS app allowed to open NightHub links. */
export function iosAppIds(): string[] {
  const raw = process.env.IOS_APP_IDS || '4S4XRSW6AC.com.thomas88.nighthub';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Link paths the app handles directly when installed (universal links). */
export const APP_LINK_PATHS = ['/r/event/*'];

export const APP_SCHEME = 'nighthub';
export const IOS_APP_STORE_ID = '6816712313';

export function appStoreUrl(): string {
  return (
    process.env.EXPO_PUBLIC_APP_STORE_URL ||
    `https://apps.apple.com/app/id${IOS_APP_STORE_ID}`
  );
}

/** Empty until the Android app is published: the page then says it is coming soon. */
export function playStoreUrl(): string | null {
  return process.env.EXPO_PUBLIC_PLAY_STORE_URL || null;
}

export const LEGAL = {
  ownerName: 'Thomas Perodi',
  ownerCity: 'Borgonovo Val Tidone (PC)',
  contactEmail: 'perodithomas88@gmail.com',
  lastUpdated: '28 settembre 2026',
};
