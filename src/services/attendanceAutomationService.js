import { HRMSRecord } from '../models/HRMSRecord.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import { attendancePerformance } from './attendanceStatusService.js';

const INDIA_OFFSET_MS = 330 * 60000;
const DAY_MS = 86400000;
const attendanceRoles = ['employee', 'executive'];
let automationTimer;

export const startOfIndiaDay = (value = new Date()) => {
  const shifted = new Date(new Date(value).getTime() + INDIA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - INDIA_OFFSET_MS);
};

const isSunday = (day) =>
  new Date(day.getTime() + INDIA_OFFSET_MS).getUTCDay() === 0;

async function closeStaleAttendance(today, now) {
  const openRecords = await HRMSRecord.find({
    module: 'attendance',
    deletedAt: null,
    'data.checkIn': { $exists: true },
    'data.checkOut': { $exists: false },
    'data.date': { $lt: today },
  });

  for (const record of openRecords) {
    const attendanceDay = startOfIndiaDay(record.data?.date || record.data?.checkIn);
    const checkOut = new Date(attendanceDay.getTime() + DAY_MS - 1000);
    const minutesWorked = Math.max(
      0,
      Math.min(1440, Math.round((checkOut - new Date(record.data.checkIn)) / 60000)),
    );
    record.data = {
      ...record.data,
      checkOut,
      minutesWorked,
      attendanceStatus: attendancePerformance({
        checkIn: record.data.checkIn,
        checkOut,
      }),
      autoCheckedOut: true,
      autoCheckedOutAt: now,
    };
    record.updatedBy = record.employee;
    await record.save();
  }

  return openRecords.length;
}

async function markMissingEmployeesOnLeave(day, now) {
  const nextDay = new Date(day.getTime() + DAY_MS);
  if (isSunday(day)) return { skipped: 'sunday', markedOnLeave: 0 };

  const holiday = await HRMSRecord.exists({
    module: 'holidays',
    deletedAt: null,
    status: { $nin: ['Draft', 'Archived'] },
    'data.date': { $gte: day, $lt: nextDay },
  });
  if (holiday) return { skipped: 'holiday', markedOnLeave: 0 };

  const employees = await User.find({
    active: true,
    role: { $in: attendanceRoles },
    createdAt: { $lt: nextDay },
  }).select('_id department createdAt').lean();
  if (!employees.length) return { skipped: null, markedOnLeave: 0 };

  const employeeIds = employees.map((employee) => employee._id);
  const [profiles, existingRecords] = await Promise.all([
    EmployeeProfile.find({ user: { $in: employeeIds } })
      .select('user joiningDate')
      .lean(),
    HRMSRecord.find({
      module: 'attendance',
      employee: { $in: employeeIds },
      deletedAt: null,
      'data.date': { $gte: day, $lt: nextDay },
    }).select('employee').lean(),
  ]);
  const profileByEmployee = new Map(
    profiles.map((profile) => [String(profile.user), profile]),
  );
  const recordedEmployees = new Set(
    existingRecords.map((record) => String(record.employee)),
  );
  const missingEmployees = employees.filter((employee) => {
    if (recordedEmployees.has(String(employee._id))) return false;
    const joiningDate = profileByEmployee.get(String(employee._id))?.joiningDate;
    return !joiningDate || startOfIndiaDay(joiningDate) <= day;
  });

  if (missingEmployees.length) {
    await HRMSRecord.insertMany(
      missingEmployees.map((employee) => ({
        module: 'attendance',
        title: 'Automatic leave',
        employee: employee._id,
        department: employee.department,
        status: 'Leave',
        effectiveDate: day,
        data: {
          date: day,
          attendanceStatus: 'On Leave',
          automaticLeave: true,
          automationReason: 'No check-in recorded',
          markedAt: now,
        },
        createdBy: employee._id,
        updatedBy: employee._id,
      })),
    );
  }

  return { skipped: null, markedOnLeave: missingEmployees.length };
}

export async function runAttendanceAutomation({ now = new Date() } = {}) {
  const today = startOfIndiaDay(now);
  const previousDay = new Date(today.getTime() - DAY_MS);
  const autoCheckedOut = await closeStaleAttendance(today, now);
  const leaveResult = await markMissingEmployeesOnLeave(previousDay, now);
  return {
    date: previousDay,
    autoCheckedOut,
    ...leaveResult,
  };
}

const delayUntilNextRun = () => {
  const now = new Date();
  const nextMidnight = startOfIndiaDay(now).getTime() + DAY_MS + 5000;
  return Math.max(1000, nextMidnight - now.getTime());
};

export function startAttendanceAutomation() {
  if (automationTimer) return () => clearTimeout(automationTimer);

  const execute = async () => {
    try {
      const result = await runAttendanceAutomation();
      logger.info({ event: 'attendance.automation.completed', ...result }, 'Attendance automation completed');
    } catch (err) {
      logger.error({ err, event: 'attendance.automation.failed' }, 'Attendance automation failed');
    }
  };
  const schedule = () => {
    automationTimer = setTimeout(async () => {
      await execute();
      schedule();
    }, delayUntilNextRun());
    automationTimer.unref?.();
  };

  void execute();
  schedule();
  return () => {
    clearTimeout(automationTimer);
    automationTimer = undefined;
  };
}
