import { expect, test, vi } from 'vitest';
import { roles } from '../src/constants/roles.js';
import { User } from '../src/models/User.js';
import { authorizeDepartment } from '../src/middleware/authorizeDepartment.js';

test('only the nine agreed roles are valid', () => {
  expect(roles).toEqual([
    'super_admin',
    'admin',
    'manager',
    'hr',
    'executive',
    'team_leader',
    'employee',
    'customer',
    'lead_caller',
  ]);
  for (const role of roles) {
    const user = new User({
      name: 'Test',
      email: 'test@example.test',
      passwordHash: 'test',
      role,
      department: 'sales',
    });
    expect(user.validateSync()).toBeUndefined();
  }
  const retired = new User({
    name: 'Test',
    email: 'test@example.test',
    passwordHash: 'test',
    role: 'hr_manager',
  });
  expect(retired.validateSync().errors.role).toBeTruthy();
});
test('team leaders require a department', () => {
  const user = new User({
    name: 'Test',
    email: 'test@example.test',
    passwordHash: 'test',
    role: 'team_leader',
  });
  expect(user.validateSync().errors.department).toBeTruthy();
});
test('department guard permits matching resources and rejects other departments', async () => {
  const guard = authorizeDepartment((req) => req.resource.department);
  const next = vi.fn();
  const req = {
    user: { role: 'team_leader', department: 'sales' },
    resource: { department: 'sales' },
  };
  await guard(req, {}, next);
  expect(next).toHaveBeenCalledOnce();
  req.resource.department = 'hr';
  await expect(guard(req, {}, next)).rejects.toMatchObject({ status: 403 });
  req.user.department = null;
  await expect(guard(req, {}, next)).rejects.toMatchObject({ status: 403 });
});
