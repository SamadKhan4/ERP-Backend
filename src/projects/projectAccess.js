import { Client } from '../models/Client.js';
import mongoose from 'mongoose';
import { permissionsFor } from '../services/permissionService.js';
import { resolveReportScope } from '../reports/reportAccessService.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Department } from '../models/Department.js';
import { Project } from '../models/Project.js';
import { TeamTask } from '../models/TeamWork.js';
import { AppError } from '../utils/errors.js';
export const oid = (value) => {
  if (!mongoose.isValidObjectId(value))
    throw new AppError(400, 'Invalid record identifier');
  return new mongoose.Types.ObjectId(String(value));
};
export const canProject = (req, key) =>
  req.projectPermissions.includes('*') ||
  req.projectPermissions.includes(
    key.startsWith('projects.') ? key : `projects.${key}`,
  );
export const requireProject = (key) => (req, res, next) => {
  if (!canProject(req, key))
    throw new AppError(403, 'Project permission denied');
  next();
};
export async function projectAccess(req, res, next) {
  req.projectPermissions = await permissionsFor(req.user);
  if (!canProject(req, 'view'))
    throw new AppError(403, 'Project access denied');
  req.projectSearchClients = [];
  if (typeof req.query.search === 'string' && req.query.search) {
    const regex = req.query.search
      .slice(0, 100)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    req.projectSearchClients = await Client.distinct('_id', {
      companyName: { $regex: regex, $options: 'i' },
    });
  }
  req.projectScope = {};
  req.projectDepartments = [];
  if (!canProject(req, 'view_all')) {
    const own = {
      $or: [
        { createdBy: req.user._id },
        { projectManager: req.user._id },
        { assignedTo: req.user._id },
        {
          teamMembers: {
            $elemMatch: { employee: req.user._id, status: 'ACTIVE' },
          },
        },
        {
          _id: {
            $in: await TeamTask.distinct('project', {
              assignedTo: req.user._id,
              deletedAt: null,
            }),
          },
        },
      ],
    };
    let scope = own;
    if (canProject(req, 'view_department')) {
      const profile = await EmployeeProfile.findOne({ user: req.user._id })
        .select('departmentId')
        .lean();
      const headed = await Department.distinct('_id', {
        $or: [
          { departmentHead: req.user._id },
          { reportingManager: req.user._id },
        ],
      });
      req.projectDepartments = [
        ...headed,
        ...(profile?.departmentId
          ? [profile.departmentId]
          : req.user.departmentId
            ? [req.user.departmentId]
            : []),
      ];
      scope = {
        $or: [
          own,
          { primaryDepartment: { $in: req.projectDepartments } },
          { collaboratingDepartments: { $in: req.projectDepartments } },
        ],
      };
    } else if (canProject(req, 'view_team')) {
      const result = await resolveReportScope(
        { user: req.user, reportPermissions: ['reports.projects.team'] },
        { category: 'projects' },
      );
      scope = {
        $or: [
          own,
          { projectManager: { $in: result.ids } },
          { assignedTo: { $in: result.ids } },
          {
            teamMembers: {
              $elemMatch: { employee: { $in: result.ids }, status: 'ACTIVE' },
            },
          },
        ],
      };
    }
    req.projectScope = scope;
  }
  next();
}
export async function findProject(req, id, session) {
  const row = await Project.findOne({
    $and: [{ _id: oid(id) }, req.projectScope],
  }).session(session || null);
  if (!row) throw new AppError(404, 'Project not found or access denied');
  return row;
}
export function assertOpen(row) {
  if (
    row.archivedAt ||
    ['COMPLETED', 'CANCELLED', 'Completed', 'Cancelled'].includes(row.status)
  )
    throw new AppError(409, 'Project is closed; reopen before making changes');
}
