import mongoose from 'mongoose';
import { roles } from '../constants/roles.js';
export const Role = mongoose.model(
  'Role',
  new mongoose.Schema(
    {
      name: { type: String, enum: roles, unique: true, required: true },
      label: { type: String, required: true },
      permissions: [String],
      reportPermissions: { type: [String], default: undefined },
      projectPermissions: { type: [String], default: undefined },
      financePermissions: { type: [String], default: undefined },
    },
    { timestamps: true },
  ),
);
