import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    leaveType: { type: String, required: true, trim: true, maxlength: 80 },
    amount: { type: Number, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 300 },
    request: { type: mongoose.Schema.Types.ObjectId, ref: 'HRMSRecord', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

schema.index({ employee: 1, leaveType: 1, createdAt: -1 });
schema.index(
  { request: 1, reason: 1 },
  {
    unique: true,
    partialFilterExpression: { request: { $type: 'objectId' } },
  },
);

export const LeaveLedger = mongoose.model('LeaveLedger', schema);
