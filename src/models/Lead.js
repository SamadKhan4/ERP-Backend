import mongoose from 'mongoose';
import {
  stages,
  priorities,
  temperatures,
  serviceCatalog,
} from '../../shared/crm.js';
const ref = (name) => ({ type: mongoose.Schema.Types.ObjectId, ref: name });
export const leadFields = {
  companyName: { type: String, required: true, trim: true, maxlength: 160 },
  contactPerson: { type: String, trim: true, maxlength: 120, default: '' },
  phone: { type: String, trim: true, default: '' },
  whatsapp: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, default: '' },
  website: { type: String, default: '' },
  industry: { type: String, default: '' },
  address: {
    addressLine: String,
    city: String,
    state: String,
    country: String,
    pincode: String,
  },
  leadSource: { type: String, required: true },
  interestedServices: [
    { type: String, enum: serviceCatalog.map((item) => item.id) },
  ],
  estimatedBudget: { type: Number, min: 0, default: 0 },
  currency: {
    type: String,
    enum: ['INR', 'USD', 'EUR', 'GBP'],
    default: 'INR',
  },
  assignedTo: ref('User'),
  priority: { type: String, enum: priorities, default: 'MEDIUM' },
  temperature: { type: String, enum: temperatures, default: 'WARM' },
  nextFollowUpAt: Date,
  expectedClosingDate: Date,
  probability: { type: Number, min: 0, max: 100, default: 0 },
  notes: { type: String, maxlength: 5000, default: '' },
  tags: [String],
};
const schema = new mongoose.Schema(
  {
    ...leadFields,
    importKey: { type: String },
    leadId: { type: String, unique: true, required: true },
    companyKey: { type: String, required: true, index: true },
    stage: { type: String, enum: stages, default: 'NEW' },
    status: { type: String, enum: stages, default: 'NEW' },
    createdBy: { ...ref('User'), required: true },
    lostReason: String,
    lostDetail: String,
    lostAt: Date,
    wonAt: Date,
    attachments: [
      {
        name: String,
        mimeType: String,
        size: Number,
        storageName: String,
        addedBy: ref('User'),
        addedAt: Date,
      },
    ],
    convertedClientId: ref('Client'),
    convertedAt: Date,
    lastActivityAt: Date,
    deletedAt: { type: Date, default: null },
    deletedBy: ref('User'),
  },
  { timestamps: true, optimisticConcurrency: true },
);
schema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      phone: { $type: 'string', $gt: '' },
      deletedAt: null,
    },
  },
);
schema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      email: { $type: 'string', $gt: '' },
      deletedAt: null,
    },
  },
);
schema.index({ assignedTo: 1, stage: 1, createdAt: -1 });
schema.index({ assignedTo: 1, nextFollowUpAt: 1 });
schema.index({ stage: 1, createdAt: -1 });
schema.index({ leadSource: 1, createdAt: -1 });
schema.index({ deletedAt: 1, createdAt: -1 });
schema.index({ nextFollowUpAt: 1 });
schema.index(
  { importKey: 1 },
  { unique: true, partialFilterExpression: { importKey: { $type: 'string' } } },
);
export const Lead = mongoose.model('Lead', schema);
