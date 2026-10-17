import mongoose from 'mongoose';
const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const amount = {
  type: Number,
  min: 0,
  max: 10000000000000,
  validate: Number.isSafeInteger,
};
const payment = new mongoose.Schema(
  {
    paymentId: { type: String, required: true, unique: true },
    invoice: { ...ref('Invoice'), required: true },
    client: ref('Client'),
    paymentDate: { type: Date, required: true },
    amountMinor: { ...amount, required: true },
    method: String,
    transactionReference: String,
    bank: String,
    notes: String,
    idempotencyKey: { type: String, unique: true, required: true },
    fingerprint: String,
    recordedBy: { ...ref('User'), required: true },
    status: { type: String, enum: ['POSTED', 'REVERSED'], default: 'POSTED' },
    reversedBy: ref('User'),
    reversedAt: Date,
    reversalReason: String,
  },
  { timestamps: true },
);
payment.index({ invoice: 1, status: 1 });
payment.index({ client: 1, paymentDate: -1 });
payment.index({ paymentDate: -1 });
export const FinancePayment = mongoose.model('FinancePayment', payment);
const expense = new mongoose.Schema(
  {
    expenseId: { type: String, required: true, unique: true },
    date: { type: Date, required: true },
    category: String,
    vendor: String,
    description: String,
    amountMinor: { ...amount, required: true },
    taxMinor: { ...amount, default: 0 },
    totalMinor: { ...amount, required: true },
    method: String,
    reference: String,
    project: ref('Project'),
    client: ref('Client'),
    department: String,
    employee: ref('User'),
    service: String,
    status: {
      type: String,
      enum: [
        'DRAFT',
        'PENDING_APPROVAL',
        'APPROVED',
        'PAID',
        'REJECTED',
        'CANCELLED',
      ],
      default: 'DRAFT',
    },
    createdBy: { ...ref('User'), required: true },
    approvedBy: ref('User'),
    approvedAt: Date,
    paidAt: Date,
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);
expense.index({ date: -1, category: 1, status: 1 });
expense.index({ project: 1, client: 1 });
expense.index({ department: 1, employee: 1 });
export const FinanceExpense = mongoose.model('FinanceExpense', expense);
const recurring = new mongoose.Schema(
  {
    client: { ...ref('Client'), required: true },
    project: ref('Project'),
    service: String,
    description: String,
    startDate: Date,
    endDate: Date,
    nextBillingDate: { type: Date, required: true },
    frequency: {
      type: String,
      enum: ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY', 'CUSTOM'],
    },
    customDays: Number,
    amountMinor: amount,
    taxRate: String,
    autoInvoice: { type: Boolean, default: false },
    accountManager: ref('User'),
    status: {
      type: String,
      enum: ['ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED'],
      default: 'ACTIVE',
    },
    createdBy: { ...ref('User'), required: true },
    revision: { type: Number, default: 0 },
    lastError: String,
  },
  { timestamps: true },
);
recurring.index({ status: 1, nextBillingDate: 1 });
recurring.index({ client: 1 });
export const FinanceRecurring = mongoose.model('FinanceRecurring', recurring);
const followup = new mongoose.Schema(
  {
    invoice: { ...ref('Invoice'), required: true },
    client: ref('Client'),
    type: String,
    date: { type: Date, required: true },
    notes: String,
    outcome: String,
    promisedPaymentDate: Date,
    nextFollowUpAt: Date,
    assignedTo: ref('User'),
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'RESCHEDULED', 'MISSED'],
      default: 'PENDING',
    },
    createdBy: { ...ref('User'), required: true },
  },
  { timestamps: true },
);
followup.index({ invoice: 1, date: -1 });
followup.index({ assignedTo: 1, nextFollowUpAt: 1, status: 1 });
export const FinanceFollowUp = mongoose.model('FinanceFollowUp', followup);
export const FinanceSettings = mongoose.model(
  'FinanceSettings',
  new mongoose.Schema(
    {
      _id: { type: String, default: 'finance' },
      companyName: String,
      address: String,
      gstin: String,
      stateCode: String,
      bankName: String,
      accountNumber: String,
      ifscCode: String,
      branch: String,
      upi: String,
      terms: String,
      requireExpenseApproval: { type: Boolean, default: true },
      updatedBy: ref('User'),
    },
    { timestamps: true },
  ),
);
export const FinanceDocument = mongoose.model(
  'FinanceDocument',
  new mongoose.Schema(
    {
      invoice: ref('Invoice'),
      expense: ref('FinanceExpense'),
      name: String,
      storedName: { type: String, select: false },
      mimeType: String,
      size: Number,
      createdBy: ref('User'),
    },
    { timestamps: true },
  ),
);
