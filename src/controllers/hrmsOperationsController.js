import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { LeaveLedger } from '../models/LeaveLedger.js';
import { PayrollEntry } from '../models/PayrollEntry.js';
import { OnboardingDocument } from '../models/OnboardingDocument.js';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { employeeRoleFilterFor } from '../services/employeeAccessService.js';
import { nextEmployeeCode } from '../services/employeeCodeService.js';
import { attendancePerformance } from '../services/attendanceStatusService.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
const date = z.coerce.date();
const note = z.string().trim().min(1).max(1000);
const leaveType = z.string().trim().min(1).max(80);
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).passthrough();

const pdfText = (value) =>
  String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replace(/[^\x20-\x7E]/g, '?');

function simplePdf(lines) {
  const stream = `BT\n/F1 12 Tf\n50 790 Td\n${lines
    .map((line, index) => `${index ? '0 -25 Td\n' : ''}(${pdfText(line)}) Tj`)
    .join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

const startOfIndiaDay = (value = new Date()) => {
  const shifted = new Date(new Date(value).getTime() + 330 * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - 330 * 60000);
};

const daysInclusive = (start, end) =>
  Math.floor((startOfIndiaDay(end) - startOfIndiaDay(start)) / 86400000) + 1;

function ensureId(value, label = 'identifier') {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, `Invalid ${label}`);
}

async function audit(req, action, record, details) {
  await AuditLog.create({
    user: req.user.id,
    action,
    entityType: record.module || 'employees',
    entityId: record._id,
    details,
  });
}

function paginated(res, items, page, limit, total, message) {
  res.json({
    success: true,
    message,
    data: { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
  });
}

async function findRecord(id, module) {
  ensureId(id);
  const record = await HRMSRecord.findOne({ _id: id, module, deletedAt: null });
  if (!record) throw new AppError(404, 'HRMS record not found');
  return record;
}

async function listModule(req, res, module, extra = {}) {
  const { page, limit } = pageSchema.parse(req.query);
  const filter = {
    module,
    deletedAt: null,
    ...(req.query.status ? { status: String(req.query.status) } : {}),
    ...(req.query.employee ? { employee: req.query.employee } : {}),
    ...(req.user.role === 'team_leader' ? { department: req.user.department } : {}),
    ...extra,
  };
  const [items, total] = await Promise.all([
    HRMSRecord.find(filter).populate('employee', 'name email role department active').sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    HRMSRecord.countDocuments(filter),
  ]);
  paginated(res, items, page, limit, total, 'Records fetched successfully');
}

async function createRecord(req, module, { title, employee, department, status = 'Draft', effectiveDate, data = {} }) {
  const record = await HRMSRecord.create({
    module,
    title,
    employee,
    department,
    status,
    effectiveDate,
    data,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  await audit(req, `hrms.${module}.created`, record);
  return record;
}

export async function attendanceCheckIn(req, res) {
  const input = z.object({ note: z.string().trim().max(500).optional() }).strict().parse(req.body || {});
  const now = new Date();
  const day = startOfIndiaDay(now);
  const tomorrow = new Date(day.getTime() + 86400000);
  const existing = await HRMSRecord.findOne({ module: 'attendance', employee: req.user.id, deletedAt: null, 'data.date': { $gte: day, $lt: tomorrow } });
  if (existing) throw new AppError(409, existing.data?.checkOut ? 'Attendance already completed today' : 'Already checked in today');
  const record = await createRecord(req, 'attendance', {
    title: 'Daily attendance', employee: req.user.id, department: req.user.department,
    status: 'Present', effectiveDate: day,
    data: { date: day, checkIn: now, attendanceStatus: attendancePerformance({ checkIn: now }), note: input.note },
  });
  res.status(201).json({ success: true, message: 'Checked in successfully', data: record });
}

export async function attendanceCheckOut(req, res) {
  z.object({ note: z.string().trim().max(500).optional() }).strict().parse(req.body || {});
  const now = new Date();
  const earliest = new Date(startOfIndiaDay(now).getTime() - 86400000);
  const record = await HRMSRecord.findOne({ module: 'attendance', employee: req.user.id, deletedAt: null, 'data.checkIn': { $gte: earliest }, 'data.checkOut': { $exists: false } }).sort({ 'data.checkIn': -1 });
  if (!record) throw new AppError(409, 'No open attendance punch found');
  if (['employee', 'executive'].includes(req.user.role)) {
    const day = startOfIndiaDay(record.data.date || record.data.checkIn);
    const report = await HRMSRecord.exists({
      module: 'daily-reports',
      employee: req.user.id,
      deletedAt: null,
      'data.date': { $gte: day, $lt: new Date(day.getTime() + 86400000) },
    });
    if (!report)
      throw new AppError(409, 'Submit today’s daily report before checking out');
  }
  const minutesWorked = Math.max(0, Math.min(1440, Math.round((now - new Date(record.data.checkIn)) / 60000)));
  record.data = { ...record.data, checkOut: now, minutesWorked, attendanceStatus: attendancePerformance({ checkIn: record.data.checkIn, checkOut: now }) };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, 'hrms.attendance.checked_out', record, { minutesWorked });
  res.json({ success: true, message: 'Checked out successfully', data: record });
}

export async function attendanceToday(req, res) {
  const day = startOfIndiaDay();
  return listModule(req, res, 'attendance', { 'data.date': { $gte: day, $lt: new Date(day.getTime() + 86400000) } });
}

export async function attendanceDaily(req, res) {
  const input = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(req.query);
  const day = startOfIndiaDay(`${input.date}T00:00:00+05:30`);
  const tomorrow = new Date(day.getTime() + 86400000);
  const filter = {
    module: 'attendance',
    deletedAt: null,
    'data.date': { $gte: day, $lt: tomorrow },
    ...(req.user.role === 'team_leader' ? { department: req.user.department } : {}),
  };
  const records = await HRMSRecord.find(filter)
    .populate('employee', 'name email role department active')
    .sort({ 'data.checkIn': 1 })
    .lean();
  const items = records.map((record) => ({
    ...record,
    attendanceStatus: attendancePerformance({ checkIn: record.data?.checkIn, checkOut: record.data?.checkOut }),
  }));
  const summary = items.reduce((result, item) => {
    result[item.attendanceStatus] = (result[item.attendanceStatus] || 0) + 1;
    return result;
  }, { 'On Time': 0, Late: 0, 'Half Day': 0 });
  res.json({ success: true, message: 'Daily attendance fetched successfully', data: { date: input.date, items, summary, total: items.length } });
}

export async function myAttendance(req, res) {
  return listModule(req, res, 'attendance', { employee: req.user.id });
}

export async function createDailyReport(req, res) {
  const input = z.object({
    summary: z.string().trim().min(10).max(3000),
    completedTasks: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    blockers: z.string().trim().max(1000).optional(),
    tomorrowPlan: z.string().trim().max(1000).optional(),
  }).strict().parse(req.body);
  const earliest = new Date(startOfIndiaDay().getTime() - 86400000);
  const attendance = await HRMSRecord.findOne({
    module: 'attendance',
    employee: req.user.id,
    deletedAt: null,
    'data.checkIn': { $gte: earliest },
    'data.checkOut': { $exists: false },
  }).sort({ 'data.checkIn': -1 });
  if (!attendance) throw new AppError(409, 'Check in before submitting a daily report');
  const day = startOfIndiaDay(attendance.data.date || attendance.data.checkIn);
  const tomorrow = new Date(day.getTime() + 86400000);
  if (await HRMSRecord.exists({ module: 'daily-reports', employee: req.user.id, deletedAt: null, 'data.date': { $gte: day, $lt: tomorrow } }))
    throw new AppError(409, 'Daily report already submitted for this attendance day');
  const record = await createRecord(req, 'daily-reports', {
    title: `Daily report · ${day.toISOString().slice(0, 10)}`,
    employee: req.user.id,
    department: req.user.department,
    status: 'Submitted',
    effectiveDate: day,
    data: { ...input, date: day, submittedAt: new Date() },
  });
  res.status(201).json({ success: true, message: 'Daily report submitted successfully', data: record });
}

export async function myDailyReports(req, res) {
  return listModule(req, res, 'daily-reports', { employee: req.user.id });
}

export async function employeeDashboard(req, res) {
  const today = startOfIndiaDay();
  const tomorrow = new Date(today.getTime() + 86400000);
  const attendanceFrom = new Date(today.getTime() - 31 * 86400000);
  const [profile, todayAttendance, dailyReport, recentAttendance, leaveBalances, holidays, payrollEntries, announcements, leaveRequests] = await Promise.all([
    EmployeeProfile.findOne({ user: req.user.id }).select('-address -emergencyContact').lean(),
    HRMSRecord.findOne({ module: 'attendance', employee: req.user.id, deletedAt: null, 'data.date': { $gte: today, $lt: tomorrow } }).lean(),
    HRMSRecord.findOne({ module: 'daily-reports', employee: req.user.id, deletedAt: null, 'data.date': { $gte: today, $lt: tomorrow } }).lean(),
    HRMSRecord.find({ module: 'attendance', employee: req.user.id, deletedAt: null, 'data.date': { $gte: attendanceFrom } }).sort({ 'data.date': -1 }).limit(31).lean(),
    balanceFor(req.user.id),
    HRMSRecord.find({ module: 'holidays', deletedAt: null, 'data.date': { $gte: today }, status: { $nin: ['Draft', 'Archived'] } }).sort({ 'data.date': 1 }).limit(6).lean(),
    PayrollEntry.find({ employee: req.user.id }).populate({ path: 'run', match: { module: 'payroll-runs', deletedAt: null, status: { $in: ['Approved', 'Paid'] } }, select: 'title status data.month data.year' }).sort({ _id: -1 }).limit(6).lean(),
    HRMSRecord.find({ module: 'announcements', deletedAt: null, status: { $in: ['Published', 'Scheduled'] } }).sort({ effectiveDate: -1, createdAt: -1 }).limit(5).lean(),
    HRMSRecord.find({ module: 'leave', employee: req.user.id, deletedAt: null }).sort({ _id: -1 }).limit(8).lean(),
  ]);
  res.json({
    success: true,
    data: {
      generatedAt: new Date(),
      employee: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        department: req.user.department || null,
        profile,
      },
      todayAttendance,
      dailyReport,
      recentAttendance,
      leaveBalances,
      upcomingHolidays: holidays,
      payslips: payrollEntries.filter((entry) => entry.run).map((entry) => ({ payrollRun: entry.run, entry })),
      announcements,
      leaveRequests,
    },
  });
}

export async function attendanceSummary(req, res) {
  const from = req.query.from ? date.parse(req.query.from) : new Date(startOfIndiaDay().setUTCDate(startOfIndiaDay().getUTCDate() - 30));
  const to = req.query.to ? date.parse(req.query.to) : new Date();
  const match = { module: 'attendance', deletedAt: null, 'data.date': { $gte: from, $lte: to }, ...(req.query.employee ? { employee: new mongoose.Types.ObjectId(req.query.employee) } : {}) };
  const data = await HRMSRecord.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, minutes: { $sum: { $ifNull: ['$data.minutesWorked', 0] } } } }, { $sort: { count: -1 } }]);
  res.json({ success: true, message: 'Attendance summary fetched successfully', data: { from, to, statuses: data } });
}

export async function createRegularization(req, res) {
  const input = z.object({ attendanceId: objectId, requestedCheckIn: date.optional(), requestedCheckOut: date.optional(), reason: note }).strict().parse(req.body);
  const attendance = await findRecord(input.attendanceId, 'attendance');
  if (String(attendance.employee) !== String(req.user.id)) throw new AppError(403, 'You can only correct your own attendance');
  const pending = await HRMSRecord.exists({ module: 'attendance-regularizations', employee: req.user.id, status: 'Pending', deletedAt: null, 'data.attendanceId': attendance._id });
  if (pending) throw new AppError(409, 'A correction request is already pending');
  const record = await createRecord(req, 'attendance-regularizations', { title: 'Attendance correction', employee: req.user.id, department: req.user.department, status: 'Pending', data: input });
  res.status(201).json({ success: true, message: 'Correction requested successfully', data: record });
}

export async function reviewRegularization(req, res) {
  const input = z.object({ reason: z.string().trim().max(1000).optional() }).strict().parse(req.body || {});
  const record = await findRecord(req.params.id, 'attendance-regularizations');
  if (record.status !== 'Pending') throw new AppError(409, 'Correction request has already been reviewed');
  const approved = req.params.decision === 'approve';
  if (approved) {
    const attendance = await findRecord(record.data.attendanceId, 'attendance');
    const checkIn = record.data.requestedCheckIn || attendance.data.checkIn;
    const checkOut = record.data.requestedCheckOut || attendance.data.checkOut;
    attendance.data = { ...attendance.data, checkIn, checkOut, ...(checkIn && checkOut ? { minutesWorked: Math.max(0, Math.min(1440, Math.round((new Date(checkOut) - new Date(checkIn)) / 60000))) } : {}), correctedBy: req.user.id };
    attendance.updatedBy = req.user.id;
    await attendance.save();
  }
  record.status = approved ? 'Approved' : 'Rejected';
  record.data = { ...record.data, reviewerNote: input.reason, reviewedAt: new Date(), reviewedBy: req.user.id };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, `hrms.attendance_regularization.${req.params.decision}d`, record);
  res.json({ success: true, message: `Correction ${record.status.toLowerCase()} successfully`, data: record });
}

export async function finalizeAttendance(req, res) {
  const input = z.object({ from: date, to: date }).strict().refine((v) => v.to >= v.from, { message: 'End date must follow start date' }).parse(req.body);
  const existing = await HRMSRecord.exists({ module: 'attendance-periods', deletedAt: null, 'data.from': input.from, 'data.to': input.to });
  if (existing) throw new AppError(409, 'Attendance period already finalized');
  const result = await HRMSRecord.updateMany({ module: 'attendance', deletedAt: null, 'data.date': { $gte: input.from, $lte: input.to }, 'data.finalizedAt': { $exists: false } }, { $set: { 'data.finalizedAt': new Date(), 'data.finalizedBy': req.user._id, updatedBy: req.user._id } });
  const record = await createRecord(req, 'attendance-periods', { title: 'Finalized attendance period', status: 'Finalized', effectiveDate: input.to, data: { ...input, recordsLocked: result.modifiedCount } });
  res.status(201).json({ success: true, message: 'Attendance finalized successfully', data: record });
}

async function balanceFor(employee, type) {
  const groups = await LeaveLedger.aggregate([{ $match: { employee: new mongoose.Types.ObjectId(employee), ...(type ? { leaveType: type } : {}) } }, { $group: { _id: '$leaveType', balance: { $sum: '$amount' } } }, { $sort: { _id: 1 } }]);
  return groups.map((item) => ({ leaveType: item._id, balance: item.balance }));
}

export async function getLeaveBalance(req, res) {
  const employee = req.params.employeeId || req.user.id;
  ensureId(employee, 'employee identifier');
  if (req.params.employeeId && !['super_admin', 'admin', 'hr', 'manager', 'team_leader'].includes(req.user.role)) throw new AppError(403, 'Employee balance access denied');
  res.json({ success: true, message: 'Leave balance fetched successfully', data: await balanceFor(employee) });
}

export async function createLeaveRequest(req, res) {
  const input = z.object({ leaveType, startDate: date, endDate: date, reason: note, title: z.string().trim().max(180).optional() }).strict().refine((v) => v.endDate >= v.startDate, { message: 'End date must follow start date' }).parse(req.body);
  const employee = req.body.employee || req.user.id;
  const overlap = await HRMSRecord.exists({ module: 'leave', employee, deletedAt: null, status: { $in: ['Pending', 'Approved'] }, 'data.startDate': { $lte: input.endDate }, 'data.endDate': { $gte: input.startDate } });
  if (overlap) throw new AppError(409, 'Leave overlaps an existing request');
  const record = await createRecord(req, 'leave', { title: input.title || `${input.leaveType} leave`, employee, department: req.user.department, status: 'Pending', effectiveDate: input.startDate, data: input });
  res.status(201).json({ success: true, message: 'Leave requested successfully', data: record });
}

export async function reviewLeave(req, res) {
  const input = z.object({ reason: z.string().trim().max(1000).optional() }).strict().parse(req.body || {});
  const record = await findRecord(req.params.id, 'leave');
  if (record.status !== 'Pending') throw new AppError(409, 'Leave request has already been reviewed');
  const approved = req.params.decision === 'approve';
  if (approved) {
    const days = daysInclusive(record.data.startDate, record.data.endDate);
    const balances = await balanceFor(record.employee, record.data.leaveType);
    const balance = balances[0]?.balance || 0;
    if (record.data.leaveType !== 'unpaid' && balance < days) throw new AppError(409, 'Insufficient leave balance');
    await LeaveLedger.create({ employee: record.employee, leaveType: record.data.leaveType, amount: -days, reason: 'approved_leave', request: record._id, createdBy: req.user.id });
  }
  record.status = approved ? 'Approved' : 'Rejected';
  record.data = { ...record.data, reviewerNote: input.reason, reviewedAt: new Date(), reviewedBy: req.user.id };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, `hrms.leave.${req.params.decision}d`, record);
  res.json({ success: true, message: `Leave ${record.status.toLowerCase()} successfully`, data: record });
}

export async function cancelLeave(req, res) {
  const record = await findRecord(req.params.id, 'leave');
  if (String(record.employee) !== String(req.user.id) && !['super_admin', 'admin', 'hr'].includes(req.user.role)) throw new AppError(403, 'Leave cancellation denied');
  if (!['Pending', 'Approved'].includes(record.status)) throw new AppError(409, 'Leave cannot be cancelled');
  if (record.status === 'Approved') {
    const debit = await LeaveLedger.findOne({ request: record._id, reason: 'approved_leave' });
    if (debit) await LeaveLedger.create({ employee: record.employee, leaveType: debit.leaveType, amount: -debit.amount, reason: 'approved_leave_reversal', request: record._id, createdBy: req.user.id });
  }
  record.status = 'Cancelled';
  record.data = { ...record.data, cancelledAt: new Date(), cancelledBy: req.user.id };
  await record.save();
  await audit(req, 'hrms.leave.cancelled', record);
  res.json({ success: true, message: 'Leave cancelled successfully', data: record });
}

export async function adjustLeave(req, res) {
  const input = z.object({ employee: objectId, leaveType, amount: z.number().min(-365).max(365).refine((v) => v !== 0), reason: note }).strict().parse(req.body);
  const entry = await LeaveLedger.create({ ...input, createdBy: req.user.id });
  await AuditLog.create({ user: req.user.id, action: 'hrms.leave.balance_adjusted', entityType: 'leave-ledger', entityId: entry._id, details: { amount: input.amount, leaveType: input.leaveType } });
  res.status(201).json({ success: true, message: 'Leave balance adjusted successfully', data: entry });
}

export async function assignSalary(req, res) {
  const input = z.object({ structureId: objectId.optional(), annualCTC: z.number().positive(), effectiveFrom: date, components: z.array(z.object({ name: z.string().trim().min(1).max(100), type: z.enum(['earning', 'deduction']), amount: z.number().min(0) })).max(50).default([]) }).strict().parse(req.body);
  ensureId(req.params.id, 'employee identifier');
  if (!(await User.exists({ _id: req.params.id, active: true }))) throw new AppError(404, 'Employee not found');
  const version = (await HRMSRecord.countDocuments({ module: 'salary-assignments', employee: req.params.id, deletedAt: null })) + 1;
  const record = await createRecord(req, 'salary-assignments', { title: `Salary assignment v${version}`, employee: req.params.id, status: 'Active', effectiveDate: input.effectiveFrom, data: { ...input, version, currency: 'INR' } });
  res.status(201).json({ success: true, message: 'Salary assigned successfully', data: record });
}

export async function salaryHistory(req, res) {
  return listModule(req, res, 'salary-assignments', { employee: req.params.id });
}

export async function employeeHistory(req, res) {
  ensureId(req.params.id, 'employee identifier');
  const [profile, records, logs] = await Promise.all([
    EmployeeProfile.findOne({ user: req.params.id }).lean(),
    HRMSRecord.find({ module: { $in: ['salary-assignments', 'onboarding', 'offboarding'] }, employee: req.params.id, deletedAt: null }).sort({ effectiveDate: -1, _id: -1 }).lean(),
    AuditLog.find({ entityType: 'employees', entityId: req.params.id }).sort({ _id: -1 }).lean(),
  ]);
  res.json({ success: true, message: 'Employment history fetched successfully', data: { profile, records, auditEvents: logs } });
}

export async function transferEmployee(req, res) {
  const input = z.object({ department: z.enum(['social_media', 'web_dev', 'graphics', 'video_editing', 'seo']), manager: objectId.optional(), location: z.string().trim().max(120).optional(), effectiveDate: date.default(() => new Date()), reason: z.string().trim().max(500).optional() }).strict().parse(req.body);
  ensureId(req.params.id, 'employee identifier');
  const employee = await User.findById(req.params.id);
  if (!employee || employee.role === 'customer') throw new AppError(404, 'Employee not found');
  const previous = { department: employee.department };
  employee.department = input.department;
  await employee.save();
  const profile = await EmployeeProfile.findOneAndUpdate({ user: employee._id }, { $set: { department: input.department, manager: input.manager }, $setOnInsert: { user: employee._id, employeeCode: await nextEmployeeCode() } }, { new: true, upsert: true });
  const record = await createRecord(req, 'onboarding', { title: 'Employee transfer', employee: employee._id, department: input.department, status: 'Completed', effectiveDate: input.effectiveDate, data: { joiningDate: input.effectiveDate, progress: 100, tasks: [], event: 'transfer', previous, location: input.location, manager: input.manager, reason: input.reason } });
  res.status(201).json({ success: true, message: 'Employee transferred successfully', data: { employee, profile, record } });
}

export async function promoteEmployee(req, res) {
  const input = z.object({ designation: z.string().trim().min(1).max(120), effectiveDate: date.default(() => new Date()), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
  ensureId(req.params.id, 'employee identifier');
  const profile = await EmployeeProfile.findOne({ user: req.params.id });
  if (!profile) throw new AppError(404, 'Employee profile not found');
  const previousDesignation = profile.designation;
  profile.designation = input.designation;
  await profile.save();
  const record = await createRecord(req, 'performance', { title: 'Employee promotion', employee: req.params.id, department: profile.department, status: 'Completed', effectiveDate: input.effectiveDate, data: { participants: 1, completion: 100, period: String(input.effectiveDate.getFullYear()), event: 'promotion', previousDesignation, designation: input.designation, note: input.note } });
  res.status(201).json({ success: true, message: 'Promotion recorded successfully', data: { profile, record } });
}

export async function employeeRelated(req, res) {
  const modules = { documents: 'documents', assets: 'assets', 'attendance-summary': 'attendance', 'leave-summary': 'leave' };
  const module = modules[req.params.related];
  if (!module) throw new AppError(404, 'Employee resource not found');
  if (req.params.related === 'documents') {
    const { page, limit } = pageSchema.parse(req.query);
    const filter = { employee: req.params.id, deletedAt: null };
    const [items, total] = await Promise.all([
      OnboardingDocument.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      OnboardingDocument.countDocuments(filter),
    ]);
    return paginated(res, items, page, limit, total, 'Employee documents fetched successfully');
  }
  if (req.params.related.endsWith('summary')) {
    const rows = await HRMSRecord.aggregate([{ $match: { module, employee: new mongoose.Types.ObjectId(req.params.id), deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 }, minutes: { $sum: { $ifNull: ['$data.minutesWorked', 0] } } } }]);
    return res.json({ success: true, message: 'Employee summary fetched successfully', data: rows });
  }
  return listModule(req, res, module, { employee: req.params.id });
}

export async function importEmployees(req, res) {
  const input = z.object({ employees: z.array(z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), department: z.enum(['social_media', 'web_dev', 'graphics', 'video_editing', 'seo']).optional(), designation: z.string().trim().max(120).optional(), joiningDate: date.optional() }).strict()).min(1).max(100) }).strict().parse(req.body);
  const duplicateInput = input.employees.map((item) => item.email.toLowerCase()).filter((email, index, all) => all.indexOf(email) !== index);
  if (duplicateInput.length) throw new AppError(409, `Duplicate import email: ${duplicateInput[0]}`);
  const exists = await User.findOne({ email: { $in: input.employees.map((item) => item.email.toLowerCase()) } });
  if (exists) throw new AppError(409, `ERP user already exists: ${exists.email}`);
  const cases = await HRMSRecord.insertMany(input.employees.map((item) => ({
    module: 'onboarding', title: item.name, department: item.department,
    status: 'Unassigned', effectiveDate: item.joiningDate,
    data: { personal: { fullName: item.name, email: item.email.toLowerCase() }, employment: { department: item.department, designation: item.designation, joiningDate: item.joiningDate }, requiredDocuments: ['identity_proof', 'address_proof', 'profile_photo', 'education', 'bank_proof'], tasks: [], progress: 0, importedAt: new Date() },
    createdBy: req.user.id, updatedBy: req.user.id,
  })));
  await AuditLog.create({ user: req.user.id, action: 'hrms.onboarding.imported', entityType: 'onboarding', details: { count: cases.length } });
  res.status(201).json({ success: true, message: `${cases.length} unassigned onboarding cases imported successfully`, data: { count: cases.length, items: cases } });
}

export async function exportEmployees(req, res) {
  const users = await User.find({ role: employeeRoleFilterFor(req.user.role) }).select('_id name email role department active createdAt').sort({ name: 1 }).lean();
  const profiles = await EmployeeProfile.find({ user: { $in: users.map((item) => item._id) } }).select('-address -emergencyContact').lean();
  const map = new Map(profiles.map((item) => [String(item.user), item]));
  res.setHeader('Content-Disposition', 'attachment; filename="employees.json"');
  res.json({ success: true, message: 'Employees exported successfully', data: { items: users.map((item) => ({ ...item, profile: map.get(String(item._id)) })) } });
}

export async function createPayrollRun(req, res) {
  const input = z.object({ month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2200), title: z.string().trim().max(180).optional() }).strict().parse(req.body);
  const exists = await HRMSRecord.exists({ module: 'payroll-runs', deletedAt: null, 'data.month': input.month, 'data.year': input.year });
  if (exists) throw new AppError(409, 'Payroll run already exists for this month');
  const record = await createRecord(req, 'payroll-runs', { title: input.title || `Payroll ${input.month}/${input.year}`, status: 'Draft', data: { ...input, currency: 'INR', entries: [] } });
  res.status(201).json({ success: true, message: 'Payroll run created successfully', data: record });
}

export async function calculatePayroll(req, res) {
  const run = await findRecord(req.params.id, 'payroll-runs');
  if (!['Draft', 'Calculated'].includes(run.status)) throw new AppError(409, 'Payroll run is locked');
  const employees = await User.find({ active: true, role: { $nin: ['customer'] } }).select('_id name department').lean();
  const assignments = await HRMSRecord.find({ module: 'salary-assignments', deletedAt: null, employee: { $in: employees.map((item) => item._id) }, effectiveDate: { $lte: new Date(run.data.year, run.data.month, 0) } }).sort({ employee: 1, effectiveDate: -1 }).lean();
  const latest = new Map();
  for (const item of assignments) if (!latest.has(String(item.employee))) latest.set(String(item.employee), item);
  const entries = employees.map((employee) => {
    const salary = latest.get(String(employee._id));
    const gross = salary ? Math.round(salary.data.annualCTC / 12) : 0;
    const deductions = (salary?.data.components || []).filter((c) => c.type === 'deduction').reduce((sum, c) => sum + c.amount, 0);
    return { run: run._id, employee: employee._id, employeeName: employee.name, department: employee.department, salaryAssignment: salary?._id, gross, deductions, net: Math.max(0, gross - deductions), currency: 'INR', snapshot: { salaryVersion: salary?.data?.version, components: salary?.data?.components || [] } };
  });
  await PayrollEntry.deleteMany({ run: run._id });
  if (entries.length) await PayrollEntry.insertMany(entries);
  run.status = 'Calculated';
  run.data = { ...run.data, entries: undefined, employeeCount: entries.length, grossAmount: entries.reduce((sum, item) => sum + item.gross, 0), netAmount: entries.reduce((sum, item) => sum + item.net, 0), calculatedAt: new Date(), calculatedBy: req.user.id };
  run.updatedBy = req.user.id;
  await run.save();
  await audit(req, 'hrms.payroll.calculated', run, { employeeCount: entries.length });
  res.json({ success: true, message: 'Payroll calculated successfully', data: run });
}

export async function approvePayroll(req, res) {
  const run = await findRecord(req.params.id, 'payroll-runs');
  if (run.status !== 'Calculated') throw new AppError(409, 'Only calculated payroll can be approved');
  if (String(run.data.calculatedBy) === String(req.user.id)) throw new AppError(409, 'Maker-checker requires another authorized user');
  run.status = 'Approved';
  run.data = { ...run.data, approvedAt: new Date(), approvedBy: req.user.id };
  await run.save();
  await audit(req, 'hrms.payroll.approved', run);
  res.json({ success: true, message: 'Payroll approved successfully', data: run });
}

export async function markPayrollPaid(req, res) {
  const input = z.object({ reference: z.string().trim().min(1).max(150), paidAt: date.default(() => new Date()), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
  const run = await findRecord(req.params.id, 'payroll-runs');
  if (run.status !== 'Approved') throw new AppError(409, 'Only approved payroll can be marked paid');
  run.status = 'Paid';
  run.data = { ...run.data, paymentRegister: { ...input, recordedBy: req.user.id }, paymentDisclaimer: 'Recorded payment status; no bank transfer was initiated by ERP.' };
  await run.save();
  await audit(req, 'hrms.payroll.marked_paid', run, { reference: input.reference });
  res.json({ success: true, message: 'Payroll payment recorded successfully', data: run });
}

export async function payrollEntries(req, res) {
  await findRecord(req.params.id, 'payroll-runs');
  const { page, limit } = pageSchema.parse(req.query);
  const filter = { run: req.params.id };
  const [items, total] = await Promise.all([PayrollEntry.find(filter).populate('employee', 'name email department active').sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).lean(), PayrollEntry.countDocuments(filter)]);
  paginated(res, items, page, limit, total, 'Payroll entries fetched successfully');
}

export async function myPayslips(req, res) {
  const entries = await PayrollEntry.find({ employee: req.user.id }).populate({ path: 'run', match: { module: 'payroll-runs', deletedAt: null, status: { $in: ['Approved', 'Paid'] } }, select: 'title status data.month data.year' }).sort({ _id: -1 }).lean();
  const items = entries.filter((item) => item.run).map((entry) => ({ payrollRun: entry.run, entry }));
  paginated(res, items, 1, items.length || 20, items.length, 'Payslips fetched successfully');
}

export async function downloadPayslip(req, res) {
  const run = await findRecord(req.params.id, 'payroll-runs');
  const employee = req.query.employee || req.user.id;
  if (String(employee) !== String(req.user.id) && !['super_admin', 'admin', 'hr'].includes(req.user.role)) throw new AppError(403, 'Payslip access denied');
  const entry = await PayrollEntry.findOne({ run: run._id, employee }).lean();
  if (!entry) throw new AppError(404, 'Payslip not found');
  const pdf = simplePdf([
    'AdBorn ERP - Salary Payslip',
    `Payroll period: ${run.title}`,
    `Employee: ${entry.employeeName}`,
    `Department: ${entry.department || 'Not assigned'}`,
    `Gross salary: INR ${Number(entry.gross).toFixed(2)}`,
    `Deductions: INR ${Number(entry.deductions).toFixed(2)}`,
    `Net salary: INR ${Number(entry.net).toFixed(2)}`,
    `Payment status: ${run.status}`,
    `Generated: ${new Date().toISOString()}`,
  ]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${run.data.year}-${run.data.month}.pdf"`);
  res.send(pdf);
}

