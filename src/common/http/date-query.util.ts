import { BadRequestException } from '@nestjs/common';

/** Parses an optional ISO date/datetime query param (`?from=2026-09-01`). */
export function parseDateQuery(
  value: string | undefined,
  name: string,
): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Data non valida per "${name}"`);
  }
  return date;
}
