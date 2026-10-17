import mongoose from 'mongoose';
import { serviceCatalog } from '../../shared/crm.js';
const schema = new mongoose.Schema(
  {
    projectId: { type: String, required: true, unique: true },
    title: { type: String, required: true, maxlength: 180 },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    clientRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      required: false,
    },
    quotation: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
    service: {
      type: String,
      enum: serviceCatalog.map((item) => item.id),
      required: false,
    },
    billingType: {
      type: String,
      enum: ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY'],
      default: 'ONE_TIME',
    },
    amount: { type: Number, min: 0, default: 0 },
    currency: {
      type: String,
      enum: ['INR', 'USD', 'EUR', 'GBP'],
      default: 'INR',
    },
    status: {
      type: String,
      enum: [
        'Planned',
        'Active',
        'Completed',
        'On Hold',
        'Cancelled',
        'UPCOMING',
        'PLANNING',
        'ONGOING',
        'ON_HOLD',
        'REVIEW',
        'COMPLETED',
        'CANCELLED',
      ],
      default: 'Planned',
    },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startDate: Date,
    nextBillingAt: Date,
    notes: { type: String, maxlength: 3000 },
    projectCode: String,
    primaryDepartment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
    },
    collaboratingDepartments: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    ],
    projectManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    teamMembers: [
      {
        employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        roleInProject: String,
        allocationPercentage: { type: Number, min: 0, max: 100 },
        assignedAt: Date,
        removedAt: Date,
        status: {
          type: String,
          enum: ['ACTIVE', 'REMOVED'],
          default: 'ACTIVE',
        },
      },
    ],
    expectedStartDate: Date,
    deadline: Date,
    completedAt: Date,
    completionNotes: String,
    deliveryNotes: String,
    priority: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
      default: 'MEDIUM',
    },
    projectType: String,
    description: String,
    scopeOfWork: String,
    tags: [String],
    revision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);
schema.index({ clientRef: 1, createdAt: -1 });
schema.index({ lead: 1, createdAt: -1 });
schema.index({ assignedTo: 1, status: 1, createdAt: -1 });
schema.index({ primaryDepartment: 1, status: 1, deadline: 1 });
schema.index({ projectManager: 1, status: 1 });
schema.index({ 'teamMembers.employee': 1, archivedAt: 1 });
schema.index({ status: 1, deadline: 1 });
export const Project = mongoose.model('Project', schema);
