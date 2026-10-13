import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    run: { type: mongoose.Schema.Types.ObjectId, ref: 'HRMSRecord', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employeeName: { type: String, required: true, trim: true, maxlength: 120 },
    department: { type: String, trim: true, maxlength: 80 },
    salaryAssignment: { type: mongoose.Schema.Types.ObjectId, ref: 'HRMSRecord' },
    gross: { type: Number, required: true, min: 0 },
    deductions: { type: Number, required: true, min: 0 },
    net: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', enum: ['INR'] },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

schema.index({ run: 1, employee: 1 }, { unique: true });

export const PayrollEntry = mongoose.model('PayrollEntry', schema);