export async function convertCandidate(req, res) {
  const input = z.object({ joiningDate: date.optional(), designation: z.string().trim().max(120).optional(), workLocation: z.string().trim().max(120).optional() }).strict().parse(req.body);
  const candidate = await findRecord(req.params.id, 'candidates');
  if (candidate.data.convertedOnboarding) {
    const onboarding = await HRMSRecord.findById(candidate.data.convertedOnboarding).lean();
    return res.json({ success: true, message: 'Candidate already has an onboarding case', data: onboarding });
  }
  if (candidate.status !== 'Hired') throw new AppError(409, 'Only a hired candidate can be converted');
  if (!candidate.data.email || !candidate.data.name) throw new AppError(400, 'Candidate name and email are required');
  const existing = await User.findOne({ email: String(candidate.data.email).toLowerCase() });
  if (existing) throw new AppError(409, 'An ERP user already exists for this email');
  const onboarding = await createRecord(req, 'onboarding', {
    title: candidate.data.name, department: candidate.department, status: 'Unassigned', effectiveDate: input.joiningDate,
    data: { personal: { fullName: candidate.data.name, email: String(candidate.data.email).toLowerCase(), phone: candidate.data.phone }, employment: { department: candidate.department, designation: input.designation, joiningDate: input.joiningDate, workLocation: input.workLocation }, address: {}, emergencyContact: {}, education: [], experience: [], requiredDocuments: ['identity_proof', 'address_proof', 'profile_photo', 'education', 'bank_proof'], tasks: [], progress: 0, sourceCandidate: candidate._id },
  });
  candidate.data = { ...candidate.data, convertedOnboarding: onboarding._id, convertedAt: new Date() };
  await candidate.save();
  await audit(req, 'hrms.candidate.onboarding_created', candidate, { onboarding: onboarding._id });
  res.status(201).json({ success: true, message: 'Candidate moved to unassigned onboarding', data: onboarding });
}

