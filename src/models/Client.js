import mongoose from 'mongoose';
import { leadFields } from './Lead.js';
const schema = new mongoose.Schema(
  {
    ...leadFields,
    clientId: { type: String, required: true, unique: true },
    originatingLead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      required: true,
      unique: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);
schema.index(
  { phone: 1 },
  {
    unique: true,
    partialFilterExpression: { phone: { $type: 'string', $gt: '' } },
  },
);
schema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string', $gt: '' } },
  },
);
schema.index({ assignedTo: 1, createdAt: -1 });
export const Client = mongoose.model('Client', schema);
