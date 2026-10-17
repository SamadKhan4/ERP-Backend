export const financePermissions = [
  'finance.dashboard.view',
  ...['view', 'create', 'edit', 'cancel', 'export'].map(
    (action) => `finance.invoices.${action}`,
  ),
  ...['view', 'create', 'reverse', 'export'].map(
    (action) => `finance.payments.${action}`,
  ),
  'finance.outstanding.view',
  'finance.followups.manage',
  ...['view', 'create', 'edit', 'approve'].map(
    (action) => `finance.expenses.${action}`,
  ),
  'finance.ledger.view',
  'finance.recurring.view',
  'finance.recurring.manage',
  'finance.profitability.view',
  'finance.reports.view',
  'finance.reports.export',
  'finance.settings.manage',
  ...['own', 'team', 'department', 'assigned', 'all'].map(
    (scope) => `finance.scope.${scope}`,
  ),
];
