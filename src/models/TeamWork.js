import mongoose from 'mongoose';
import { taskStatuses, taskPriorities } from '../../shared/team.js';
const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const sprint = new mongoose.Schema(
  {
    leader: { ...ref('User'), required: true },
    title: { type: String, required: true },
    goal: String,
    startDate: Date,
    endDate: Date,
    status: {
      type: String,
      enum: ['PLANNED', 'ACTIVE', 'COMPLETED'],
      default: 'PLANNED',
    },
    revision: { type: Number, default: 0 },
    committedPoints: { type: Number, default: 0 },
    completedPoints: { type: Number, default: 0 },
    completedAt: Date,
    retrospective: { wentWell: String, improve: String, actions: String },
    createdBy: ref('User'),
  },
  { timestamps: true },
);
sprint.index({ leader: 1, status: 1 });
sprint.index(
  { leader: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
);
export const TeamSprint = mongoose.model('TeamSprint', sprint);
const task = new mongoose.Schema(
  {
    leader: { ...ref('User'), required: true },
    taskId: { type: String, unique: true, required: true },
    title: { type: String, required: true },
    description: String,
    assignedTo: ref('User'),
    sprint: ref('TeamSprint'),
    project: ref('Project'),
    status: { type: String, enum: taskStatuses, default: 'BACKLOG' },
    priority: { type: String, enum: taskPriorities, default: 'MEDIUM' },
    points: { type: Number, min: 0, max: 100, default: 0 },
    dueDate: Date,
    blocker: String,
    acceptanceCriteria: String,
    completedAt: Date,
    createdBy: ref('User'),
    version: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
task.index({ leader: 1, deletedAt: 1, sprint: 1, status: 1 });
task.index({ assignedTo: 1, deletedAt: 1, dueDate: 1 });
export const TeamTask = mongoose.model('TeamTask', task);
const standup = new mongoose.Schema(
  {
    leader: { ...ref('User'), required: true },
    employee: { ...ref('User'), required: true },
    date: { type: String, required: true },
    yesterday: String,
    today: { type: String, required: true },
    blockers: String,
  },
  { timestamps: true },
);
standup.index({ leader: 1, employee: 1, date: 1 }, { unique: true });
export const TeamStandup = mongoose.model('TeamStandup', standup);
