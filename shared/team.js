export const taskStatuses = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'REVIEW',
  'BLOCKED',
  'DONE',
];
export const taskPriorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const teamPermissions = [
  'team.workspace.view',
  'team.workspace.manage',
  'team.members.manage',
  'team.tasks.self',
];
export const teamLabel = (value) =>
  String(value || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
