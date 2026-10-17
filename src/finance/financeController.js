import { z } from 'zod';
import { Invoice } from '../models/Invoice.js';
import { Client } from '../models/Client.js';
import { Project } from '../models/Project.js';
import { Quotation } from '../models/Quotation.js';
import { Department } from '../models/Department.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { Role } from '../models/Role.js';
import { roleDefinitions } from '../constants/roles.js';
import { permissionsFor } from '../services/permissionService.js';
import { financePermissions } from './financePermissions.js';
import {
  FinancePayment,
  FinanceExpense,
  FinanceRecurring,
  FinanceFollowUp,
  FinanceSettings,
  FinanceDocument,
} from '../models/Finance.js';
import { OutgoingMail } from '../models/OutgoingMail.js';
import { env } from '../config/env.js';
import { serviceCatalog } from '../../shared/crm.js';
import { financeScope, financeId, hasFinance } from './financeAccess.js';
import {
  listSchema,
  invoiceSchema,
  paymentSchema,
  expenseSchema,
  recurringSchema,
  followupSchema,
  settingsSchema,
  clientTaxSchema,
  methods,
  expenseCategories,
} from './financeValidator.js';
import {
  financeTransaction,
  financeAudit,
  financeNotify,
  findFinanceInvoice,
  findFinanceClient,
  createFinanceInvoice,
  buildInvoiceFields,
  recordFinancePayment,
  reverseFinancePayment,
  saveFinanceExpense,
  validateAllocations,
  generateRecurringInvoice,
} from './financeService.js';
import {
  queryFinanceInvoices,
  financeDashboard,
  clientLedger,
  dateRange,
  accessibleInvoiceIds,
  invoiceStages,
} from './financeQueryService.js';
import { invoiceState, minor } from './financeMoney.js';
import { AppError } from '../utils/errors.js';
import {
  storeDocument,
  readDocument,
  cleanupDocument,
  documentMime,
} from '../services/documentStorageService.js';
import { renderReportExport } from '../reports/reportExportService.js';
import { financeInvoicePdf } from './financePdfService.js';
const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });
const parseQuery = (req) => listSchema.parse(req.query);
const safeSettings = (settings) =>
  settings
    ? {
        companyName: settings.companyName,
        stateCode: settings.stateCode,
        gstin: settings.gstin,
        requireExpenseApproval: settings.requireExpenseApproval,
      }
    : null;
