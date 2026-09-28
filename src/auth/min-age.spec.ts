import { BadRequestException } from '@nestjs/common';
import { assertMinimumAge, MIN_AGE } from './auth.service';

const codeOf = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (e) {
    return ((e as BadRequestException).getResponse() as { code?: string }).code;
  }
};

describe('assertMinimumAge', () => {
  const today = new Date(Date.UTC(2026, 8, 28)); // 28 settembre 2026

  it(`accetta chi compie ${MIN_AGE} anni oggi`, () => {
    expect(
      codeOf(() => assertMinimumAge(new Date('2012-09-28'), today)),
    ).toBeNull();
  });

  it(`rifiuta chi compie ${MIN_AGE} anni domani`, () => {
    expect(codeOf(() => assertMinimumAge(new Date('2012-09-29'), today))).toBe(
      'UNDERAGE',
    );
  });

  it('richiede la data di nascita', () => {
    expect(codeOf(() => assertMinimumAge(undefined, today))).toBe(
      'BIRTH_DATE_REQUIRED',
    );
  });

  it('rifiuta date nel futuro o assurde', () => {
    expect(codeOf(() => assertMinimumAge(new Date('2030-01-01'), today))).toBe(
      'BIRTH_DATE_INVALID',
    );
    expect(codeOf(() => assertMinimumAge(new Date('1900-01-01'), today))).toBe(
      'BIRTH_DATE_INVALID',
    );
  });
});
