import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Department } from '../models/Department.js';
import { Project } from '../models/Project.js';
import { TeamTask } from '../models/TeamWork.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { LeaveLedger } from '../models/LeaveLedger.js';
import { PayrollEntry } from '../models/PayrollEntry.js';
import { Lead } from '../models/Lead.js';
import { Client } from '../models/Client.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { Invoice } from '../models/Invoice.js';
import { FinancePayment, FinanceExpense } from '../models/Finance.js';
import { Quotation } from '../models/Quotation.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
const oid = (value) => new mongoose.Types.ObjectId(String(value));
const blank = (field, fallback = '') => ({ $ifNull: [field, fallback] });
const indiaDate = (field, format = '%Y-%m-%d') => ({
  $dateToString: { date: field, format, timezone: 'Asia/Kolkata', onNull: '' },
});
const lookup = (collection, local, alias, select) => ({
  $lookup: {
    from: collection,
    localField: local,
    foreignField: '_id',
    pipeline: [{ $project: select }],
    as: alias,
  },
});
const first = (field) => ({ $arrayElemAt: [field, 0] });
const name = (field) => blank(first(`$${field}.name`), 'Not assigned');
const and = (conditions) => ({ $and: conditions });
export async function buildReportQuery(req, report, filters, access) {
  let ids = access.ids;
  // Department/manager/employee filters always intersect the authorization scope.
  const staffFilter = [];
  if (ids) staffFilter.push({ _id: { $in: ids } });
  if (filters.employee) staffFilter.push({ _id: oid(filters.employee) });
  if (filters.department) {
    const department = await Department.findOne(
      mongoose.isValidObjectId(filters.department)
        ? { $or: [{ _id: filters.department }, { key: filters.department }] }
        : { key: filters.department },
    )
      .select('key')
      .lean();
    staffFilter.push({ department: department?.key || '__no_department__' });
  }
  if (filters.manager || filters.designation || filters.employmentType) {
    const profiles = await EmployeeProfile.find({
      ...(filters.manager ? { manager: oid(filters.manager) } : {}),
      ...(filters.designation ? { designation: filters.designation } : {}),
      ...(filters.employmentType
        ? { employmentType: filters.employmentType }
        : {}),
    })
      .select('user')
      .lean();
    staffFilter.push({ _id: { $in: profiles.map((profile) => profile.user) } });
  }
  if (filters.role) staffFilter.push({ role: filters.role });
  if (staffFilter.length)
    ids = (await User.find(and(staffFilter)).select('_id').lean()).map(
      (user) => user._id,
    );
  const scoped = (field) => (ids ? { [field]: { $in: ids } } : {});
  const from = filters.from ? new Date(`${filters.from}T00:00:00+05:30`) : null;
  const to = filters.to
    ? new Date(new Date(`${filters.to}T00:00:00+05:30`).getTime() + 86400000)
    : null;
  const date = (field) =>
    from || to
      ? {
          [field]: {
            ...(from ? { $gte: from } : {}),
            ...(to ? { $lt: to } : {}),
          },
        }
      : {};
  const preset = report.preset || {},
    source = report.source;
  const pipeline = [];
  let Model,
    projection,
    dateBasis = 'Created date';
  const userJoins = (field = 'employee') => {
    pipeline.push(lookup('users', field, 'person', { name: 1 }));
  };
  if (['users', 'employees', 'permissions'].includes(source)) {
    Model = User;
    pipeline.push({
      $match: and([
        scoped('_id'),
        {
          role:
            source === 'users' || source === 'permissions'
              ? { $exists: true }
              : { $ne: 'customer' },
        },
        ...(preset.joining ? [] : [date('createdAt')]),
      ]),
    });
    pipeline.push({
      $lookup: {
        from: 'employeeprofiles',
        localField: '_id',
        foreignField: 'user',
        pipeline: [
          {
            $project: {
              employeeCode: 1,
              designation: 1,
              manager: 1,
              employmentType: 1,
              joiningDate: 1,
            },
          },
        ],
        as: 'profiles',
      },
    });
    pipeline.push({ $set: { profile: first('$profiles') } });
    pipeline.push(
      lookup('users', 'profile.manager', 'managerUser', { name: 1 }),
    );
    if (preset.joining) {
      pipeline.push({ $match: date('profile.joiningDate') });
      dateBasis = 'Joining date';
    }
    projection = {
      name: 1,
      email: 1,
      role: 1,
      department: blank('$department'),
      status: { $cond: ['$active', 'Active', 'Inactive'] },
      createdAt: 1,
      employeeCode: blank('$profile.employeeCode'),
      designation: blank('$profile.designation'),
      manager: name('managerUser'),
      employmentType: blank('$profile.employmentType'),
      joiningDate: '$profile.joiningDate',
    };
    if (source === 'permissions') {
      // Role grants plus defaults are resolved through a safe literal map, never auth records.
      const { Role } = await import('../models/Role.js');
      const { rolePermissionDefaults } = await import('../constants/roles.js');
      const { permissionsFor } =
        await import('../services/permissionService.js');
      const roles = await Role.find().select('name').lean();
      const names = [
        ...new Set([
          ...Object.keys(rolePermissionDefaults),
          ...roles.map((role) => role.name),
        ]),
      ];
      const branches = [];
      for (const role of names)
        branches.push({
          case: { $eq: ['$role', role] },
          then: { $literal: await permissionsFor({ role }) },
        });
      pipeline.push(
        { $set: { permission: { $switch: { branches, default: [] } } } },
        { $unwind: '$permission' },
      );
      projection = { name: 1, role: 1, permission: 1 };
    }
  } else if (source === 'login') {
    Model = AuditLog;
    dateBasis = 'Audit event date';
    pipeline.push({
      $match: and([
        scoped('user'),
        date('createdAt'),
        preset.audit
          ? { action: { $regex: '^(auth[.]|user_management[.])' } }
          : { action: 'auth.login' },
      ]),
    });
    if (preset.lastLogin)
      pipeline.push(
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$user',
            user: { $first: '$user' },
            action: { $first: '$action' },
            createdAt: { $first: '$createdAt' },
          },
        },
      );
    userJoins('user');
    pipeline.push(lookup('users', 'user', 'roleUser', { role: 1 }));
    projection = {
      name: name('person'),
      role: first('$roleUser.role'),
      action: 1,
      date: '$createdAt',
    };
  } else if (source === 'departments') {
    Model = Department;
    let keys;
    if (ids) keys = await User.distinct('department', { _id: { $in: ids } });
    pipeline.push({
      $match: and([
        ...(keys ? [{ key: { $in: keys } }] : []),
        ...(filters.department
          ? [
              {
                $or: [
                  { key: filters.department },
                  ...(mongoose.isValidObjectId(filters.department)
                    ? [{ _id: oid(filters.department) }]
                    : []),
                ],
              },
            ]
          : []),
        date('createdAt'),
      ]),
    });
    pipeline.push(
      {
        $lookup: {
          from: 'users',
          let: { key: '$key' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$department', '$$key'] },
                role: { $ne: 'customer' },
                ...(ids ? { _id: { $in: ids } } : {}),
              },
            },
            { $count: 'total' },
          ],
          as: 'staff',
        },
      },
      lookup('users', 'head', 'heads', { name: 1 }),
    );
    projection = {
      name: 1,
      code: 1,
      status: 1,
      head: name('heads'),
      employees: blank(first('$staff.total'), 0),
    };
  } else if (source === 'projects' || source === 'tasks') {
    Model = source === 'projects' ? Project : TeamTask;
    let projects = [];
    if (ids && source === 'projects')
      projects = await TeamTask.distinct('project', {
        assignedTo: { $in: ids },
        deletedAt: null,
        project: { $ne: null },
      });
    pipeline.push({
      $match: and([
        source === 'tasks' ? { deletedAt: null } : { archivedAt: null },
        ids
          ? source === 'projects'
            ? {
                $or: [
                  scoped('assignedTo'),
                  { _id: { $in: projects } },
                  { projectManager: { $in: ids } },
                  {
                    teamMembers: {
                      $elemMatch: { employee: { $in: ids }, status: 'ACTIVE' },
                    },
                  },
                ],
              }
            : scoped('assignedTo')
          : {},
        date('createdAt'),
      ]),
    });
    userJoins('assignedTo');
    if (source === 'projects') {
      pipeline.push({
        $set: {
          status: {
            $switch: {
              branches: Object.entries({
                UPCOMING: 'Planned',
                PLANNING: 'Planning',
                ONGOING: 'Active',
                ON_HOLD: 'On Hold',
                REVIEW: 'Review',
                COMPLETED: 'Completed',
                CANCELLED: 'Cancelled',
              }).map(([key, value]) => ({
                case: { $eq: ['$status', key] },
                then: value,
              })),
              default: '$status',
            },
          },
        },
      });
      pipeline.push(
        lookup('clients', 'clientRef', 'clients', { companyName: 1 }),
      );
      projection = {
        projectId: 1,
        title: 1,
        service: 1,
        status: 1,
        assignedTo: name('person'),
        startDate: 1,
        nextBillingAt: 1,
        client: blank(first('$clients.companyName')),
      };
    } else {
      pipeline.push(lookup('projects', 'project', 'projects', { title: 1 }));
      if (preset.overdue)
        pipeline.push({
          $match: { dueDate: { $lt: new Date() }, status: { $ne: 'DONE' } },
        });
      if (preset.pending)
        pipeline.push({ $match: { status: { $ne: 'DONE' } } });
      projection = {
        taskId: 1,
        title: 1,
        assignedTo: name('person'),
        project: blank(first('$projects.title')),
        status: 1,
        priority: 1,
        points: 1,
        dueDate: 1,
        completedAt: 1,
      };
    }
  } else if (
    ['attendance', 'leave', 'timesheets', 'lifecycle'].includes(source)
  ) {
    Model = HRMSRecord;
    dateBasis =
      source === 'leave'
        ? 'Leave overlaps selected dates'
        : 'Effective date (attendance uses recorded work date)';
    const module = preset.module || source;
    let range = date('effectiveDate');
    if (source === 'leave')
      range = {
        ...(to ? { 'data.startDate': { $lt: to } } : {}),
        ...(from ? { 'data.endDate': { $gte: from } } : {}),
      };
    pipeline.push({
      $match: and([{ module, deletedAt: null }, scoped('employee'), range]),
    });
    userJoins();
    const common = {
      employee: name('person'),
      department: blank('$department'),
      status: 1,
      date: blank('$data.date', indiaDate('$effectiveDate')),
      month: indiaDate('$effectiveDate', '%Y-%m'),
    };
    if (source === 'attendance')
      projection = {
        ...common,
        checkIn: '$data.checkIn',
        checkOut: '$data.checkOut',
        minutesWorked: blank('$data.minutesWorked', 0),
      };
    if (source === 'leave')
      projection = {
        ...common,
        leaveType: '$data.leaveType',
        startDate: '$data.startDate',
        endDate: '$data.endDate',
      };
    if (source === 'timesheets')
      projection = { ...common, hours: blank('$data.hours', 0) };
    if (source === 'lifecycle')
      projection = { ...common, title: 1, date: '$effectiveDate' };
  } else if (source === 'balances') {
    Model = LeaveLedger;
    dateBasis =
      'Ledger movements through selected end date (opening balances retained)';
    pipeline.push(
      {
        $match: and([scoped('employee'), to ? { createdAt: { $lt: to } } : {}]),
      },
      {
        $group: {
          _id: { employee: '$employee', leaveType: '$leaveType' },
          employee: { $first: '$employee' },
          leaveType: { $first: '$leaveType' },
          balance: { $sum: '$amount' },
        },
      },
    );
    userJoins();
    projection = { employee: name('person'), leaveType: 1, balance: 1 };
  } else if (source === 'payroll') {
    Model = PayrollEntry;
    dateBasis =
      'Payroll period (run effective date); only Approved / Paid runs';
    pipeline.push(
      { $match: scoped('employee') },
      {
        $lookup: {
          from: 'hrmsrecords',
          localField: 'run',
          foreignField: '_id',
          pipeline: [
            {
              $match: {
                module: 'payroll-runs',
                deletedAt: null,
                status: { $in: ['Approved', 'Paid'] },
                ...date('effectiveDate'),
              },
            },
            { $project: { status: 1, 'data.month': 1, 'data.year': 1 } },
          ],
          as: 'runs',
        },
      },
      { $unwind: '$runs' },
    );
    projection = {
      employeeName: 1,
      department: 1,
      period: {
        $concat: [
          { $toString: '$runs.data.year' },
          '-',
          { $toString: '$runs.data.month' },
        ],
      },
      status: '$runs.status',
      gross: 1,
      deductions: 1,
      net: 1,
      currency: 1,
    };
  } else if (['leads', 'clients', 'followups'].includes(source)) {
    Model =
      source === 'leads' ? Lead : source === 'clients' ? Client : CRMFollowUp;
    dateBasis = source === 'followups' ? 'Scheduled date' : 'Created date';
    pipeline.push({
      $match: and([
        { deletedAt: null },
        scoped('assignedTo'),
        date(source === 'followups' ? 'scheduledAt' : 'createdAt'),
      ]),
    });
    if (preset.stage) pipeline.push({ $match: { stage: preset.stage } });
    if (preset.open)
      pipeline.push({ $match: { stage: { $nin: ['WON', 'LOST'] } } });
    if (source === 'followups' && preset.overdue)
      pipeline.push({
        $match: { status: 'PENDING', scheduledAt: { $lt: new Date() } },
      });
    userJoins('assignedTo');
    if (source === 'followups')
      projection = {
        followUpId: 1,
        employee: name('person'),
        type: 1,
        status: 1,
        scheduledAt: 1,
        completedAt: 1,
      };
    else {
      if (preset.unwindServices)
        pipeline.push({ $unwind: '$interestedServices' });
      const days = {
        $divide: [{ $subtract: ['$$NOW', '$createdAt'] }, 86400000],
      };
      projection = {
        leadId: 1,
        clientId: 1,
        companyName: 1,
        assignedTo: name('person'),
        leadSource: 1,
        stage: 1,
        priority: 1,
        nextFollowUpAt: 1,
        createdAt: 1,
        estimatedBudget: 1,
        currency: 1,
        service: '$interestedServices',
        ageBucket: {
          $switch: {
            branches: [7, 30, 60, 90].map((day) => ({
              case: { $lte: [days, day] },
              then: `≤ ${day} days`,
            })),
            default: '90+ days',
          },
        },
      };
    }
  } else if (source === 'finance_payments') {
    Model = FinancePayment;
    dateBasis =
      'Receipt date; amounts are integer INR paise. Reversals remain auditable.';
    pipeline.push(
      { $match: and([scoped('recordedBy'), date('paymentDate')]) },
      lookup('invoices', 'invoice', 'invoiceRows', {
        invoiceNumber: 1,
        deletedAt: 1,
      }),
      { $unwind: '$invoiceRows' },
      { $match: { 'invoiceRows.deletedAt': null } },
    );
    projection = {
      paymentId: 1,
      invoice: '$invoiceRows.invoiceNumber',
      date: '$paymentDate',
      amountMinor: 1,
      method: 1,
      status: 1,
      reversedAt: 1,
    };
  } else if (source === 'finance_expenses') {
    Model = FinanceExpense;
    dateBasis =
      'Expense date; amounts are integer INR paise. Paid/approved costs are distinct from drafts.';
    pipeline.push({ $match: and([scoped('createdBy'), date('date')]) });
    projection = {
      expenseId: 1,
      date: 1,
      category: 1,
      vendor: 1,
      amountMinor: 1,
      taxMinor: 1,
      totalMinor: 1,
      status: 1,
      department: 1,
    };
  } else if (['invoices', 'aging', 'quotations'].includes(source)) {
    Model = source === 'quotations' ? Quotation : Invoice;
    dateBasis =
      source === 'quotations'
        ? 'Quotation created date (INR)'
        : 'Invoice date (INR); not receipt date';
    const field = source === 'quotations' ? 'createdAt' : 'invoiceDate';
    pipeline.push({
      $match: and([
        { deletedAt: null },
        ids
          ? source === 'quotations'
            ? { $or: [scoped('salesPerson'), scoped('createdBy')] }
            : scoped('createdBy')
          : {},
        date(field),
      ]),
    });
    if (preset.billed)
      pipeline.push({ $match: { status: { $nin: ['Draft', 'Cancelled'] } } });
    if (source === 'aging') {
      const today = new Date(
        `${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}T00:00:00+05:30`,
      );
      pipeline.push({
        $match: { status: { $in: ['Sent', 'Overdue', 'Partially Paid'] } },
      });
      if (preset.overdue)
        pipeline.push({ $match: { dueDate: { $lt: today } } });
      if (preset.dueToday)
        pipeline.push({
          $match: {
            dueDate: { $gte: today, $lt: new Date(today.getTime() + 86400000) },
          },
        });
      if (preset.upcoming)
        pipeline.push({
          $match: { dueDate: { $gte: new Date(today.getTime() + 86400000) } },
        });
      pipeline.push({
        $set: {
          daysOverdue: {
            $max: [
              0,
              {
                $floor: {
                  $divide: [{ $subtract: [today, '$dueDate'] }, 86400000],
                },
              },
            ],
          },
        },
      });
      projection = {
        invoiceNumber: 1,
        company: '$client.company',
        dueDate: 1,
        daysOverdue: 1,
        bucket: {
          $switch: {
            branches: [30, 60, 90].map((days, index) => ({
              case: { $lte: ['$daysOverdue', days] },
              then: ['0–30', '31–60', '61–90'][index],
            })),
            default: '90+',
          },
        },
        outstanding: {
          $max: [
            0,
            {
              $subtract: [
                '$grandTotal',
                { $divide: [{ $ifNull: ['$paidMinor', 0] }, 100] },
              ],
            },
          ],
        },
        currency: { $literal: 'INR' },
      };
    } else if (source === 'quotations') {
      userJoins('salesPerson');
      projection = {
        quotationNumber: 1,
        company: '$client.company',
        salesPerson: name('person'),
        service: 1,
        status: 1,
        subtotal: 1,
        gstAmount: 1,
        grandTotal: 1,
        validUntil: 1,
        currency: { $literal: 'INR' },
      };
    } else
      projection = {
        invoiceNumber: 1,
        company: '$client.company',
        invoiceDate: 1,
        dueDate: 1,
        status: 1,
        subtotal: 1,
        gstAmount: 1,
        grandTotal: 1,
        month: indiaDate('$invoiceDate', '%Y-%m'),
        currency: { $literal: 'INR' },
      };
  } else
    throw new AppError(409, 'Source data is not available for this report');
  const identityField = {
    assignedTo: 'assignedTo',
    employeeName: 'employee',
    employee: source === 'followups' ? 'assignedTo' : 'employee',
    salesPerson: 'salesPerson',
    company: 'clientRef',
    client: 'clientRef',
    project: 'project',
  }[preset.group];
  if (identityField) projection.groupIdentity = `$${identityField}`;
  pipeline.push({ $project: projection });
  if (preset.status) pipeline.push({ $match: { status: preset.status } });
  if (filters.status) pipeline.push({ $match: { status: filters.status } });
  if (filters.search && !preset.group) {
    const regex = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fields = report.columns.filter(
      (column) =>
        ![
          'gross',
          'net',
          'deductions',
          'balance',
          'count',
          'amount',
          'employees',
        ].includes(column),
    );
    if (fields.length)
      pipeline.push({
        $match: {
          $or: fields.map((field) => ({
            [field]: { $regex: regex, $options: 'i' },
          })),
        },
      });
  }
  if (preset.group) {
    pipeline.push(
      {
        $group: {
          _id: {
            label: blank(`$${preset.group}`, 'Not assigned'),
            ...(identityField ? { identity: '$groupIdentity' } : {}),
            ...(preset.sum
              ? {
                  currency: blank(
                    '$currency',
                    preset.sum === 'hours'
                      ? 'hours'
                      : preset.sum === 'minutesWorked'
                        ? 'minutes'
                        : 'INR',
                  ),
                }
              : {}),
          },
          count: { $sum: 1 },
          ...(preset.sum ? { amount: { $sum: `$${preset.sum}` } } : {}),
        },
      },
      {
        $project: {
          _id: 0,
          label: '$_id.label',
          count: 1,
          ...(preset.sum ? { amount: 1, currency: '$_id.currency' } : {}),
        },
      },
    );
  }
  if (filters.search && preset.group)
    pipeline.push({
      $match: {
        label: {
          $regex: filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        },
      },
    });
  return { Model, pipeline, dateBasis };
}
