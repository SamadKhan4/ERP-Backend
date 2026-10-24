import mongoose from 'mongoose';

export const quotationServices = [
  'web',
  'social_media',
  'seo',
  'graphics',
  'video',
  'meta_ads',
  'google_ads',
];

const partySchema = new mongoose.Schema(
  {
    company: { type: String, trim: true, maxlength: 160, required: true },
    contactPerson: { type: String, trim: true, maxlength: 120, required: true },
    contactNumber: { type: String, trim: true, maxlength: 30, required: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: '',
    },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    service: { type: String, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300, required: true },
    amount: { type: Number, min: 0, max: 100000000 },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    quotationNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', index: true },
    clientRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      index: true,
    },
    salesPerson: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // `service` is retained as the primary service for older quotations.
    service: {
      type: String,
      trim: true,
      maxlength: 120,
      required: true,
      index: true,
    },
    services: {
      type: [{ type: String, trim: true, maxlength: 120 }],
      required: true,
      validate: [
        (items) => items.length > 0 && items.length <= 20,
        'Add 1-20 services',
      ],
      index: true,
    },
    serviceTotals: {
      type: [
        new mongoose.Schema(
          {
            service: { type: String, required: true },
            total: { type: Number, min: 0, max: 100000000, required: true },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    title: { type: String, trim: true, maxlength: 180, required: true },
    client: { type: partySchema, required: true },
    secondaryClient: { type: partySchema },
    items: {
      type: [itemSchema],
      validate: [
        (items) => items.length > 0 && items.length <= 20 * 100,
        'Quotation requires 1-100 items per service',
      ],
    },
    terms: {
      type: [String],
      default: [],
      validate: [(items) => items.length <= 10, 'Maximum 10 terms'],
    },
    gstRate: { type: Number, min: 0, max: 100, default: 18 },
    subtotal: { type: Number, min: 0, required: true },
    gstAmount: { type: Number, min: 0, required: true },
    grandTotal: { type: Number, min: 0, required: true },
    status: {
      type: String,
      enum: ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'],
      default: 'Draft',
      index: true,
    },
    validUntil: { type: Date },
    notes: { type: String, trim: true, maxlength: 1500 },
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

export const Quotation = mongoose.model('Quotation', schema);
