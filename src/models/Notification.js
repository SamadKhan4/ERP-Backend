import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, required: true, trim: true, maxlength: 80 },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    link: { type: String, trim: true, maxlength: 300 },
    entityType: { type: String, trim: true, maxlength: 80 },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    readAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

schema.index({ recipient: 1, readAt: 1, createdAt: -1 });

export const Notification = mongoose.model('Notification', schema);
