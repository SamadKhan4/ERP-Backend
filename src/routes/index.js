import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import * as auth from '../controllers/authController.js';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { profileSchema } from '../validators/authValidator.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { departments } from '../constants/departments.js';
import { hrmsRouter } from './hrmsRoutes.js';
import * as userManagement from '../controllers/userManagementController.js';
import * as quotations from '../controllers/quotationController.js';
import * as invoices from '../controllers/invoiceController.js';
import * as notifications from '../controllers/notificationController.js';
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
router.post('/user-management', authenticate, userManagement.createManagedUser);
router.patch('/user-management/:id', authenticate, userManagement.updateManagedUser);
router.delete('/user-management/:id', authenticate, userManagement.deactivateManagedUser);
router.get('/departments', authenticate, (req, res) =>
  res.json({ success: true, data: departments }),
);
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
