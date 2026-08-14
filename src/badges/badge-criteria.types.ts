// Shape of the `criteria` JSON column on `badges`.
// Each `type` maps to an evaluator in BadgesService that computes a numeric
// metric for a user and compares it against `threshold`.

export type BadgeCriteria =
  | { type: 'entries_count'; threshold: number }
  | { type: 'distinct_venues_count'; threshold: number }
  | { type: 'friends_count'; threshold: number }
  | { type: 'table_reservations_count'; threshold: number }
  | { type: 'spend_total'; threshold: number }
  | { type: 'weekend_streak'; weeks: number }
  | { type: 'event_before_time'; before: string; threshold: number } // "HH:MM"
  | { type: 'event_after_time'; after: string; threshold: number } // "HH:MM"
  | {
      type: 'seasonal_window';
      // Window is defined by month/day pairs, re-evaluated every year.
      // If the "from" point falls after the "to" point in the calendar,
      // the window is treated as wrapping across the new year (e.g. winter).
      monthFrom: number;
      dayFrom: number;
      monthTo: number;
      dayTo: number;
      threshold: number;
    }
  | { type: 'account_age_days'; days: number }
  | { type: 'profile_completed' }
  | { type: 'early_adopter'; rank: number }
  | { type: 'coattend_same_friend'; threshold: number }
  | {
      type: 'coattend_group';
      minFriendsPresent: number;
      eventsThreshold: number;
    }
  | { type: 'manual' }; // never auto-unlocked; awarded explicitly (secret / untrackable badges)

export type BadgeCriteriaType = BadgeCriteria['type'];
