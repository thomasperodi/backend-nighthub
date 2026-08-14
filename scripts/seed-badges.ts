import 'dotenv/config';

import { PrismaClient, Prisma, BadgeCategory, BadgeRarity } from '@prisma/client';
import type { BadgeCriteria } from '../src/badges/badge-criteria.types';

const prisma = new PrismaClient();

type BadgeSeed = {
  code: string;
  category: BadgeCategory;
  rarity: BadgeRarity;
  icon: string;
  name: string;
  description: string;
  criteria: BadgeCriteria;
  isSecret?: boolean;
  isPublic?: boolean;
  sortOrder?: number;
};

const badges: BadgeSeed[] = [
  // ---------------------------------------------------------------- 1. Nightlife
  { code: 'prima_notte', category: 'NIGHTLIFE', rarity: 'COMMON', icon: '🌙', name: 'Prima Notte', description: 'Partecipa al tuo primo evento', criteria: { type: 'entries_count', threshold: 1 } },
  { code: 'nighthubber', category: 'NIGHTLIFE', rarity: 'COMMON', icon: '🎟️', name: 'NightHubber', description: 'Partecipa a 3 eventi', criteria: { type: 'entries_count', threshold: 3 } },
  { code: 'party_starter', category: 'NIGHTLIFE', rarity: 'RARE', icon: '🔥', name: 'Party Starter', description: 'Partecipa a 5 eventi', criteria: { type: 'entries_count', threshold: 5 } },
  { code: 'night_lover', category: 'NIGHTLIFE', rarity: 'RARE', icon: '💜', name: 'Night Lover', description: 'Partecipa a 10 eventi', criteria: { type: 'entries_count', threshold: 10 } },
  { code: 'night_addict', category: 'NIGHTLIFE', rarity: 'EPIC', icon: '🖤', name: 'Night Addict', description: 'Partecipa a 25 eventi', criteria: { type: 'entries_count', threshold: 25 } },
  { code: 'night_legend', category: 'NIGHTLIFE', rarity: 'LEGENDARY', icon: '👑', name: 'Night Legend', description: 'Partecipa a 50 eventi', criteria: { type: 'entries_count', threshold: 50 } },
  { code: 'afterlife', category: 'NIGHTLIFE', rarity: 'LEGENDARY', icon: '💀', name: 'Afterlife', description: 'Partecipa a 100 eventi', criteria: { type: 'entries_count', threshold: 100 } },

  // ---------------------------------------------------------------- 2. Esplorazione
  { code: 'explorer', category: 'EXPLORATION', rarity: 'COMMON', icon: '🧭', name: 'Explorer', description: 'Partecipa a 3 eventi diversi', criteria: { type: 'entries_count', threshold: 3 } },
  { code: 'event_hunter', category: 'EXPLORATION', rarity: 'RARE', icon: '🗺️', name: 'Event Hunter', description: 'Partecipa a eventi in 5 locali diversi', criteria: { type: 'distinct_venues_count', threshold: 5 } },
  { code: 'night_explorer', category: 'EXPLORATION', rarity: 'EPIC', icon: '🌍', name: 'Night Explorer', description: 'Partecipa a 10 eventi diversi', criteria: { type: 'entries_count', threshold: 10 } },
  { code: 'event_collector', category: 'EXPLORATION', rarity: 'LEGENDARY', icon: '🏆', name: 'Event Collector', description: 'Partecipa a 25 eventi diversi', criteria: { type: 'entries_count', threshold: 25 } },

  // ---------------------------------------------------------------- 3. Social
  { code: 'hello_night', category: 'SOCIAL', rarity: 'COMMON', icon: '👋', name: 'Hello Night', description: 'Aggiungi il primo amico', criteria: { type: 'friends_count', threshold: 1 } },
  { code: 'squad', category: 'SOCIAL', rarity: 'COMMON', icon: '🤝', name: 'Squad', description: 'Raggiungi 5 amici', criteria: { type: 'friends_count', threshold: 5 } },
  { code: 'big_squad', category: 'SOCIAL', rarity: 'RARE', icon: '🫂', name: 'Big Squad', description: 'Raggiungi 15 amici', criteria: { type: 'friends_count', threshold: 15 } },
  { code: 'social_butterfly', category: 'SOCIAL', rarity: 'EPIC', icon: '🦋', name: 'Social Butterfly', description: 'Raggiungi 30 amici', criteria: { type: 'friends_count', threshold: 30 } },
  { code: 'people_magnet', category: 'SOCIAL', rarity: 'LEGENDARY', icon: '🧲', name: 'People Magnet', description: 'Raggiungi 100 amici', criteria: { type: 'friends_count', threshold: 100 } },
  // No separate "followers" concept yet (friendships are bidirectional) - kept manual until a follow system exists.
  { code: 'the_connector', category: 'SOCIAL', rarity: 'LEGENDARY', icon: '👑', name: 'The Connector', description: 'Un punto di riferimento nella community', criteria: { type: 'manual' } },

  // ---------------------------------------------------------------- 4. Squad Goals
  { code: 'two_of_us', category: 'SQUAD', rarity: 'COMMON', icon: '👫', name: 'Two of Us', description: 'Partecipa a un evento con un amico', criteria: { type: 'coattend_same_friend', threshold: 1 } },
  { code: 'dynamic_duo', category: 'SQUAD', rarity: 'RARE', icon: '👯', name: 'Dynamic Duo', description: 'Partecipa a 5 eventi con lo stesso amico', criteria: { type: 'coattend_same_friend', threshold: 5 } },
  { code: 'squad_night', category: 'SQUAD', rarity: 'RARE', icon: '🔥', name: 'Squad Night', description: 'Partecipa a un evento con almeno 5 amici', criteria: { type: 'coattend_group', minFriendsPresent: 5, eventsThreshold: 1 } },
  { code: 'the_crew', category: 'SQUAD', rarity: 'EPIC', icon: '💜', name: 'The Crew', description: 'Partecipa a 10 eventi con almeno 3 amici', criteria: { type: 'coattend_group', minFriendsPresent: 3, eventsThreshold: 10 } },
  { code: 'the_ogs', category: 'SQUAD', rarity: 'LEGENDARY', icon: '👑', name: 'The OGs', description: 'Partecipa a 25 eventi con lo stesso amico', criteria: { type: 'coattend_same_friend', threshold: 25 } },

  // ---------------------------------------------------------------- 5. Tavoli & VIP
  { code: 'first_table', category: 'TABLES_VIP', rarity: 'COMMON', icon: '🥂', name: 'First Table', description: 'Prenota il primo tavolo', criteria: { type: 'table_reservations_count', threshold: 1 } },
  { code: 'table_hunter', category: 'TABLES_VIP', rarity: 'RARE', icon: '🍾', name: 'Table Hunter', description: 'Prenota 3 tavoli', criteria: { type: 'table_reservations_count', threshold: 3 } },
  { code: 'vip_night', category: 'TABLES_VIP', rarity: 'RARE', icon: '💎', name: 'VIP Night', description: 'Prenota 5 tavoli', criteria: { type: 'table_reservations_count', threshold: 5 } },
  { code: 'vip_regular', category: 'TABLES_VIP', rarity: 'EPIC', icon: '👑', name: 'VIP Regular', description: 'Prenota 10 tavoli', criteria: { type: 'table_reservations_count', threshold: 10 } },
  { code: 'big_spender', category: 'TABLES_VIP', rarity: 'LEGENDARY', icon: '💰', name: 'Big Spender', description: 'Raggiungi una soglia di spesa importante', criteria: { type: 'spend_total', threshold: 2000 }, isPublic: false },
  // Bottle orders aren't linked to the customer user in the schema today - kept manual.
  { code: 'bottle_service', category: 'TABLES_VIP', rarity: 'EXCLUSIVE', icon: '🥂', name: 'Bottle Service', description: 'Prenota un tavolo con bottle service', criteria: { type: 'manual' } },

  // ---------------------------------------------------------------- 6. Streak
  { code: 'hot_streak', category: 'STREAK', rarity: 'RARE', icon: '🔥', name: 'Hot Streak', description: 'Partecipa a eventi per 2 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 2 } },
  { code: 'on_fire', category: 'STREAK', rarity: 'EPIC', icon: '🔥🔥', name: 'On Fire', description: '4 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 4 } },
  { code: 'unstoppable', category: 'STREAK', rarity: 'EPIC', icon: '🔥🔥🔥', name: 'Unstoppable', description: '6 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 6 } },
  { code: 'no_sleep', category: 'STREAK', rarity: 'LEGENDARY', icon: '💀', name: 'No Sleep', description: '8 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 8 } },
  { code: 'cant_stop', category: 'STREAK', rarity: 'LEGENDARY', icon: '👹', name: "Can't Stop", description: '12 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 12 } },
  { code: 'never_miss', category: 'STREAK', rarity: 'LEGENDARY', icon: '🐐', name: 'Never Miss', description: '20 weekend consecutivi', criteria: { type: 'weekend_streak', weeks: 20 } },

  // ---------------------------------------------------------------- 7. Night Challenges
  { code: 'early_bird', category: 'NIGHT_CHALLENGES', rarity: 'COMMON', icon: '🌆', name: 'Early Bird', description: "Partecipa a un evento prima delle 22:00", criteria: { type: 'event_before_time', before: '22:00', threshold: 1 } },
  { code: 'midnight_club', category: 'NIGHT_CHALLENGES', rarity: 'RARE', icon: '🌙', name: 'Midnight Club', description: 'Partecipa a un evento dopo mezzanotte', criteria: { type: 'event_after_time', after: '00:00', threshold: 1 } },
  { code: 'night_owl', category: 'NIGHT_CHALLENGES', rarity: 'EPIC', icon: '🦉', name: 'Night Owl', description: 'Partecipa a 5 eventi dopo mezzanotte', criteria: { type: 'event_after_time', after: '00:00', threshold: 5 } },
  // Require presence-duration tracking we don't have yet - kept manual.
  { code: 'sunrise_survivor', category: 'NIGHT_CHALLENGES', rarity: 'LEGENDARY', icon: '🌅', name: 'Sunrise Survivor', description: 'Rimani fino alle prime luci del mattino', criteria: { type: 'manual' } },
  { code: 'last_one_standing', category: 'NIGHT_CHALLENGES', rarity: 'LEGENDARY', icon: '🌚', name: 'Last One Standing', description: 'Sei tra gli ultimi presenti a un evento', criteria: { type: 'manual' } },

  // ---------------------------------------------------------------- 8. Eventi speciali (finestre stagionali ricorrenti ogni anno)
  { code: 'halloween_night', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '🎃', name: 'Halloween Night', description: 'Partecipa a un evento di Halloween', criteria: { type: 'seasonal_window', monthFrom: 10, dayFrom: 25, monthTo: 10, dayTo: 31, threshold: 1 } },
  { code: 'christmas_night', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '🎄', name: 'Christmas Night', description: 'Partecipa a un evento natalizio', criteria: { type: 'seasonal_window', monthFrom: 12, dayFrom: 24, monthTo: 12, dayTo: 26, threshold: 1 } },
  { code: 'new_years_night', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '🎆', name: "New Year's Night", description: 'Partecipa a un evento di Capodanno', criteria: { type: 'seasonal_window', monthFrom: 12, dayFrom: 31, monthTo: 1, dayTo: 1, threshold: 1 } },
  { code: 'valentines_night', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '❤️', name: "Valentine's Night", description: 'Partecipa a un evento di San Valentino', criteria: { type: 'seasonal_window', monthFrom: 2, dayFrom: 13, monthTo: 2, dayTo: 15, threshold: 1 } },
  { code: 'summer_starter', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '☀️', name: 'Summer Starter', description: 'Partecipa al primo evento estivo', criteria: { type: 'seasonal_window', monthFrom: 6, dayFrom: 1, monthTo: 6, dayTo: 30, threshold: 1 } },
  { code: 'winter_opener', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '❄️', name: 'Winter Opener', description: "Partecipa all'apertura della stagione invernale", criteria: { type: 'seasonal_window', monthFrom: 12, dayFrom: 1, monthTo: 12, dayTo: 20, threshold: 1 } },
  { code: 'summer_night', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '🏖️', name: 'Summer Night', description: "Partecipa a 5 eventi durante l'estate", criteria: { type: 'seasonal_window', monthFrom: 6, dayFrom: 1, monthTo: 8, dayTo: 31, threshold: 5 } },
  { code: 'winter_warrior', category: 'SPECIAL_EVENTS', rarity: 'EXCLUSIVE', icon: '🧊', name: 'Winter Warrior', description: "Partecipa a 5 eventi durante l'inverno", criteria: { type: 'seasonal_window', monthFrom: 12, dayFrom: 21, monthTo: 3, dayTo: 20, threshold: 5 } },

  // ---------------------------------------------------------------- 9. Milestone
  { code: 'getting_started', category: 'MILESTONE', rarity: 'COMMON', icon: '🌱', name: 'Getting Started', description: 'Completa il profilo', criteria: { type: 'profile_completed' } },
  { code: 'first_week', category: 'MILESTONE', rarity: 'COMMON', icon: '⚡', name: 'First Week', description: 'Usa NightHub per 7 giorni', criteria: { type: 'account_age_days', days: 7 } },
  { code: 'regular', category: 'MILESTONE', rarity: 'RARE', icon: '🔥', name: 'Regular', description: 'Usa NightHub per 30 giorni', criteria: { type: 'account_age_days', days: 30 } },
  { code: 'committed', category: 'MILESTONE', rarity: 'EPIC', icon: '💜', name: 'Committed', description: 'Usa NightHub per 90 giorni', criteria: { type: 'account_age_days', days: 90 } },
  { code: 'og_member', category: 'MILESTONE', rarity: 'LEGENDARY', icon: '👑', name: 'OG Member', description: 'Usa NightHub per 1 anno', criteria: { type: 'account_age_days', days: 365 } },
  { code: 'nighthub_og', category: 'MILESTONE', rarity: 'LEGENDARY', icon: '💎', name: 'NightHub OG', description: 'Sei tra i primi 500 utenti di NightHub', criteria: { type: 'early_adopter', rank: 500 } },

  // ---------------------------------------------------------------- 10. Secret badges (nome/descrizione mascherati finché non sbloccati)
  { code: 'secret_agent', category: 'SECRET', rarity: 'EPIC', icon: '🥷', name: 'Secret Agent', description: 'Condizione segreta', criteria: { type: 'manual' }, isSecret: true },
  { code: 'i_see_you', category: 'SECRET', rarity: 'RARE', icon: '👀', name: 'I See You', description: 'Condizione segreta', criteria: { type: 'manual' }, isSecret: true },
  { code: 'night_creature', category: 'SECRET', rarity: 'EPIC', icon: '🌚', name: 'Night Creature', description: 'Condizione segreta', criteria: { type: 'manual' }, isSecret: true },
  { code: 'og', category: 'SECRET', rarity: 'LEGENDARY', icon: '💜', name: 'OG', description: 'Condizione segreta', criteria: { type: 'manual' }, isSecret: true },
  { code: 'goat', category: 'SECRET', rarity: 'LEGENDARY', icon: '🐐', name: 'GOAT', description: 'Condizione segreta', criteria: { type: 'manual' }, isSecret: true },
  { code: 'easter_egg', category: 'SECRET', rarity: 'EXCLUSIVE', icon: '🕵️', name: 'Easter Egg', description: 'Trova un easter egg nascosto in app', criteria: { type: 'manual' }, isSecret: true },
  { code: 'mystery', category: 'SECRET', rarity: 'LEGENDARY', icon: '💀', name: '???', description: 'Condizione completamente nascosta', criteria: { type: 'manual' }, isSecret: true },
];

async function main() {
  let sortOrder = 0;
  for (const badge of badges) {
    await prisma.badges.upsert({
      where: { code: badge.code },
      update: {
        category: badge.category,
        rarity: badge.rarity,
        icon: badge.icon,
        name: badge.name,
        description: badge.description,
        criteria: badge.criteria as unknown as Prisma.InputJsonValue,
        is_secret: badge.isSecret ?? false,
        is_public: badge.isPublic ?? true,
        sort_order: badge.sortOrder ?? sortOrder,
      },
      create: {
        code: badge.code,
        category: badge.category,
        rarity: badge.rarity,
        icon: badge.icon,
        name: badge.name,
        description: badge.description,
        criteria: badge.criteria as unknown as Prisma.InputJsonValue,
        is_secret: badge.isSecret ?? false,
        is_public: badge.isPublic ?? true,
        sort_order: badge.sortOrder ?? sortOrder,
      },
    });
    sortOrder += 1;
  }

  console.log(`Seeded ${badges.length} badges.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
