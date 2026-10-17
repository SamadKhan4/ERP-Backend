import { financeAccess, financeScope } from '../finance/financeAccess.js';
import { z } from 'zod';
import { Project } from '../models/Project.js';
import { TeamTask } from '../models/TeamWork.js';
import {
  ProjectMilestone,
  ProjectNote,
  ProjectFile,
} from '../models/ProjectWork.js';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { Department } from '../models/Department.js';
import { Client } from '../models/Client.js';
import { Quotation, quotationServices } from '../models/Quotation.js';
import { Lead } from '../models/Lead.js';
import { AuditLog } from '../models/AuditLog.js';
import { Invoice } from '../models/Invoice.js';
import { FinancePayment, FinanceExpense } from '../models/Finance.js';
import { Role } from '../models/Role.js';
import { AppError } from '../utils/errors.js';
import {
  storeDocument,
  readDocument,
  cleanupDocument,
  documentMime,
} from '../services/documentStorageService.js';
import { renderReportExport } from '../reports/reportExportService.js';
import { oid, canProject, findProject, assertOpen } from './projectAccess.js';
import { projectPermissions, normalizeStatus } from './projectPermissions.js';
import {
  projectSchema,
  teamSchema,
  taskSchema,
  milestoneSchema,
  listSchema,
} from './projectValidator.js';
import {
  transaction,
  number,
  event,
  notify,
  memberIds,
  validateProject,
  projectStages,
  presentProjects,
  indiaDay,
} from './projectService.js';
const ok = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });
const paginate = (items, total, q) => ({
  items,
  pagination: {
    page: q.page,
    limit: q.limit,
    total,
    totalPages: Math.ceil(total / q.limit),
  },
});
const query = (req) => listSchema.parse(req.query);
async function lock(req, session, { closed = false } = {}) {
  const row = await findProject(req, req.params.id, session);
  if (!closed) assertOpen(row);
  await Project.updateOne(
    { _id: row._id },
    { $inc: { revision: 1 } },
    { session },
  );
  return row;
}
export async function metadata(req, res) {
  const q = z
    .object({
      search: z.string().trim().max(100).default(''),
      client: z
        .string()
        .regex(/^[a-f\d]{24}$/i)
        .optional(),
    })
    .strict()
    .parse(req.query);
  const regex = q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [departments, users, clients, quotes, leads] = await Promise.all([
    Department.find({ status: 'ACTIVE' })
      .select('name code')
      .sort({ name: 1 })
      .limit(200)
      .lean(),
    canProject(req, 'create') ||
    canProject(req, 'manage_team') ||
    canProject(req, 'tasks.assign')
      ? User.find({
          active: true,
          role: { $ne: 'customer' },
          ...(q.search ? { name: { $regex: regex, $options: 'i' } } : {}),
        })
          .select('name email department')
          .limit(100)
          .lean()
      : [],
    canProject(req, 'create') || canProject(req, 'edit')
      ? Client.find(
          q.search ? { companyName: { $regex: regex, $options: 'i' } } : {},
        )
          .select('companyName clientId originatingLead')
          .limit(50)
          .lean()
      : [],
    canProject(req, 'create') || canProject(req, 'edit')
      ? Quotation.find({
          status: 'Accepted',
          deletedAt: null,
          ...(q.client ? { clientRef: q.client } : {}),
        })
          .select('quotationNumber clientRef lead service')
          .sort({ createdAt: -1 })
          .limit(100)
          .lean()
      : [],
    canProject(req, 'create') || canProject(req, 'edit')
      ? Lead.find(
          q.search ? { companyName: { $regex: regex, $options: 'i' } } : {},
        )
          .select('leadId companyName')
          .limit(50)
          .lean()
      : [],
  ]);
  ok(res, {
    currentUserId: req.user.id,
    permissions: req.projectPermissions,
    scope: canProject(req, 'view_all')
      ? 'ALL'
      : canProject(req, 'view_department')
        ? 'DEPARTMENT'
        : canProject(req, 'view_team')
          ? 'TEAM'
          : 'ASSIGNED',
    departments,
    users,
    clients,
    quotations: quotes,
    leads,
    services: quotationServices,
  });
}
export async function list(req, res) {
  const q = query(req);
  const [result] = await Project.aggregate([
    ...projectStages(req, q),
    {
      $facet: {
        items: [
          { $sort: { [q.sort]: q.order === 'asc' ? 1 : -1, _id: 1 } },
          { $skip: (q.page - 1) * q.limit },
          { $limit: q.limit },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const rows = await Project.populate(result.items, [
    { path: 'clientRef', select: 'companyName clientId' },
    { path: 'primaryDepartment', select: 'name' },
    { path: 'projectManager', select: 'name' },
    { path: 'assignedTo', select: 'name' },
    { path: 'teamMembers.employee', select: 'name' },
  ]);
  ok(
    res,
    paginate(await presentProjects(rows, req), result.total[0]?.count || 0, q),
  );
}
export async function dashboard(req, res) {
  const q = query(req);
  delete q.status;
  const stages = projectStages(req, q);
  const today = indiaDay();
  const [result] = await Project.aggregate([
    ...stages,
    {
      $facet: {
        status: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        departments: [
          { $group: { _id: '$primaryDepartment', count: { $sum: 1 } } },
          {
            $lookup: {
              from: 'departments',
              localField: '_id',
              foreignField: '_id',
              as: 'department',
            },
          },
          {
            $project: {
              name: {
                $ifNull: [{ $first: '$department.name' }, 'Unallocated'],
              },
              count: 1,
            },
          },
          { $sort: { count: -1 } },
          { $limit: 12 },
        ],
        monthly: [
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m',
                  date: '$createdAt',
                  timezone: 'Asia/Kolkata',
                },
              },
              created: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 6 },
        ],
        completedMonthly: [
          { $match: { completedAt: { $ne: null } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m',
                  date: '$completedAt',
                  timezone: 'Asia/Kolkata',
                },
              },
              completed: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 6 },
        ],
        delayed: [{ $match: { delayed: true } }, { $count: 'count' }],
        nearDeadline: [
          {
            $match: {
              deadline: { $gte: today, $lt: new Date(+today + 7 * 86400000) },
              status: { $nin: ['COMPLETED', 'CANCELLED'] },
            },
          },
          { $sort: { deadline: 1 } },
          { $limit: 6 },
        ],
        recentlyCompleted: [
          { $match: { status: 'COMPLETED' } },
          { $sort: { completedAt: -1 } },
          { $limit: 5 },
        ],
        timeline: [
          { $match: { status: { $nin: ['COMPLETED', 'CANCELLED'] } } },
          {
            $group: {
              _id: {
                $switch: {
                  branches: [
                    { case: '$delayed', then: 'Overdue' },
                    {
                      case: {
                        $lte: ['$deadline', new Date(+today + 7 * 86400000)],
                      },
                      then: 'Due within 7 days',
                    },
                    {
                      case: {
                        $lte: ['$deadline', new Date(+today + 30 * 86400000)],
                      },
                      then: 'Due within 30 days',
                    },
                  ],
                  default: 'Later / unscheduled',
                },
              },
              count: { $sum: 1 },
            },
          },
        ],
        workload: [
          { $unwind: '$teamMembers' },
          { $match: { 'teamMembers.status': 'ACTIVE' } },
          {
            $group: {
              _id: '$teamMembers.employee',
              projects: { $sum: 1 },
              allocation: { $sum: '$teamMembers.allocationPercentage' },
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'employee',
            },
          },
          {
            $project: {
              name: { $first: '$employee.name' },
              projects: 1,
              allocation: 1,
            },
          },
          { $sort: { allocation: -1 } },
          { $limit: 10 },
        ],
      },
    },
  ]);
  result.total = result.status.reduce((sum, r) => sum + r.count, 0);
  result.delayedCount = result.delayed[0]?.count || 0;
  result.nearDeadline = await presentProjects(result.nearDeadline, req);
  result.recentlyCompleted = await presentProjects(
    result.recentlyCompleted,
    req,
  );
  ok(res, result);
}
export async function create(req, res) {
  const input = projectSchema.parse(req.body);
  const row = await transaction(async (session) => {
    await validateProject(req, input, session);
    const fields = { ...input };
    delete fields.revision;
    const [row] = await Project.create(
      [
        {
          ...fields,
          status: 'UPCOMING',
          projectId: await number('PRJ', session),
          assignedTo: input.projectManager,
          createdBy: req.user._id,
          updatedBy: req.user._id,
        },
      ],
      { session },
    );
    await event(req, row, 'PROJECT_CREATED', {}, session);
    await notify(
      req,
      row,
      'assigned',
      'Project assigned',
      [row.projectManager],
      session,
    );
    return row;
  });
  ok(res, (await presentProjects([row], req))[0], 201);
}
export async function detail(req, res) {
  const row = await findProject(req, req.params.id);
  await row.populate([
    { path: 'clientRef', select: 'companyName clientId' },
    { path: 'primaryDepartment collaboratingDepartments', select: 'name code' },
    { path: 'projectManager assignedTo', select: 'name email' },
    { path: 'teamMembers.employee', select: 'name email' },
    { path: 'lead', select: 'leadId leadSource assignedTo' },
    { path: 'quotation', select: 'quotationNumber services' },
  ]);
  const [milestones] = await ProjectMilestone.aggregate([
    { $match: { project: row._id } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        completed: {
          $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
        },
      },
    },
  ]);
  ok(res, {
    ...(await presentProjects([row], req))[0],
    milestoneSummary: milestones || { total: 0, completed: 0 },
  });
}
export async function update(req, res) {
  const input = projectSchema.parse(req.body);
  const row = await transaction(async (session) => {
    const row = await lock(req, session);
    if (input.revision !== row.revision)
      throw new AppError(409, 'Project changed; refresh before saving');
    if (
      row.clientRef &&
      String(row.clientRef) !== String(input.clientRef || '')
    )
      throw new AppError(
        409,
        'Project client cannot change; create a new project to retain billing history',
      );
    await validateProject(req, input, session, row);
    const before = {
      title: row.title,
      manager: row.projectManager,
      department: row.primaryDepartment,
    };
    const fields = { ...input };
    delete fields.revision;
    row.set({
      ...fields,
      assignedTo: input.projectManager,
      updatedBy: req.user._id,
      revision: row.revision + 1,
    });
    await row.save({ session });
    await event(
      req,
      row,
      'PROJECT_UPDATED',
      {
        before,
        after: {
          title: row.title,
          manager: row.projectManager,
          department: row.primaryDepartment,
        },
      },
      session,
    );
    if (String(before.manager) !== String(row.projectManager)) {
      await event(req, row, 'MANAGER_ASSIGNED', {}, session);
      await notify(
        req,
        row,
        'assigned',
        'Project manager assigned',
        [row.projectManager],
        session,
      );
    }
    if (String(before.department) !== String(row.primaryDepartment))
      await event(req, row, 'DEPARTMENT_CHANGED', {}, session);
    return row;
  });
  ok(res, (await presentProjects([row], req))[0]);
}
const transitions = {
  UPCOMING: ['PLANNING', 'ONGOING', 'CANCELLED'],
  PLANNING: ['ONGOING', 'ON_HOLD', 'CANCELLED'],
  ONGOING: ['ON_HOLD', 'REVIEW', 'CANCELLED'],
  ON_HOLD: ['PLANNING', 'ONGOING', 'CANCELLED'],
  REVIEW: ['ONGOING', 'COMPLETED', 'ON_HOLD', 'CANCELLED'],
  COMPLETED: ['ONGOING'],
  CANCELLED: ['PLANNING', 'ONGOING'],
};
export async function status(req, res) {
  const input = z
    .object({
      status: z.enum([
        'UPCOMING',
        'PLANNING',
        'ONGOING',
        'ON_HOLD',
        'REVIEW',
        'COMPLETED',
        'CANCELLED',
      ]),
      revision: z.number().int().min(0),
      completionNotes: z.string().trim().max(3000).default(''),
      deliveryNotes: z.string().trim().max(3000).default(''),
    })
    .strict()
    .parse({
      ...req.body,
      ...(req.params.action === 'start'
        ? { status: 'ONGOING' }
        : req.params.action === 'complete'
          ? { status: 'COMPLETED' }
          : req.params.action === 'reopen'
            ? { status: 'ONGOING' }
            : {}),
    });
  const result = await transaction(async (session) => {
    const row = await lock(req, session, { closed: true });
    if (row.archivedAt)
      throw new AppError(409, 'Archived projects cannot change status');
    if (row.revision !== input.revision)
      throw new AppError(409, 'Project changed; refresh');
    const old = normalizeStatus(row.status);
    const permission = ['COMPLETED', 'CANCELLED'].includes(old)
      ? 'reopen'
      : input.status === 'COMPLETED'
        ? 'complete'
        : 'change_status';
    if (!canProject(req, permission))
      throw new AppError(403, 'Status operation permission denied');
    if (!transitions[old]?.includes(input.status))
      throw new AppError(409, 'Invalid project lifecycle transition');
    if (input.status === 'COMPLETED') {
      if (
        (await TeamTask.exists({
          project: row._id,
          deletedAt: null,
          status: { $ne: 'DONE' },
        }).session(session)) ||
        (await ProjectMilestone.exists({
          project: row._id,
          status: { $ne: 'COMPLETED' },
        }).session(session))
      )
        throw new AppError(
          409,
          'Complete all tasks and milestones before closing project',
        );
      row.completedAt = new Date();
      row.completionNotes = input.completionNotes;
      row.deliveryNotes = input.deliveryNotes;
    } else if (['COMPLETED', 'CANCELLED'].includes(old))
      row.completedAt = undefined;
    if (input.status === 'ONGOING' && !row.startDate)
      row.startDate = new Date();
    row.status = input.status;
    row.revision++;
    row.updatedBy = req.user._id;
    await row.save({ session });
    const type =
      input.status === 'COMPLETED'
        ? 'PROJECT_COMPLETED'
        : ['COMPLETED', 'CANCELLED'].includes(old)
          ? 'PROJECT_REOPENED'
          : input.status === 'ONGOING'
            ? 'PROJECT_STARTED'
            : 'STATUS_CHANGED';
    await event(req, row, type, { before: old, after: input.status }, session);
    await notify(
      req,
      row,
      'status',
      `Project ${input.status.toLowerCase().replaceAll('_', ' ')}`,
      memberIds(row),
      session,
    );
    return row;
  });
  ok(res, (await presentProjects([result], req))[0]);
}
export async function archive(req, res) {
  await transaction(async (session) => {
    const row = await lock(req, session, { closed: true });
    row.archivedAt = new Date();
    row.revision++;
    await row.save({ session });
    await event(req, row, 'PROJECT_ARCHIVED', {}, session);
  });
  ok(res, { archived: true });
}
export async function team(req, res) {
  const row = await findProject(req, req.params.id);
  await row.populate('teamMembers.employee', 'name email');
  const profiles = await EmployeeProfile.find({
    user: { $in: row.teamMembers.map((m) => m.employee?._id) },
  })
    .select('user department designation')
    .lean();
  const tasks = await TeamTask.aggregate([
    { $match: { project: row._id, deletedAt: null } },
    {
      $group: {
        _id: '$assignedTo',
        total: { $sum: 1 },
        done: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } },
      },
    },
  ]);
  ok(res, {
    items: row.teamMembers.map((member) => ({
      ...member.toObject(),
      profile: profiles.find(
        (p) => String(p.user) === String(member.employee?._id),
      ),
      tasks: tasks.find(
        (t) => String(t._id) === String(member.employee?._id),
      ) || { total: 0, done: 0 },
    })),
  });
}
export async function saveMember(req, res) {
  const input = req.method === 'DELETE' ? null : teamSchema.parse(req.body);
  await transaction(async (session) => {
    const row = await lock(req, session);
    let member = req.params.memberId
      ? row.teamMembers.id(oid(req.params.memberId))
      : null;
    if (req.params.memberId && !member)
      throw new AppError(404, 'Member not found');
    if (input) {
      if (
        !(await User.exists({
          _id: input.employee,
          active: true,
          role: { $ne: 'customer' },
        }).session(session)) ||
        !(await EmployeeProfile.exists({ user: input.employee }).session(
          session,
        ))
      )
        throw new AppError(400, 'Choose an active employee');
      if (
        row.teamMembers.some(
          (m) =>
            m.status === 'ACTIVE' &&
            String(m.employee) === input.employee &&
            String(m._id) !== String(member?._id),
        )
      )
        throw new AppError(409, 'Employee already assigned');
      if (member && String(member.employee) !== input.employee)
        throw new AppError(
          400,
          'Remove member before assigning another employee',
        );
      if (member) member.set(input);
      else
        row.teamMembers.push({
          ...input,
          assignedAt: new Date(),
          status: 'ACTIVE',
        });
    } else {
      if (
        await TeamTask.exists({
          project: row._id,
          assignedTo: member.employee,
          deletedAt: null,
          status: { $ne: 'DONE' },
        }).session(session)
      )
        throw new AppError(
          409,
          'Reassign unfinished tasks before removing this member',
        );
      member.status = 'REMOVED';
      member.removedAt = new Date();
    }
    row.revision++;
    await row.save({ session });
    await event(
      req,
      row,
      input ? 'MEMBER_ADDED' : 'MEMBER_REMOVED',
      { employee: input?.employee || member.employee },
      session,
    );
    if (input)
      await notify(
        req,
        row,
        'team',
        'Added to project team',
        [input.employee],
        session,
      );
  });
  ok(res, { saved: true });
}
export async function tasks(req, res) {
  const row = await findProject(req, req.params.id),
    q = query(req);
  const filter = {
    project: row._id,
    deletedAt: null,
    ...(!canProject(req, 'tasks.edit') && !canProject(req, 'tasks.assign')
      ? { assignedTo: req.user._id }
      : {}),
    ...(q.search
      ? {
          title: {
            $regex: q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i',
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    TeamTask.find(filter)
      .populate('assignedTo', 'name')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    TeamTask.countDocuments(filter),
  ]);
  ok(
    res,
    paginate(
      items.map((t) => ({
        ...t,
        status:
          t.status === 'DONE'
            ? 'COMPLETED'
            : t.status === 'BACKLOG'
              ? 'TODO'
              : t.status,
      })),
      total,
      q,
    ),
  );
}
export async function saveTask(req, res) {
  const input = taskSchema.parse(req.body);
  const row = await transaction(async (session) => {
    const project = await lock(req, session);
    let task = req.params.taskId
      ? await TeamTask.findOne({
          _id: oid(req.params.taskId),
          project: project._id,
          deletedAt: null,
        }).session(session)
      : null;
    if (req.params.taskId && !task) throw new AppError(404, 'Task not found');
    if (task && task.version !== input.version)
      throw new AppError(409, 'Task changed; refresh');
    const managed = canProject(req, 'tasks.edit');
    if (task?.sprint)
      throw new AppError(
        409,
        'Manage sprint tasks through Team Workspace to preserve sprint history',
      );
    if (task && !managed) {
      if (String(task.assignedTo) !== String(req.user._id))
        throw new AppError(403, 'Only your assigned task can be updated');
      const target = input.status === 'COMPLETED' ? 'DONE' : input.status;
      const fields = ['title', 'description', 'priority', 'estimatedHours'];
      if (
        fields.some((k) => String(input[k] ?? '') !== String(task[k] ?? '')) ||
        String(input.assignedTo || '') !== String(task.assignedTo || '')
      )
        throw new AppError(
          403,
          'Employees can update only their task status and hours',
        );
      if (target === 'DONE' && !canProject(req, 'tasks.complete'))
        throw new AppError(403, 'Task completion permission required');
      task.status = target;
      task.actualHours = input.actualHours;
    } else {
      if (
        input.assignedTo &&
        !(await User.exists({ _id: input.assignedTo, active: true }).session(
          session,
        ))
      )
        throw new AppError(400, 'Task assignee is inactive');
      if (
        input.assignedTo &&
        !memberIds(project).map(String).includes(input.assignedTo)
      )
        throw new AppError(
          400,
          'Task assignee must be an active project member or manager',
        );
      if (
        String(task?.assignedTo || '') !== String(input.assignedTo || '') &&
        !canProject(req, 'tasks.assign')
      )
        throw new AppError(403, 'Task assignment permission required');
      const fields = {
        ...input,
        status: input.status === 'COMPLETED' ? 'DONE' : input.status,
      };
      delete fields.version;
      if (
        fields.dueDate &&
        fields.startDate &&
        fields.dueDate < fields.startDate
      )
        throw new AppError(400, 'Task due date precedes start');
      if (input.dependsOn.length) {
        if (task && input.dependsOn.includes(String(task._id)))
          throw new AppError(400, 'Task cannot depend on itself');
        if (
          (await TeamTask.countDocuments({
            _id: { $in: input.dependsOn },
            project: project._id,
            deletedAt: null,
          }).session(session)) !== input.dependsOn.length
        )
          throw new AppError(400, 'Dependencies must belong to this project');
        if (task) {
          const graph = await TeamTask.aggregate([
            { $match: { _id: { $in: input.dependsOn.map(oid) } } },
            {
              $graphLookup: {
                from: 'teamtasks',
                startWith: '$dependsOn',
                connectFromField: 'dependsOn',
                connectToField: '_id',
                as: 'ancestors',
                maxDepth: 100,
              },
            },
            { $match: { 'ancestors._id': task._id } },
          ]).session(session);
          if (graph.length) throw new AppError(400, 'Circular task dependency');
        }
      }
      if (task) task.set(fields);
      else
        task = new TeamTask({
          ...fields,
          taskId: await number('TASK', session),
          leader: project.projectManager || project.assignedTo,
          project: project._id,
          client: project.clientRef,
          department: project.primaryDepartment,
          createdBy: req.user._id,
        });
    }
    if (
      task.status === 'DONE' &&
      (await TeamTask.exists({
        _id: { $in: task.dependsOn },
        status: { $ne: 'DONE' },
        deletedAt: null,
      }).session(session))
    )
      throw new AppError(409, 'Complete dependencies first');
    task.completedAt =
      task.status === 'DONE' ? task.completedAt || new Date() : undefined;
    task.version++;
    await task.save({ session });
    await event(
      req,
      project,
      task.status === 'DONE'
        ? 'TASK_COMPLETED'
        : req.params.taskId
          ? 'TASK_UPDATED'
          : 'TASK_CREATED',
      { task: task._id, title: task.title },
      session,
    );
    await notify(
      req,
      project,
      'task',
      'Project task assigned',
      [task.assignedTo],
      session,
    );
    return task;
  });
  ok(res, row, req.params.taskId ? 200 : 201);
}
export async function milestones(req, res) {
  const row = await findProject(req, req.params.id),
    q = query(req);
  const filter = { project: row._id };
  const [items, total] = await Promise.all([
    ProjectMilestone.find(filter)
      .sort({ dueDate: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ProjectMilestone.countDocuments(filter),
  ]);
  ok(
    res,
    paginate(
      items.map((m) => ({
        ...m,
        displayStatus:
          m.status !== 'COMPLETED' && m.dueDate < indiaDay()
            ? 'DELAYED'
            : m.status,
      })),
      total,
      q,
    ),
  );
}
export async function saveMilestone(req, res) {
  const input = milestoneSchema.parse(req.body);
  const result = await transaction(async (session) => {
    const project = await lock(req, session);
    const fields = {
      ...input,
      progress:
        input.status === 'COMPLETED' ? 100 : Math.min(99, input.progress),
      completedAt: input.status === 'COMPLETED' ? new Date() : null,
    };
    delete fields.revision;
    let row;
    if (req.params.milestoneId)
      row = await ProjectMilestone.findOneAndUpdate(
        {
          _id: oid(req.params.milestoneId),
          project: project._id,
          revision: input.revision,
        },
        { $set: fields, $inc: { revision: 1 } },
        { new: true, session },
      );
    else
      [row] = await ProjectMilestone.create(
        [{ ...fields, project: project._id, createdBy: req.user._id }],
        { session },
      );
    if (!row) throw new AppError(409, 'Milestone changed; refresh');
    await event(
      req,
      project,
      input.status === 'COMPLETED'
        ? 'MILESTONE_COMPLETED'
        : 'MILESTONE_CREATED',
      { title: row.title },
      session,
    );
    return row;
  });
  ok(res, result);
}
export async function activity(req, res) {
  const row = await findProject(req, req.params.id),
    q = query(req);
  const filter = { entityType: 'project', entityId: row._id };
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .select('user action details createdAt')
      .populate('user', 'name')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  ok(res, paginate(items, total, q));
}
export async function notes(req, res) {
  const row = await findProject(req, req.params.id),
    q = query(req);
  const filter = { project: row._id };
  const [items, total] = await Promise.all([
    ProjectNote.find(filter)
      .populate('author', 'name')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ProjectNote.countDocuments(filter),
  ]);
  ok(res, paginate(items, total, q));
}
export async function addNote(req, res) {
  const { content } = z
    .object({ content: z.string().trim().min(1).max(5000) })
    .strict()
    .parse(req.body);
  const row = await transaction(async (session) => {
    const project = await lock(req, session);
    const [note] = await ProjectNote.create(
      [{ project: project._id, author: req.user._id, content }],
      { session },
    );
    await event(req, project, 'NOTE_ADDED', {}, session);
    return note;
  });
  ok(res, row, 201);
}
export async function files(req, res) {
  const row = await findProject(req, req.params.id),
    q = query(req);
  const filter = { project: row._id };
  const [items, total] = await Promise.all([
    ProjectFile.find(filter)
      .populate('uploadedBy', 'name')
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean(),
    ProjectFile.countDocuments(filter),
  ]);
  ok(res, paginate(items, total, q));
}
export async function upload(req, res) {
  if (!req.file) throw new AppError(400, 'Choose a PDF or image');
  const { category } = z
    .object({
      category: z
        .enum([
          'Requirements',
          'Brief',
          'Designs',
          'Documents',
          'Deliverables',
          'Client Files',
          'Internal Files',
          'Other',
        ])
        .default('Other'),
    })
    .strict()
    .parse(req.body);
  await findProject(req, req.params.id);
  const storedName = await storeDocument('crm', req.file.buffer);
  try {
    const row = await transaction(async (session) => {
      const project = await lock(req, session);
      const [file] = await ProjectFile.create(
        [
          {
            project: project._id,
            fileName: req.file.originalname.slice(0, 180),
            storedName,
            mime: documentMime(req.file.buffer),
            size: req.file.size,
            category,
            uploadedBy: req.user._id,
          },
        ],
        { session },
      );
      await event(
        req,
        project,
        'FILE_UPLOADED',
        { file: file._id, name: file.fileName },
        session,
      );
      return file;
    });
    ok(res, { _id: row._id, fileName: row.fileName }, 201);
  } catch (error) {
    await cleanupDocument('crm', storedName);
    throw error;
  }
}
export async function download(req, res) {
  const project = await findProject(req, req.params.id);
  const file = await ProjectFile.findOne({
    _id: oid(req.params.fileId),
    project: project._id,
  }).select('+storedName');
  if (!file) throw new AppError(404, 'File not found');
  res
    .type(file.mime)
    .attachment(file.fileName)
    .send(await readDocument('crm', file.storedName));
}
export async function financials(req, res) {
  await financeAccess(req, res, () => {});
  const project = await findProject(req, req.params.id);
  const p = req.projectPermissions;
  const has = (key) => p.includes('*') || p.includes(key);
  if (!has('finance.invoices.view'))
    throw new AppError(403, 'Finance invoice permission required');
  const invoices = await Invoice.find({
    $and: [
      financeScope(req, 'invoices'),
      { project: project._id, deletedAt: null },
    ],
  })
    .select('invoiceNumber status grandTotal totalMinor paidMinor currency')
    .limit(1001)
    .lean();
  if (invoices.length > 1000)
    throw new AppError(
      422,
      'Use Finance reports to review more than 1000 project invoices',
    );
  if (invoices.some((i) => i.currency && i.currency !== 'INR'))
    throw new AppError(409, 'Mixed currency summary is unavailable');
  const issued = invoices.filter(
    (i) => !['Draft', 'Cancelled'].includes(i.status),
  );
  const billed = issued.reduce(
    (sum, r) => sum + (r.totalMinor ?? Math.round(r.grandTotal * 100)),
    0,
  );
  const outstanding = issued.reduce(
    (sum, r) =>
      sum +
      Math.max(
        0,
        (r.totalMinor ?? Math.round(r.grandTotal * 100)) -
          (r.paidMinor ??
            (r.status === 'Paid' ? Math.round(r.grandTotal * 100) : 0)),
      ),
    0,
  );
  let collected = null,
    directExpenses = null;
  if (has('finance.payments.view')) {
    const [total] = await FinancePayment.aggregate([
      {
        $match: {
          invoice: { $in: invoices.map((i) => i._id) },
          status: 'POSTED',
        },
      },
      { $group: { _id: null, amount: { $sum: '$amountMinor' } } },
    ]);
    collected = total?.amount || 0;
  }
  if (has('finance.expenses.view')) {
    const [total] = await FinanceExpense.aggregate([
      {
        $match: {
          $and: [
            financeScope(req, 'expenses'),
            { project: project._id, status: { $in: ['APPROVED', 'PAID'] } },
          ],
        },
      },
      {
        $group: {
          _id: null,
          amount: { $sum: '$amountMinor' },
          count: { $sum: 1 },
        },
      },
    ]);
    directExpenses = total?.count ? total.amount : null;
  }
  const quote =
    project.quotation && has('quotations.read')
      ? await Quotation.findById(project.quotation)
          .select('quotationNumber grandTotal')
          .lean()
      : null;
  ok(res, {
    budget: project.amount,
    currency: project.currency,
    billedMinor: billed,
    collectedMinor: collected,
    outstandingMinor: outstanding,
    directExpensesMinor: directExpenses,
    contributionMinor: null,
    costCoverage:
      directExpenses === null
        ? 'No recorded project costs'
        : 'Direct recorded costs only; complete cost coverage is not confirmed',
    quotation: quote,
    invoices,
  });
}
const reportKeys = [
  'summary',
  'status',
  'upcoming',
  'ongoing',
  'completed',
  'delayed',
  'department',
  'manager',
  'team',
  'tasks',
  'milestones',
  'deadline',
  'profitability',
];
export async function report(req, res) {
  const key = req.params.reportKey;
  if (!reportKeys.includes(key))
    throw new AppError(404, 'Unknown project report');
  const { format, ...raw } = req.query;
  const q = listSchema.parse(raw);
  if (format && !canProject(req, 'reports.export'))
    throw new AppError(403, 'Project report export denied');
  if (key === 'profitability') {
    if (
      !canProject(req, 'financials.view') ||
      !req.projectPermissions.some(
        (p) => p === '*' || p === 'finance.profitability.view',
      )
    )
      throw new AppError(403, 'Profitability permission denied');
    await financeAccess(req, res, () => {});
    for (const key of ['finance.invoices.view', 'finance.expenses.view'])
      if (!req.projectPermissions.some((p) => p === '*' || p === key))
        throw new AppError(403, 'Finance source permission required');
  }
  if (['upcoming', 'ongoing', 'completed', 'delayed'].includes(key))
    q.status = key.toUpperCase();
  let rows, total;
  if (['department', 'manager', 'status'].includes(key)) {
    const field =
      key === 'department'
        ? 'primaryDepartment'
        : key === 'manager'
          ? 'projectManager'
          : 'status';
    const [result] = await Project.aggregate([
      ...projectStages(req, q),
      {
        $group: {
          _id: `$${field}`,
          projects: { $sum: 1 },
          completed: {
            $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
          },
          delayed: { $sum: { $cond: ['$delayed', 1, 0] } },
          ongoing: { $sum: { $cond: [{ $eq: ['$status', 'ONGOING'] }, 1, 0] } },
        },
      },
      ...(key === 'status'
        ? []
        : [
            {
              $lookup: {
                from: key === 'department' ? 'departments' : 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'person',
              },
            },
          ]),
      {
        $project: {
          name:
            key === 'status'
              ? '$_id'
              : { $ifNull: [{ $first: '$person.name' }, 'Unassigned'] },
          projects: 1,
          completed: 1,
          delayed: 1,
          ongoing: 1,
        },
      },
      { $sort: { projects: -1 } },
      {
        $facet: {
          items: [
            { $skip: format ? 0 : (q.page - 1) * q.limit },
            { $limit: format ? 5001 : q.limit },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    rows = result.items;
    total = result.total[0]?.count || 0;
  } else if (key === 'profitability') {
    const [result] = await Project.aggregate([
      ...projectStages(req, q),
      {
        $facet: {
          items: [
            { $sort: { createdAt: -1 } },
            { $skip: format ? 0 : (q.page - 1) * q.limit },
            { $limit: format ? 5001 : q.limit },
            {
              $lookup: {
                from: 'invoices',
                let: { project: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $and: [
                        financeScope(req, 'invoices'),
                        {
                          $expr: { $eq: ['$project', '$$project'] },
                          deletedAt: null,
                          status: { $nin: ['Draft', 'Cancelled'] },
                          currency: { $in: ['INR', null] },
                        },
                      ],
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      taxableMinor: {
                        $sum: {
                          $ifNull: [
                            '$taxableMinor',
                            { $round: [{ $multiply: ['$subtotal', 100] }, 0] },
                          ],
                        },
                      },
                    },
                  },
                ],
                as: 'billing',
              },
            },
            {
              $lookup: {
                from: 'financeexpenses',
                let: { project: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $and: [
                        financeScope(req, 'expenses'),
                        {
                          $expr: { $eq: ['$project', '$$project'] },
                          status: { $in: ['APPROVED', 'PAID'] },
                        },
                      ],
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      cost: { $sum: '$amountMinor' },
                      count: { $sum: 1 },
                    },
                  },
                ],
                as: 'costs',
              },
            },
            {
              $project: {
                projectId: 1,
                project: '$title',
                billedBeforeTaxMinor: {
                  $ifNull: [{ $first: '$billing.taxableMinor' }, 0],
                },
                directCostMinor: { $first: '$costs.cost' },
                directContributionMinor: {
                  $cond: [
                    { $gt: [{ $ifNull: [{ $first: '$costs.count' }, 0] }, 0] },
                    {
                      $subtract: [
                        { $ifNull: [{ $first: '$billing.taxableMinor' }, 0] },
                        { $first: '$costs.cost' },
                      ],
                    },
                    null,
                  ],
                },
                coverage: {
                  $cond: [
                    { $gt: [{ $ifNull: [{ $first: '$costs.count' }, 0] }, 0] },
                    'DIRECT_COST_ONLY',
                    'NO_RECORDED_COSTS',
                  ],
                },
                currency: { $literal: 'INR' },
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    rows = result.items;
    total = result.total[0]?.count || 0;
  } else if (['tasks', 'milestones', 'team'].includes(key)) {
    const base = projectStages(req, q);
    const collection =
      key === 'tasks'
        ? 'teamtasks'
        : key === 'milestones'
          ? 'projectmilestones'
          : null;
    const pipeline = collection
      ? [
          ...base,
          {
            $lookup: {
              from: collection,
              localField: '_id',
              foreignField: 'project',
              as: 'records',
            },
          },
          { $unwind: '$records' },
          ...(key === 'tasks'
            ? [{ $match: { 'records.deletedAt': null } }]
            : []),
          {
            $project: {
              projectId: 1,
              project: '$title',
              title: '$records.title',
              status: '$records.status',
              dueDate: '$records.dueDate',
              assignedTo: '$records.assignedTo',
            },
          },
        ]
      : [
          ...base,
          { $unwind: '$teamMembers' },
          {
            $lookup: {
              from: 'users',
              localField: 'teamMembers.employee',
              foreignField: '_id',
              as: 'employee',
            },
          },
          {
            $project: {
              projectId: 1,
              project: '$title',
              employee: { $first: '$employee.name' },
              role: '$teamMembers.roleInProject',
              allocation: '$teamMembers.allocationPercentage',
              status: '$teamMembers.status',
            },
          },
        ];
    const [result] = await Project.aggregate([
      ...pipeline,
      {
        $facet: {
          items: [
            { $skip: format ? 0 : (q.page - 1) * q.limit },
            { $limit: format ? 5001 : q.limit },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    rows = result.items;
    total = result.total[0]?.count || 0;
  } else {
    const [result] = await Project.aggregate([
      ...projectStages(req, q),
      {
        $facet: {
          items: [
            { $sort: { deadline: 1 } },
            { $skip: format ? 0 : (q.page - 1) * q.limit },
            { $limit: format ? 5001 : q.limit },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    const populated = await Project.populate(result.items, [
      { path: 'primaryDepartment', select: 'name' },
      { path: 'projectManager', select: 'name' },
      { path: 'clientRef', select: 'companyName' },
    ]);
    rows = (await presentProjects(populated, req)).map((p) => ({
      projectId: p.projectId,
      project: p.title,
      client: p.clientRef?.companyName,
      department: p.primaryDepartment?.name,
      manager: p.projectManager?.name,
      status: p.status,
      deadline: p.deadline,
      progress: p.progress,
      health: p.health,
      daysOverdue: p.daysOverdue,
    }));
    total = result.total[0]?.count || 0;
  }
  if (!format) return ok(res, paginate(rows, total, q));
  if (!['csv', 'xlsx', 'pdf'].includes(format))
    throw new AppError(400, 'Invalid export format');
  if (total > (format === 'pdf' ? 1000 : 5000))
    throw new AppError(422, 'Narrow filters before exporting');
  const columns = Object.keys(rows[0] || { projectId: '' }).filter(
    (k) => k !== '_id',
  );
  const file = await renderReportExport(
    { report: { title: `Project ${key}`, columns }, rows },
    format,
  );
  await AuditLog.create({
    user: req.user._id,
    action: 'project.REPORT_EXPORTED',
    details: { key, total },
  });
  res.type(file.mime).attachment(`projects-${key}.${format}`).send(file.buffer);
}
export async function access(req, res) {
  ok(res, {
    permissions: projectPermissions,
    roles: await Role.find().select('name label projectPermissions').lean(),
  });
}
export async function saveAccess(req, res) {
  const { permissions } = z
    .object({
      permissions: z
        .array(z.enum(projectPermissions))
        .max(projectPermissions.length),
    })
    .strict()
    .parse(req.body);
  if (req.user.role !== 'super_admin')
    throw new AppError(
      403,
      'Only Super Admin can configure project role access',
    );
  if (req.params.role === 'super_admin')
    throw new AppError(403, 'Super Admin access cannot be overridden');
  const role = await Role.findOneAndUpdate(
    { name: req.params.role },
    { $set: { projectPermissions: permissions } },
    { new: true },
  );
  if (!role) throw new AppError(404, 'Role not found');
  await AuditLog.create({
    user: req.user._id,
    action: 'project.ACCESS_UPDATED',
    details: { role: role.name, permissions },
  });
  ok(res, role);
}
