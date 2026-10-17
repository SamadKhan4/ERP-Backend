import mongoose from 'mongoose';
const ref = {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User',
  required: true,
};
const saved = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    reportKey: { type: String, required: true },
    owner: ref,
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    columns: [String],
    sort: mongoose.Schema.Types.Mixed,
    chart: { type: String, default: 'bar' },
    scope: String,
    visibility: {
      type: String,
      enum: ['PRIVATE', 'TEAM', 'DEPARTMENT', 'GLOBAL'],
      default: 'PRIVATE',
    },
    department: String,
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
saved.index({ owner: 1, createdAt: -1 });
saved.index({ visibility: 1, department: 1 });
export const SavedReport = mongoose.model('SavedReport', saved);
const schedule = new mongoose.Schema(
  {
    name: { type: String, required: true },
    reportKey: { type: String, required: true },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    format: { type: String, enum: ['csv', 'xlsx', 'pdf'], required: true },
    frequency: {
      type: String,
      enum: ['DAILY', 'WEEKLY', 'MONTHLY'],
      required: true,
    },
    recipients: [String],
    nextRunAt: { type: Date, required: true },
    createdBy: ref,
    status: { type: String, enum: ['ACTIVE', 'PAUSED'], default: 'ACTIVE' },
    lockedUntil: Date,
    lease: String,
    lastRunAt: Date,
    lastError: String,
  },
  { timestamps: true },
);
schedule.index({ status: 1, nextRunAt: 1, lockedUntil: 1 });
schedule.index({ createdBy: 1, createdAt: -1 });
export const ScheduledReport = mongoose.model('ScheduledReport', schedule);
const generation = new mongoose.Schema(
  {
    user: ref,
    reportKey: String,
    category: String,
    title: String,
    scope: String,
    format: String,
    status: {
      type: String,
      enum: ['GENERATED', 'SENT', 'FAILED'],
      default: 'GENERATED',
    },
    rows: Number,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
generation.index({ user: 1, createdAt: -1 });
generation.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });
export const ReportGenerationLog = mongoose.model(
  'ReportGenerationLog',
  generation,
);
