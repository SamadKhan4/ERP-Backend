import mongoose from 'mongoose';

const clientSchema = new mongoose.Schema({
  company: { type: String, trim: true, maxlength: 160, required: true },
  contactPerson: { type: String, trim: true, maxlength: 120, required: true },
  address: { type: String, trim: true, maxlength: 300, required: true },
  contactNumber: { type: String, trim: true, maxlength: 30, required: true },
  email: { type: String, trim: true, lowercase: true, maxlength: 254, required: true },
}, { _id: false });

const paymentSchema = new mongoose.Schema({
  bankName: { type: String, trim: true, maxlength: 120, required: true },
  accountNumber: { type: String, trim: true, maxlength: 60, required: true },
  ifscCode: { type: String, trim: true, uppercase: true, maxlength: 30, required: true },
  branch: { type: String, trim: true, maxlength: 120, required: true },
}, { _id: false });

const itemSchema = new mongoose.Schema({
  title: { type: String, trim: true, maxlength: 300, required: true },
  amount: { type: Number, min: 0, max: 100000000, required: true },
}, { _id: false });

const schema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  invoiceDate: { type: Date, required: true },
  dueDate: { type: Date, required: true, index: true },
  client: { type: clientSchema, required: true },
  paymentDetails: { type: paymentSchema, required: true },
  items: { type: [itemSchema], validate: [(items) => items.length > 0 && items.length <= 6, 'Invoice requires 1-6 service rows'] },
  gstRate: { type: Number, min: 0, max: 100, default: 18 },
  subtotal: { type: Number, min: 0, required: true },
  gstAmount: { type: Number, min: 0, required: true },
  grandTotal: { type: Number, min: 0, required: true },
  status: { type: String, enum: ['Draft', 'Sent', 'Paid', 'Overdue', 'Cancelled'], default: 'Draft', index: true },
  notes: { type: String, trim: true, maxlength: 1500 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  deletedAt: { type: Date, default: null, index: true },
}, { timestamps: true });

schema.index({ deletedAt: 1, createdAt: -1 });
schema.index({ 'client.company': 1, deletedAt: 1 });

export const Invoice = mongoose.model('Invoice', schema);
