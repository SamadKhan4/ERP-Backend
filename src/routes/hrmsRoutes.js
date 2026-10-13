import { Router } from 'express';
import { authenticate, authorize } from '../middleware/authenticate.js';
import * as employees from '../controllers/employeeController.js';
import * as hrms from '../controllers/hrmsController.js';
import * as operations from '../controllers/hrmsOperationsController.js';
import * as onboarding from '../controllers/onboardingController.js';
import { onboardingUpload } from '../middleware/onboardingUpload.js';
import { hrmsResourceDefinitions } from '../validators/hrmsValidator.js';
import { AppError } from '../utils/errors.js';

export const hrmsRouter = Router();
hrmsRouter.use(authenticate);

const resourcePermission = (operation) => (req, res, next) => {
  const definition = hrmsResourceDefinitions[req.params.resource];
  if (!definition) throw new AppError(404, 'HRMS resource not found');
  const permission = definition.payroll
    ? operation === 'read' ? 'hrms.payroll.read' : 'hrms.payroll.manage'
    : operation === 'read' ? 'hrms.read' : operation === 'approve' ? 'hrms.approve' : 'hrms.manage';
  return authorize(permission)(req, res, next);
};

const asResource = (resource, handler) => (req, res, next) => {
  req.params.resource = resource;
  return handler(req, res, next);
};

const withParams = (values, handler) => (req, res, next) => {
  Object.assign(req.params, values);
  return handler(req, res, next);
};

const pass = (req, res, next) => next();

function registerCrud(path, resource, { payroll = false, remove = false } = {}) {
  const read = authorize(payroll ? 'hrms.payroll.read' : 'hrms.read');
  const manage = authorize(payroll ? 'hrms.payroll.manage' : 'hrms.manage');
  hrmsRouter.get(path, read, asResource(resource, hrms.listRecords));
  hrmsRouter.post(path, manage, asResource(resource, hrms.createRecord));
  hrmsRouter.get(`${path}/:id`, read, asResource(resource, hrms.getRecord));
  hrmsRouter.patch(`${path}/:id`, manage, asResource(resource, hrms.updateRecord));
  if (remove) hrmsRouter.delete(`${path}/:id`, manage, asResource(resource, hrms.deleteRecord));
}

hrmsRouter.get('/dashboard', authorize('hrms.read'), hrms.dashboard);
for (const section of ['summary', 'attendance-trends', 'leave-summary', 'departments', 'recent-employees', 'upcoming-birthdays', 'upcoming-leaves', 'activities'])
  hrmsRouter.get(`/dashboard/${section}`, authorize('hrms.read'), hrms.dashboard);

hrmsRouter.get('/employees/export', authorize('users.read'), operations.exportEmployees);
hrmsRouter.post('/employees/import', authorize('users.manage'), operations.importEmployees);
hrmsRouter.get('/employees', authorize('users.read'), employees.listEmployees);
hrmsRouter.post('/employees', authorize('users.manage'), onboarding.blockDirectEmployeeCreation);
hrmsRouter.post('/employees/from-onboarding/:id', authorize('users.manage'), onboarding.createEmployeeFromOnboarding);
hrmsRouter.get('/employees/:id', authorize('users.read'), employees.getEmployee);
hrmsRouter.patch('/employees/:id', authorize('users.manage'), employees.updateEmployee);
hrmsRouter.patch('/employees/:id/status', authorize('users.manage'), employees.updateEmployee);
hrmsRouter.delete('/employees/:id', authorize('users.manage'), employees.deactivateEmployee);
hrmsRouter.get('/employees/:id/employment-history', authorize('users.read'), operations.employeeHistory);
hrmsRouter.post('/employees/:id/transfers', authorize('users.manage'), operations.transferEmployee);
hrmsRouter.post('/employees/:id/promotions', authorize('users.manage'), operations.promoteEmployee);
for (const related of ['documents', 'assets', 'attendance-summary', 'leave-summary'])
  hrmsRouter.get(`/employees/:id/${related}`, authorize('users.read'), withParams({ related }, operations.employeeRelated));

registerCrud('/departments', 'departments', { remove: true });
registerCrud('/designations', 'designations', { remove: true });

