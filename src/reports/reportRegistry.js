export const reportCategories = {
  users: {
    title: 'User Reports',
    description: 'Accounts, roles, login activity and access audits.',
  },
  departments: {
    title: 'Department Reports',
    description: 'Headcount, team allocation and department operations.',
  },
  projects: {
    title: 'Project Reports',
    description: 'Assigned projects, tasks and delivery workload.',
  },
  hr: {
    title: 'HR Reports',
    description:
      'Employees, attendance, leave, timesheets and authorized payroll.',
  },
  finance: {
    title: 'Finance Reports',
    description: 'Billing, collections, quotations and outstanding amounts.',
  },
  crm: {
    title: 'CRM Reports',
    description: 'Owned leads, conversion, sales pipeline and follow-ups.',
  },
  management: {
    title: 'Management Reports',
    description: 'Live summaries from authorized business modules.',
  },
};
const columns = {
  users: ['name', 'email', 'role', 'department', 'status', 'createdAt'],
  employees: [
    'name',
    'employeeCode',
    'designation',
    'department',
    'manager',
    'employmentType',
    'joiningDate',
    'status',
  ],
  login: ['name', 'role', 'action', 'date'],
  permissions: ['name', 'role', 'permission'],
  departments: ['name', 'code', 'status', 'head', 'employees'],
  projects: [
    'projectId',
    'title',
    'service',
    'status',
    'assignedTo',
    'startDate',
    'nextBillingAt',
  ],
  tasks: [
    'taskId',
    'title',
    'assignedTo',
    'project',
    'status',
    'priority',
    'points',
    'dueDate',
    'completedAt',
  ],
  attendance: [
    'employee',
    'department',
    'date',
    'status',
    'checkIn',
    'checkOut',
    'minutesWorked',
  ],
  leave: [
    'employee',
    'department',
    'leaveType',
    'startDate',
    'endDate',
    'status',
  ],
  balances: ['employee', 'leaveType', 'balance'],
  timesheets: ['employee', 'department', 'date', 'status', 'hours'],
  lifecycle: ['employee', 'department', 'title', 'status', 'date'],
  payroll: [
    'employeeName',
    'department',
    'period',
    'status',
    'gross',
    'deductions',
    'net',
    'currency',
  ],
  leads: [
    'leadId',
    'companyName',
    'assignedTo',
    'leadSource',
    'stage',
    'priority',
    'nextFollowUpAt',
    'createdAt',
  ],
  followups: [
    'followUpId',
    'employee',
    'type',
    'status',
    'scheduledAt',
    'completedAt',
  ],
  clients: ['clientId', 'companyName', 'assignedTo', 'leadSource', 'createdAt'],
  quotations: [
    'quotationNumber',
    'company',
    'salesPerson',
    'service',
    'status',
    'subtotal',
    'gstAmount',
    'grandTotal',
    'validUntil',
  ],
  invoices: [
    'invoiceNumber',
    'company',
    'invoiceDate',
    'dueDate',
    'status',
    'subtotal',
    'gstAmount',
    'grandTotal',
  ],
  aging: [
    'invoiceNumber',
    'company',
    'dueDate',
    'daysOverdue',
    'bucket',
    'outstanding',
  ],
};
export const reportRegistry = [];
function add(category, source, definitions, options = {}) {
  for (const [key, title, preset = {}] of definitions) {
    const group = preset.group;
    reportRegistry.push({
      key,
      category,
      source,
      title,
      description:
        options.description ||
        `Live ${title.toLowerCase()} within your authorized scope.`,
      permission: options.permission || `reports.${category}.view`,
      extraPermission: options.extraPermission,
      columns: group
        ? ['label', 'count', ...(preset.sum ? ['amount', 'currency'] : [])]
        : options.columns || columns[source],
      filters: [
        'search',
        'from',
        'to',
        'department',
        'employee',
        'manager',
        'role',
        'status',
        'designation',
        'employmentType',
      ],
      allowedScopes: ['OWN', 'TEAM', 'DEPARTMENT', 'ASSIGNED', 'ALL'],
      exportOptions: ['csv', 'xlsx', 'pdf'],
      ...options,
      preset,
    });
  }
}
add('users', 'users', [
  ['user_list', 'User List'],
  ['active_users', 'Active Users', { status: 'Active' }],
  ['inactive_users', 'Inactive Users', { status: 'Inactive' }],
  ['account_status', 'Account Status', { group: 'status' }],
  ['user_roles', 'User Role Report', { group: 'role' }],
]);
add('users', 'permissions', [['user_permissions', 'User Permission Report']]);
add('users', 'login', [
  ['login_activity', 'Login Activity'],
  ['last_login', 'Last Login', { lastLogin: true }],
  ['user_access_audit', 'User Access Audit', { audit: true }],
]);
add(
  'hr',
  'employees',
  [
    ['employee_master', 'Employee Master'],
    ['active_employees', 'Active Employees', { status: 'Active' }],
    ['inactive_employees', 'Inactive Employees', { status: 'Inactive' }],
    ['employee_headcount', 'Employee Headcount', { group: 'department' }],
    [
      'designation_employees',
      'Designation-wise Employees',
      { group: 'designation' },
    ],
    ['employment_types', 'Employment Type Report', { group: 'employmentType' }],
    ['joining_report', 'Joining Report', { joining: true }],
  ],
  { extraPermission: 'reports.hr.employees', tab: 'Employees' },
);
add('departments', 'departments', [
  ['department_summary', 'Department Summary'],
  ['department_headcount', 'Department Headcount'],
]);
add(
  'departments',
  'employees',
  [
    ['direct_reports', 'Direct Reports Summary'],
    ['resource_allocation', 'Department Resource Allocation'],
  ],
  { extraPermission: 'reports.hr.employees' },
);
add(
  'departments',
  'attendance',
  [['department_attendance', 'Department Attendance', { group: 'department' }]],
  { extraPermission: 'reports.hr.attendance' },
);
add(
  'departments',
  'leave',
  [['department_leave', 'Department Leave', { group: 'department' }]],
  { extraPermission: 'reports.hr.leave' },
);
add('departments', 'tasks', [
  [
    'department_task_completion',
    'Department Task Completion',
    { group: 'status' },
  ],
  ['team_workload', 'Team Workload', { group: 'assignedTo' }],
]);
add('departments', 'projects', [
  [
    'department_project_load',
    'Department Project Load',
    { group: 'assignedTo' },
  ],
]);
add(
  'departments',
  'payroll',
  [
    [
      'department_payroll_cost',
      'Department Payroll Cost',
      { group: 'department', sum: 'net' },
    ],
  ],
  { extraPermission: 'reports.hr.payroll' },
);
add('projects', 'projects', [
  ['project_list', 'Project List'],
  ['active_projects', 'Active Projects', { status: 'Active' }],
  ['completed_projects', 'Completed Projects', { status: 'Completed' }],
  ['project_progress', 'Project Progress', { group: 'status' }],
  [
    'project_team_allocation',
    'Project Team Allocation',
    { group: 'assignedTo' },
  ],
  ['client_projects', 'Client-wise Projects', { group: 'client' }],
  ['service_projects', 'Service-wise Projects', { group: 'service' }],
]);
add('projects', 'tasks', [
  ['task_summary', 'Task Summary'],
  ['pending_tasks', 'Pending Tasks', { pending: true }],
  ['completed_tasks', 'Completed Tasks', { status: 'DONE' }],
  ['overdue_tasks', 'Overdue Tasks', { overdue: true }],
  ['blocked_tasks', 'Blocked Tasks', { status: 'BLOCKED' }],
  ['employee_tasks', 'Employee-wise Tasks', { group: 'assignedTo' }],
  ['project_tasks', 'Project-wise Tasks', { group: 'project' }],
  ['task_completion', 'Task Completion Rate', { group: 'status' }],
]);
add(
  'hr',
  'attendance',
  [
    ['employee_attendance', 'Employee Attendance'],
    ['daily_attendance', 'Daily Attendance', { group: 'date' }],
    ['monthly_attendance', 'Monthly Attendance', { group: 'month' }],
    ['present_attendance', 'Present Report', { status: 'Present' }],
    ['late_attendance', 'Late Report', { status: 'Late' }],
    ['half_day_attendance', 'Half Day Report', { status: 'Half Day' }],
    ['wfh_attendance', 'WFH Report', { status: 'WFH' }],
    [
      'working_hours',
      'Working Hours',
      { group: 'employee', sum: 'minutesWorked' },
    ],
  ],
  { extraPermission: 'reports.hr.attendance', tab: 'Attendance' },
);
add(
  'hr',
  'lifecycle',
  [
    [
      'attendance_regularizations',
      'Attendance Regularization',
      { module: 'attendance-regularizations' },
    ],
  ],
  { extraPermission: 'reports.hr.attendance', tab: 'Attendance' },
);
add(
  'hr',
  'leave',
  [
    ['leave_summary', 'Leave Summary', { group: 'status' }],
    ['employee_leave', 'Employee Leave'],
    ['approved_leave', 'Approved Leave', { status: 'Approved' }],
    ['rejected_leave', 'Rejected Leave', { status: 'Rejected' }],
    ['pending_leave', 'Pending Leave', { status: 'Pending' }],
    ['leave_types', 'Leave Type Report', { group: 'leaveType' }],
    ['leave_trend', 'Monthly Leave Trend', { group: 'month' }],
  ],
  { extraPermission: 'reports.hr.leave', tab: 'Leave' },
);
add('hr', 'balances', [['leave_balance', 'Leave Balance']], {
  extraPermission: 'reports.hr.leave',
  tab: 'Leave',
});
add(
  'hr',
  'timesheets',
  [
    ['employee_timesheets', 'Employee Timesheets'],
    [
      'team_productivity',
      'Recorded Timesheet Hours',
      { group: 'employee', sum: 'hours' },
    ],
  ],
  { extraPermission: 'reports.hr.timesheets', tab: 'Employees' },
);
add(
  'hr',
  'lifecycle',
  [
    ['onboarding_report', 'Joining / Onboarding', { module: 'onboarding' }],
    [
      'resignation_report',
      'Resignation / Offboarding',
      { module: 'offboarding' },
    ],
  ],
  { extraPermission: 'reports.hr.employees', tab: 'Employees' },
);
add(
  'hr',
  'payroll',
  [
    ['payroll_summary', 'Payroll Summary'],
    ['employee_salary', 'Employee Salary Report'],
    ['gross_salary', 'Gross Salary', { group: 'employeeName', sum: 'gross' }],
    [
      'salary_deductions',
      'Deductions',
      { group: 'employeeName', sum: 'deductions' },
    ],
    ['net_pay', 'Net Pay', { group: 'employeeName', sum: 'net' }],
    ['payroll_status', 'Payroll Status', { group: 'status' }],
    ['payroll_trend', 'Monthly Payroll Trend', { group: 'period', sum: 'net' }],
  ],
  { extraPermission: 'reports.hr.payroll', tab: 'Payroll' },
);
add(
  'crm',
  'leads',
  [
    ['total_leads', 'Total Leads'],
    ['new_leads', 'New Leads', { stage: 'NEW' }],
    ['open_leads', 'Open Leads', { open: true }],
    ['won_leads', 'Won Leads', { stage: 'WON' }],
    ['lost_leads', 'Lost Leads', { stage: 'LOST' }],
    ['lead_source', 'Lead Source Performance', { group: 'leadSource' }],
    ['lead_conversion', 'Lead Conversion', { group: 'stage' }],
    ['sales_pipeline', 'Sales Pipeline', { group: 'stage' }],
    [
      'sales_performance',
      'Sales Employee Performance',
      { group: 'assignedTo' },
    ],
    [
      'service_interest',
      'Service Interest',
      { group: 'service', unwindServices: true },
    ],
    ['lead_aging', 'Lead Aging', { group: 'ageBucket' }],
  ],
  { extraPermission: 'reports.crm.leads' },
);
add(
  'crm',
  'followups',
  [
    ['followup_performance', 'Follow-up Performance', { group: 'status' }],
    ['overdue_followups', 'Overdue Follow-ups', { overdue: true }],
  ],
  { extraPermission: 'reports.crm.performance' },
);
add(
  'crm',
  'clients',
  [
    ['client_list', 'Client List'],
    ['client_source', 'Client Source', { group: 'leadSource' }],
  ],
  { extraPermission: 'reports.crm.leads' },
);
add(
  'finance',
  'invoices',
  [
    ['invoice_register', 'Invoice Register'],
    ['draft_invoices', 'Draft Invoices', { status: 'Draft' }],
    ['sent_invoices', 'Sent Invoices', { status: 'Sent' }],
    ['paid_invoices', 'Paid Invoices', { status: 'Paid' }],
    ['cancelled_invoices', 'Cancelled Invoices', { status: 'Cancelled' }],
    [
      'monthly_billing',
      'Monthly Billing',
      { group: 'month', sum: 'grandTotal', billed: true },
    ],
    [
      'client_billing',
      'Client-wise Billing',
      { group: 'company', sum: 'grandTotal', billed: true },
    ],
    [
      'gst_summary',
      'Invoice GST Summary',
      { group: 'month', sum: 'gstAmount', billed: true },
    ],
  ],
  { extraPermission: 'reports.finance.invoices' },
);
add(
  'finance',
  'invoices',
  [
    [
      'billed_revenue',
      'Billed Revenue',
      { group: 'month', sum: 'grandTotal', billed: true },
    ],
    [
      'revenue_by_client',
      'Revenue by Client',
      { group: 'company', sum: 'grandTotal', billed: true },
    ],
  ],
  {
    extraPermission: 'reports.finance.revenue',
    description:
      'Issued invoice totals including GST; drafts and cancelled invoices excluded. Not cash collections. Existing invoices are INR-only.',
  },
);
add(
  'finance',
  'invoices',
  [
    [
      'collected_revenue',
      'Paid Invoice Value',
      { status: 'Paid', group: 'month', sum: 'grandTotal' },
    ],
  ],
  {
    extraPermission: 'reports.finance.payments',
    description:
      'Full value of invoices marked Paid, grouped by invoice date. The ERP has no receipt-date or partial-payment ledger; this is not a cash-flow report.',
  },
);
add(
  'finance',
  'aging',
  [
    ['outstanding_aging', 'Outstanding Aging'],
    [
      'client_outstanding',
      'Client Outstanding',
      { group: 'company', sum: 'outstanding' },
    ],
    ['overdue_invoices', 'Overdue Invoices', { overdue: true }],
    ['due_today', 'Due Today', { dueToday: true }],
    ['upcoming_due', 'Upcoming Due', { upcoming: true }],
  ],
  {
    extraPermission: 'reports.finance.outstanding',
    description:
      'Unpaid issued invoice value. Aging uses due date in IST. No partial-payment ledger exists.',
  },
);
add(
  'finance',
  'quotations',
  [
    ['quotation_register', 'Quotation Register'],
    ['draft_quotations', 'Draft Quotations', { status: 'Draft' }],
    ['sent_quotations', 'Sent Quotations', { status: 'Sent' }],
    ['accepted_quotations', 'Accepted Quotations', { status: 'Accepted' }],
    ['rejected_quotations', 'Rejected Quotations', { status: 'Rejected' }],
    ['expired_quotations', 'Expired Quotations', { status: 'Expired' }],
    [
      'quotation_conversion',
      'Quotation Status Distribution',
      { group: 'status' },
    ],
    [
      'sales_quotations',
      'Salesperson Quotation Value',
      { group: 'salesPerson', sum: 'grandTotal' },
    ],
    [
      'service_quotation_value',
      'Primary Service Quotation Value',
      { group: 'service', sum: 'grandTotal' },
    ],
  ],
  { extraPermission: 'reports.finance.quotations' },
);
add(
  'crm',
  'leads',
  [
    [
      'expected_revenue',
      'Expected Lead Value',
      { group: 'stage', sum: 'estimatedBudget', open: true },
    ],
    [
      'won_deal_value',
      'Won Deal Value',
      { stage: 'WON', group: 'assignedTo', sum: 'estimatedBudget' },
    ],
  ],
  {
    extraPermission: 'reports.crm.leads',
    description:
      'Estimated lead budgets, separated by currency. Not invoiced or collected revenue.',
  },
);
add(
  'management',
  'employees',
  [
    [
      'management_headcount',
      'Employee Headcount Overview',
      { group: 'department' },
    ],
  ],
  { extraPermission: 'reports.hr.employees' },
);
add('management', 'tasks', [
  ['business_overview', 'Business Delivery Overview', { group: 'status' }],
]);
add('management', 'projects', [
  ['project_health', 'Project Health', { group: 'status' }],
]);
add(
  'management',
  'leads',
  [['sales_conversion', 'Sales Conversion Overview', { group: 'stage' }]],
  { extraPermission: 'reports.crm.leads' },
);
add(
  'management',
  'invoices',
  [
    [
      'revenue_overview',
      'Revenue Overview',
      { group: 'month', sum: 'grandTotal', billed: true },
    ],
    [
      'top_clients',
      'Client Billing Overview',
      { group: 'company', sum: 'grandTotal', billed: true },
    ],
  ],
  { extraPermission: 'reports.finance.revenue' },
);
add(
  'management',
  'aging',
  [
    [
      'outstanding_overview',
      'Outstanding Overview',
      { group: 'bucket', sum: 'outstanding' },
    ],
  ],
  { extraPermission: 'reports.finance.outstanding' },
);
for (const [category, key, title, reason, extraPermission] of [
  [
    'finance',
    'expense_register',
    'Expense Reports',
    'No expense/vendor-cost ledger exists in this ERP.',
    'reports.finance.expenses',
  ],
  [
    'finance',
    'profitability',
    'Profitability Reports',
    'Actual cost allocation is unavailable; profit and margins cannot be calculated.',
    'reports.finance.profitability',
  ],
  [
    'finance',
    'payment_collections',
    'Payment Collection Ledger',
    'Receipt dates, payment methods and partial-payment records are not stored.',
    'reports.finance.payments',
  ],
  [
    'projects',
    'project_deadlines',
    'Project Deadline Reports',
    'Projects store billing dates, not delivery deadlines or milestones.',
  ],
  [
    'projects',
    'estimated_actual_hours',
    'Estimated vs Actual Hours',
    'Task estimates and actual project hours are not recorded together.',
  ],
  [
    'hr',
    'probation_employees',
    'Probation / Notice Period',
    'Employee profiles do not store probation or notice-period state.',
    'reports.hr.employees',
  ],
  [
    'hr',
    'absent_attendance',
    'Absent Report',
    'Absence requires work calendars and expected shifts; missing check-ins are not treated as absence.',
    'reports.hr.attendance',
  ],
])
  reportRegistry.push({
    key,
    category,
    title,
    description: reason,
    unavailable: reason,
    permission: `reports.${category}.view`,
    extraPermission,
    columns: [],
    filters: [],
    exportOptions: [],
  });
