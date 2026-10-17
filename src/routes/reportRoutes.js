import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { reportAccess } from '../reports/reportAccessService.js';
import * as controller from '../reports/reportController.js';
export const reportRouter = Router();
reportRouter.use(authenticate, reportAccess);
reportRouter.get('/', controller.catalog);
reportRouter.get('/categories', controller.catalog);
reportRouter.get('/dashboard', controller.catalog);
reportRouter.get('/recent', controller.recent);
reportRouter.get('/analytics', controller.analytics);
reportRouter.get('/access', controller.access);
reportRouter.patch('/access/:role', controller.changeAccess);
reportRouter.get('/saved', controller.savedList);
reportRouter.post('/saved', controller.saveView);
reportRouter.patch('/saved/:id', controller.saveView);
reportRouter.delete('/saved/:id', controller.deleteView);
reportRouter.get('/scheduled', controller.scheduleList);
reportRouter.post('/scheduled', controller.schedule);
reportRouter.patch('/scheduled/:id', controller.schedule);
reportRouter.get('/:reportKey', controller.detail);
reportRouter.post(
  '/:reportKey/export',
  rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: (req) => String(req.user._id),
  }),
  controller.generate,
);
