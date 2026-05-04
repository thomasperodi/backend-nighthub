import { BadRequestException } from '@nestjs/common';
import { Gender, Prisma } from '@prisma/client';
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

  // Prioritize exact-gender prices, but still allow neutral prices as fallback.
  if (rowGender === targetGender) score += 20;
  else if (rowGender === null) score += 10;

  // Prefer explicit time windows over all-night prices.
  if (startSeconds !== null && endSeconds !== null) score += 18;
  else if (startSeconds !== null || endSeconds !== null) score += 12;
  else score += 2;

  return score;
}

function getWindowCoverageSeconds(
  startSeconds: number | null,
  endSeconds: number | null,
): number {
  const fullDaySeconds = 24 * 60 * 60;

  if (startSeconds === null && endSeconds === null) return fullDaySeconds;
  if (startSeconds === null || endSeconds === null) {
    // Open-ended windows are treated as less specific than bounded windows.
    return 12 * 60 * 60;
  }

  if (startSeconds === endSeconds) return fullDaySeconds;
  if (startSeconds < endSeconds) return endSeconds - startSeconds;
  return fullDaySeconds - startSeconds + endSeconds;
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

  const eligibleRows = rows.filter(
    (row) => row.gender === targetGender || row.gender === null,
  );

  if (!eligibleRows.length) return null;

  const sortBySpecificity = (
    a: {
      gender: Gender | null;
      startSeconds: number | null;
      endSeconds: number | null;
      createdAt: Date;
    },
    b: {
      gender: Gender | null;
      startSeconds: number | null;
      endSeconds: number | null;
      createdAt: Date;
    },
  ) => {
    const aScore = scorePriceRow({
      rowGender: a.gender,
      targetGender,
      startSeconds: a.startSeconds,
      endSeconds: a.endSeconds,
    });
    const bScore = scorePriceRow({
      rowGender: b.gender,
      targetGender,
      startSeconds: b.startSeconds,
      endSeconds: b.endSeconds,
    });

    if (bScore !== aScore) return bScore - aScore;

    const aCoverage = getWindowCoverageSeconds(a.startSeconds, a.endSeconds);
    const bCoverage = getWindowCoverageSeconds(b.startSeconds, b.endSeconds);
    if (aCoverage !== bCoverage) return aCoverage - bCoverage;

    return b.createdAt.getTime() - a.createdAt.getTime();
  };

  const selected = [...eligibleRows].sort(sortBySpecificity)[0];
  return selected?.price ?? null;
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
    select: { id: true },
  });

  if (!event) return new Prisma.Decimal(0);

  const nowSeconds = getSecondsInTimeZone(getEventTimeZone(), at);
  const priceRows = await prisma.event_entry_prices.findMany({
    where: { event_id: eventId },
    orderBy: [{ created_at: 'desc' }],
  });

  if (!priceRows.length) {
    throw new BadRequestException(
      'Listino ingressi non configurato per questo evento',
    );
  }

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

  if (!applicable.length) {
    throw new BadRequestException(
      'Nessun prezzo ingresso valido per la fascia oraria corrente',
    );
  }

  const selectedPrice = pickBestRow(applicable, gender);
  if (!selectedPrice) {
    throw new BadRequestException(
      `Nessun prezzo ingresso configurato per il sesso ${gender} nella fascia oraria corrente`,
    );
  }

  if (selectedPrice.isNegative()) {
    throw new BadRequestException('Il prezzo ingresso non puo essere negativo');
  }

  return new Prisma.Decimal(selectedPrice);
}
