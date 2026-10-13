import mongoose from 'mongoose';
export const Session = mongoose.model(
  'Session',
  new mongoose.Schema(
    {
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      tokenHash: { type: String, unique: true, required: true },
      expires: { type: Date, required: true, index: { expires: 0 } },
    },
    { timestamps: true },
  ),
);
