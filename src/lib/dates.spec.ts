import { describe, expect, it } from 'vitest';
import { formatShortPastDate } from './dates';

describe('formatShortPastDate', () => {
  it('labels a timestamp from earlier today as "dnes"', () => {
    expect(formatShortPastDate(new Date().toISOString())).toBe('dnes');
  });

  it('formats an earlier date as the day.month. shorthand', () => {
    const past = new Date();
    past.setDate(past.getDate() - 5);
    expect(formatShortPastDate(past.toISOString())).toBe(`${past.getDate()}.${past.getMonth() + 1}.`);
  });
});
