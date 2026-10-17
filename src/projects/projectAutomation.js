import { Project } from '../models/Project.js';
import { TeamTask } from '../models/TeamWork.js';
import { ProjectMilestone } from '../models/ProjectWork.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import { indiaDay, memberIds } from './projectService.js';
export async function runProjectReminders() {
  const today = indiaDay(),
    soon = new Date(+today + 7 * 86400000);
  const projects = await Project.find({
    archivedAt: null,
    status: { $nin: ['COMPLETED', 'CANCELLED', 'Completed', 'Cancelled'] },
    deadline: { $lt: soon },
  })
    .select('title projectId projectManager assignedTo teamMembers deadline')
    .limit(200)
    .lean();
  for (const p of projects) {
    const type = `project.${p.deadline < today ? 'delayed' : 'deadline'}.${today.toISOString().slice(0, 10)}`;
    const recipients = await User.distinct('_id', {
      _id: { $in: memberIds(p) },
      active: true,
    });
    for (const recipient of recipients)
      await Notification.updateOne(
        { recipient, entityId: p._id, type },
        {
          $setOnInsert: {
            title:
              p.deadline < today
                ? 'Project delayed'
                : 'Project deadline approaching',
            message: `${p.projectId}: ${p.title}`.slice(0, 1000),
            link: `/projects/${p._id}`,
            entityType: 'project',
          },
        },
        { upsert: true },
      );
  }
  for (const [Model, field, type] of [
    [TeamTask, 'assignedTo', 'task'],
    [ProjectMilestone, 'createdBy', 'milestone'],
  ]) {
    const rows = await Model.find({
      dueDate: { $lt: new Date(+today + 86400000) },
      status: { $nin: ['DONE', 'COMPLETED'] },
      ...(type === 'task' ? { deletedAt: null } : {}),
    })
      .select(`project title dueDate ${field}`)
      .limit(200)
      .lean();
    for (const r of rows) {
      if (!r.project || !r[field]) continue;
      const p = await Project.exists({
        _id: r.project,
        archivedAt: null,
        status: { $nin: ['COMPLETED', 'CANCELLED', 'Completed', 'Cancelled'] },
      });
      if (!p || !(await User.exists({ _id: r[field], active: true }))) continue;
      await Notification.updateOne(
        {
          recipient: r[field],
          entityId: r._id,
          type: `project.${type}.due.${today.toISOString().slice(0, 10)}`,
        },
        {
          $setOnInsert: {
            title: `Project ${type} ${r.dueDate < today ? 'overdue' : 'due today'}`,
            message: r.title.slice(0, 1000),
            link: `/projects/${r.project}/${type === 'task' ? 'tasks' : 'milestones'}`,
            entityType: type,
          },
        },
        { upsert: true },
      );
    }
  }
}
export function startProjectAutomation() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runProjectReminders();
    } catch (error) {
      logger.warn(
        { event: 'project.reminder_failed', error: error.message },
        'Project reminder failed',
      );
    } finally {
      running = false;
    }
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
