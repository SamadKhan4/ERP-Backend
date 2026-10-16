import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { loadCRMAccess, requireCRM } from '../services/crmAccessService.js';
import * as leads from '../controllers/crmLeadController.js';
import * as activities from '../controllers/crmActivityController.js';
import * as followups from '../controllers/crmFollowUpController.js';
import { pipeline } from '../controllers/crmPipelineController.js';
import * as clients from '../controllers/crmClientController.js';
import * as quotations from '../controllers/quotationController.js';
import {
  receiveDocument,
  addDocument,
  downloadDocument,
} from '../controllers/crmDocumentController.js';
import * as reports from '../controllers/crmReportController.js';
import * as settings from '../controllers/crmSettingsController.js';
import * as imports from '../controllers/crmImportController.js';
export const crmRouter = Router();
crmRouter.use(authenticate, loadCRMAccess);
crmRouter.post(
  '/leads/import/preview',
  requireCRM('crm.leads.import'),
  requireCRM('crm.leads.create'),
  imports.receiveWorkbook,
  imports.preview,
);
crmRouter.post(
  '/leads/import/:batchId/validate',
  requireCRM('crm.leads.import'),
  requireCRM('crm.leads.create'),
  imports.validate,
);
crmRouter.post(
  '/leads/import/:batchId/commit',
  requireCRM('crm.leads.import'),
  requireCRM('crm.leads.create'),
  imports.commit,
);
crmRouter.get('/metadata', leads.metadata);
crmRouter.get('/assignees', leads.assignees);
crmRouter.get('/pipeline', requireCRM('crm.pipeline.view'), pipeline);
crmRouter.get(
  '/dashboard',
  requireCRM('crm.dashboard.view'),
  reports.dashboard,
);
crmRouter.get(
  '/reports/export',
  requireCRM('crm.reports.export'),
  reports.exportLeads,
);
crmRouter.get(
  '/reports/:kind/export',
  requireCRM('crm.reports.export'),
  reports.exportReport,
);
crmRouter.get('/reports/:kind', requireCRM('crm.reports.view'), reports.report);
crmRouter.get(
  '/settings',
  requireCRM('crm.settings.manage'),
  settings.getSettings,
);
crmRouter.patch(
  '/settings',
  requireCRM('crm.settings.manage'),
  settings.updateSettings,
);
crmRouter.patch(
  '/settings/roles/:name',
  requireCRM('crm.settings.manage'),
  settings.grantRole,
);
crmRouter.get(
  '/leads/duplicates',
  requireCRM('crm.leads.create'),
  leads.duplicates,
);
crmRouter.post(
  '/leads/bulk-assign',
  requireCRM('crm.leads.bulk_assign'),
  leads.bulkAssign,
);
crmRouter.get(
  '/leads',
  requireCRM('crm.leads.view', 'crm.leads.view_team', 'crm.leads.view_own'),
  leads.list,
);
crmRouter.post('/leads', requireCRM('crm.leads.create'), leads.create);
crmRouter.get(
  '/leads/:id',
  requireCRM('crm.leads.view', 'crm.leads.view_team', 'crm.leads.view_own'),
  leads.get,
);
crmRouter.patch('/leads/:id', requireCRM('crm.leads.edit'), leads.update);
crmRouter.delete('/leads/:id', requireCRM('crm.leads.delete'), leads.archive);
crmRouter.post(
  '/leads/:id/assign',
  requireCRM('crm.leads.assign'),
  leads.assign,
);
crmRouter.post(
  '/leads/:id/change-stage',
  requireCRM('crm.leads.change_stage', 'crm.pipeline.manage'),
  leads.stage,
);
crmRouter.post(
  '/leads/:id/convert',
  requireCRM('crm.leads.convert'),
  clients.convert,
);
crmRouter.get(
  '/leads/:id/quotations',
  requireCRM('quotations.read'),
  clients.leadQuotations,
);
crmRouter.post(
  '/leads/:id/quotations',
  requireCRM('quotations.manage'),
  clients.quotationContext,
  quotations.createQuotation,
);
crmRouter.get(
  '/clients',
  requireCRM('crm.leads.convert'),
  clients.clientSearch,
);
crmRouter.get(
  '/clients/:id',
  requireCRM('crm.leads.view', 'crm.leads.view_team', 'crm.leads.view_own'),
  clients.clientDetail,
);
crmRouter.post(
  '/clients/:id/projects',
  requireCRM('crm.leads.convert'),
  clients.createProject,
);
crmRouter.post(
  '/leads/:id/documents',
  requireCRM('crm.leads.edit'),
  receiveDocument,
  addDocument,
);
crmRouter.get(
  '/leads/:id/documents/:documentId',
  requireCRM('crm.leads.view', 'crm.leads.view_team', 'crm.leads.view_own'),
  downloadDocument,
);
crmRouter.get(
  '/activities',
  requireCRM('crm.activities.view'),
  activities.listActivities,
);
crmRouter.get(
  '/leads/:id/activities',
  requireCRM('crm.activities.view'),
  activities.listActivities,
);
crmRouter.post(
  '/leads/:id/activities',
  requireCRM('crm.leads.edit'),
  activities.addActivity,
);
crmRouter.get(
  '/leads/:id/follow-ups',
  requireCRM('crm.followups.view', 'crm.followups.view_own'),
  followups.listFollowUps,
);
crmRouter.post(
  '/leads/:id/follow-ups',
  requireCRM('crm.followups.create'),
  followups.createFollowUp,
);
crmRouter.get(
  '/follow-ups',
  requireCRM('crm.followups.view', 'crm.followups.view_own'),
  followups.listFollowUps,
);
crmRouter.post(
  '/follow-ups',
  requireCRM('crm.followups.create'),
  followups.createFollowUp,
);
crmRouter.patch(
  '/follow-ups/:id',
  requireCRM('crm.followups.edit'),
  followups.editFollowUp,
);
crmRouter.post(
  '/follow-ups/:id/complete',
  requireCRM('crm.followups.complete'),
  followups.completeFollowUp,
);
crmRouter.post(
  '/follow-ups/:id/reschedule',
  requireCRM('crm.followups.edit'),
  followups.rescheduleFollowUp,
);
crmRouter.delete(
  '/follow-ups/:id',
  requireCRM('crm.followups.delete'),
  followups.cancelFollowUp,
);
