import mongoose from 'mongoose';
const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const milestone = new mongoose.Schema(
  {
    project: { ...ref('Project'), required: true },
    title: { type: String, required: true, maxlength: 180 },
    description: String,
    dueDate: Date,
    status: {
      type: String,
      enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'],
      default: 'PENDING',
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    completedAt: Date,
    createdBy: ref('User'),
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);
milestone.index({ project: 1, dueDate: 1 });
export const ProjectMilestone = mongoose.model('ProjectMilestone', milestone);
const note = new mongoose.Schema(
  {
    project: { ...ref('Project'), required: true },
    author: { ...ref('User'), required: true },
    content: { type: String, required: true, maxlength: 5000 },
  },
  { timestamps: true },
);
note.index({ project: 1, createdAt: -1 });
export const ProjectNote = mongoose.model('ProjectNote', note);
const file = new mongoose.Schema(
  {
    project: { ...ref('Project'), required: true },
    fileName: String,
    storedName: { type: String, select: false },
    mime: String,
    size: Number,
    category: String,
    uploadedBy: ref('User'),
  },
  { timestamps: true },
);
file.index({ project: 1, createdAt: -1 });
export const ProjectFile = mongoose.model('ProjectFile', file);
