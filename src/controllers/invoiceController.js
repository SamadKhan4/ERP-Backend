import {
  invoiceIssuer,
  invoiceCompanySnapshot,
  resolveInvoiceType,
} from '../services/invoiceIssuerService.js';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Invoice } from '../models/Invoice.js';
import { Counter } from '../models/Counter.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { streamInvoicePdf } from '../services/invoicePdfService.js';
import { billingReferences } from '../services/billingReferenceService.js';
import { FinanceSettings, FinancePayment } from '../models/Finance.js';
import { invoiceAmounts } from '../finance/financeMoney.js';

const bodySchema = z
  .object({
    invoiceType: z.enum(['GST', 'NON_GST']).optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^$|^[0-9]{2}[A-Z0-9]{13}$/)
      .optional(),
    quotation: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    project: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    invoiceDate: z.coerce.date(),
    dueDate: z.coerce.date(),
    client: z.object({
      company: z.string().trim().min(1).max(160),
      contactPerson: z.string().trim().min(1).max(120),
      address: z.string().trim().min(1).max(300),
      contactNumber: z.string().trim().min(5).max(30),
      email: z.string().trim().email().max(254),
    }),
    paymentDetails: z.object({
      bankName: z.string().trim().min(1).max(120),
      accountNumber: z.string().trim().min(1).max(60),
      ifscCode: z.string().trim().min(1).max(30),
      branch: z.string().trim().min(1).max(120),
    }),
    items: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(300),
          amount: z.coerce.number().min(0).max(100000000),
        }),
      )
      .min(1)
      .max(6),
    gstRate: z.coerce.number().min(0).max(100).default(18),
    status: z
      .enum(['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'])
      .default('Draft'),
    notes: z.string().trim().max(1500).optional(),
  })
  .strict()
  .refine((data) => data.dueDate >= data.invoiceDate, {
    path: ['dueDate'],
    message: 'Due date must be on or after invoice date',
  });

const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z
      .enum(['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'])
      .optional(),
    view: z.enum(['overdue', 'outstanding']).optional(),
    search: z.string().trim().max(80).optional(),
  })
  .strict();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const totals = (items, gstRate) => {
  const amounts = invoiceAmounts(
    items.map((item) => ({
      description: item.title,
      quantity: '1',
      rate: String(item.amount),
      taxRate: String(gstRate),
    })),
    'INTER_STATE',
  );
  return {
    subtotal: amounts.subtotalMinor / 100,
    gstAmount: amounts.taxMinor / 100,
    grandTotal: amounts.totalMinor / 100,
  };
};
const ensureId = (id) => {
  if (!mongoose.isValidObjectId(id))
    throw new AppError(400, 'Invalid invoice identifier');
};
async function findInvoice(id) {
  ensureId(id);
  const invoice = await Invoice.findOne({ _id: id, deletedAt: null });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  return invoice;
}
async function audit(req, action, invoice) {
  await AuditLog.create({
    user: req.user.id,
    action,
    entityType: 'invoice',
    entityId: invoice._id,
    details: { invoiceNumber: invoice.invoiceNumber, status: invoice.status },
  });
}
async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const counter = await Counter.findByIdAndUpdate(
    `invoice-${year}`,
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return `ADB-INV-${year}-${String(counter.value).padStart(4, '0')}`;
}