hrmsRouter.post('/attendance/check-in', operations.attendanceCheckIn);
hrmsRouter.post('/attendance/check-out', operations.attendanceCheckOut);
hrmsRouter.get('/attendance/today', authorize('hrms.read'), operations.attendanceToday);
hrmsRouter.get('/attendance/me', operations.myAttendance);
hrmsRouter.get('/attendance/calendar', authorize('hrms.read'), asResource('attendance', hrms.listRecords));
hrmsRouter.get('/attendance/summary', authorize('hrms.read'), operations.attendanceSummary);
hrmsRouter.post('/attendance/regularizations', operations.createRegularization);
hrmsRouter.get('/attendance/regularizations', authorize('hrms.read'), asResource('attendance-regularizations', hrms.listRecords));
for (const decision of ['approve', 'reject'])
  hrmsRouter.patch(`/attendance/regularizations/:id/${decision}`, authorize('hrms.approve'), withParams({ decision }, operations.reviewRegularization));
hrmsRouter.post('/attendance/finalize', authorize('hrms.manage'), operations.finalizeAttendance);
hrmsRouter.get('/attendance', authorize('hrms.read'), asResource('attendance', hrms.listRecords));
hrmsRouter.get('/attendance/:id', authorize('hrms.read'), asResource('attendance', hrms.getRecord));

registerCrud('/leave-types', 'leave-types');
registerCrud('/leave-policies', 'leave-policies');
hrmsRouter.get('/leaves/balance/me', operations.getLeaveBalance);
hrmsRouter.get('/leaves/balance/:employeeId', authorize('hrms.read'), operations.getLeaveBalance);
hrmsRouter.post('/leaves/requests', operations.createLeaveRequest);
hrmsRouter.get('/leaves/requests', authorize('hrms.read'), asResource('leave', hrms.listRecords));
hrmsRouter.get('/leaves/requests/:id', authorize('hrms.read'), asResource('leave', hrms.getRecord));
hrmsRouter.patch('/leaves/requests/:id/cancel', operations.cancelLeave);
for (const decision of ['approve', 'reject'])
  hrmsRouter.patch(`/leaves/requests/:id/${decision}`, authorize('hrms.approve'), withParams({ decision }, operations.reviewLeave));
hrmsRouter.post('/leaves/adjustments', authorize('hrms.manage'), operations.adjustLeave);
hrmsRouter.get('/leaves/calendar', authorize('hrms.read'), asResource('leave', hrms.listRecords));

registerCrud('/salary-structures', 'salary-structures', { payroll: true });
hrmsRouter.post('/employees/:id/salary-assignments', authorize('hrms.payroll.manage'), operations.assignSalary);
hrmsRouter.get('/employees/:id/salary-history', authorize('hrms.payroll.read'), operations.salaryHistory);
registerCrud('/salary-revisions', 'salary-revisions', { payroll: true });
hrmsRouter.patch('/salary-revisions/:id/approve', authorize('hrms.payroll.manage'), withParams({ recordModule: 'salary-revisions', operation: 'approve' }, operations.recordTransition));
hrmsRouter.post('/payroll/runs', authorize('hrms.payroll.manage'), operations.createPayrollRun);
hrmsRouter.get('/payroll/runs', authorize('hrms.payroll.read'), asResource('payroll-runs', hrms.listRecords));
hrmsRouter.get('/payroll/runs/:id', authorize('hrms.payroll.read'), asResource('payroll-runs', hrms.getRecord));
hrmsRouter.post('/payroll/runs/:id/calculate', authorize('hrms.payroll.manage'), operations.calculatePayroll);
hrmsRouter.post('/payroll/runs/:id/approve', authorize('hrms.payroll.manage'), operations.approvePayroll);
hrmsRouter.post('/payroll/runs/:id/mark-paid', authorize('hrms.payroll.manage'), operations.markPayrollPaid);
hrmsRouter.get('/payroll/runs/:id/entries', authorize('hrms.payroll.read'), operations.payrollEntries);
hrmsRouter.get('/payroll/payslips/me', operations.myPayslips);
hrmsRouter.get('/payroll/payslips/:id/download', operations.downloadPayslip);
hrmsRouter.get('/payroll/reports', authorize('hrms.payroll.read'), withParams({ recordModule: 'payroll-runs' }, operations.moduleReport));