export async function mutateChecklist(req, res) {
  const module = req.params.workflow;
  if (!['onboarding', 'offboarding'].includes(module)) throw new AppError(404, 'Workflow not found');
  const record = await findRecord(req.params.id, module);
  if (module === 'onboarding' && record.status === 'Completed') throw new AppError(409, 'Completed onboarding is locked');
  const tasks = record.data.tasks || [];
  if (req.params.taskId) {
    const input = z.object({ label: z.string().trim().min(1).max(160).optional(), completed: z.boolean().optional() }).strict().parse(req.body);
    const index = tasks.findIndex((item) => item.id === req.params.taskId);
    if (index < 0) throw new AppError(404, 'Task not found');
    tasks[index] = { ...tasks[index], ...input, ...(input.completed ? { completedAt: new Date(), completedBy: req.user.id } : { completedAt: undefined, completedBy: undefined }) };
  } else {
    const input = z.object({ label: z.string().trim().min(1).max(160), required: z.boolean().default(true) }).strict().parse(req.body);
    tasks.push({ id: randomUUID(), ...input, completed: false });
  }
  record.data = { ...record.data, tasks, progress: tasks.length ? Math.round(tasks.filter((item) => item.completed).length / tasks.length * 100) : 0 };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, `hrms.${module}.task_updated`, record);
  res.json({ success: true, message: 'Checklist updated successfully', data: record });
}

