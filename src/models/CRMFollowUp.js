import mongoose from 'mongoose';
import {
  followUpTypes,
  followUpStatuses,
  priorities,
} from '../../../shared/crm.js';
const schema = new mongoose.Schema(
  {
    followUpId: { type: String, unique: true, required: true },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: { type: String, enum: followUpTypes, required: true },
    scheduledAt: { type: Date, required: true },
    priority: { type: String, enum: priorities, default: 'MEDIUM' },
    notes: { type: String, maxlength: 3000 },
    outcome: { type: String, maxlength: 3000 },
    status: { type: String, enum: followUpStatuses, default: 'PENDING' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    completedAt: Date,
    nextFollowUpAt: Date,
    rescheduledFrom: Date,
    notifiedAt: Date,
    overdueNotifiedAt: Date,
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
schema.index({ assignedTo: 1, status: 1, scheduledAt: 1 });
schema.index({ lead: 1, status: 1, scheduledAt: 1 });
export const CRMFollowUp = mongoose.model('CRMFollowUp', schema);
