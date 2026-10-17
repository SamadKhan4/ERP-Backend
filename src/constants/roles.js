import { mailPermissions } from '../mailbox/mailPermissions.js';
import { projectPermissions } from '../projects/projectPermissions.js';
import { crmPermissions } from '../../shared/crm.js';
import { reportPermissionNames } from '../reports/reportRegistry.js';
import { financePermissions } from '../finance/financePermissions.js';
export const roleDefinitions = [
  { name: 'super_admin', label: 'Super Admin' },
  { name: 'admin', label: 'Admin' },
  { name: 'manager', label: 'Manager' },
  { name: 'hr', label: 'HR' },
  { name: 'executive', label: 'Executive' },
  { name: 'team_leader', label: 'Team Leader' },
  { name: 'employee', label: 'Employee' },
  { name: 'customer', label: 'Customer' },
  { name: 'lead_caller', label: 'Lead Caller' },
];
export const roles = roleDefinitions.map(({ name }) => name);

export const rolePermissionDefaults = {
  super_admin: ['*'],
  admin: [
    'dashboard.view',
    'users.read',
    'users.manage',
    'hrms.read',
    'hrms.manage',
    'hrms.approve',
    'hrms.payroll.read',
    'hrms.payroll.manage',
    'quotations.read',
    'quotations.manage',
    'invoices.read',
    'invoices.manage',
  ],
  manager: [
    'dashboard.view',
    'users.read',
    'hrms.read',
    'hrms.approve',
    'quotations.read',
    'quotations.manage',
    'invoices.read',
    'invoices.manage',
  ],
  hr: [
    'dashboard.view',
    'users.read',
    'users.manage',
    'hrms.read',
    'hrms.manage',
    'hrms.approve',
    'hrms.payroll.read',
    'hrms.payroll.manage',
  ],
  executive: ['dashboard.view', 'hrms.self'],
  team_leader: ['dashboard.view', 'hrms.self'],
  employee: ['dashboard.view', 'hrms.self'],
  customer: ['dashboard.view'],
  lead_caller: ['dashboard.view'],
};

rolePermissionDefaults.admin.push(...crmPermissions);
rolePermissionDefaults.manager.push('crm.dashboard.view', 'crm.leads.view', 'crm.followups.view', 'crm.activities.view', 'crm.pipeline.view', 'crm.reports.view', 'crm.reports.export');
rolePermissionDefaults.executive.push('crm.dashboard.view', 'crm.leads.view_own', 'crm.leads.create', 'crm.leads.edit', 'crm.leads.change_stage', 'crm.followups.view_own', 'crm.followups.create', 'crm.followups.edit', 'crm.followups.complete', 'crm.activities.view', 'crm.pipeline.view', 'crm.pipeline.manage');
rolePermissionDefaults.admin.push('team.members.manage');
rolePermissionDefaults.manager.push('team.members.manage');
rolePermissionDefaults.team_leader.push('team.workspace.view', 'team.workspace.manage', 'team.tasks.self');
rolePermissionDefaults.employee.push('team.tasks.self');
rolePermissionDefaults.executive.push('team.tasks.self');
rolePermissionDefaults.lead_caller.push('team.tasks.self');
const departmentPermissions = ['departments.view','departments.create','departments.edit','departments.delete','departments.manage_members','departments.change_head','departments.view_analytics'];
rolePermissionDefaults.admin.push(...departmentPermissions);
rolePermissionDefaults.hr.push(...departmentPermissions.filter((permission)=>permission!=='departments.delete'));
rolePermissionDefaults.manager.push('departments.view','departments.view_analytics');
const reporting = ['reports.view', 'reports.generate', 'reports.export', 'reports.manage_templates', 'reports.schedule'];
const grants = (role, categories, scope, extra = []) => rolePermissionDefaults[role].push(...reporting, ...categories.flatMap((category) => [`reports.${category}.view`, `reports.${category}.${scope}`, `reports.${category}.export`]), ...extra);
rolePermissionDefaults.admin.push(...reportPermissionNames);
rolePermissionDefaults.admin.push(...financePermissions);
grants('hr', ['hr', 'departments', 'users'], 'all', ['reports.hr.employees', 'reports.hr.attendance', 'reports.hr.leave', 'reports.hr.timesheets', 'reports.hr.payroll']);
grants('manager', ['hr', 'departments', 'projects', 'crm', 'management'], 'team', ['reports.hr.employees', 'reports.hr.attendance', 'reports.hr.leave', 'reports.hr.timesheets', 'reports.crm.leads', 'reports.crm.performance']);
grants('team_leader', ['hr', 'departments', 'projects'], 'team', ['reports.hr.employees', 'reports.hr.attendance', 'reports.hr.leave', 'reports.hr.timesheets']);
grants('employee', ['hr', 'projects'], 'own', ['reports.hr.attendance', 'reports.hr.leave', 'reports.hr.timesheets']);
grants('executive', ['hr', 'projects', 'crm'], 'own', ['reports.hr.attendance', 'reports.hr.leave', 'reports.hr.timesheets', 'reports.crm.leads', 'reports.crm.performance']);
grants('lead_caller', ['projects', 'crm'], 'own', ['reports.crm.leads', 'reports.crm.performance']);

rolePermissionDefaults.admin.push(...projectPermissions.filter(p=>p!=='projects.access.manage'));
rolePermissionDefaults.manager.push(...projectPermissions.filter(p=>!['projects.view_all','projects.view_department','projects.delete','projects.financials.view','projects.access.manage'].includes(p)));
for(const role of ['team_leader','employee','executive']) rolePermissionDefaults[role].push('projects.view','projects.view_assigned','projects.tasks.view','projects.tasks.complete','projects.files.view','projects.files.manage');
rolePermissionDefaults.team_leader.push('projects.tasks.create','projects.tasks.assign','projects.tasks.edit','projects.milestones.manage','projects.reports.view');

for(const role of roles.filter(r=>r!=='super_admin'))rolePermissionDefaults[role].push(...mailPermissions.filter(p=>!p.startsWith('mail.admin.')&&!p.startsWith('mail.shared.assign')&&!p.startsWith('mail.shared.manage_permissions')));
rolePermissionDefaults.admin.push(...mailPermissions);
