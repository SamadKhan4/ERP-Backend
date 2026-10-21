import {
  invoiceIssuer,
  invoiceCompanySnapshot,
  resolveInvoiceType,
} from '../services/invoiceIssuerService.js';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { Invoice } from '../models/Invoice.js';
import { Client } from '../models/Client.js';
import { Project } from '../models/Project.js';
import { Quotation } from '../models/Quotation.js';
import { User } from '../models/User.js';
import { Department } from '../models/Department.js';
import {
  FinancePayment,
  FinanceExpense,
  FinanceRecurring,
  FinanceFollowUp,
  FinanceSettings,
} from '../models/Finance.js';
import { AuditLog } from '../models/AuditLog.js';
import { Notification } from '../models/Notification.js';
import { Counter } from '../models/Counter.js';
import { AppError } from '../utils/errors.js';
import {
  minor,
  safeMinor,
  invoiceAmounts,
  invoiceState,
} from './financeMoney.js';
import { financeScope, financeId } from './financeAccess.js';
export async function financeTransaction(work) {
  try {
    return await mongoose.connection.transaction(work);
  } catch (error) {
    if (
      error.code === 20 ||
      /Transaction numbers are only allowed/.test(error.message)
    )
      throw new AppError(
        503,
        'Finance writes require MongoDB replica set support',
      );
    if (error.code === 11000)
      throw new AppError(
        409,
        'Duplicate financial request; retry with the original idempotency key',
      );
    throw error;
  }
}
export async function financeNumber(kind, session, documentDate = new Date()) {
  const date = new Date(new Date(documentDate).getTime() + 19800000),
    year = date.getUTCFullYear() - (date.getUTCMonth() < 3 ? 1 : 0),
    fy = `${year}-${String(year + 1).slice(-2)}`;
  const counter = await Counter.findByIdAndUpdate(
    `finance-${kind}-${fy}`,
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return `ADB/${kind}/${fy}/${String(counter.value).padStart(4, '0')}`;
}
export async function financeAudit(req, action, row, details = {}, session) {
  await AuditLog.create(
    [
      {
        user: req.user._id,
        action: `finance.${action}`,
        entityType: 'finance',
        entityId: row._id,
        details,
      },
    ],
    { session },
  );
}
export async function financeNotify(
  req,
  row,
  title,
  session,
  recipient = req.user._id,
) {
  await Notification.create(
    [
      {
        recipient,
        type: 'finance',
        title,
        message: title,
        link: `/finance${row.invoiceNumber ? `/invoices/${row._id}` : ''}`,
        entityType: 'finance',
        entityId: row._id,
      },
    ],
    { session },
  );
}
export function requestIdentity(req, input) {
  const key = req.get('Idempotency-Key');
  if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
    throw new AppError(400, 'A valid Idempotency-Key header is required');
  return {
    key: `${req.user.id}:${key}`,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex'),
  };
}
export async function findFinanceInvoice(req, value, session) {
  const row = await Invoice.findOne({
    _id: financeId(value),
    deletedAt: null,
    ...financeScope(req, 'invoices'),
  }).session(session || null);
  if (!row) throw new AppError(404, 'Invoice not found in your finance scope');
  return row;
}
export async function findFinanceClient(req, value, session) {
  const row = await Client.findOne({
    $and: [{ _id: financeId(value) }, financeScope(req, 'clients')],
  }).session(session || null);
  if (!row) throw new AppError(404, 'Client not found in your finance scope');
  return row;
}
export async function buildInvoiceFields(req, input, session) {
  const client = await findFinanceClient(req, input.client, session);
  const invoiceType = resolveInvoiceType(
    input,
    input.items.some((item) => minor(item.taxRate || '0') > 0),
  );
  const settings = invoiceCompanySnapshot(
    invoiceType,
    await FinanceSettings.findById('finance')
      .session(session || null)
      .lean(),
  );
  if (
    !settings?.companyName ||
    !settings?.stateCode ||
    !settings?.bankName ||
    !settings?.accountNumber ||
    !settings?.ifscCode
  )
    throw new AppError(
      409,
      'Complete Finance company / bank settings before creating an invoice',
    );
  const brand = invoiceIssuer(invoiceType);
  const taxApplies = invoiceType === 'GST';
  const invoiceItems = input.items.map((item) => ({
    ...item,
    taxRate: taxApplies ? item.taxRate : '0',
  }));
  if (
    taxApplies &&
    !invoiceItems.some((item) => minor(item.taxRate || '0') > 0)
  )
    throw new AppError(400, 'GST invoices require a positive GST rate');
  const stateCode = client.stateCode || client.gstin?.slice(0, 2);
  if (taxApplies && (!stateCode || !settings.gstin))
    throw new AppError(
      409,
      'Company GSTIN and client state code are required for GST invoices',
    );
  if (!client.email)
    throw new AppError(409, 'Add the client email before creating an invoice');
  const taxType = !taxApplies
    ? 'EXEMPT'
    : stateCode === settings.stateCode
      ? 'INTRA_STATE'
      : 'INTER_STATE';
  const totals = invoiceAmounts(invoiceItems, taxType, input.otherCharges);
  const refs = {};
  if (input.quotation) {
    const quotation = await Quotation.findOne({
      _id: financeId(input.quotation),
      clientRef: client._id,
      deletedAt: null,
      status: 'Accepted',
    }).session(session || null);
    if (!quotation)
      throw new AppError(
        400,
        'Quotation must be accepted and belong to the selected client',
      );
    refs.quotation = quotation._id;
    refs.lead = quotation.lead;
  }
  if (input.project) {
    const project = await Project.findOne({
      _id: financeId(input.project),
      clientRef: client._id,
      ...(req.financeProjectIds
        ? {
            $or: [
              { _id: { $in: req.financeProjectIds } },
              { clientRef: { $in: req.financeClientIds } },
            ],
          }
        : {}),
    }).session(session || null);
    if (!project)
      throw new AppError(
        400,
        'Project must belong to the selected client and permitted scope',
      );
    refs.project = project._id;
    refs.lead = project.lead;
    if (input.service && input.service !== project.service)
      throw new AppError(400, 'Service must match the selected project');
  }
  return {
    ...refs,
    clientRef: client._id,
    lead: refs.lead || client.originatingLead,
    client: {
      company: client.companyName,
      contactPerson: client.contactPerson || client.companyName,
      address:
        Object.values(client.address?.toObject?.() || client.address || {})
          .filter(Boolean)
          .join(', ') || 'Not provided',
      contactNumber: client.phone || 'Not provided',
      email: client.email,
    },
    paymentDetails: {
      bankName: settings.bankName,
      accountNumber: settings.accountNumber,
      ifscCode: settings.ifscCode,
      branch: settings.branch || 'Not specified',
    },
    ...brand,
    companySnapshot: {
      ...settings,
      companyName: brand.issuerName,
      ...(!taxApplies ? { gstin: '' } : {}),
    },
    taxType,
    gstin: client.gstin || '',
    stateCode,
    service: input.service,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    reference: input.reference,
    paymentTerms: input.paymentTerms,
    notes: input.notes,
    lineItems: totals.items,
    items: totals.items.map((item) => ({
      title: item.description,
      amount: item.taxableMinor / 100,
    })),
    ...Object.fromEntries(
      Object.entries(totals).filter(([key]) => key !== 'items'),
    ),
    subtotal: totals.taxableMinor / 100,
    gstAmount: totals.taxMinor / 100,
    grandTotal: totals.totalMinor / 100,
    gstRate: 0,
    status: input.status === 'SENT' ? 'Sent' : 'Draft',
    financeVersion: 1,
  };
}
export async function createFinanceInvoice(req, input) {
  const identity = requestIdentity(req, input);
  return financeTransaction(async (session) => {
    const previous = await Invoice.findOne({
      financeRequestKey: identity.key,
    }).session(session);
    if (previous) {
      if (previous.financeFingerprint !== identity.fingerprint)
        throw new AppError(
          409,
          'Idempotency key was used for a different invoice',
        );
      return previous;
    }
    const fields = await buildInvoiceFields(req, input, session);
    const [row] = await Invoice.create(
      [
        {
          ...fields,
          invoiceNumber: await financeNumber(
            'INV',
            session,
            fields.invoiceDate,
          ),
          paidMinor: 0,
          legacyPaidMinor: 0,
          financeRequestKey: identity.key,
          financeFingerprint: identity.fingerprint,
          createdBy: req.user._id,
          updatedBy: req.user._id,
        },
      ],
      { session },
    );
    await financeAudit(
      req,
      'invoice_created',
      row,
      { totalMinor: row.totalMinor },
      session,
    );
    await financeNotify(req, row, 'Invoice created', session);
    return row;
  });
}
function adopt(invoice) {
  const state = invoiceState(invoice);
  if (invoice.totalMinor === undefined || invoice.totalMinor === null) {
    invoice.totalMinor = state.totalMinor;
    invoice.paidMinor = state.paidMinor;
    invoice.legacyPaidMinor = state.paidMinor;
  }
  return state;
}
function settle(invoice) {
  const remaining = invoice.totalMinor - invoice.paidMinor;
  invoice.status =
    remaining === 0
      ? 'Paid'
      : invoice.paidMinor > 0
        ? 'Partially Paid'
        : 'Sent';
  invoice.revision = (invoice.revision || 0) + 1;
}
export async function recordFinancePayment(req, input) {
  const identity = requestIdentity(req, input),
    amountMinor = minor(input.amount);
  if (!amountMinor)
    throw new AppError(400, 'Payment must be greater than zero');
  if (input.paymentDate > new Date())
    throw new AppError(400, 'Payment cannot be dated in the future');
  return financeTransaction(async (session) => {
    const existing = await FinancePayment.findOne({
      idempotencyKey: identity.key,
    }).session(session);
    if (existing) {
      if (existing.fingerprint !== identity.fingerprint)
        throw new AppError(
          409,
          'Idempotency key was used for a different payment',
        );
      await findFinanceInvoice(req, existing.invoice, session);
      return existing;
    }
    const invoice = await findFinanceInvoice(req, input.invoice, session),
      state = adopt(invoice);
    if (['Draft', 'Cancelled'].includes(invoice.status))
      throw new AppError(
        409,
        'Payments require an issued, non-cancelled invoice',
      );
    if (amountMinor > state.settlementBalanceMinor)
      throw new AppError(409, 'Payment exceeds the invoice balance');
    if (input.paymentDate < invoice.invoiceDate)
      throw new AppError(400, 'Payment date precedes the invoice date');
    const [payment] = await FinancePayment.create(
      [
        {
          ...input,
          amountMinor,
          client: invoice.clientRef,
          paymentId: await financeNumber('PAY', session, input.paymentDate),
          idempotencyKey: identity.key,
          fingerprint: identity.fingerprint,
          recordedBy: req.user._id,
        },
      ],
      { session },
    );
    invoice.paidMinor = safeMinor(
      BigInt(invoice.paidMinor) + BigInt(amountMinor),
    );
    settle(invoice);
    invoice.updatedBy = req.user._id;
    await invoice.save({ session });
    await financeAudit(
      req,
      'payment_received',
      invoice,
      {
        payment: payment._id,
        amountMinor,
        paidMinor: invoice.paidMinor,
        balanceMinor: invoice.totalMinor - invoice.paidMinor,
      },
      session,
    );
    await financeNotify(
      req,
      invoice,
      invoice.status === 'Paid'
        ? 'Payment received — invoice settled'
        : 'Partial payment received',
      session,
    );
    return payment;
  });
}
export async function reverseFinancePayment(req, paymentId, reason) {
  return financeTransaction(async (session) => {
    const payment = await FinancePayment.findById(financeId(paymentId)).session(
      session,
    );
    if (!payment) throw new AppError(404, 'Payment not found');
    const invoice = await findFinanceInvoice(req, payment.invoice, session);
    if (payment.status === 'REVERSED') return payment;
    adopt(invoice);
    invoice.paidMinor -= payment.amountMinor;
    if (invoice.paidMinor < 0)
      throw new AppError(
        409,
        'Invoice settlement does not match posted payments',
      );
    payment.status = 'REVERSED';
    payment.reversalReason = reason;
    payment.reversedAt = new Date();
    payment.reversedBy = req.user._id;
    settle(invoice);
    await invoice.save({ session });
    await payment.save({ session });
    await financeAudit(
      req,
      'payment_reversed',
      invoice,
      { payment: payment._id, amountMinor: payment.amountMinor, reason },
      session,
    );
    await financeNotify(req, invoice, 'Payment reversed', session);
    return payment;
  });
}
export async function validateAllocations(req, input, session) {
  let client;
  if (input.client)
    client = await findFinanceClient(req, input.client, session);
  if (input.project) {
    const project = await Project.findOne({
      _id: financeId(input.project),
      ...(req.financeProjectIds
        ? {
            $or: [
              { _id: { $in: req.financeProjectIds } },
              { clientRef: { $in: req.financeClientIds } },
            ],
          }
        : {}),
    }).session(session || null);
    if (
      !project ||
      (client && String(project.clientRef) !== String(client._id))
    )
      throw new AppError(400, 'Invalid project/client allocation');
    if (input.service && project.service !== input.service)
      throw new AppError(400, 'Service must match allocated project');
    input.client ||= String(project.clientRef);
    input.service ||= project.service;
  }
  if (input.department && !(await Department.exists({ key: input.department })))
    throw new AppError(400, 'Department not found');
  for (const field of ['employee', 'accountManager', 'assignedTo'])
    if (
      input[field] &&
      !(await User.exists({
        _id: financeId(input[field]),
        active: true,
        ...(req.financeScope.ids
          ? { _id: { $in: req.financeScope.ids, $eq: financeId(input[field]) } }
          : {}),
      }))
    )
      throw new AppError(
        400,
        'Assigned employee is outside your permitted scope',
      );
}
export async function saveFinanceExpense(req, input, value) {
  return financeTransaction(async (session) => {
    await validateAllocations(req, input, session);
    const amountMinor = minor(input.amount),
      taxMinor = minor(input.tax);
    const data = {
      ...input,
      amountMinor,
      taxMinor,
      totalMinor: safeMinor(BigInt(amountMinor) + BigInt(taxMinor)),
    };
    if (!data.totalMinor)
      throw new AppError(400, 'Expense must be greater than zero');
    let row;
    if (value) {
      row = await FinanceExpense.findOne({
        _id: financeId(value),
        ...financeScope(req, 'expenses'),
      }).session(session);
      if (!row || !['DRAFT', 'REJECTED'].includes(row.status))
        throw new AppError(
          409,
          'Only draft or rejected expenses can be edited',
        );
      if (input.revision !== row.revision)
        throw new AppError(409, 'Expense changed; refresh before saving');
      Object.assign(row, data, { revision: row.revision + 1 });
      await row.save({ session });
    } else
      [row] = await FinanceExpense.create(
        [
          {
            ...data,
            expenseId: await financeNumber('EXP', session, input.date),
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    await financeAudit(
      req,
      value ? 'expense_modified' : 'expense_created',
      row,
      { totalMinor: row.totalMinor, status: row.status },
      session,
    );
    await financeNotify(
      req,
      row,
      row.status === 'PENDING_APPROVAL'
        ? 'Expense approval required'
        : 'Expense created',
      session,
    );
    return row;
  });
}
export function nextBillingDate(value, frequency, days) {
  const date = new Date(new Date(value).getTime() + 19800000);
  if (frequency === 'CUSTOM') {
    date.setUTCDate(date.getUTCDate() + days);
    return new Date(date.getTime() - 19800000);
  }
  const originalDay = date.getUTCDate(),
    months = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 }[
      frequency
    ];
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(originalDay, last));
  return new Date(date.getTime() - 19800000);
}
export async function generateRecurringInvoice(req, value, expectedPeriod) {
  return financeTransaction(async (session) => {
    const recurring = await FinanceRecurring.findOne({
      _id: financeId(value),
      ...financeScope(req, 'recurring'),
    }).session(session);
    if (!recurring) throw new AppError(404, 'Recurring service not found');
    const period = new Date(expectedPeriod);
    const previous = await Invoice.findOne({
      recurringService: recurring._id,
      billingPeriod: period,
    }).session(session);
    if (previous) return previous;
    if (
      recurring.status !== 'ACTIVE' ||
      recurring.nextBillingDate.getTime() !== period.getTime()
    )
      throw new AppError(
        409,
        'Billing period changed; refresh before generating',
      );
    if (recurring.endDate && period > recurring.endDate)
      throw new AppError(409, 'Contract has expired');
    const input = {
      client: String(recurring.client),
      project: recurring.project ? String(recurring.project) : undefined,
      service: recurring.service,
      invoiceDate: period,
      dueDate: new Date(period.getTime() + 15 * 86400000),
      items: [
        {
          description: recurring.description,
          quantity: '1',
          rate: `${Math.floor(recurring.amountMinor / 100)}.${String(recurring.amountMinor % 100).padStart(2, '0')}`,
          taxRate: recurring.taxRate,
        },
      ],
      status: 'DRAFT',
      otherCharges: '0',
    };
    const fields = await buildInvoiceFields(req, input, session);
    const [invoice] = await Invoice.create(
      [
        {
          ...fields,
          invoiceNumber: await financeNumber('INV', session, period),
          paidMinor: 0,
          legacyPaidMinor: 0,
          recurringService: recurring._id,
          billingPeriod: period,
          createdBy: req.user._id,
          updatedBy: req.user._id,
        },
      ],
      { session },
    );
    recurring.nextBillingDate = nextBillingDate(
      period,
      recurring.frequency,
      recurring.customDays,
    );
    recurring.revision += 1;
    if (recurring.endDate && recurring.nextBillingDate > recurring.endDate)
      recurring.status = 'EXPIRED';
    await recurring.save({ session });
    await financeAudit(
      req,
      'recurring_invoice_generated',
      invoice,
      { recurring: recurring._id, period },
      session,
    );
    await financeNotify(req, invoice, 'Recurring invoice generated', session);
    return invoice;
  });
}
export {
  FinancePayment,
  FinanceExpense,
  FinanceRecurring,
  FinanceFollowUp,
  FinanceSettings,
};
