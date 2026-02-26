import { EventAccessMode, Gender, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function getEventTimeZone(): string {
  return process.env.EVENTS_TIMEZONE || 'Europe/Rome';
}

function getSecondsInTimeZone(timeZone: string, instant: Date): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(instant);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  const hours = Number(map.get('hour') ?? 0);
  const minutes = Number(map.get('minute') ?? 0);
  const seconds = Number(map.get('second') ?? 0);

  return hours * 3600 + minutes * 60 + seconds;
}

function timeToSeconds(value: Date | null | undefined): number | null {
  if (!value) return null;
  return (
    value.getUTCHours() * 3600 +
    value.getUTCMinutes() * 60 +
    value.getUTCSeconds()
  );
}

function isTimeWindowMatch(params: {
  nowSeconds: number;
  startSeconds: number | null;
  endSeconds: number | null;
}): boolean {
  const { nowSeconds, startSeconds, endSeconds } = params;

  if (startSeconds === null && endSeconds === null) return true;
  if (startSeconds !== null && endSeconds === null)
    return nowSeconds >= startSeconds;
  if (startSeconds === null && endSeconds !== null)
    return nowSeconds <= endSeconds;

  if (startSeconds === endSeconds) return true;
  if (startSeconds! < endSeconds!) {
    return nowSeconds >= startSeconds! && nowSeconds <= endSeconds!;
  }

  return nowSeconds >= startSeconds! || nowSeconds <= endSeconds!;
}

function scorePriceRow(params: {
  rowGender: Gender | null;
  targetGender: Gender;
  startSeconds: number | null;
  endSeconds: number | null;
}): number {
  const { rowGender, targetGender, startSeconds, endSeconds } = params;

  let score = 0;
  if (rowGender === targetGender) score += 10;
  else if (rowGender === null) score += 1;

  if (startSeconds !== null && endSeconds !== null) score += 5;
  else if (startSeconds !== null || endSeconds !== null) score += 3;

  return score;
}

function pickBestRow(
  rows: Array<{
    price: Prisma.Decimal;
    gender: Gender | null;
    startSeconds: number | null;
    endSeconds: number | null;
    createdAt: Date;
  }>,
  targetGender: Gender,
): Prisma.Decimal | null {
  if (!rows.length) return null;

  const specificGenderRows = rows.filter((row) => row.gender === targetGender);
  const neutralGenderRows = rows.filter((row) => row.gender === null);

  const sortBySpecificity = (
    a: {
      startSeconds: number | null;
      endSeconds: number | null;
      createdAt: Date;
    },
    b: {
      startSeconds: number | null;
      endSeconds: number | null;
      createdAt: Date;
    },
  ) => {
    const aScore = scorePriceRow({
      rowGender: targetGender,
      targetGender,
      startSeconds: a.startSeconds,
      endSeconds: a.endSeconds,
    });
    const bScore = scorePriceRow({
      rowGender: targetGender,
      targetGender,
      startSeconds: b.startSeconds,
      endSeconds: b.endSeconds,
    });

    if (bScore !== aScore) return bScore - aScore;
    return b.createdAt.getTime() - a.createdAt.getTime();
  };

  if (specificGenderRows.length) {
    const selected = [...specificGenderRows].sort(sortBySpecificity)[0];
    return selected?.price ?? null;
  }

  if (neutralGenderRows.length) {
    const selected = [...neutralGenderRows].sort(sortBySpecificity)[0];
    return selected?.price ?? null;
  }

  return null;
}

export async function resolveEntryUnitPrice(params: {
  prisma: PrismaService;
  eventId: string;
  gender: Gender;
  isComplimentary?: boolean;
  at?: Date;
}): Promise<Prisma.Decimal> {
  const {
    prisma,
    eventId,
    gender,
    isComplimentary = false,
    at = new Date(),
  } = params;

  if (isComplimentary) return new Prisma.Decimal(0);

  const event = await prisma.events.findUnique({
    where: { id: eventId },
    select: { access_mode: true },
  });

  if (!event) return new Prisma.Decimal(0);
  if (event.access_mode === EventAccessMode.PRE_SALE) {
    return new Prisma.Decimal(0);
  }

  const nowSeconds = getSecondsInTimeZone(getEventTimeZone(), at);
  const priceRows = await prisma.event_entry_prices.findMany({
    where: { event_id: eventId },
    orderBy: [{ created_at: 'desc' }],
  });

  const applicable = priceRows
    .map((row) => {
      const startSeconds = timeToSeconds(row.start_time);
      const endSeconds = timeToSeconds(row.end_time);

      return {
        price: row.price,
        gender: row.gender,
        startSeconds,
        endSeconds,
        createdAt: row.created_at,
        matchesTime: isTimeWindowMatch({
          nowSeconds,
          startSeconds,
          endSeconds,
        }),
      };
    })
    .filter((item) => item.matchesTime);

  const selectedPrice = pickBestRow(applicable, gender);
  if (!selectedPrice) return new Prisma.Decimal(0);
  return new Prisma.Decimal(selectedPrice);
}
