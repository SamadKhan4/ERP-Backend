import { z } from 'zod';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { AppError } from '../utils/errors.js';
import { employeeRoleFilterFor } from '../services/employeeAccessService.js';

export const monitoringRoles = ['super_admin', 'admin', 'manager', 'hr'];

export function requireMonitoringRole(req, res, next) {
  if (!monitoringRoles.includes(req.user.role))
    throw new AppError(403, 'Employee monitoring access required');
  next();
}

export async function employeeMonitoring(req, res) {
  const id = z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .parse(req.params.id);
  const { days } = z
    .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
    .parse(req.query);
  const employee = await User.findOne({
    _id: id,
    role: employeeRoleFilterFor(req.user.role),
  })
    .select('_id name email role department active')
    .lean();
  if (!employee) throw new AppError(404, 'Employee not found');
  const now = new Date();
  const indiaDate = new Date(now.getTime() + 330 * 60000);
  indiaDate.setUTCHours(0, 0, 0, 0);
  const today = new Date(indiaDate.getTime() - 330 * 60000);
  const from = new Date(today.getTime() - (days - 1) * 86400000);
  const until = new Date(today.getTime() + 86400000);
  const base = { employee: id, deletedAt: null };
  const [profile, attendance, reports, leaves, assets, performance] =
    await Promise.all([
      EmployeeProfile.findOne({ user: id })
        .select('employeeCode designation employmentType joiningDate manager')
        .populate('manager', 'name')
        .lean(),
      HRMSRecord.find({
        ...base,
        module: 'attendance',
        'data.date': { $gte: from, $lt: until },
      })
        .sort({ 'data.date': -1 })
        .lean(),
      HRMSRecord.find({
        ...base,
        module: 'daily-reports',
        'data.date': { $gte: from, $lt: until },
      })
        .sort({ 'data.date': -1 })
        .lean(),
      HRMSRecord.find({ ...base, module: 'leave' })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      HRMSRecord.find({ ...base, module: 'assets' })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
      HRMSRecord.find({
        ...base,
        module: {
          $in: ['performance', 'performance-goals', 'performance-reviews'],
        },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .lean(),
    ]);
  const todayAttendance = attendance.find(
    (record) => new Date(record.data.date) >= today,
  );
  const reportDays = new Set(
    reports.map((record) =>
      new Date(new Date(record.data.date).getTime() + 330 * 60000)
        .toISOString()
        .slice(0, 10),
    ),
  );
  const attendanceDays = new Set(
    attendance
      .filter((record) => record.data.checkIn)
      .map((record) =>
        new Date(new Date(record.data.date).getTime() + 330 * 60000)
          .toISOString()
          .slice(0, 10),
      ),
  );
  res.json({
    success: true,
    data: {
      employee: { ...employee, profile },
      generatedAt: now,
      period: { days, from, until },
      summary: {
        attendanceDays: attendanceDays.size,
        reportedDays: reportDays.size,
        missingReports: [...attendanceDays].filter(
          (day) => !reportDays.has(day),
        ).length,
        workedMinutes: attendance.reduce(
          (sum, record) => sum + (Number(record.data.minutesWorked) || 0),
          0,
        ),
        todayStatus: todayAttendance?.data.checkIn
          ? todayAttendance.data.checkOut
            ? 'Checked out'
            : 'Checked in'
          : 'No check-in recorded',
      },
      attendance,
      reports,
      leaves,
      assets,
      performance,
    },
  });
}