export async function completeWorkflow(req, res) {
  const module = req.params.workflow;
  const record = await findRecord(req.params.id, module);
  const incomplete = (record.data.tasks || []).filter((task) => task.required !== false && !task.completed);
  const incompleteClearances = module === 'offboarding' ? (record.data.clearances || []).filter((item) => item.required !== false && item.status !== 'Cleared') : [];
  if (incomplete.length || incompleteClearances.length) throw new AppError(409, 'Required tasks and clearances must be completed first');
  record.status = 'Completed';
  record.data = { ...record.data, progress: 100, completedAt: new Date(), completedBy: req.user.id };
  await record.save();
  if (module === 'offboarding' && record.employee) {
    await Promise.all([User.updateOne({ _id: record.employee }, { active: false, $inc: { tokenVersion: 1 } }), Session.deleteMany({ user: record.employee })]);
  }
  await audit(req, `hrms.${module}.completed`, record);
  res.json({ success: true, message: `${module} completed successfully`, data: record });
}

export async function addClearance(req, res) {
  const input = z.object({ label: z.string().trim().min(1).max(160), owner: objectId.optional(), required: z.boolean().default(true) }).strict().parse(req.body);
  const record = await findRecord(req.params.id, 'offboarding');
  const clearances = [...(record.data.clearances || []), { id: randomUUID(), ...input, status: 'Pending' }];
  record.data = { ...record.data, clearances };
  await record.save();
  res.status(201).json({ success: true, message: 'Clearance initiated successfully', data: record });
}

