import { expect, test } from 'vitest';
import { attendancePerformance } from '../src/services/attendanceStatusService.js';

const indiaTime = (time) => `2026-10-15T${time}:00+05:30`;

test('attendance performance follows HR timing rules', () => {
  expect(attendancePerformance({ checkIn: indiaTime('09:50') })).toBe('On Time');
  expect(attendancePerformance({ checkIn: indiaTime('09:51') })).toBe('Late');
  expect(attendancePerformance({ checkIn: indiaTime('09:30'), checkOut: indiaTime('15:59') })).toBe('Half Day');
  expect(attendancePerformance({ checkIn: indiaTime('10:30'), checkOut: indiaTime('18:30') })).toBe('On Time');
  expect(attendancePerformance({ checkIn: indiaTime('16:00') })).toBe('Half Day');
});
