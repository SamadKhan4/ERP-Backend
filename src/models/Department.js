import mongoose from 'mongoose';
const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const schema = new mongoose.Schema(
  {
    departmentId: { type: String, required: true, unique: true },
    key: { type: String, required: true, unique: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    nameKey: { type: String, required: true, unique: true },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      unique: true,
      maxlength: 30,
    },
    description: { type: String, maxlength: 2000, default: '' },
    departmentHead: ref('User'),
    reportingManager: ref('User'),
    parentDepartment: ref('Department'),
    location: { type: String, maxlength: 180, default: '' },
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE'],
      default: 'ACTIVE',
      index: true,
    },
    createdBy: ref('User'),
    updatedBy: ref('User'),
  },
  { timestamps: true },
);
schema.index({ status: 1, name: 1 });
export const Department = mongoose.model('Department', schema);
