import mongoose from 'mongoose';
// Transactional outbox: disk cleanup survives a process restart or unlink failure.
const schema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ['onboarding', 'crm', 'reset'],
      required: true,
    },
    name: { type: String, required: true },
  },
  { timestamps: true },
);
export const FileDeletionJob = mongoose.model('FileDeletionJob', schema);
