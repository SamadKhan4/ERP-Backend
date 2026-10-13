import mongoose from 'mongoose';
import { roles } from '../constants/roles.js';
export { roles } from '../constants/roles.js';
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: roles, default: 'employee' },
    department: {
      type: String,
      trim: true,
      maxlength: 100,
      required() {
        return this.role === 'team_leader';
      },
    },
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    resetHash: { type: String, select: false },
    resetExpires: Date,
  },
  { timestamps: true },
);
schema.index({ department: 1, _id: -1 });
export const User = mongoose.model('User', schema);
