import mongoose from 'mongoose';
import { activityTypes } from '../../shared/crm.js';
const schema = new mongoose.Schema(
  {
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead', required: true },
    type: { type: String, enum: activityTypes, required: true },
    title: { type: String, required: true, maxlength: 180 },
    description: { type: String, maxlength: 5000 },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    metadata: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);
schema.index({ lead: 1, createdAt: -1 });
export const LeadActivity = mongoose.model('LeadActivity', schema);
