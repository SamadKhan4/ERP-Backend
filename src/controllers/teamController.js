import { Project } from '../models/Project.js';
import { z } from 'zod';
import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { TeamTask, TeamSprint, TeamStandup } from '../models/TeamWork.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { AuditLog } from '../models/AuditLog.js';
import { Notification } from '../models/Notification.js';
import { taskStatuses, taskPriorities } from '../../shared/team.js';
import { objectId } from '../validators/crmValidator.js';
import { has, id } from '../services/crmAccessService.js';
import {
  resolveTeam,
  requireMyTeam,
  indiaDate,
} from '../services/teamAccessService.js';
import { transaction, numberFor } from '../services/crmTransactionService.js';
import { AppError } from '../utils/errors.js';
const text = (max) => z.string().trim().max(max);
const taskFields = {
  title: text(180).min(1),
  description: text(4000),
  assignedTo: objectId.nullable(),
  sprint: objectId.nullable(),
  status: z.enum(taskStatuses),
  priority: z.enum(taskPriorities),
  points: z.coerce.number().int().min(0).max(100),
  dueDate: z.coerce.date().nullable(),
  blocker: text(2000),
  acceptanceCriteria: text(3000),
};
const createTaskSchema = z.object(taskFields).strict();
const updateTaskSchema = z
  .object(
    Object.fromEntries(
      Object.entries(taskFields).map(([key, value]) => [key, value.optional()]),
    ),
  )
  .extend({ version: z.number().int().min(0) })
  .strict();