export async function updateClearance(req, res) {
  const input = z.object({ status: z.enum(['Pending', 'Cleared', 'Blocked']), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
  const record = await findRecord(req.params.id, 'offboarding');
  const clearances = record.data.clearances || [];
  const index = clearances.findIndex((item) => item.id === req.params.clearanceId);
  if (index < 0) throw new AppError(404, 'Clearance not found');
  clearances[index] = { ...clearances[index], ...input, reviewedAt: new Date(), reviewedBy: req.user.id };
  record.data = { ...record.data, clearances };
  await record.save();
  res.json({ success: true, message: 'Clearance updated successfully', data: record });
}

export async function prepareSettlement(req, res) {
  const input = z.object({ earnings: z.number().min(0), deductions: z.number().min(0), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
  const record = await findRecord(req.params.id, 'offboarding');
  record.data = { ...record.data, settlement: { ...input, net: input.earnings - input.deductions, currency: 'INR', preparedAt: new Date(), preparedBy: req.user.id } };
  await record.save();
  await audit(req, 'hrms.offboarding.settlement_prepared', record);
  res.json({ success: true, message: 'Final settlement prepared successfully', data: record });
}

export async function assetAction(req, res) {
  const record = await findRecord(req.params.id, 'assets');
  const action = req.params.action;
  if (action === 'assign') {
    const input = z.object({ employee: objectId, returnDue: date.optional() }).strict().parse(req.body);
    if (record.status === 'Assigned') throw new AppError(409, 'Asset is already assigned');
    record.employee = input.employee; record.status = 'Assigned'; record.data = { ...record.data, assignedTo: input.employee, returnDue: input.returnDue, assignedAt: new Date() };
  } else if (action === 'acknowledge') {
    if (String(record.employee) !== String(req.user.id)) throw new AppError(403, 'Only the assigned employee can acknowledge this asset');
    record.data = { ...record.data, acknowledgedAt: new Date() };
  } else if (action === 'return') {
    if (record.status !== 'Assigned') throw new AppError(409, 'Asset is not assigned');
    record.status = 'Available'; record.employee = undefined; record.data = { ...record.data, assignedTo: undefined, returnedAt: new Date(), returnedBy: req.user.id };
  } else if (action === 'maintenance') {
    const input = z.object({ note, cost: z.number().min(0).default(0), completedAt: date.optional() }).strict().parse(req.body);
    record.data = { ...record.data, maintenance: [...(record.data.maintenance || []), { ...input, currency: 'INR', recordedAt: new Date(), recordedBy: req.user.id }] };
  } else throw new AppError(404, 'Asset action not found');
  record.updatedBy = req.user.id; await record.save(); await audit(req, `hrms.asset.${action}`, record);
  res.json({ success: true, message: `Asset ${action} recorded successfully`, data: record });
}

export async function recordTransition(req, res) {
  const record = await findRecord(req.params.id, req.params.recordModule);
  const action = req.params.operation;
  const input = z.object({ stage: z.string().trim().min(1).max(80).optional(), note: z.string().trim().max(2000).optional(), rating: z.number().min(0).max(5).optional(), progress: z.number().min(0).max(100).optional() }).passthrough().parse(req.body || {});
  const statuses = {
    close: 'Closed', approve: 'Approved', reject: 'Rejected',
    'self-review': 'Self Reviewed', 'manager-review': 'Manager Reviewed',
    finalize: 'Finalized', feedback: record.status,
  };
  if (action === 'stage') {
    if (!input.stage) throw new AppError(400, 'Hiring stage is required');
    record.status = input.stage;
    record.data = { ...record.data, stage: input.stage, stageUpdatedAt: new Date() };
  } else if (action === 'feedback') {
    record.data = { ...record.data, feedback: [...(record.data.feedback || []), { ...input, by: req.user.id, at: new Date() }] };
  } else if (action === 'self-review') {
    if (String(record.employee) !== String(req.user.id)) throw new AppError(403, 'Self review belongs to another employee');
    record.status = statuses[action]; record.data = { ...record.data, selfReview: { ...input, by: req.user.id, at: new Date() } };
  } else if (action === 'manager-review') {
    record.status = statuses[action]; record.data = { ...record.data, managerReview: { ...input, by: req.user.id, at: new Date() } };
  } else if (action === 'finalize') {
    if (!record.data.selfReview || !record.data.managerReview) throw new AppError(409, 'Self and manager reviews are required before finalization');
    record.status = statuses[action]; record.data = { ...record.data, finalizedAt: new Date(), finalizedBy: req.user.id };
  } else {
    record.status = statuses[action] || record.status;
    record.data = { ...record.data, actionNote: input.note, actionAt: new Date(), actionBy: req.user.id };
  }
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, `hrms.${req.params.recordModule}.${action}`, record);
  res.json({ success: true, message: 'Record updated successfully', data: record });
}

export async function addPolicyTask(req, res) {
  const record = await findRecord(req.params.id, req.params.recordModule);
  const input = z.record(z.string(), z.unknown()).parse(req.body || {});
  const key = req.params.collection;
  record.data = { ...record.data, [key]: [...(record.data[key] || []), { id: randomUUID(), ...input, createdAt: new Date(), createdBy: req.user.id }] };
  await record.save();
  await audit(req, `hrms.${req.params.recordModule}.${key}_added`, record);
  res.status(201).json({ success: true, message: 'Record entry added successfully', data: record });
}

export async function moduleReport(req, res) {
  const module = req.params.recordModule;
  const data = await HRMSRecord.aggregate([{ $match: { module, deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
  res.json({ success: true, message: 'Module report fetched successfully', data: { module, generatedAt: new Date(), rows: data } });
}

export async function updateSettings(req, res) {
  const input = z.object({ settings: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]{1,79}$/), value: z.union([z.string().max(1000), z.number(), z.boolean()]), scope: z.enum(['company', 'department', 'default']).default('company') })).min(1).max(100) }).strict().parse(req.body);
  const items = [];
  for (const item of input.settings) {
    const record = await HRMSRecord.findOneAndUpdate(
      { module: 'settings', deletedAt: null, 'data.key': item.key },
      { $set: { title: item.key.replaceAll('.', ' '), status: 'Configured', data: item, updatedBy: req.user._id }, $setOnInsert: { module: 'settings', createdBy: req.user._id } },
      { new: true, upsert: true, runValidators: true },
    );
    items.push(record);
    await audit(req, 'hrms.settings.updated', record);
  }
  res.json({ success: true, message: 'HRMS settings updated successfully', data: { items } });
}

export async function policyVersion(req, res) {
  const input = z.object({ version: z.string().trim().min(1).max(30), content: z.string().trim().min(1).max(100000), effectiveDate: date.optional() }).strict().parse(req.body);
  const record = await findRecord(req.params.id, 'policies');
  const versions = record.data.versions || [];
  if (versions.some((item) => item.version === input.version)) throw new AppError(409, 'Policy version already exists');
  record.status = 'Published'; record.data = { ...record.data, versions: [...versions, { ...input, publishedAt: new Date(), publishedBy: req.user.id }] }; await record.save();
  await audit(req, 'hrms.policy.version_published', record, { version: input.version });
  res.status(201).json({ success: true, message: 'Policy version published successfully', data: record });
}

export async function acknowledgePolicy(req, res) {
  const record = await findRecord(req.params.id, 'policies');
  const acknowledgements = record.data.acknowledgements || [];
  if (acknowledgements.some((item) => String(item.employee) === String(req.user.id))) return res.json({ success: true, message: 'Policy already acknowledged', data: record });
  record.data = { ...record.data, acknowledgements: [...acknowledgements, { employee: req.user._id, acknowledgedAt: new Date() }] }; await record.save();
  await audit(req, 'hrms.policy.acknowledged', record);
  res.json({ success: true, message: 'Policy acknowledged successfully', data: record });
}

export async function downloadDocument(req, res) {
  const record = await findRecord(req.params.id, 'documents');
  if (record.employee && String(record.employee) !== String(req.user.id) && !['super_admin', 'admin', 'hr'].includes(req.user.role)) throw new AppError(403, 'Document access denied');
  if (!record.data.fileUrl) throw new AppError(404, 'Document file is not available');
  await audit(req, 'hrms.document.downloaded', record);
  res.json({ success: true, message: 'Authorized download URL fetched successfully', data: { fileUrl: record.data.fileUrl, expiresInSeconds: 300 } });
}

export async function eventFeed(req, res) {
  const today = startOfIndiaDay();
  const end = new Date(today.getTime() + 90 * 86400000);
  const profiles = await EmployeeProfile.find({}).populate('user', 'name active department').lean();
  const kind = req.params.kind;
  const field = kind === 'birthdays' ? 'dateOfBirth' : 'joiningDate';
  const items = profiles.filter((item) => item.user?.active && item[field]).map((item) => {
    const source = new Date(item[field]);
    const next = new Date(today.getFullYear(), source.getMonth(), source.getDate());
    if (next < today) next.setFullYear(next.getFullYear() + 1);
    return { employee: item.user, date: next, years: today.getFullYear() - source.getFullYear(), kind };
  }).filter((item) => item.date <= end).sort((a, b) => a.date - b.date);
  res.json({ success: true, message: 'Events fetched successfully', data: { items, pagination: { page: 1, limit: items.length, total: items.length, totalPages: 1 } } });
}

export async function combinedCalendar(req, res) {
  const [holidays, leaves, announcements] = await Promise.all([
    HRMSRecord.find({ module: 'holidays', deletedAt: null }).lean(),
    HRMSRecord.find({ module: 'leave', status: 'Approved', deletedAt: null }).populate('employee', 'name department').lean(),
    HRMSRecord.find({ module: 'announcements', status: { $in: ['Published', 'Scheduled'] }, deletedAt: null }).lean(),
  ]);
  res.json({ success: true, message: 'HR calendar fetched successfully', data: { holidays, leaves, announcements } });
}

export async function reports(req, res) {
  const moduleMap = { headcount: null, attendance: 'attendance', leaves: 'leave', payroll: 'payroll-runs', attrition: 'offboarding', recruitment: 'candidates', performance: 'performance-reviews', timesheets: 'timesheets', assets: 'assets' };
  const kind = req.params.kind;
  if (!(kind in moduleMap)) throw new AppError(404, 'Report not found');
  let data;
  if (kind === 'headcount') data = await User.aggregate([{ $match: { active: true, role: { $ne: 'customer' } } }, { $group: { _id: '$department', count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
  else data = await HRMSRecord.aggregate([{ $match: { module: moduleMap[kind], deletedAt: null } }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
  res.json({ success: true, message: `${kind} report fetched successfully`, data: { kind, currency: kind === 'payroll' ? 'INR' : undefined, generatedAt: new Date(), rows: data } });
}

export async function createReportExport(req, res) {
  const input = z.object({ report: z.enum(['headcount', 'attendance', 'leaves', 'payroll', 'attrition', 'recruitment', 'performance', 'timesheets', 'assets']), format: z.enum(['csv', 'json']).default('csv'), filters: z.record(z.string(), z.unknown()).default({}) }).strict().parse(req.body);
  const record = await createRecord(req, 'report-exports', { title: `${input.report} export`, status: 'Queued', data: { ...input, requestedAt: new Date() } });
  res.status(202).json({ success: true, message: 'Report export queued successfully', data: record });
}

export async function settingPolicy(req, res) {
  const key = req.params.policy;
  const record = await HRMSRecord.findOne({ module: 'settings', deletedAt: null, 'data.key': key }).sort({ _id: -1 });
  if (req.method === 'GET') return res.json({ success: true, message: 'Policy fetched successfully', data: record });
  const input = z.object({ value: z.record(z.string(), z.unknown()), effectiveFrom: date.optional() }).strict().parse(req.body);
  const version = (record?.data?.version || 0) + 1;
  const created = await createRecord(req, 'settings', { title: key.replaceAll('-', ' '), status: 'Configured', effectiveDate: input.effectiveFrom, data: { key, value: input.value, scope: 'company', version, previous: record?._id } });
  res.status(201).json({ success: true, message: 'Policy version saved successfully', data: created });
}

export async function auditLogs(req, res) {
  const { page, limit } = pageSchema.parse(req.query);
  const filter = { action: /^hrms\./ };
  const [items, total] = await Promise.all([AuditLog.find(filter).populate('user', 'name email').sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), AuditLog.countDocuments(filter)]);
  paginated(res, items, page, limit, total, 'Audit logs fetched successfully');
}

const approvalModules = ['leave', 'attendance-regularizations', 'salary-revisions', 'payroll-runs', 'timesheets'];

export async function approvalList(req, res) {
  const history = req.params.scope === 'history';
  return listModuleAcross(req, res, approvalModules, history ? { status: { $in: ['Approved', 'Rejected', 'Paid'] } } : { status: { $in: ['Pending', 'Calculated', 'Submitted'] } });
}

async function listModuleAcross(req, res, modules, extra) {
  const { page, limit } = pageSchema.parse(req.query);
  const filter = { module: { $in: modules }, deletedAt: null, ...extra, ...(req.user.role === 'team_leader' ? { department: req.user.department } : {}) };
  const [items, total] = await Promise.all([HRMSRecord.find(filter).populate('employee', 'name department').sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), HRMSRecord.countDocuments(filter)]);
  paginated(res, items, page, limit, total, 'Approvals fetched successfully');
}

export async function approvalDetail(req, res) {
  ensureId(req.params.id);
  const record = await HRMSRecord.findOne({ _id: req.params.id, module: { $in: approvalModules }, deletedAt: null }).populate('employee', 'name department');
  if (!record) throw new AppError(404, 'Approval not found');
  res.json({ success: true, message: 'Approval fetched successfully', data: record });
}

export async function approvalAction(req, res) {
  ensureId(req.params.id);
  const record = await HRMSRecord.findOne({ _id: req.params.id, module: { $in: approvalModules }, deletedAt: null });
  if (!record) throw new AppError(404, 'Approval not found');
  req.params.decision = req.params.action;
  if (record.module === 'leave') return reviewLeave(req, res);
  if (record.module === 'attendance-regularizations') return reviewRegularization(req, res);
  if (record.module === 'payroll-runs' && req.params.action === 'approve') return approvePayroll(req, res);
  const input = z.object({ reason: z.string().trim().max(1000).optional() }).strict().parse(req.body || {});
  record.status = req.params.action === 'approve' ? 'Approved' : 'Rejected';
  record.data = { ...record.data, reviewerNote: input.reason, reviewedAt: new Date(), reviewedBy: req.user.id };
  await record.save(); await audit(req, `hrms.${record.module}.${req.params.action}d`, record);
  res.json({ success: true, message: `Request ${record.status.toLowerCase()} successfully`, data: record });
}

export { listModule };
