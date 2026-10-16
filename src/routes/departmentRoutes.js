import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import {
  departmentAccess,
  requireDepartmentPermission as permit,
} from '../services/departmentService.js';
import * as controller from '../controllers/departmentController.js';
import { hasDepartmentPermission } from '../services/departmentService.js';
import { AppError } from '../utils/errors.js';
export const departmentRouter = Router();
departmentRouter.use(authenticate, departmentAccess);
departmentRouter.get('/', controller.listEntry);
departmentRouter.get(
  '/people',
  (req, res, next) => {
    if (
      ![
        'departments.edit',
        'departments.create',
        'departments.manage_members',
        'departments.change_head',
      ].some((permission) =>
        hasDepartmentPermission(req.departmentPermissions, permission),
      )
    )
      throw new AppError(403, 'Department people lookup permission denied');
    next();
  },
  controller.peopleOptions,
);
departmentRouter.post('/', permit('departments.create'), controller.create);
departmentRouter.get('/:id', permit('departments.view'), controller.detail);
departmentRouter.get('/:id/designations', permit('departments.view'), controller.designations);
departmentRouter.patch('/:id', permit('departments.edit'), controller.update);
departmentRouter.delete(
  '/:id',
  permit('departments.delete'),
  controller.remove,
);
departmentRouter.patch(
  '/:id/status',
  permit('departments.edit'),
  controller.status,
);
departmentRouter.get(
  '/:id/summary',
  permit('departments.view_analytics'),
  controller.summary,
);
departmentRouter.get(
  '/:id/employees',
  permit('departments.view'),
  controller.employees,
);
departmentRouter.post(
  '/:id/employees',
  permit('departments.manage_members'),
  controller.assign,
);
departmentRouter.get(
  '/:id/projects',
  permit('departments.view_analytics'),
  controller.projects,
);
departmentRouter.get(
  '/:id/activity',
  permit('departments.view'),
  controller.activity,
);
