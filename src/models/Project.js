import mongoose from 'mongoose';
import { serviceCatalog } from '../../../shared/crm.js';
const schema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true },
    title: { type: String, required: true, maxlength: 180 },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    clientRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: true,
    },
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    service: {
      type: String,
      enum: serviceCatalog.map((item) => item.id),
      required: true,
    },
    billingType: {
      type: String,
      enum: ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY'],
      default: 'ONE_TIME',
    },
    amount: { type: Number, min: 0, required: true },
    currency: {
      type: String,
      enum: ['INR', 'USD', 'EUR', 'GBP'],
      default: 'INR',
    },
    status: {
      type: String,
      enum: ['Planned', 'Active', 'Completed', 'On Hold', 'Cancelled'],
      default: 'Planned',
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startDate: Date,
    nextBillingAt: Date,
    notes: { type: String, maxlength: 3000 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);
schema.index({ clientRef: 1, createdAt: -1 });
schema.index({ lead: 1, createdAt: -1 });
export const Project = mongoose.model('Project', schema);
