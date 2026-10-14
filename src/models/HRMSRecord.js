import mongoose from 'mongoose';
import { departments } from '../constants/departments.js';

export const hrmsResourceNames = [
  'departments',
  'designations',
  'recruitment',
  'jobs',
  'candidates',
  'interviews',
  'onboarding',
  'offboarding',
  'attendance',
  'attendance-regularizations',
  'attendance-periods',
  'daily-reports',
  'leave',
  'leave-types',
  'leave-policies',
  'leave-adjustments',
  'shifts',
  'shift-assignments',
  'timesheets',
  'holidays',
  'payroll',
  'payroll-runs',
  'salary',
  'salary-structures',
  'salary-assignments',
  'salary-revisions',
  'performance',
  'performance-cycles',
  'performance-goals',
  'performance-reviews',
  'training',
  'training-programs',
  'training-enrollments',
  'assets',
  'documents',
  'policies',
  'announcements',
  'report-exports',
  'settings',
];

const schema = new mongoose.Schema(
  {
    module: { type: String, enum: hrmsResourceNames, required: true },
    title: { type: String, required: true, trim: true, maxlength: 180 },
    department: {
      type: String,
      enum: departments.map(({ id }) => id),
      index: true,
    },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    status: { type: String, required: true, trim: true, maxlength: 80 },
    effectiveDate: { type: Date, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ module: 1, deletedAt: 1, _id: -1 });
schema.index({ module: 1, status: 1, effectiveDate: -1 });
schema.index({ module: 1, department: 1, deletedAt: 1 });
schema.index({ module: 1, employee: 1, effectiveDate: -1 });

export const HRMSRecord = mongoose.model('HRMSRecord', schema);
