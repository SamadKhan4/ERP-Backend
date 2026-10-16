import { z } from 'zod';
import { Invoice } from '../models/Invoice.js';
import { Project } from '../models/Project.js';
import { Client } from '../models/Client.js';
import { Lead } from '../models/Lead.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { TeamTask } from '../models/TeamWork.js';
import { User } from '../models/User.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';

const indiaDate = (date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, 'Invalid date');
const countGroups = (rows) =>
  Object.fromEntries(rows.map((row) => [row._id, row.count]));

export async function overview(req, res) {
  // The company-wide overview is separate from employee/self-service dashboards.
  if (!['super_admin', 'admin', 'manager'].includes(req.user.role))
    throw new AppError(403, 'Company overview access denied');
  const now = new Date();
  const { date } = z
    .object({ date: dateSchema.default(indiaDate(now)) })
    .strict()
    .parse(req.query);
  const day = new Date(`${date}T00:00:00+05:30`);
  const tomorrow = new Date(day.getTime() + 86400000);
  const today = new Date(`${indiaDate(now)}T00:00:00+05:30`);
  const currentMonth = indiaDate(now).slice(0, 7);
  const months = Array.from({ length: 6 }, (_, index) => {
    const value = new Date(`${currentMonth}-01T00:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() - 5 + index);
    return value.toISOString().slice(0, 7);
  });
  const invoiceMatch = {
    deletedAt: null,
    status: { $nin: ['Draft', 'Cancelled'] },
  };
  const activeEmployees = { active: true, role: { $nin: ['customer'] } };
  const [
    financeResult,
    trend,
    projectGroups,
    clientCount,
    leadGroups,
    employeeCount,
    attendance,
    reports,
    pendingLeaves,
    overdueFollowups,
    taskGroups,
    tasks,
    invoices,
    activities,
  ] = await Promise.all([
    Invoice.aggregate([
      { $match: invoiceMatch },
      {
        $group: {
          _id: null,
          paid: {
            $sum: { $cond: [{ $eq: ['$status', 'Paid'] }, '$grandTotal', 0] },
          },
          outstanding: {
            $sum: { $cond: [{ $ne: ['$status', 'Paid'] }, '$grandTotal', 0] },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$status', 'Paid'] },
                    { $lt: ['$dueDate', today] },
                  ],
                },
                '$grandTotal',
                0,
              ],
            },
          },
          overdueCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$status', 'Paid'] },
                    { $lt: ['$dueDate', today] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...invoiceMatch,
          invoiceDate: {
            $gte: new Date(`${months[0]}-01T00:00:00+05:30`),
            $lte: now,
          },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m',
              date: '$invoiceDate',
              timezone: 'Asia/Kolkata',
            },
          },
          billed: { $sum: '$grandTotal' },
          paid: {
            $sum: { $cond: [{ $eq: ['$status', 'Paid'] }, '$grandTotal', 0] },
          },
        },
      },
    ]),
    Project.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Client.countDocuments(),
    Lead.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
    ]),
    User.countDocuments(activeEmployees),
    HRMSRecord.aggregate([
      {
        $match: {
          module: 'attendance',
          deletedAt: null,
          'data.date': { $gte: day, $lt: tomorrow },
          'data.checkIn': { $ne: null },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'employee',
          foreignField: '_id',
          as: 'person',
        },
      },
      { $match: { 'person.active': true, 'person.role': { $ne: 'customer' } } },
      { $group: { _id: '$employee' } },
      { $count: 'count' },
    ]),
    HRMSRecord.aggregate([
      {
        $match: {
          module: 'daily-reports',
          deletedAt: null,
          effectiveDate: { $gte: day, $lt: tomorrow },
        },
      },
      { $group: { _id: '$employee' } },
      { $count: 'count' },
    ]),
    HRMSRecord.countDocuments({
      module: 'leave',
      deletedAt: null,
      status: 'Pending',
    }),
    CRMFollowUp.countDocuments({
      deletedAt: null,
      status: 'PENDING',
      scheduledAt: { $lt: now },
    }),
    TeamTask.aggregate([
      { $match: { deletedAt: null } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    TeamTask.aggregate([
      { $match: { deletedAt: null, status: { $ne: 'DONE' } } },
      {
        $addFields: {
          noDeadline: { $cond: [{ $ifNull: ['$dueDate', false] }, 0, 1] },
        },
      },
      { $sort: { noDeadline: 1, dueDate: 1, createdAt: -1 } },
      { $limit: 6 },
      {
        $lookup: {
          from: 'users',
          localField: 'assignedTo',
          foreignField: '_id',
          as: 'assignee',
        },
      },
      {
        $project: {
          taskId: 1,
          title: 1,
          status: 1,
          priority: 1,
          dueDate: 1,
          assignedTo: { name: { $arrayElemAt: ['$assignee.name', 0] } },
        },
      },
    ]),
    Invoice.find({ deletedAt: null })
      .select(
        'invoiceNumber client.company project invoiceDate dueDate grandTotal status',
      )
      .populate('project', 'title')
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
    AuditLog.find()
      .select('action user createdAt')
      .sort({ createdAt: -1 })
      .limit(6)
      .populate('user', 'name')
      .lean(),
  ]);
  const present = attendance[0]?.count || 0;
  const finance = financeResult[0] || {
    paid: 0,
    outstanding: 0,
    overdue: 0,
    overdueCount: 0,
  };
  delete finance._id;
  res.json({
    success: true,
    data: {
      generatedAt: now,
      date,
      finance,
      revenue: months.map((month) => ({
        month,
        billed: 0,
        paid: 0,
        ...trend.find((row) => row._id === month),
        _id: undefined,
      })),
      projects: countGroups(projectGroups),
      clients: clientCount,
      leads: countGroups(leadGroups),
      attendance: {
        employees: employeeCount,
        present,
        notCheckedIn: Math.max(0, employeeCount - present),
        percent: employeeCount
          ? Math.round((present / employeeCount) * 100)
          : 0,
        reports: reports[0]?.count || 0,
      },
      pendingLeaves,
      overdueFollowups,
      taskSummary: countGroups(taskGroups),
      tasks,
      invoices,
      activities,
    },
  });
}
