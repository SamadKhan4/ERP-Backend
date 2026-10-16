import { crmPermissions } from '../../../shared/crm.js';
import { teamPermissions } from '../../../shared/team.js';
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
rolePermissionDefaults.admin.push(...teamPermissions);
rolePermissionDefaults.manager.push(...teamPermissions);
rolePermissionDefaults.team_leader.push('team.workspace.view', 'team.workspace.manage', 'team.tasks.self');
rolePermissionDefaults.employee.push('team.tasks.self');
rolePermissionDefaults.executive.push('team.tasks.self');
rolePermissionDefaults.lead_caller.push('team.tasks.self');
