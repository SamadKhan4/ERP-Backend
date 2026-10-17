import mongoose from 'mongoose';
export const AuditLog = mongoose.model(
  'AuditLog',
  new mongoose.Schema(
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      action: { type: String, required: true },
      entityType: { type: String, trim: true, maxlength: 80 },
      entityId: { type: mongoose.Schema.Types.ObjectId },
      details: { type: mongoose.Schema.Types.Mixed },
    },
    { timestamps: true },
  ),
);
AuditLog.schema.index({ createdAt: -1 });
AuditLog.schema.index({ user: 1, action: 1, createdAt: -1 });
AuditLog.schema.index({ entityType: 1, entityId: 1, createdAt: -1 });