export async function listInvoices(req, res) {
  const query = listSchema.parse(req.query);
  const filter = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.search
      ? {
          $or: [
            {
              invoiceNumber: {
                $regex: escapeRegExp(query.search),
                $options: 'i',
              },
            },
            {
              'client.company': {
                $regex: escapeRegExp(query.search),
                $options: 'i',
              },
            },
            {
              'client.contactPerson': {
                $regex: escapeRegExp(query.search),
                $options: 'i',
              },
            },
          ],
        }
      : {}),
  };
  if (query.view) {
    filter.status = { $nin: ['Draft', 'Cancelled', 'Paid'] };
    if (query.view === 'overdue') {
      const indiaDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
      }).format(new Date());
      filter.dueDate = { $lt: new Date(`${indiaDay}T00:00:00+05:30`) };
    }
  }
  const [items, total] = await Promise.all([
    Invoice.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Invoice.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
  });
}
export async function getInvoice(req, res) {
  res.json({ success: true, data: await findInvoice(req.params.id) });
}
export async function createInvoice(req, res) {
  const input = bodySchema.parse(req.body);
  const issuer = invoiceIssuer(resolveInvoiceType(input, input.gstRate > 0));
  if (issuer.invoiceType === 'NON_GST') input.gstRate = 0;
  else if (input.gstRate <= 0)
    throw new AppError(400, 'GST invoices require a positive GST rate');
  if (input.status === 'Paid')
    throw new AppError(
      400,
      'Record a payment in Finance to settle the invoice',
    );
  const settings = await FinanceSettings.findById('finance').lean();
  const invoice = await Invoice.create({
    companySnapshot: invoiceCompanySnapshot(issuer.invoiceType, settings || {}),
    ...input,
    ...issuer,
    ...(await billingReferences(input)),
    ...totals(input.items, input.gstRate),
    invoiceNumber: await nextInvoiceNumber(),
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  await audit(req, 'invoice.created', invoice);
  res.status(201).json({
    success: true,
    message: 'Invoice created successfully',
    data: invoice,
  });
}
export async function updateInvoice(req, res) {
  const input = bodySchema.parse(req.body);
  const issuer = invoiceIssuer(resolveInvoiceType(input, input.gstRate > 0));
  if (issuer.invoiceType === 'NON_GST') input.gstRate = 0;
  else if (input.gstRate <= 0)
    throw new AppError(400, 'GST invoices require a positive GST rate');
  const invoice = await findInvoice(req.params.id);
  if (input.status === 'Paid')
    throw new AppError(
      400,
      'Record a payment in Finance to settle the invoice',
    );
  if (
    invoice.financeVersion ||
    invoice.paidMinor ||
    invoice.status === 'Paid' ||
    (await FinancePayment.exists({ invoice: invoice._id }))
  )
    throw new AppError(
      409,
      'Use Finance Management for invoices with financial history',
    );
  if (
    (input.quotation && String(invoice.quotation) !== input.quotation) ||
    (input.project && String(invoice.project) !== input.project)
  )
    throw new AppError(409, 'Existing billing references cannot be changed');
  if (
    invoice.invoiceType &&
    invoice.status !== 'Draft' &&
    invoice.invoiceType !== issuer.invoiceType
  )
    throw new AppError(
      409,
      'Issued invoice branding cannot change; create a new invoice',
    );
  if (invoice.status === 'Draft') {
    const settings = await FinanceSettings.findById('finance').lean();
    invoice.companySnapshot = invoiceCompanySnapshot(
      issuer.invoiceType,
      settings || invoice.companySnapshot || {},
    );
  }
  Object.assign(invoice, input, issuer, totals(input.items, input.gstRate), {
    updatedBy: req.user.id,
  });
  await invoice.save();
  await audit(req, 'invoice.updated', invoice);
  res.json({
    success: true,
    message: 'Invoice updated successfully',
    data: invoice,
  });
}
export async function deleteInvoice(req, res) {
  const invoice = await findInvoice(req.params.id);
  if (
    invoice.financeVersion ||
    invoice.paidMinor ||
    invoice.status === 'Paid' ||
    (await FinancePayment.exists({ invoice: invoice._id }))
  )
    throw new AppError(
      409,
      'Use Finance cancellation; financial history cannot be archived',
    );
  invoice.deletedAt = new Date();
  invoice.updatedBy = req.user.id;
  await invoice.save();
  await audit(req, 'invoice.archived', invoice);
  res.json({ success: true, message: 'Invoice archived successfully' });
}
export async function downloadInvoice(req, res) {
  const invoice = await findInvoice(req.params.id);
  await audit(req, 'invoice.downloaded', invoice);
  return streamInvoicePdf(res, invoice.toObject());
}