export async function metadata(req, res) {
  if (
    !req.financePermissions.some(
      (permission) => permission === '*' || /^finance\./.test(permission),
    )
  )
    throw new AppError(403, 'Finance access denied');
  const query = z
    .object({
      search: z.string().trim().max(100).default(''),
      client: z
        .string()
        .regex(/^[a-f\d]{24}$/i)
        .optional(),
    })
    .strict()
    .parse(req.query);
  const regex = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [
    clients,
    projects,
    quotations,
    departments,
    users,
    settings,
    invoices,
  ] = await Promise.all([
    Client.find({
      $and: [
        financeScope(req, 'clients'),
        query.search ? { companyName: { $regex: regex, $options: 'i' } } : {},
      ],
    })
      .select('companyName contactPerson email phone gstin stateCode')
      .sort({ companyName: 1 })
      .limit(50)
      .lean(),
    Project.find({
      ...(req.financeProjectIds
        ? {
            $or: [
              { _id: { $in: req.financeProjectIds } },
              { clientRef: { $in: req.financeClientIds } },
            ],
          }
        : {}),
      ...(query.client ? { clientRef: financeId(query.client) } : {}),
    })
      .select('projectId title clientRef service')
      .limit(50)
      .lean(),
    Quotation.find({
      deletedAt: null,
      status: 'Accepted',
      ...(req.financeClientIds
        ? { clientRef: { $in: req.financeClientIds } }
        : {}),
      ...(query.client ? { clientRef: financeId(query.client) } : {}),
    })
      .select('quotationNumber title clientRef service')
      .limit(50)
      .lean(),
    Department.find(
      req.financeScope.ids ? { key: req.user.department || '__none__' } : {},
    )
      .select('key name')
      .limit(100)
      .lean(),
    User.find({
      active: true,
      ...(req.financeScope.ids ? { _id: { $in: req.financeScope.ids } } : {}),
    })
      .select('name role')
      .limit(100)
      .lean(),
    FinanceSettings.findById('finance').lean(),
    [
      'finance.invoices.view',
      'finance.payments.create',
      'finance.followups.manage',
    ].some((permission) => hasFinance(req, permission))
      ? queryFinanceInvoices(
          req,
          {
            page: 1,
            limit: 50,
            ...(query.client ? { client: query.client } : {}),
          },
          { outstanding: true },
        )
      : { items: [] },
  ]);
  ok(res, {
    clients,
    projects,
    quotations,
    departments,
    users,
    invoices: invoices.items,
    services: serviceCatalog,
    methods,
    expenseCategories,
    settings: safeSettings(settings),
    permissions: req.financePermissions.filter(
      (permission) => permission === '*' || permission.startsWith('finance.'),
    ),
    scope: req.financeScope.scope,
  });
}
export async function settings(req, res) {
  ok(res, await FinanceSettings.findById('finance').lean());
}
export async function updateSettings(req, res) {
  const input = settingsSchema.parse(req.body);
  if (input.gstin && input.gstin.slice(0, 2) !== input.stateCode)
    throw new AppError(400, 'Company GSTIN/state code mismatch');
  const row = await FinanceSettings.findByIdAndUpdate(
    'finance',
    { $set: { ...input, updatedBy: req.user._id } },
    { new: true, upsert: true },
  );
  await financeAudit(
    req,
    'settings_changed',
    { _id: req.user._id },
    { fields: Object.keys(input) },
  );
  ok(res, row);
}
export async function accessSettings(req, res) {
  const items = [];
  for (const role of roleDefinitions)
    items.push({
      ...role,
      permissions: (await permissionsFor({ role: role.name })).filter(
        (permission) => permission === '*' || permission.startsWith('finance.'),
      ),
    });
  ok(res, { items, permissions: financePermissions });
}
export async function changeAccess(req, res) {
  const role = roleDefinitions.find((item) => item.name === req.params.role);
  const { permissions } = z
    .object({ permissions: z.array(z.enum(financePermissions)).max(100) })
    .strict()
    .parse(req.body);
  if (!role || role.name === 'super_admin')
    throw new AppError(400, 'Super Admin finance access is immutable');
  if (
    req.user.role !== 'super_admin' &&
    (['admin', req.user.role].includes(role.name) ||
      permissions.includes('finance.settings.manage') ||
      permissions.some((permission) => !hasFinance(req, permission)))
  )
    throw new AppError(403, 'Cannot delegate privileged finance access');
  await Role.updateOne(
    { name: role.name },
    {
      $set: {
        label: role.label,
        financePermissions: [...new Set(permissions)],
      },
      $setOnInsert: { name: role.name },
    },
    { upsert: true },
  );
  await financeAudit(
    req,
    'access_changed',
    { _id: req.user._id },
    { role: role.name, permissions },
  );
  ok(res, { updated: true });
}
export async function clientTax(req, res) {
  const input = clientTaxSchema.parse(req.body),
    row = await findFinanceClient(req, req.params.id);
  if (input.gstin && input.gstin.slice(0, 2) !== input.stateCode)
    throw new AppError(400, 'Client GSTIN/state code mismatch');
  Object.assign(row, input);
  await row.save();
  await financeAudit(req, 'client_tax_updated', row);
  ok(res, { _id: row._id, gstin: row.gstin, stateCode: row.stateCode });
}
export async function dashboard(req, res) {
  ok(res, await financeDashboard(req, parseQuery(req)));
}
export async function invoices(req, res) {
  ok(res, await queryFinanceInvoices(req, parseQuery(req)));
}
export async function outstanding(req, res) {
  const data = await queryFinanceInvoices(req, parseQuery(req), {
    outstanding: true,
  });
  const ids = data.items.map((row) => row._id);
  const followups = await FinanceFollowUp.find({ invoice: { $in: ids } })
    .select('invoice date nextFollowUpAt assignedTo status')
    .sort({ date: -1 })
    .lean();
  data.items = data.items.map((row) => ({
    ...row,
    lastFollowUp:
      followups.find((follow) => String(follow.invoice) === String(row._id)) ||
      null,
  }));
  ok(res, data);
}
export async function invoiceDetail(req, res) {
  const row = await findFinanceInvoice(req, req.params.id);
  const [payments, activity, followups, documents] = await Promise.all([
    hasFinance(req, 'finance.payments.view')
      ? FinancePayment.find({ invoice: row._id })
          .sort({ paymentDate: -1 })
          .limit(100)
          .lean()
      : [],
    AuditLog.find({ entityType: 'finance', entityId: row._id })
      .select('action createdAt user details')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    hasFinance(req, 'finance.outstanding.view')
      ? FinanceFollowUp.find({ invoice: row._id })
          .sort({ date: -1 })
          .limit(100)
          .lean()
      : [],
    FinanceDocument.find({ invoice: row._id })
      .select('name mimeType size createdAt')
      .limit(100)
      .lean(),
  ]);
  ok(res, {
    invoice: { ...row.toObject(), ...invoiceState(row) },
    payments,
    activity,
    followups,
    documents,
  });
}
export async function createInvoice(req, res) {
  const input = invoiceSchema.parse(req.body);
  ok(res, await createFinanceInvoice(req, input), 201);
}
export async function editInvoice(req, res) {
  const input = invoiceSchema.parse(req.body);
  const row = await financeTransaction(async (session) => {
    const row = await findFinanceInvoice(req, req.params.id, session);
    if (row.status !== 'Draft' || invoiceState(row).paidMinor)
      throw new AppError(409, 'Only unpaid draft invoices can be edited');
    if (input.revision !== row.revision)
      throw new AppError(409, 'Invoice changed; refresh before editing');
    if (row.clientRef && String(row.clientRef) !== input.client)
      throw new AppError(409, 'Invoice client cannot be changed');
    const fields = await buildInvoiceFields(req, input, session);
    Object.assign(row, fields, {
      revision: row.revision + 1,
      updatedBy: req.user._id,
    });
    await row.save({ session });
    await financeAudit(
      req,
      'invoice_edited',
      row,
      { revision: row.revision, totalMinor: row.totalMinor },
      session,
    );
    return row;
  });
  ok(res, row);
}
export async function issueInvoice(req, res) {
  const { email = false } = z
    .object({ email: z.boolean().default(false) })
    .strict()
    .parse(req.body || {});
  if (email && env.MAIL_DELIVERY !== 'smtp')
    throw new AppError(503, 'Mail delivery is disabled');
  const row = await financeTransaction(async (session) => {
    const row = await findFinanceInvoice(req, req.params.id, session);
    if (row.status !== 'Draft')
      throw new AppError(409, 'Only drafts can be issued');
    row.status = 'Sent';
    row.sentAt = new Date();
    row.revision += 1;
    row.updatedBy = req.user._id;
    await row.save({ session });
    if (email)
      await OutgoingMail.create(
        [
          {
            user: req.user._id,
            invoice: row._id,
            recipient: row.client.email,
            subject: `Invoice ${row.invoiceNumber} — ${row.companySnapshot?.companyName || 'AdBorn ERP'}`,
            text: `Dear ${row.client.contactPerson},\nInvoice ${row.invoiceNumber} has been issued for INR ${row.grandTotal.toFixed(2)}. Due date: ${new Date(row.dueDate.getTime() + 19800000).toISOString().slice(0, 10)}.\nYour invoice PDF and payment details are attached.`,
            status: 'PENDING',
          },
        ],
        { session },
      );
    await financeAudit(
      req,
      'invoice_sent',
      row,
      { emailQueued: email },
      session,
    );
    await financeNotify(req, row, 'Invoice issued', session);
    return row;
  });
  ok(res, { invoice: row, emailQueued: email });
}
export async function cancelInvoice(req, res) {
  const { reason } = z
    .object({ reason: z.string().trim().min(3).max(500) })
    .strict()
    .parse(req.body);
  const row = await financeTransaction(async (session) => {
    const row = await findFinanceInvoice(req, req.params.id, session);
    if (invoiceState(row).paidMinor > 0)
      throw new AppError(
        409,
        'Reverse posted payments before cancelling this invoice',
      );
    if (row.status !== 'Cancelled') {
      row.status = 'Cancelled';
      row.cancelledAt = new Date();
      row.cancellationReason = reason;
      row.revision += 1;
      await row.save({ session });
      await financeAudit(req, 'invoice_cancelled', row, { reason }, session);
    }
    return row;
  });
  ok(res, row);
}
export async function invoicePdf(req, res) {
  const row = await findFinanceInvoice(req, req.params.id);
  const file = await financeInvoicePdf(row);
  await financeAudit(req, 'invoice_pdf_exported', row);
  res
    .type('application/pdf')
    .set(
      'Content-Disposition',
      `${req.query.disposition === 'inline' ? 'inline' : 'attachment'}; filename="invoice-${row._id}.pdf"`,
    )
    .send(file);
}
export async function payments(req, res) {
  const query = parseQuery(req),
    ids =
      req.financeScope.ids || query.client
        ? await accessibleInvoiceIds(req)
        : null;
  const filter = {
    ...(ids ? { invoice: { $in: ids } } : {}),
    ...(query.invoice
      ? {
          invoice: financeId(query.invoice),
          ...(ids ? { $and: [{ invoice: { $in: ids } }] } : {}),
        }
      : {}),
    ...(query.client ? { client: financeId(query.client) } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.search
      ? {
          $or: ['paymentId', 'transactionReference'].map((field) => ({
            [field]: {
              $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              $options: 'i',
            },
          })),
        }
      : {}),
    ...dateRange(query, 'paymentDate'),
  };
  const [items, total] = await Promise.all([
    FinancePayment.find(filter)
      .select('-fingerprint -idempotencyKey')
      .populate('invoice', 'invoiceNumber')
      .sort({ paymentDate: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    FinancePayment.countDocuments(filter),
  ]);
  ok(res, {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
}
export async function paymentCreate(req, res) {
  ok(res, await recordFinancePayment(req, paymentSchema.parse(req.body)), 201);
}
export async function paymentReverse(req, res) {
  const { reason } = z
    .object({ reason: z.string().trim().min(3).max(500) })
    .strict()
    .parse(req.body);
  ok(res, await reverseFinancePayment(req, req.params.id, reason));
}
export async function expenses(req, res) {
  const query = parseQuery(req),
    filter = {
      $and: [
        financeScope(req, 'expenses'),
        dateRange(query, 'date'),
        ...['client', 'project', 'employee']
          .filter((key) => query[key])
          .map((key) => ({ [key]: financeId(query[key]) })),
        ...['department', 'category', 'status']
          .filter((key) => query[key])
          .map((key) => ({ [key]: query[key] })),
      ],
    };
  if (query.search)
    filter.$and.push({
      $or: ['vendor', 'description', 'expenseId'].map((field) => ({
        [field]: {
          $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          $options: 'i',
        },
      })),
    });
  const [items, total] = await Promise.all([
    FinanceExpense.find(filter)
      .sort({ date: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    FinanceExpense.countDocuments(filter),
  ]);
  ok(res, {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
}
export async function expenseDetail(req, res) {
  const expense = await FinanceExpense.findOne({
    _id: financeId(req.params.id),
    ...financeScope(req, 'expenses'),
  }).lean();
  if (!expense) throw new AppError(404, 'Expense not found');
  const documents = await FinanceDocument.find({ expense: expense._id })
    .select('name mimeType size createdAt')
    .limit(100)
    .lean();
  ok(res, { expense, documents });
}
export async function expenseSave(req, res) {
  ok(
    res,
    await saveFinanceExpense(req, expenseSchema.parse(req.body), req.params.id),
    req.params.id ? 200 : 201,
  );
}
export async function expenseAction(req, res) {
  const { action, revision } = z
    .object({
      action: z.enum(['submit', 'approve', 'reject', 'pay', 'cancel']),
      revision: z.number().int().min(0),
    })
    .strict()
    .parse(req.body);
  const permission = ['approve', 'reject'].includes(action)
    ? 'finance.expenses.approve'
    : 'finance.expenses.edit';
  if (!hasFinance(req, permission))
    throw new AppError(403, 'Expense action permission denied');
  const data = await financeTransaction(async (session) => {
    const row = await FinanceExpense.findOne({
      _id: financeId(req.params.id),
      ...financeScope(req, 'expenses'),
    }).session(session);
    if (!row || row.revision !== revision)
      throw new AppError(409, 'Expense changed or unavailable; refresh first');
    const settings = await FinanceSettings.findById('finance')
      .session(session)
      .lean();
    const transitions = {
      submit: {
        from: ['DRAFT', 'REJECTED'],
        to:
          settings?.requireExpenseApproval === false
            ? 'APPROVED'
            : 'PENDING_APPROVAL',
      },
      approve: { from: ['PENDING_APPROVAL'], to: 'APPROVED' },
      reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
      pay: { from: ['APPROVED'], to: 'PAID' },
      cancel: {
        from: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'],
        to: 'CANCELLED',
      },
    };
    const change = transitions[action];
    if (!change.from.includes(row.status))
      throw new AppError(409, 'Invalid expense status transition');
    row.status = change.to;
    row.revision += 1;
    if (action === 'approve' || row.status === 'APPROVED') {
      row.approvedBy = req.user._id;
      row.approvedAt = new Date();
    }
    if (action === 'pay') row.paidAt = new Date();
    await row.save({ session });
    await financeAudit(
      req,
      `expense_${action}`,
      row,
      { status: row.status },
      session,
    );
    await financeNotify(
      req,
      row,
      `Expense ${row.status.toLowerCase()}`,
      session,
      row.createdBy,
    );
    return row;
  });
  ok(res, data);
}
export async function followups(req, res) {
  const query = parseQuery(req),
    ids = await accessibleInvoiceIds(req),
    filter = {
      invoice: { $in: ids },
      ...(query.invoice
        ? { $and: [{ invoice: financeId(query.invoice) }] }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...dateRange(query, 'date'),
    };
  const [items, total] = await Promise.all([
    FinanceFollowUp.find(filter)
      .populate('invoice', 'invoiceNumber')
      .sort({ nextFollowUpAt: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    FinanceFollowUp.countDocuments(filter),
  ]);
  ok(res, {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
}
export async function followupSave(req, res) {
  const input = followupSchema.parse(req.body),
    invoice = await findFinanceInvoice(req, input.invoice);
  await validateAllocations(req, input);
  const row = req.params.id
    ? await FinanceFollowUp.findOneAndUpdate(
        { _id: financeId(req.params.id), invoice: invoice._id },
        { $set: input },
        { new: true, runValidators: true },
      )
    : await FinanceFollowUp.create({
        ...input,
        client: invoice.clientRef,
        createdBy: req.user._id,
      });
  if (!row) throw new AppError(404, 'Follow-up not found');
  await financeAudit(req, 'followup_saved', invoice, {
    followup: row._id,
    status: row.status,
  });
  ok(res, row);
}
export async function recurring(req, res) {
  const query = parseQuery(req),
    filter = {
      $and: [
        financeScope(req, 'recurring'),
        dateRange(query, 'nextBillingDate'),
        ...(query.search
          ? [
              {
                $or: ['service', 'description'].map((field) => ({
                  [field]: {
                    $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    $options: 'i',
                  },
                })),
              },
            ]
          : []),
        ...(query.status ? [{ status: query.status }] : []),
        ...(query.client ? [{ client: financeId(query.client) }] : []),
      ],
    };
  const [items, total] = await Promise.all([
    FinanceRecurring.find(filter)
      .populate('client', 'companyName')
      .sort({ nextBillingDate: 1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    FinanceRecurring.countDocuments(filter),
  ]);
  ok(res, {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  });
}
export async function recurringSave(req, res) {
  const input = recurringSchema.parse(req.body);
  await findFinanceClient(req, input.client);
  await validateAllocations(req, input);
  if (minor(input.taxRate) > 10000)
    throw new AppError(400, 'Tax rate cannot exceed 100');
  const fields = { ...input, amountMinor: minor(input.amount) };
  delete fields.revision;
  let row;
  if (req.params.id)
    row = await FinanceRecurring.findOneAndUpdate(
      {
        _id: financeId(req.params.id),
        revision: input.revision,
        ...financeScope(req, 'recurring'),
      },
      { $set: fields, $inc: { revision: 1 } },
      { new: true },
    );
  else
    row = await FinanceRecurring.create({ ...fields, createdBy: req.user._id });
  if (!row)
    throw new AppError(409, 'Recurring service changed; refresh before saving');
  await financeAudit(req, 'recurring_saved', row);
  ok(res, row);
}
export async function recurringGenerate(req, res) {
  const { period } = z
    .object({ period: z.coerce.date() })
    .strict()
    .parse(req.body);
  ok(res, await generateRecurringInvoice(req, req.params.id, period), 201);
}
export async function ledger(req, res) {
  const query = parseQuery(req);
  if (!query.client) throw new AppError(400, 'Select a client for the ledger');
  await findFinanceClient(req, query.client);
  ok(res, await clientLedger(req, query.client, query));
}
export async function profitability(req, res) {
  const query = parseQuery(req);
  const billed = await Invoice.aggregate([
    ...invoiceStages(req, query),
    { $match: { issued: true } },
    {
      $group: {
        _id: query.project
          ? '$project'
          : query.client
            ? '$clientRef'
            : '$service',
        billedMinor: { $sum: '$totalMinor' },
        taxableMinor: {
          $sum: {
            $ifNull: [
              '$taxableMinor',
              { $toLong: { $round: [{ $multiply: ['$subtotal', 100] }, 0] } },
            ],
          },
        },
      },
    },
  ]);
  const allocated = await FinanceExpense.aggregate([
    {
      $match: {
        $and: [
          financeScope(req, 'expenses'),
          dateRange(query, 'date'),
          { status: { $in: ['APPROVED', 'PAID'] } },
          ...(query.project ? [{ project: financeId(query.project) }] : []),
          ...(query.client ? [{ client: financeId(query.client) }] : []),
        ],
      },
    },
    {
      $group: {
        _id: query.project ? '$project' : query.client ? '$client' : '$service',
        directCostMinor: { $sum: '$amountMinor' },
        expenses: { $sum: 1 },
      },
    },
  ]);
  const items = billed.map((row) => {
    const cost = allocated.find((item) => String(item._id) === String(row._id));
    return {
      allocation: row._id || 'Unallocated',
      billedMinor: Number(row.billedMinor),
      taxableMinor: Number(row.taxableMinor),
      directCostMinor: cost ? Number(cost.directCostMinor) : null,
      contributionMinor: cost
        ? Number(row.taxableMinor) - Number(cost.directCostMinor)
        : null,
      status: cost ? 'DIRECT_COST_ONLY' : 'COST_DATA_UNAVAILABLE',
    };
  });
  ok(res, {
    items,
    basis:
      'Pre-GST billed revenue minus recorded allocated approved/paid expense base amounts. This is direct contribution, not net profit: salaries, overhead and unallocated costs may be missing. No cost record means profitability is unavailable.',
  });
}
export async function uploadDocument(req, res) {
  if (!req.file) throw new AppError(400, 'Choose a document');
  const invoice = req.params.invoiceId
    ? await findFinanceInvoice(req, req.params.invoiceId)
    : null;
  const expense = req.params.expenseId
    ? await FinanceExpense.findOne({
        _id: financeId(req.params.expenseId),
        ...financeScope(req, 'expenses'),
      })
    : null;
  if (!invoice && !expense)
    throw new AppError(404, 'Financial record not found');
  const storedName = await storeDocument('crm', req.file.buffer);
  try {
    const row = await FinanceDocument.create({
      invoice: invoice?._id,
      expense: expense?._id,
      name: req.file.originalname.slice(0, 160),
      storedName,
      mimeType: documentMime(req.file.buffer),
      size: req.file.size,
      createdBy: req.user._id,
    });
    await financeAudit(req, 'document_uploaded', invoice || expense, {
      document: row._id,
    });
    ok(res, { _id: row._id, name: row.name, size: row.size }, 201);
  } catch (error) {
    await cleanupDocument('crm', storedName).catch(() => {});
    throw error;
  }
}
export async function downloadDocument(req, res) {
  const row = await FinanceDocument.findById(financeId(req.params.id)).select(
    '+storedName',
  );
  if (!row) throw new AppError(404, 'Document not found');
  if (row.invoice) {
    if (!hasFinance(req, 'finance.invoices.view'))
      throw new AppError(403, 'Invoice access denied');
    await findFinanceInvoice(req, row.invoice);
  } else {
    if (
      !hasFinance(req, 'finance.expenses.view') ||
      !(await FinanceExpense.exists({
        _id: row.expense,
        ...financeScope(req, 'expenses'),
      }))
    )
      throw new AppError(403, 'Expense access denied');
  }
  res
    .type(row.mimeType)
    .attachment(row.name)
    .send(await readDocument('crm', row.storedName));
}
export async function exportFinance(req, res) {
  const query = parseQuery(req),
    key = req.params.key;
  const permissions = {
    invoices: 'finance.invoices.view',
    outstanding: 'finance.outstanding.view',
    gst: 'finance.invoices.view',
    ledger: 'finance.ledger.view',
    payments: 'finance.payments.view',
    expenses: 'finance.expenses.view',
  };
  if (!permissions[key] || !hasFinance(req, permissions[key]))
    throw new AppError(403, 'Finance report source permission denied');
  if (
    ['invoices', 'gst'].includes(key) &&
    !hasFinance(req, 'finance.invoices.export')
  )
    throw new AppError(403, 'Invoice export permission denied');
  if (key === 'payments' && !hasFinance(req, 'finance.payments.export'))
    throw new AppError(403, 'Payment export permission denied');
  let data, permission;
  if (key === 'invoices' || key === 'outstanding' || key === 'gst') {
    permission =
      key === 'outstanding'
        ? 'finance.outstanding.view'
        : 'finance.invoices.view';
    const result = await queryFinanceInvoices(
      req,
      { ...query, page: 1, limit: 5001 },
      { outstanding: key === 'outstanding', issuedOnly: key === 'gst' },
    );
    data = {
      items: result.items.map((row) => ({
        invoice: row.invoiceNumber,
        client: row.client.company,
        date: row.invoiceDate,
        dueDate: row.dueDate,
        totalMinor: row.totalMinor,
        paidMinor: row.paidMinor,
        balanceMinor: row.balanceMinor,
        status: row.financeStatus,
        ...(key === 'gst'
          ? {
              taxableMinor: row.taxableMinor,
              cgstMinor: row.cgstMinor,
              sgstMinor: row.sgstMinor,
              igstMinor: row.igstMinor,
              gstMinor: row.taxMinor,
              clientGstin: row.gstin,
              stateCode: row.stateCode,
            }
          : {}),
      })),
      total: result.pagination.total,
    };
  } else if (key === 'ledger') {
    permission = 'finance.ledger.view';
    if (!query.client) throw new AppError(400, 'Choose a client');
    await findFinanceClient(req, query.client);
    const result = await clientLedger(req, query.client, {
      ...query,
      page: 1,
      limit: 5001,
    });
    data = { items: result.items, total: result.pagination.total };
  } else if (key === 'payments') {
    permission = 'finance.payments.view';
    const ids = await accessibleInvoiceIds(req);
    const filter = {
      invoice: { $in: ids },
      ...dateRange(query, 'paymentDate'),
      ...(query.client ? { client: financeId(query.client) } : {}),
      ...(query.invoice
        ? { $and: [{ invoice: financeId(query.invoice) }] }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.search
        ? {
            $or: ['paymentId', 'transactionReference'].map((field) => ({
              [field]: {
                $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                $options: 'i',
              },
            })),
          }
        : {}),
    };
    data = {
      items: await FinancePayment.find(filter)
        .select(
          'paymentId paymentDate amountMinor method status reversedAt -_id',
        )
        .limit(5001)
        .lean(),
      total: await FinancePayment.countDocuments(filter),
    };
  } else if (key === 'expenses') {
    permission = 'finance.expenses.view';
    const filter = {
      $and: [
        financeScope(req, 'expenses'),
        dateRange(query, 'date'),
        ...(query.status ? [{ status: query.status }] : []),
        ...(query.category ? [{ category: query.category }] : []),
        ...['client', 'project', 'employee']
          .filter((field) => query[field])
          .map((field) => ({ [field]: financeId(query[field]) })),
        ...(query.department ? [{ department: query.department }] : []),
        ...(query.search
          ? [
              {
                $or: ['vendor', 'description', 'expenseId'].map((field) => ({
                  [field]: {
                    $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    $options: 'i',
                  },
                })),
              },
            ]
          : []),
      ],
    };
    data = {
      items: await FinanceExpense.find(filter)
        .select(
          'expenseId date category vendor amountMinor taxMinor totalMinor status -_id',
        )
        .limit(5001)
        .lean(),
      total: await FinanceExpense.countDocuments(filter),
    };
  } else throw new AppError(404, 'Finance report not found');
  if (!hasFinance(req, permission))
    throw new AppError(403, 'Finance report source permission denied');
  if (data.total > 5000)
    throw new AppError(422, 'Narrow filters to 5000 rows for export');
  const columns = Object.keys(data.items[0] || { result: '' }).filter(
    (field) => field !== '_id',
  );
  const exported = await renderReportExport(
    {
      report: { key: `finance_${key}`, title: `Finance ${key}`, columns },
      scope: req.financeScope.scope,
      dateBasis: 'Amounts shown as integer INR paise; 100 paise = INR 1',
      rows: data.items,
    },
    query.format || 'csv',
  );
  await financeAudit(
    req,
    'report_exported',
    { _id: req.user._id },
    { key, rows: data.total, scope: req.financeScope.scope },
  );
  res.type(exported.mime).attachment(exported.filename).send(exported.buffer);
}
