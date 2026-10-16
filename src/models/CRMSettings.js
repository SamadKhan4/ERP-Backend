import mongoose from 'mongoose';
import { sources, lostReasons } from '../../shared/crm.js';
export const CRMSettings = mongoose.model(
  'CRMSettings',
  new mongoose.Schema(
    {
      _id: { type: String, default: 'crm' },
      sources: { type: [String], default: sources },
      lostReasons: { type: [String], default: lostReasons },
      tags: [String],
      stageLabels: { type: Map, of: String },
      defaultFollowUpDays: { type: Number, default: 1, min: 1, max: 365 },
    },
    { timestamps: true },
  ),
);