registerCrud('/shifts/assignments', 'shift-assignments');
registerCrud('/shifts', 'shifts', { remove: true });
registerCrud('/holidays', 'holidays', { remove: true });
hrmsRouter.get('/timesheets/summary', authorize('hrms.read'), withParams({ recordModule: 'timesheets' }, operations.moduleReport));
registerCrud('/timesheets', 'timesheets');
hrmsRouter.patch('/timesheets/:id/approve', authorize('hrms.approve'), withParams({ recordModule: 'timesheets', operation: 'approve' }, operations.recordTransition));

registerCrud('/jobs', 'jobs');
hrmsRouter.patch('/jobs/:id/close', authorize('hrms.manage'), withParams({ recordModule: 'jobs', operation: 'close' }, operations.recordTransition));
registerCrud('/candidates', 'candidates');
hrmsRouter.patch('/candidates/:id/stage', authorize('hrms.manage'), withParams({ recordModule: 'candidates', operation: 'stage' }, operations.recordTransition));
hrmsRouter.post('/candidates/:id/convert-to-employee', authorize('users.manage'), operations.convertCandidate);
registerCrud('/interviews', 'interviews');
hrmsRouter.post('/interviews/:id/feedback', authorize('hrms.manage'), withParams({ recordModule: 'interviews', operation: 'feedback' }, operations.recordTransition));

hrmsRouter.get('/onboarding', authorize('hrms.read'), onboarding.listOnboarding);
hrmsRouter.post('/onboarding', authorize('hrms.manage'), onboarding.createOnboarding);
hrmsRouter.get('/onboarding/:id', authorize('hrms.read'), onboarding.getOnboarding);
hrmsRouter.patch('/onboarding/:id', authorize('hrms.manage'), onboarding.updateOnboarding);
hrmsRouter.delete('/onboarding/:id', authorize('hrms.manage'), onboarding.deleteOnboarding);
hrmsRouter.post('/onboarding/:id/documents', authorize('hrms.manage'), onboardingUpload, onboarding.uploadDocument);
hrmsRouter.patch('/onboarding/:id/documents/:documentId/verify', authorize('hrms.manage'), onboarding.verifyDocument);
hrmsRouter.get('/onboarding/:id/documents/:documentId/download', authorize('hrms.read'), onboarding.downloadDocument);
hrmsRouter.delete('/onboarding/:id/documents/:documentId', authorize('hrms.manage'), onboarding.deleteDocument);
hrmsRouter.post('/onboarding/:id/tasks', authorize('hrms.manage'), withParams({ workflow: 'onboarding' }, operations.mutateChecklist));
hrmsRouter.patch('/onboarding/:id/tasks/:taskId', authorize('hrms.manage'), withParams({ workflow: 'onboarding' }, operations.mutateChecklist));
hrmsRouter.post('/onboarding/:id/complete', authorize('hrms.manage'), onboarding.completeOnboarding);
hrmsRouter.get('/offboarding/reports', authorize('hrms.read'), withParams({ recordModule: 'offboarding' }, operations.moduleReport));
registerCrud('/offboarding', 'offboarding');
hrmsRouter.post('/offboarding/:id/clearances', authorize('hrms.manage'), operations.addClearance);
hrmsRouter.patch('/offboarding/:id/clearances/:clearanceId', authorize('hrms.manage'), operations.updateClearance);
hrmsRouter.post('/offboarding/:id/settlement', authorize('hrms.payroll.manage'), operations.prepareSettlement);
hrmsRouter.post('/offboarding/:id/complete', authorize('hrms.manage'), withParams({ workflow: 'offboarding' }, operations.completeWorkflow));

registerCrud('/performance/cycles', 'performance-cycles');
registerCrud('/performance/goals', 'performance-goals');
registerCrud('/performance/reviews', 'performance-reviews');
for (const operation of ['self-review', 'manager-review', 'finalize'])
  hrmsRouter.post(`/performance/reviews/:id/${operation}`, operation === 'self-review' ? pass : authorize('hrms.approve'), withParams({ recordModule: 'performance-reviews', operation }, operations.recordTransition));
hrmsRouter.get('/performance/reports', authorize('hrms.read'), withParams({ recordModule: 'performance-reviews' }, operations.moduleReport));

hrmsRouter.get('/assets/reports', authorize('hrms.read'), withParams({ recordModule: 'assets' }, operations.moduleReport));
registerCrud('/assets', 'assets');
for (const action of ['assign', 'acknowledge', 'return', 'maintenance'])
  hrmsRouter.post(`/assets/:id/${action}`, action === 'acknowledge' ? pass : authorize('hrms.manage'), withParams({ action }, operations.assetAction));
