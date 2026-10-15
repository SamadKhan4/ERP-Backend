const INDIA_OFFSET_MINUTES = 330;

const indiaClockMinutes = (value) => {
  if (!value) return null;
  const shifted = new Date(new Date(value).getTime() + INDIA_OFFSET_MINUTES * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

export function attendancePerformance({ checkIn, checkOut }) {
  const checkInMinutes = indiaClockMinutes(checkIn);
  const checkOutMinutes = indiaClockMinutes(checkOut);
  if (checkInMinutes === null) return 'Absent';
  if (checkInMinutes >= 16 * 60 || (checkOutMinutes !== null && checkOutMinutes < 16 * 60)) return 'Half Day';
  if (checkInMinutes <= 9 * 60 + 50 || (checkOutMinutes !== null && checkOutMinutes >= 18 * 60 + 30)) return 'On Time';
  return 'Late';
}
