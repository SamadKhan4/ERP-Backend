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
    email: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    service: { type: String, enum: quotationServices },
    description: { type: String, trim: true, maxlength: 300, required: true },
    amount: { type: Number, min: 0, max: 100000000, required: true },
  },
  { _id: false },
);

const schema = new mongoose.Schema(
  {
    quotationNumber: { type: String, required: true, unique: true, index: true },
    // `service` is retained as the primary service for older quotations.
    service: { type: String, enum: quotationServices, required: true, index: true },
    services: {
      type: [{ type: String, enum: quotationServices }],
      required: true,
      validate: [(items) => items.length > 0 && items.length <= quotationServices.length, 'Select 1-7 services'],
      index: true,
    },
    title: { type: String, trim: true, maxlength: 180, required: true },
    client: { type: partySchema, required: true },
    secondaryClient: { type: partySchema },
    items: { type: [itemSchema], validate: [(items) => items.length > 0 && items.length <= quotationServices.length * 6, 'Quotation requires 1-6 items per service'] },
    terms: { type: [String], default: [], validate: [(items) => items.length <= 10, 'Maximum 10 terms'] },
    gstRate: { type: Number, min: 0, max: 100, default: 18 },
    subtotal: { type: Number, min: 0, required: true },
    gstAmount: { type: Number, min: 0, required: true },
    grandTotal: { type: Number, min: 0, required: true },
    status: { type: String, enum: ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'], default: 'Draft', index: true },
    validUntil: { type: Date },
    notes: { type: String, trim: true, maxlength: 1500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

schema.index({ deletedAt: 1, createdAt: -1 });
schema.index({ 'client.company': 1, deletedAt: 1 });

export const Quotation = mongoose.model('Quotation', schema);
