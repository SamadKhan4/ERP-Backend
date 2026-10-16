import mongoose from 'mongoose';
const schema = new mongoose.Schema(
  {
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    filename: String,
    sheetName: String,
    headers: [String],
    rows: [{ row: Number, cells: [String], formulaColumns: [Number] }],
    configHash: String,
    results: [
      {
        row: Number,
        status: String,
        lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
        leadId: String,
        message: String,
      },
    ],
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ createdBy: 1, createdAt: -1 });
export const CRMImportBatch = mongoose.model('CRMImportBatch', schema);