async function audit(req, action, entity, details, session) {
  await AuditLog.create(
    [
      {
        user: req.user._id,
        action: `team.${action}`,
        entityType: 'team',
        entityId: entity._id,
        details,
      },
    ],
    { session },
  );
}
export async function leaders(req, res) {
  const items = await User.find({
    role: 'team_leader',
    active: true,
    ...(!has(req.teamPermissions, 'team.members.manage')
      ? { _id: req.user._id }
      : {}),
  })
    .select('_id name department')
    .sort({ name: 1 })
    .limit(200)
    .lean();
  res.json({ success: true, data: { items } });
}
export async function workspace(req, res) {
  const team = await resolveTeam(req);
  const day = indiaDate();
  const start = new Date(`${day}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  const [
    sprints,
    summary,
    workload,
    standups,
    attendance,
    reports,
    activity,
    sprintProgress,
  ] = await Promise.all([
    TeamSprint.find({ leader: team.leader._id })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean(),
    TeamTask.aggregate([
      { $match: { leader: team.leader._id, deletedAt: null } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          points: { $sum: '$points' },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$status', 'DONE'] },
                    { $ne: ['$dueDate', null] },
                    { $lt: ['$dueDate', new Date()] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    TeamTask.aggregate([
      {
        $match: {
          leader: team.leader._id,
          deletedAt: null,
          status: { $ne: 'DONE' },
        },
      },
      {
        $group: {
          _id: '$assignedTo',
          tasks: { $sum: 1 },
          points: { $sum: '$points' },
          blocked: {
            $sum: { $cond: [{ $eq: ['$status', 'BLOCKED'] }, 1, 0] },
          },
        },
      },
    ]),
    TeamStandup.find({
      leader: team.leader._id,
      date: day,
      employee: { $in: team.ids },
    })
      .populate('employee', 'name')
      .lean(),
    HRMSRecord.find({
      module: 'attendance',
      employee: { $in: team.ids },
      deletedAt: null,
      'data.date': { $gte: start, $lt: end },
    })
      .select('employee data.checkIn data.checkOut data.minutesWorked status')
      .lean(),
    HRMSRecord.find({
      module: 'daily-reports',
      employee: { $in: team.ids },
      deletedAt: null,
      'data.date': { $gte: start, $lt: end },
    })
      .select('employee data.summary data.blockers data.completedTasks')
      .lean(),
    AuditLog.find({
      entityType: 'team',
      'details.leader': String(team.leader._id),
    })
      .select('action details createdAt user')
      .populate('user', 'name')
      .sort({ createdAt: -1 })
      .limit(25)
      .lean(),
    TeamTask.aggregate([
      {
        $match: {
          leader: team.leader._id,
          deletedAt: null,
          sprint: { $ne: null },
        },
      },
      {
        $group: {
          _id: { sprint: '$sprint', status: '$status' },
          tasks: { $sum: 1 },
          points: { $sum: '$points' },
        },
      },
    ]),
  ]);
  res.json({
    success: true,
    data: {
      leader: team.leader,
      members: team.members,
      sprints,
      summary,
      workload,
      standups,
      attendance,
      reports,
      activity,
      sprintProgress,
      date: day,
    },
  });
}
export async function listTasks(req, res) {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      search: text(100).default(''),
      status: z.enum(taskStatuses).optional(),
      assignedTo: objectId.optional(),
      sprint: z.union([objectId, z.literal('backlog')]).optional(),
    })
    .parse(req.query);
  const team = await resolveTeam(req);
  const filter = {
    leader: team.leader._id,
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.assignedTo ? { assignedTo: query.assignedTo } : {}),
    ...(query.sprint
      ? { sprint: query.sprint === 'backlog' ? null : query.sprint }
      : {}),
    ...(query.search
      ? {
          title: {
            $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i',
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    TeamTask.find(filter)
      .populate('assignedTo', 'name')
      .populate('sprint', 'title status')
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * 50)
      .limit(50)
      .lean(),
    TeamTask.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: query.page,
        total,
        totalPages: Math.ceil(total / 50),
      },
    },
  });
}
async function validateTask(team, input, session) {
  if (
    input.assignedTo &&
    !team.ids.some((value) => String(value) === String(input.assignedTo))
  )
    throw new AppError(403, 'Assign tasks only to active members of this team');
  if (
    input.sprint &&
    !(await TeamSprint.findOneAndUpdate(
      {
        _id: input.sprint,
        leader: team.leader._id,
        status: { $ne: 'COMPLETED' },
      },
      { $inc: { revision: 1 } },
      { session },
    ))
  )
    throw new AppError(400, 'Select an open sprint in this team');
  if (input.status === 'BLOCKED' && !input.blocker?.trim())
    throw new AppError(400, 'Describe the blocker');
}
async function notifyTask(req, task, previousOwner, session) {
  if (task.assignedTo && String(task.assignedTo) !== String(previousOwner))
    await Notification.create(
      [
        {
          recipient: task.assignedTo,
          type: 'team_task_assigned',
          title: 'Task assigned to you',
          message: `${task.taskId}: ${task.title}`,
          link: '/employee#tasks',
          entityType: 'task',
          entityId: task._id,
          createdBy: req.user._id,
        },
      ],
      { session },
    );
  if (previousOwner && String(previousOwner) !== String(task.assignedTo))
    await Notification.create(
      [
        {
          recipient: previousOwner,
          type: 'team_task_reassigned',
          title: 'Task assignment changed',
          message: `${task.taskId}: ${task.title}`,
          link: '/employee#tasks',
          entityType: 'task',
          entityId: task._id,
          createdBy: req.user._id,
        },
      ],
      { session },
    );
}
export async function createTask(req, res) {
  const input = createTaskSchema.parse(req.body);
  const team = await resolveTeam(req);
  const task = await transaction(async (session) => {
    await validateTask(team, input, session);
    const [record] = await TeamTask.create(
      [
        {
          ...input,
          leader: team.leader._id,
          taskId: await numberFor('team-task', 'ADB/TASK/', session),
          createdBy: req.user._id,
          ...(input.status === 'DONE' ? { completedAt: new Date() } : {}),
        },
      ],
      { session },
    );
    await audit(
      req,
      'task.created',
      record,
      { leader: String(team.leader._id), title: record.title },
      session,
    );
    await notifyTask(req, record, null, session);
    return record;
  });
  res.status(201).json({ success: true, message: 'Task created', data: task });
}
export async function updateTask(req, res) {
  const self = req.path.startsWith('/my-tasks');
  const input = (
    self
      ? z
          .object({
            status: z.enum(taskStatuses),
            blocker: text(2000),
            version: z.number().int().min(0),
          })
          .strict()
      : updateTaskSchema
  ).parse(req.body);
  const team = self ? null : await resolveTeam(req);
  const result = await transaction(async (session) => {
    const task = await TeamTask.findOne({
      _id: id(req.params.id),
      deletedAt: null,
      ...(self ? { assignedTo: req.user._id } : { leader: team.leader._id }),
    }).session(session);
    if (!task) throw new AppError(404, 'Task not found or access denied');
    if (task.project) {
      const project = await Project.findOneAndUpdate(
        {
          _id: task.project,
          archivedAt: null,
          status: {
            $nin: ['COMPLETED', 'CANCELLED', 'Completed', 'Cancelled'],
          },
        },
        { $inc: { revision: 1 } },
        { session },
      );
      if (!project)
        throw new AppError(
          409,
          'Project is closed; reopen before changing tasks',
        );
      if (
        ![
          project.projectManager,
          project.assignedTo,
          ...project.teamMembers
            .filter((m) => m.status === 'ACTIVE')
            .map((m) => m.employee),
        ]
          .filter(Boolean)
          .map(String)
          .includes(String(req.user._id))
      )
        throw new AppError(403, 'You are no longer an active project member');
      if (changesProjectAssignee(req.body, task, project))
        throw new AppError(
          400,
          'Assign project tasks only to active project members',
        );
      if (
        req.body.status === 'DONE' &&
        (await TeamTask.exists({
          _id: { $in: task.dependsOn },
          deletedAt: null,
          status: { $ne: 'DONE' },
        }).session(session))
      )
        throw new AppError(409, 'Complete task dependencies first');
    } else if (self) await requireMyTeam(req, task.leader);
    if (task.version !== input.version)
      throw new AppError(409, 'This task changed. Refresh and try again.');
    if (
      task.sprint &&
      !(await TeamSprint.findOneAndUpdate(
        { _id: task.sprint, status: { $ne: 'COMPLETED' } },
        { $inc: { revision: 1 } },
        { session },
      ))
    )
      throw new AppError(409, 'Completed sprint tasks are locked');
    const changes = { ...input };
    delete changes.version;
    if (!self)
      await validateTask(team, { ...task.toObject(), ...changes }, session);
    if (changes.status === 'BLOCKED' && !changes.blocker?.trim())
      throw new AppError(400, 'Describe the blocker');
    const before = {
      status: task.status,
      assignedTo: task.assignedTo,
      sprint: task.sprint,
    };
    const previousOwner = task.assignedTo;
    Object.assign(task, changes);
    task.version += 1;
    task.completedAt =
      task.status === 'DONE' ? task.completedAt || new Date() : null;
    if (task.status !== 'BLOCKED') task.blocker = '';
    await task.save({ session });
    if (task.project)
      await AuditLog.create(
        [
          {
            user: req.user._id,
            action:
              task.status === 'DONE'
                ? 'project.TASK_COMPLETED'
                : 'project.TASK_UPDATED',
            entityType: 'project',
            entityId: task.project,
            details: { task: task._id, title: task.title },
          },
        ],
        { session },
      );
    await audit(
      req,
      'task.updated',
      task,
      {
        leader: String(task.leader),
        before,
        after: changes,
        title: task.title,
      },
      session,
    );
    await notifyTask(req, task, previousOwner, session);
    if (task.status === 'BLOCKED' && before.status !== 'BLOCKED')
      await Notification.create(
        [
          {
            recipient: task.leader,
            type: 'team_blocker',
            title: 'Team task blocked',
            message: `${task.taskId}: ${task.blocker}`.slice(0, 1000),
            link: '/team',
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    if (
      before.status !== task.status &&
      ['REVIEW', 'DONE'].includes(task.status) &&
      String(task.leader) !== req.user.id
    )
      await Notification.create(
        [
          {
            recipient: task.leader,
            type: 'team_task_progress',
            title:
              task.status === 'DONE'
                ? 'Team task completed'
                : 'Task ready for review',
            message: `${task.taskId}: ${task.title}`,
            link: '/team',
            entityType: 'task',
            entityId: task._id,
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    if (
      task.assignedTo &&
      String(task.assignedTo) !== req.user.id &&
      String(previousOwner) === String(task.assignedTo)
    )
      await Notification.create(
        [
          {
            recipient: task.assignedTo,
            type: 'team_task_updated',
            title: 'Your team task was updated',
            message: `${task.taskId}: ${task.title}`,
            link: '/employee#tasks',
            entityType: 'task',
            entityId: task._id,
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    return task;
  });
  res.json({ success: true, message: 'Task updated', data: result });
}
export async function createSprint(req, res) {
  const input = z
    .object({
      title: text(120).min(1),
      goal: text(2000),
      startDate: z.coerce.date(),
      endDate: z.coerce.date(),
    })
    .strict()
    .refine(
      (value) => value.endDate > value.startDate,
      'Sprint end must follow its start',
    )
    .parse(req.body);
  const team = await resolveTeam(req);
  const result = await transaction(async (session) => {
    const [record] = await TeamSprint.create(
      [{ ...input, leader: team.leader._id, createdBy: req.user._id }],
      { session },
    );
    await audit(
      req,
      'sprint.created',
      record,
      { leader: String(team.leader._id), title: record.title },
      session,
    );
    return record;
  });
  res
    .status(201)
    .json({ success: true, message: 'Sprint planned', data: result });
}
export async function changeSprint(req, res) {
  const input = z
    .object({
      action: z.enum(['start', 'complete']),
      wentWell: text(3000).default(''),
      improve: text(3000).default(''),
      actions: text(3000).default(''),
    })
    .strict()
    .parse(req.body);
  const team = await resolveTeam(req);
  const result = await transaction(async (session) => {
    const sprint = await TeamSprint.findOne({
      _id: id(req.params.id),
      leader: team.leader._id,
    }).session(session);
    if (!sprint) throw new AppError(404, 'Sprint not found');
    if (input.action === 'start') {
      if (sprint.status !== 'PLANNED')
        throw new AppError(409, 'Only planned sprints can start');
      if (
        await TeamSprint.exists({
          leader: team.leader._id,
          status: 'ACTIVE',
        }).session(session)
      )
        throw new AppError(
          409,
          'Complete the active sprint before starting another',
        );
      const totals = await TeamTask.aggregate([
        { $match: { sprint: sprint._id, deletedAt: null } },
        { $group: { _id: null, points: { $sum: '$points' } } },
      ]).session(session);
      sprint.committedPoints = totals[0]?.points || 0;
      sprint.status = 'ACTIVE';
    } else {
      if (sprint.status !== 'ACTIVE')
        throw new AppError(409, 'Only active sprints can be completed');
      const done = await TeamTask.aggregate([
        { $match: { sprint: sprint._id, status: 'DONE', deletedAt: null } },
        { $group: { _id: null, points: { $sum: '$points' } } },
      ]).session(session);
      sprint.completedPoints = done[0]?.points || 0;
      sprint.status = 'COMPLETED';
      sprint.completedAt = new Date();
      sprint.retrospective = {
        wentWell: input.wentWell,
        improve: input.improve,
        actions: input.actions,
      };
      await TeamTask.updateMany(
        { sprint: sprint._id, status: { $ne: 'DONE' }, deletedAt: null },
        { $set: { sprint: null }, $inc: { version: 1 } },
        { session },
      );
    }
    await sprint.save({ session });
    await audit(
      req,
      `sprint.${input.action}`,
      sprint,
      {
        leader: String(team.leader._id),
        title: sprint.title,
        committedPoints: sprint.committedPoints,
        completedPoints: sprint.completedPoints,
      },
      session,
    );
    return sprint;
  });
  res.json({
    success: true,
    message:
      input.action === 'start'
        ? 'Sprint started'
        : 'Sprint completed; unfinished work returned to backlog',
    data: result,
  });
}
export async function myWork(req, res) {
  const { page, view, limit } = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      view: z.enum(['open', 'done', 'all']).default('open'),
      limit: z.coerce.number().int().min(1).max(25).default(25),
    })
    .parse(req.query);
  const profile = await EmployeeProfile.findOne({ user: req.user._id })
    .select('manager')
    .populate('manager', 'name active role')
    .lean();
  const leader =
    req.user.role === 'team_leader'
      ? { _id: req.user._id, name: req.user.name }
      : profile?.manager?.active && profile.manager.role === 'team_leader'
        ? profile.manager
        : null;
  const filter = {
    assignedTo: req.user._id,
    deletedAt: null,
    $or: [
      { project: { $ne: null } },
      ...(leader ? [{ leader: leader._id }] : []),
    ],
    ...(view === 'open'
      ? { status: { $ne: 'DONE' } }
      : view === 'done'
        ? { status: 'DONE' }
        : {}),
  };
  const summaryFilter = { ...filter };
  delete summaryFilter.status;
  const [tasks, total, standup, summary] = await Promise.all([
    TeamTask.find(filter)
      .populate('sprint', 'title status')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    TeamTask.countDocuments(filter),
    leader
      ? TeamStandup.findOne({
          employee: req.user._id,
          leader: leader._id,
          date: indiaDate(),
        }).lean()
      : null,
    TeamTask.aggregate([
      { $match: summaryFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);
  res.json({
    success: true,
    data: {
      leader,
      tasks,
      standup,
      summary,
      date: indiaDate(),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}

export async function archiveTask(req, res) {
  const { version } = z
    .object({ version: z.number().int().min(0) })
    .strict()
    .parse(req.body);
  const team = await resolveTeam(req);
  await transaction(async (session) => {
    const task = await TeamTask.findOne({
      _id: id(req.params.id),
      leader: team.leader._id,
      deletedAt: null,
    }).session(session);
    if (!task) throw new AppError(404, 'Task not found');
    if (
      task.project &&
      !(await Project.findOneAndUpdate(
        {
          _id: task.project,
          archivedAt: null,
          status: {
            $nin: ['COMPLETED', 'CANCELLED', 'Completed', 'Cancelled'],
          },
        },
        { $inc: { revision: 1 } },
        { session },
      ))
    )
      throw new AppError(409, 'Closed project tasks cannot be archived');
    if (task.version !== version)
      throw new AppError(409, 'This task changed. Refresh and try again.');
    if (
      task.sprint &&
      !(await TeamSprint.findOneAndUpdate(
        { _id: task.sprint, status: { $ne: 'COMPLETED' } },
        { $inc: { revision: 1 } },
        { session },
      ))
    )
      throw new AppError(409, 'Completed sprint history is locked');
    task.deletedAt = new Date();
    task.version += 1;
    await task.save({ session });
    if (task.project)
      await AuditLog.create(
        [
          {
            user: req.user._id,
            action:
              task.status === 'DONE'
                ? 'project.TASK_COMPLETED'
                : 'project.TASK_UPDATED',
            entityType: 'project',
            entityId: task.project,
            details: { task: task._id, title: task.title },
          },
        ],
        { session },
      );
    await audit(
      req,
      'task.archived',
      task,
      { leader: String(team.leader._id), title: task.title },
      session,
    );
  });
  res.json({ success: true, message: 'Task archived' });
}
export async function saveStandup(req, res) {
  const input = z
    .object({
      leader: objectId,
      yesterday: text(3000),
      today: text(3000).min(1),
      blockers: text(2000),
    })
    .strict()
    .parse(req.body);
  await requireMyTeam(req, input.leader);
  const leader = await User.exists({
    _id: input.leader,
    active: true,
    role: 'team_leader',
  });
  if (!leader) throw new AppError(400, 'Team Leader unavailable');
  const result = await transaction(async (session) => {
    const record = await TeamStandup.findOneAndUpdate(
      { leader: input.leader, employee: req.user._id, date: indiaDate() },
      {
        $set: {
          yesterday: input.yesterday,
          today: input.today,
          blockers: input.blockers,
        },
      },
      { new: true, upsert: true, session },
    );
    await audit(
      req,
      'standup.saved',
      record,
      { leader: input.leader, title: `${req.user.name} submitted a stand-up` },
      session,
    );
    return record;
  });
  res.json({ success: true, message: 'Daily stand-up saved', data: result });
}

export async function memberOptions(req, res) {
  const { search, page } = z
    .object({
      search: text(100).default(''),
      page: z.coerce.number().int().min(1).default(1),
    })
    .parse(req.query);
  const filter = {
    active: true,
    role: { $in: ['employee', 'executive', 'lead_caller'] },
    ...(search
      ? {
          name: {
            $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i',
          },
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    User.find(filter)
      .select('_id name email department')
      .sort({ name: 1 })
      .skip((page - 1) * 25)
      .limit(25)
      .lean(),
    User.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: { page, total, totalPages: Math.ceil(total / 25) },
    },
  });
}
export async function assignMember(req, res) {
  const { employee, remove } = z
    .object({ employee: objectId, remove: z.boolean().default(false) })
    .strict()
    .parse(req.body);
  const team = await resolveTeam(req);
  const user = await User.findOne({
    _id: employee,
    active: true,
    role: { $in: ['employee', 'executive', 'lead_caller'] },
  });
  if (!user) throw new AppError(400, 'Select an active employee');
  await transaction(async (session) => {
    const profile = await EmployeeProfile.findOne({ user: employee }).session(
      session,
    );
    if (!profile)
      throw new AppError(
        409,
        'Complete employee onboarding before assigning a reporting manager',
      );
    const previous = profile.manager;
    if (remove && String(previous) !== String(team.leader._id))
      throw new AppError(409, 'Employee no longer belongs to this team');
    profile.manager = remove ? null : team.leader._id;
    await profile.save({ session });
    if (previous && String(previous) !== String(profile.manager))
      await TeamTask.updateMany(
        {
          leader: previous,
          assignedTo: user._id,
          deletedAt: null,
          status: { $ne: 'DONE' },
        },
        { $set: { assignedTo: null }, $inc: { version: 1 } },
        { session },
      );
    await audit(
      req,
      'membership.changed',
      user,
      {
        leader: String(team.leader._id),
        title: `${user.name}: ${remove ? 'removed from team' : 'reporting manager assigned'}`,
        before: previous,
        after: profile.manager,
      },
      session,
    );
  });
  res.json({
    success: true,
    message: remove
      ? 'Member removed; open tasks left for reassignment'
      : 'Reporting manager assigned',
  });
}

function changesProjectAssignee(body, task, project) {
  return (
    body.assignedTo &&
    String(body.assignedTo) !== String(task.assignedTo) &&
    ![
      project.projectManager,
      project.assignedTo,
      ...project.teamMembers
        .filter((m) => m.status === 'ACTIVE')
        .map((m) => m.employee),
    ]
      .filter(Boolean)
      .map(String)
      .includes(String(body.assignedTo))
  );
}
