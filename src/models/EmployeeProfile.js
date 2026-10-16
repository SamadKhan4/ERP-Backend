import mongoose from 'mongoose';
import { departmentReferenceHooks } from '../services/departmentMasterService.js';

const schema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    employeeCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 30,
    },
    designation: { type: String, trim: true, maxlength: 120 },
    department: {
      type: String,
      index: true,
    },
    employmentType: {
      type: String,
      enum: ['full_time', 'part_time', 'contract', 'intern'],
      default: 'full_time',
    },
    joiningDate: { type: Date, index: true },
    dateOfBirth: { type: Date },
    gender: { type: String, trim: true, maxlength: 40 },
    bloodGroup: { type: String, trim: true, maxlength: 10 },
    maritalStatus: { type: String, trim: true, maxlength: 40 },
    phone: { type: String, trim: true, maxlength: 30 },
    alternatePhone: { type: String, trim: true, maxlength: 30 },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      index: true,
    },
    workLocation: { type: String, trim: true, maxlength: 120 },
    address: { type: mongoose.Schema.Types.Mixed },
    education: { type: [mongoose.Schema.Types.Mixed], default: [] },
    experience: { type: [mongoose.Schema.Types.Mixed], default: [] },
    emergencyContact: {
      name: { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 30 },
      relationship: { type: String, trim: true, maxlength: 60 },
    },
  },
  { timestamps: true },
);

schema.index({ department: 1, joiningDate: -1 });
schema.index({ dateOfBirth: 1 });
schema.index({ manager: 1, user: 1 });

departmentReferenceHooks(schema, false);
export const EmployeeProfile = mongoose.model('EmployeeProfile', schema);
