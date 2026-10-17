import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { financeAccess, requireFinance } from '../finance/financeAccess.js';
import * as c from '../finance/financeController.js';
import { receiveDocument } from '../controllers/crmDocumentController.js';
export const financeRouter = Router();
financeRouter.use(authenticate, financeAccess);
const get = (path, permission, controller) =>
  financeRouter.get(path, requireFinance(permission), controller);
const post = (path, permission, controller) =>
  financeRouter.post(path, requireFinance(permission), controller);
const patch = (path, permission, controller) =>
  financeRouter.patch(path, requireFinance(permission), controller);
financeRouter.get('/metadata', c.metadata);
get('/access', 'finance.settings.manage', c.accessSettings);
patch('/access/:role', 'finance.settings.manage', c.changeAccess);
get('/settings', 'finance.settings.manage', c.settings);
patch('/settings', 'finance.settings.manage', c.updateSettings);
patch('/clients/:id/tax', 'finance.invoices.edit', c.clientTax);
get('/dashboard', 'finance.dashboard.view', c.dashboard);
get('/invoices', 'finance.invoices.view', c.invoices);
post('/invoices', 'finance.invoices.create', c.createInvoice);
get('/invoices/:id', 'finance.invoices.view', c.invoiceDetail);
patch('/invoices/:id', 'finance.invoices.edit', c.editInvoice);
post('/invoices/:id/send', 'finance.invoices.edit', c.issueInvoice);
post('/invoices/:id/cancel', 'finance.invoices.cancel', c.cancelInvoice);
get('/invoices/:id/pdf', 'finance.invoices.export', c.invoicePdf);
get('/payments', 'finance.payments.view', c.payments);
post('/payments', 'finance.payments.create', c.paymentCreate);
post('/payments/:id/reverse', 'finance.payments.reverse', c.paymentReverse);
get('/outstanding', 'finance.outstanding.view', c.outstanding);
get('/followups', 'finance.outstanding.view', c.followups);
post('/followups', 'finance.followups.manage', c.followupSave);
patch('/followups/:id', 'finance.followups.manage', c.followupSave);
get('/expenses', 'finance.expenses.view', c.expenses);
get('/expenses/:id', 'finance.expenses.view', c.expenseDetail);
post('/expenses', 'finance.expenses.create', c.expenseSave);
patch('/expenses/:id', 'finance.expenses.edit', c.expenseSave);
financeRouter.post('/expenses/:id/action', c.expenseAction);
get('/ledger', 'finance.ledger.view', c.ledger);
get('/recurring', 'finance.recurring.view', c.recurring);
post('/recurring', 'finance.recurring.manage', c.recurringSave);
patch('/recurring/:id', 'finance.recurring.manage', c.recurringSave);
financeRouter.post(
  '/recurring/:id/generate',
  requireFinance('finance.recurring.manage'),
  requireFinance('finance.invoices.create'),
  c.recurringGenerate,
);
get('/profitability', 'finance.profitability.view', c.profitability);
financeRouter.get(
  '/reports/:key',
  requireFinance('finance.reports.view'),
  requireFinance('finance.reports.export'),
  rateLimit({ windowMs: 60000, limit: 10 }),
  c.exportFinance,
);
financeRouter.post(
  '/invoices/:invoiceId/documents',
  requireFinance('finance.invoices.edit'),
  receiveDocument,
  c.uploadDocument,
);
financeRouter.post(
  '/expenses/:expenseId/documents',
  requireFinance('finance.expenses.edit'),
  receiveDocument,
  c.uploadDocument,
);
financeRouter.get('/documents/:id', c.downloadDocument);
