import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: String, required: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  subject: { type: String, required: true, maxlength: 200 },
  text: { type: String, required: true, maxlength: 20000 },
  status: { type: String, enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'], default: 'PENDING' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: Date, lease: String, sentAt: Date, lastError: String,
}, { timestamps: true });
schema.index({ user: 1, createdAt: -1 });
schema.index({ status: 1, nextAttemptAt: 1 });
export const OutgoingMail = mongoose.model('OutgoingMail', schema);
