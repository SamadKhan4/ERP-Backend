import mongoose from 'mongoose';

const clientSchema = new mongoose.Schema(
  {
    company: { type: String, trim: true, maxlength: 160, required: true },
    contactPerson: { type: String, trim: true, maxlength: 120, required: true },
    address: { type: String, trim: true, maxlength: 300, required: true },
    contactNumber: { type: String, trim: true, maxlength: 30, required: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      required: true,
    },
  },
  { _id: false },
);

const paymentSchema = new mongoose.Schema(
  {
    bankName: { type: String, trim: true, maxlength: 120, required: true },
    accountNumber: { type: String, trim: true, maxlength: 60, required: true },
    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 30,
      required: true,
    },
    branch: { type: String, trim: true, maxlength: 120, required: true },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 300, required: true },
    amount: { type: Number, min: 0, max: 100000000, required: true },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    clientRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      index: true,
    },
    quotation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quotation',
      index: true,
    },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    invoiceDate: { type: Date, required: true },
    dueDate: { type: Date, required: true, index: true },
    client: { type: clientSchema, required: true },
    paymentDetails: { type: paymentSchema, required: true },
    items: {
      type: [itemSchema],
      validate: [
        (items) => items.length > 0 && items.length <= 6,
        'Invoice requires 1-6 service rows',
      ],
    },
    gstRate: { type: Number, min: 0, max: 100, default: 18 },
    subtotal: { type: Number, min: 0, required: true },
    gstAmount: { type: Number, min: 0, required: true },
    grandTotal: { type: Number, min: 0, required: true },
    status: {
      type: String,
      enum: ['Draft', 'Sent', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'],
      default: 'Draft',
      index: true,
    },
    notes: { type: String, trim: true, maxlength: 1500 },
    invoiceType:{type:String,enum:['GST','NON_GST']},issuerBrand:{type:String,enum:['ABCO','ADBORN']},issuerName:String,
    financeVersion: Number,
    totalMinor: Number, paidMinor: { type: Number, min: 0 }, legacyPaidMinor: Number,
    subtotalMinor: Number, discountMinor: Number, taxableMinor: Number, taxMinor: Number,
    cgstMinor: Number, sgstMinor: Number, igstMinor: Number, otherChargesMinor: Number,
    lineItems: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    currency: { type: String, enum: ['INR'], default: 'INR' }, taxType: String,
    gstin: String, stateCode: String, service: String, reference: String, paymentTerms: String,
    companySnapshot: mongoose.Schema.Types.Mixed,
    recurringService: { type: mongoose.Schema.Types.ObjectId, ref: 'FinanceRecurring' }, billingPeriod: Date,
    financeRequestKey: String, financeFingerprint: String,
    revision: { type: Number, default: 0 }, sentAt: Date, cancelledAt: Date, cancellationReason: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

schema.index({ deletedAt: 1, createdAt: -1 });
schema.index({ 'client.company': 1, deletedAt: 1 });
schema.index({ deletedAt: 1, invoiceDate: 1, status: 1 });
schema.index({ createdBy: 1, deletedAt: 1, invoiceDate: 1 });
schema.index({ clientRef: 1, status: 1, dueDate: 1 });
schema.index({ financeRequestKey: 1 }, { unique: true, partialFilterExpression: { financeRequestKey: { $type: 'string' } } });
schema.index({ recurringService: 1, billingPeriod: 1 }, { unique: true, partialFilterExpression: { recurringService: { $type: 'objectId' } } });

export const Invoice = mongoose.model('Invoice', schema);
