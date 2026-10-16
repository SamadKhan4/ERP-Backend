import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { teamAccess, requireTeam } from '../services/teamAccessService.js';
import * as team from '../controllers/teamController.js';
export const teamRouter = Router();
teamRouter.use(authenticate, teamAccess);
teamRouter.get('/leaders', requireTeam('team.workspace.view'), team.leaders);
teamRouter.get(
  '/member-options',
  requireTeam('team.members.manage'),
  team.memberOptions,
);
teamRouter.post(
  '/members',
  requireTeam('team.members.manage'),
  team.assignMember,
);
teamRouter.get(
  '/workspace',
  requireTeam('team.workspace.view'),
  team.workspace,
);
teamRouter.get('/tasks', requireTeam('team.workspace.view'), team.listTasks);
teamRouter.post(
  '/tasks',
  requireTeam('team.workspace.manage'),
  team.createTask,
);
teamRouter.patch(
  '/tasks/:id',
  requireTeam('team.workspace.manage'),
  team.updateTask,
);
teamRouter.delete(
  '/tasks/:id',
  requireTeam('team.workspace.manage'),
  team.archiveTask,
);
teamRouter.post(
  '/sprints',
  requireTeam('team.workspace.manage'),
  team.createSprint,
);
teamRouter.post(
  '/sprints/:id/action',
  requireTeam('team.workspace.manage'),
  team.changeSprint,
);
teamRouter.get('/my-work', requireTeam('team.tasks.self'), team.myWork);
teamRouter.patch(
  '/my-tasks/:id',
  requireTeam('team.tasks.self'),
  team.updateTask,
);
teamRouter.post('/standups', requireTeam('team.tasks.self'), team.saveStandup);
