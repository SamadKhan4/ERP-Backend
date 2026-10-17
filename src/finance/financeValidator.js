import { z } from 'zod';
const id = z.string().regex(/^[a-f\d]{24}$/i);
const decimal = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine(
    (value) => /^\d{1,10}(\.\d{1,2})?$/.test(value),
    'Use a non-negative amount with at most 2 decimal places',
  );
const date = z.preprocess((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+05:30` : value, z.coerce.date());
export const methods = [
  'CASH',
  'UPI',
  'BANK_TRANSFER',
  'CHEQUE',
  'CREDIT_CARD',
  'PAYMENT_GATEWAY',
  'OTHER',
];
export const expenseCategories = [
  'Salary',
  'Office Rent',
  'Software Subscription',
  'Advertising',
  'Travel',
  'Utilities',
  'Equipment',
  'Hosting',
  'Domain',
  'Freelancer',
  'Vendor',
  'Marketing',
  'Miscellaneous',
];
export const invoiceSchema = z
  .object({
    client: id,
    quotation: id.optional(),
    project: id.optional(),
    service: z.string().max(60).optional(),
    invoiceDate: date,
    dueDate: date,
    items: z
      .array(
        z
          .object({
            description: z.string().trim().min(1).max(300),
            quantity: z
              .union([z.string(), z.number()])
              .transform(String)
              .refine((value) => /^\d{1,7}(\.\d{1,4})?$/.test(value))
              .default('1'),
            rate: decimal,
            discount: decimal.default('0'),
            taxRate: decimal.default('0'),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    otherCharges: decimal.default('0'),
    status: z.enum(['DRAFT', 'SENT']).default('DRAFT'),
    reference: z.string().trim().max(120).optional(),
    paymentTerms: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(1500).optional(),
    revision: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (value) => value.dueDate >= value.invoiceDate,
    'Due date must be on or after invoice date',
  );
export const paymentSchema = z
  .object({
    invoice: id,
    paymentDate: date,
    amount: decimal,
    method: z.enum(methods),
    transactionReference: z.string().trim().max(180).optional(),
    bank: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict();
export const expenseSchema = z
  .object({
    date,
    category: z.enum(expenseCategories),
    vendor: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1000),
    amount: decimal,
    tax: decimal.default('0'),
    method: z.enum(methods).default('BANK_TRANSFER'),
    reference: z.string().trim().max(180).optional(),
    project: id.optional(),
    client: id.optional(),
    department: z.string().max(100).optional(),
    employee: id.optional(),
    service: z.string().max(60).optional(),
    status: z.enum(['DRAFT', 'PENDING_APPROVAL']).default('DRAFT'),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
export const followupSchema = z
  .object({
    invoice: id,
    type: z.enum([
      'CALL',
      'WHATSAPP',
      'EMAIL',
      'MEETING',
      'PROMISE_TO_PAY',
      'NOTE',
    ]),
    date,
    notes: z.string().trim().min(1).max(2000),
    outcome: z.string().max(1000).optional(),
    promisedPaymentDate: date.optional(),
    nextFollowUpAt: date.optional(),
    assignedTo: id.optional(),
    status: z
      .enum(['PENDING', 'COMPLETED', 'RESCHEDULED', 'MISSED'])
      .default('PENDING'),
  })
  .strict();
export const recurringSchema = z
  .object({
    client: id,
    project: id.optional(),
    service: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    startDate: date,
    endDate: date.optional(),
    nextBillingDate: date,
    frequency: z.enum([
      'MONTHLY',
      'QUARTERLY',
      'HALF_YEARLY',
      'YEARLY',
      'CUSTOM',
    ]),
    customDays: z.number().int().min(1).max(365).optional(),
    amount: decimal,
    taxRate: decimal.default('0'),
    autoInvoice: z.boolean().default(false),
    accountManager: id.optional(),
    status: z
      .enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED'])
      .default('ACTIVE'),
    revision: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endDate && value.endDate < value.startDate)
      ctx.addIssue({ code: 'custom', message: 'End date precedes start date' });
    if (value.frequency === 'CUSTOM' && !value.customDays)
      ctx.addIssue({
        code: 'custom',
        message: 'Custom interval days required',
      });
    if (value.nextBillingDate < value.startDate)
      ctx.addIssue({
        code: 'custom',
        message: 'Billing date precedes start date',
      });
  });
export const settingsSchema = z
  .object({
    companyName: z.string().trim().min(1).max(160),
    address: z.string().trim().min(1).max(500),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{2}[A-Z0-9]{13}$/)
      .or(z.literal(''))
      .default(''),
    stateCode: z.string().regex(/^\d{2}$/),
    bankName: z.string().trim().min(1).max(120),
    accountNumber: z.string().trim().min(1).max(60),
    ifscCode: z.string().trim().min(1).max(30),
    branch: z.string().trim().max(120).default(''),
    upi: z.string().trim().max(120).default(''),
    terms: z.string().trim().max(2000).default(''),
    requireExpenseApproval: z.boolean().default(true),
  })
  .strict();
export const clientTaxSchema = z
  .object({
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^\d{2}[A-Z0-9]{13}$/)
      .or(z.literal('')),
    stateCode: z.string().regex(/^\d{2}$/),
  })
  .strict();
export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    status: z.string().max(40).optional(),
    client: id.optional(),
    invoice: id.optional(),
    project: id.optional(),
    employee: id.optional(),
    department: z.string().max(100).optional(),
    category: z.string().max(60).optional(),
    method: z.enum(methods).optional(),
    from: date.optional(),
    to: date.optional(),
    minAmount: decimal.optional(),
    maxAmount: decimal.optional(),
    due: z.enum(['today', 'upcoming', 'overdue', 'severe']).optional(),
    sort: z
      .enum(['date', 'dueDate', 'totalMinor', 'invoiceNumber', 'createdAt'])
      .default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    format: z.enum(['csv', 'xlsx', 'pdf']).optional(),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    'Invalid date range',
  );