for (const [key, source, columns, description] of [
  ['expense_register', 'finance_expenses', ['expenseId','date','category','vendor','amountMinor','taxMinor','totalMinor','status','department'], 'Live expense register. Amounts are integer INR paise.'],
  ['payment_collections', 'finance_payments', ['paymentId','invoice','date','amountMinor','method','status','reversedAt'], 'Actual payment receipts and reversal status. Amounts are integer INR paise.'],
]) {
  const entry = reportRegistry.find((report) => report.key === key);
  Object.assign(entry, { source, columns, description, filters: ['from','to','status','department'], allowedScopes: ['OWN','TEAM','DEPARTMENT','ALL'], exportOptions: ['csv','xlsx','pdf'], preset: {} });
  delete entry.unavailable;
}
reportRegistry.find((report) => report.key === 'profitability').description = reportRegistry.find((report) => report.key === 'profitability').unavailable = 'Full salary/overhead cost coverage is incomplete. Finance → Profitability shows recorded direct contribution without claiming net profit.';
export const findReport = (key) =>
  reportRegistry.find((report) => report.key === key);
export const reportPermissionNames = [
  ...new Set([
    'reports.view',
    'reports.generate',
    'reports.export',
    'reports.schedule',
    'reports.manage_templates',
    'reports.manage_access',
    ...reportRegistry
      .flatMap((report) => [report.permission, report.extraPermission])
      .filter(Boolean),
    ...Object.keys(reportCategories).flatMap((category) =>
      ['all', 'team', 'own', 'department', 'assigned', 'export'].map(
        (scope) => `reports.${category}.${scope}`,
      ),
    ),
  ]),
];
