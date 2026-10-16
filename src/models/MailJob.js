import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['WELCOME'], default: 'WELCOME' },
  recipient: { type: String, required: true },
  status: { type: String, enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED'], default: 'PENDING' },
  encryptedToken: { type: String, select: false },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: Date, lease: String, sentAt: Date,
  lastError: String,
}, { timestamps: true });
schema.index({ user: 1, kind: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
export const MailJob = mongoose.model('MailJob', schema);