hrmsRouter.get('/assets/employee/:employeeId', authorize('hrms.read'), (req, res, next) => { req.query.employee = req.params.employeeId; return asResource('assets', hrms.listRecords)(req, res, next); });

registerCrud('/training/programs', 'training-programs');
registerCrud('/training/enrollments', 'training-enrollments');
hrmsRouter.get('/training/reports', authorize('hrms.read'), withParams({ recordModule: 'training-enrollments' }, operations.moduleReport));

registerCrud('/documents', 'documents', { remove: true });
hrmsRouter.get('/documents/:id/download', operations.downloadDocument);
registerCrud('/policies', 'policies');
hrmsRouter.post('/policies/:id/versions', authorize('hrms.manage'), operations.policyVersion);
hrmsRouter.post('/policies/:id/acknowledge', operations.acknowledgePolicy);
registerCrud('/announcements', 'announcements', { remove: true });
for (const kind of ['birthdays', 'anniversaries']) hrmsRouter.get(`/events/${kind}`, authorize('hrms.read'), withParams({ kind }, operations.eventFeed));
hrmsRouter.get('/events/calendar', authorize('hrms.read'), operations.combinedCalendar);

hrmsRouter.get('/reports/summary', authorize('hrms.read'), hrms.reports);
for (const kind of ['headcount', 'attendance', 'leaves', 'payroll', 'attrition', 'recruitment', 'performance', 'timesheets', 'assets'])
  hrmsRouter.get(`/reports/${kind}`, authorize(kind === 'payroll' ? 'hrms.payroll.read' : 'hrms.read'), withParams({ kind }, operations.reports));
hrmsRouter.post('/reports/exports', authorize('hrms.manage'), operations.createReportExport);
hrmsRouter.get('/settings', authorize('hrms.read'), asResource('settings', hrms.listRecords));
hrmsRouter.patch('/settings', authorize('hrms.manage'), operations.updateSettings);
for (const policy of ['attendance-policy', 'payroll-policy', 'approval-workflows']) {
  hrmsRouter.get(`/settings/${policy}`, authorize(policy === 'payroll-policy' ? 'hrms.payroll.read' : 'hrms.read'), withParams({ policy }, operations.settingPolicy));
  hrmsRouter.put(`/settings/${policy}`, authorize(policy === 'payroll-policy' ? 'hrms.payroll.manage' : 'hrms.manage'), withParams({ policy }, operations.settingPolicy));
}
hrmsRouter.get('/settings/audit-logs', authorize('hrms.read'), operations.auditLogs);
for (const scope of ['pending', 'history']) hrmsRouter.get(`/approvals/${scope}`, authorize('hrms.approve'), withParams({ scope }, operations.approvalList));
hrmsRouter.get('/approvals/:id', authorize('hrms.approve'), operations.approvalDetail);
for (const action of ['approve', 'reject']) hrmsRouter.post(`/approvals/:id/${action}`, authorize('hrms.approve'), withParams({ action }, operations.approvalAction));

hrmsRouter.get('/self/profile', employees.getMyEmployeeProfile);
hrmsRouter.get('/self/onboarding', onboarding.getMyOnboarding);
hrmsRouter.post('/self/onboarding/documents', onboardingUpload, onboarding.uploadMyDocument);
hrmsRouter.get('/self/onboarding/documents/:documentId/download', onboarding.downloadMyDocument);
hrmsRouter.delete('/self/onboarding/documents/:documentId', onboarding.deleteMyDocument);
hrmsRouter.get('/self/:resource', hrms.listSelfRecords);
hrmsRouter.post('/self/:resource', hrms.createSelfRecord);

hrmsRouter.get('/:resource', resourcePermission('read'), hrms.listRecords);
hrmsRouter.post('/:resource', resourcePermission('manage'), hrms.createRecord);
hrmsRouter.get('/:resource/:id', hrms.validateResource, resourcePermission('read'), hrms.getRecord);
hrmsRouter.patch('/:resource/:id', hrms.validateResource, resourcePermission('manage'), hrms.updateRecord);
hrmsRouter.patch('/:resource/:id/status', hrms.validateResource, resourcePermission('approve'), hrms.updateRecordStatus);
hrmsRouter.delete('/:resource/:id', hrms.validateResource, resourcePermission('manage'), hrms.deleteRecord);
