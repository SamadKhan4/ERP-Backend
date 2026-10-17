import { mailboxRouter } from './mailboxRoutes.js';
import { projectRouter } from './projectRoutes.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import * as auth from '../controllers/authController.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { profileSchema } from '../validators/authValidator.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { departmentRouter } from './departmentRoutes.js';
import { transfer as transferDepartment } from '../controllers/departmentController.js';
import { departmentAccess, requireDepartmentPermission } from '../services/departmentService.js';
import { hrmsRouter } from './hrmsRoutes.js';
import { crmRouter } from './crmRoutes.js';
import { teamRouter } from './teamRoutes.js';
import * as userManagement from '../controllers/userManagementController.js';
import * as quotations from '../controllers/quotationController.js';
import * as invoices from '../controllers/invoiceController.js';
import * as notifications from '../controllers/notificationController.js';
import { overview } from '../controllers/dashboardController.js';
import { reportRouter } from './reportRoutes.js';
import { financeRouter } from './financeRoutes.js';
import * as mail from '../controllers/mailController.js';
import * as outgoingMail from '../controllers/outgoingMailController.js';
export const router = Router();
router.get('/health', (req, res) =>
  res.json({
    success: true,
    data: {
      status: 'ok',
      database:
        mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    },
  }),
);
router.get('/ready', (req, res) =>
  res
    .status(mongoose.connection.readyState === 1 ? 200 : 503)
    .json({ success: mongoose.connection.readyState === 1 }),
);
router.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1)
    return res
      .status(503)
      .json({ success: false, error: { message: 'Database unavailable' } });
  next();
});
const authRouter = Router();
authRouter.use(
  rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
);
authRouter.post('/login', auth.login);
authRouter.post('/refresh', auth.refresh);
authRouter.post('/logout', auth.logout);
authRouter.get('/me', authenticate, auth.me);
authRouter.post('/change-password', authenticate, auth.changePassword);
authRouter.post('/forgot-password', auth.forgotPassword);
authRouter.post('/reset-password', auth.resetPassword);
router.use('/auth', authRouter);
router.use('/hrms', hrmsRouter);
router.use('/crm', crmRouter);
router.use('/team', teamRouter);
router.use('/reports', reportRouter);
router.use('/finance', financeRouter);
router.use('/projects', projectRouter);
router.get('/dashboard/overview', authenticate, authorize('dashboard.view'), overview);
router.get('/notifications', authenticate, notifications.listNotifications);
router.patch('/notifications/read-all', authenticate, notifications.markAllNotificationsRead);
router.patch('/notifications/:id/read', authenticate, notifications.markNotificationRead);
router.get('/quotations', authenticate, authorize('quotations.read'), quotations.listQuotations);
router.post('/quotations', authenticate, authorize('quotations.manage'), quotations.createQuotation);
router.get('/quotations/:id/download', authenticate, authorize('quotations.read'), quotations.downloadQuotation);
router.get('/quotations/:id', authenticate, authorize('quotations.read'), quotations.getQuotation);
router.put('/quotations/:id', authenticate, authorize('quotations.manage'), quotations.updateQuotation);
router.delete('/quotations/:id', authenticate, authorize('quotations.manage'), quotations.deleteQuotation);
router.get('/invoices', authenticate, authorize('invoices.read'), invoices.listInvoices);
router.post('/invoices', authenticate, authorize('invoices.manage'), invoices.createInvoice);
router.get('/invoices/:id/download', authenticate, authorize('invoices.read'), invoices.downloadInvoice);
router.get('/invoices/:id', authenticate, authorize('invoices.read'), invoices.getInvoice);
router.put('/invoices/:id', authenticate, authorize('invoices.manage'), invoices.updateInvoice);
router.delete('/invoices/:id', authenticate, authorize('invoices.manage'), invoices.deleteInvoice);
router.get('/user-management', authenticate, userManagement.listManagedUsers);
router.use('/mail', mailboxRouter);
router.get('/mail', authenticate, mail.list);
router.get('/mail/sent', authenticate, outgoingMail.history);

router.post('/mail/users/:id/welcome', authenticate, rateLimit({ windowMs: 60000, limit: 10 }), mail.resend);
router.post('/user-management', authenticate, userManagement.createManagedUser);
router.patch('/user-management/:id', authenticate, userManagement.updateManagedUser);
router.delete('/user-management/:id', authenticate, userManagement.deactivateManagedUser);
router.delete('/user-management/:id/permanent', authenticate, userManagement.deleteManagedUser);
router.use('/departments', departmentRouter);
router.patch('/employees/:id/department', authenticate, departmentAccess, requireDepartmentPermission('departments.manage_members'), transferDepartment);
router.get('/users/me', authenticate, auth.me);
router.patch('/users/me', authenticate, async (req, res) => {
  const data = profileSchema.parse(req.body);
  req.user.name = data.name;
  await req.user.save();
  await AuditLog.create({ user: req.user.id, action: 'user.profile_updated' });
  auth.me(req, res);
});
router.get(
  '/users',
  authenticate,
  authorize('users.read'),
  async (req, res) => {
    const users = await User.find().select('name email role active').limit(100);
    res.json({ success: true, data: users });
  },
);
