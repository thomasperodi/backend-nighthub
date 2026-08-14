import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PlanSeed = {
  key: string;
  name: string;
  tagline: string;
  icon: string;
  monthly_price: number | null;
  included_events: number | null;
  included_people: number | null;
  extra_event_price: number | null;
  extra_person_price: number | null;
  is_custom?: boolean;
  is_recommended?: boolean;
  sort_order: number;
};

const plans: PlanSeed[] = [
  {
    key: 'essential',
    name: 'Essential',
    tagline: 'Per locali piccoli e serate occasionali',
    icon: '🌙',
    monthly_price: 29,
    included_events: 2,
    included_people: 600,
    extra_event_price: 5,
    extra_person_price: 0.02,
    sort_order: 1,
  },
  {
    key: 'pulse',
    name: 'Pulse',
    tagline: 'Per locali attivi che vogliono crescere',
    icon: '🚀',
    monthly_price: 59,
    included_events: 6,
    included_people: 2500,
    extra_event_price: 4,
    extra_person_price: 0.015,
    is_recommended: true,
    sort_order: 2,
  },
  {
    key: 'peak',
    name: 'Peak',
    tagline: 'Per club e discoteche ad alto volume',
    icon: '🔥',
    monthly_price: 119,
    included_events: 12,
    included_people: 6000,
    extra_event_price: 3,
    extra_person_price: 0.01,
    sort_order: 3,
  },
  {
    key: 'elite',
    name: 'Elite',
    tagline: 'Per grandi realtà e organizzatori',
    icon: '👑',
    monthly_price: null,
    included_events: null,
    included_people: null,
    extra_event_price: null,
    extra_person_price: null,
    is_custom: true,
    sort_order: 4,
  },
];

async function main() {
  for (const plan of plans) {
    await prisma.subscription_plans.upsert({
      where: { key: plan.key },
      update: {
        name: plan.name,
        tagline: plan.tagline,
        icon: plan.icon,
        monthly_price: plan.monthly_price,
        included_events: plan.included_events,
        included_people: plan.included_people,
        extra_event_price: plan.extra_event_price,
        extra_person_price: plan.extra_person_price,
        is_custom: Boolean(plan.is_custom),
        is_recommended: Boolean(plan.is_recommended),
        sort_order: plan.sort_order,
      },
      create: {
        key: plan.key,
        name: plan.name,
        tagline: plan.tagline,
        icon: plan.icon,
        monthly_price: plan.monthly_price,
        included_events: plan.included_events,
        included_people: plan.included_people,
        extra_event_price: plan.extra_event_price,
        extra_person_price: plan.extra_person_price,
        is_custom: Boolean(plan.is_custom),
        is_recommended: Boolean(plan.is_recommended),
        sort_order: plan.sort_order,
      },
    });
    console.log(`✓ ${plan.name}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
