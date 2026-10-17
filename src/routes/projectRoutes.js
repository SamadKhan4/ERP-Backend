import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate.js';
import { env } from '../config/env.js';
import { projectAccess, requireProject } from '../projects/projectAccess.js';
import * as c from '../projects/projectController.js';
export const projectRouter = Router();
projectRouter.use(authenticate, projectAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE, files: 1, fields: 2 },
});
projectRouter.get('/metadata', c.metadata);
projectRouter.get('/dashboard', c.dashboard);
projectRouter.get('/access', requireProject('access.manage'), c.access);
projectRouter.patch(
  '/access/:role',
  requireProject('access.manage'),
  c.saveAccess,
);
projectRouter.get(
  '/reports/:reportKey',
  requireProject('reports.view'),
  c.report,
);
projectRouter.get('/', c.list);
projectRouter.post('/', requireProject('create'), c.create);
projectRouter.get('/:id', c.detail);
projectRouter.patch('/:id', requireProject('edit'), c.update);
projectRouter.delete('/:id', requireProject('delete'), c.archive);
projectRouter.patch('/:id/status', c.status);
for (const action of ['start', 'complete', 'reopen'])
  projectRouter.post(`/:id/${action}`, (req, res, next) => {
    req.params.action = action;
    return c.status(req, res, next);
  });
projectRouter.get('/:id/team', c.team);
projectRouter.post('/:id/team', requireProject('manage_team'), c.saveMember);
projectRouter.patch(
  '/:id/team/:memberId',
  requireProject('manage_team'),
  c.saveMember,
);
projectRouter.delete(
  '/:id/team/:memberId',
  requireProject('manage_team'),
  c.saveMember,
);
projectRouter.get('/:id/tasks', requireProject('tasks.view'), c.tasks);
projectRouter.post('/:id/tasks', requireProject('tasks.create'), c.saveTask);
projectRouter.patch(
  '/:id/tasks/:taskId',
  requireProject('tasks.complete'),
  c.saveTask,
);
projectRouter.get('/:id/milestones', c.milestones);
projectRouter.post(
  '/:id/milestones',
  requireProject('milestones.manage'),
  c.saveMilestone,
);
projectRouter.patch(
  '/:id/milestones/:milestoneId',
  requireProject('milestones.manage'),
  c.saveMilestone,
);
projectRouter.get('/:id/activity', c.activity);
projectRouter.get('/:id/notes', c.notes);
projectRouter.post('/:id/notes', c.addNote);
projectRouter.get('/:id/files', requireProject('files.view'), c.files);
projectRouter.post(
  '/:id/files',
  requireProject('files.manage'),
  upload.single('file'),
  c.upload,
);
projectRouter.get(
  '/:id/files/:fileId/download',
  requireProject('files.view'),
  c.download,
);
projectRouter.get(
  '/:id/financials',
  requireProject('financials.view'),
  c.financials,
);
