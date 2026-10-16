import { beforeAll, afterAll, expect, test } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
let database,
  app,
  User,
  EmployeeProfile,
  TeamTask,
  TeamSprint,
  TeamStandup,
  users = {},
  tokens = {};
const origin = 'http://localhost:5173';
const call = (method, path, actor, body) => {
  const agent = request(app);
  return agent[method](`/api/v1/team${path}`)
    .set('Origin', origin)
    .auth(tokens[actor] || 'invalid', { type: 'bearer' })
    .send(body);
};
beforeAll(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGO_URI: database.getUri(),
    CLIENT_URL: origin,
    JWT_ACCESS_SECRET: 't'.repeat(64),
    JWT_REFRESH_SECRET: 'u'.repeat(64),
    COOKIE_SECURE: 'false',
  });
  ({ app } = await import('../src/app.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ EmployeeProfile } = await import('../src/models/EmployeeProfile.js'));
  ({ TeamTask, TeamSprint, TeamStandup } =
    await import('../src/models/TeamWork.js'));
  await mongoose.connect(database.getUri());
  const { issueSession } = await import('../src/services/tokenService.js');
  for (const [key, role] of Object.entries({
    admin: 'admin',
    super: 'super_admin',
    manager: 'manager',
    leadA: 'team_leader',
    leadB: 'team_leader',
    memberA: 'employee',
    memberB: 'employee',
    hr: 'hr',
  })) {
    users[key] = await User.create({
      name: key,
      email: `${key}@team.test`,
      role,
      department: 'web_dev',
      passwordHash: 'not-used',
    });
    tokens[key] = (await issueSession(users[key])).accessToken;
  }
  await EmployeeProfile.create([
    { user: users.memberA.id, employeeCode: 'TEAM-A', manager: users.leadA.id },
    { user: users.memberB.id, employeeCode: 'TEAM-B', manager: users.leadB.id },
  ]);
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
}, 120000);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
const taskBody = () => ({
  title: 'Implement sprint feature',
  description: 'Build the assigned feature',
  assignedTo: users.memberA.id,
  sprint: null,
  status: 'TODO',
  priority: 'HIGH',
  points: 5,
  dueDate: null,
  blocker: '',
  acceptanceCriteria: 'Review and tests pass',
});

test('team scopes, task ownership, blocker validation and concurrent edit protection', async () => {
  expect((await call('get', '/workspace', 'missing')).status).toBe(401);
  expect((await call('get', '/workspace', 'hr')).status).toBe(403);
  expect((await call('get', '/workspace', 'memberA')).status).toBe(403);
  expect(
    (await call('get', `/workspace?leader=${users.leadB.id}`, 'leadA')).status,
  ).toBe(403);
  expect(
    (
      await call('post', '/tasks', 'leadA', {
        ...taskBody(),
        assignedTo: users.memberB.id,
      })
    ).status,
  ).toBe(403);
  const created = await call('post', '/tasks', 'leadA', taskBody());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const task = created.body.data;
  expect(
    (
      await call('patch', `/my-tasks/${task._id}`, 'memberB', {
        status: 'DONE',
        blocker: '',
        version: 0,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('patch', `/my-tasks/${task._id}`, 'memberA', {
        status: 'BLOCKED',
        blocker: '',
        version: 0,
      })
    ).status,
  ).toBe(400);
  const blocked = await call('patch', `/my-tasks/${task._id}`, 'memberA', {
    status: 'BLOCKED',
    blocker: 'Need API access',
    version: 0,
  });
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
  expect(
    (
      await call('patch', `/tasks/${task._id}`, 'leadA', {
        status: 'DONE',
        version: 0,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('patch', `/my-tasks/${task._id}`, 'memberA', {
        status: 'DONE',
        blocker: '',
        assignedTo: users.memberB.id,
        version: 1,
      })
    ).status,
  ).toBe(400);
  expect((await call('get', '/tasks', 'leadB')).body.data.items).toHaveLength(
    0,
  );
  const workspace = await call('get', '/workspace', 'leadA');
  expect(workspace.body.data.members.map((member) => member._id)).toEqual([
    users.memberA.id,
  ]);
  expect(JSON.stringify(workspace.body)).not.toContain('passwordHash');
  expect(
    (await call('get', '/my-work', 'memberA')).body.data.tasks,
  ).toHaveLength(1);
});

test('sprints timebox work, lock history and carry unfinished tasks into backlog', async () => {
  const planned = await call('post', '/sprints', 'leadA', {
    title: 'Sprint One',
    goal: 'Ship the feature',
    startDate: '2026-10-16',
    endDate: '2026-10-30',
  });
  expect(planned.status).toBe(201);
  const sprint = planned.body.data;
  const created = await call('post', '/tasks', 'leadA', {
    ...taskBody(),
    sprint: sprint._id,
  });
  const task = created.body.data;
  expect(
    (
      await call('post', `/sprints/${sprint._id}/action`, 'leadA', {
        action: 'start',
      })
    ).status,
  ).toBe(200);
  expect((await TeamSprint.findById(sprint._id)).committedPoints).toBe(5);
  const second = await call('post', '/sprints', 'leadA', {
    title: 'Sprint Two',
    goal: '',
    startDate: '2026-11-01',
    endDate: '2026-11-15',
  });
  expect(
    (
      await call('post', `/sprints/${second.body.data._id}/action`, 'leadA', {
        action: 'start',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('patch', `/my-tasks/${task._id}`, 'memberA', {
        status: 'DONE',
        blocker: '',
        version: 0,
      })
    ).status,
  ).toBe(200);
  const unfinished = await call('post', '/tasks', 'leadA', {
    ...taskBody(),
    title: 'Unfinished task',
    sprint: sprint._id,
    points: 3,
  });
  expect(
    (
      await call('post', `/sprints/${sprint._id}/action`, 'leadA', {
        action: 'complete',
        wentWell: 'Collaboration',
        improve: 'Estimation',
        actions: 'Smaller stories',
      })
    ).status,
  ).toBe(200);
  expect((await TeamSprint.findById(sprint._id)).completedPoints).toBe(5);
  expect((await TeamTask.findById(unfinished.body.data._id)).sprint).toBeNull();
  expect(
    (
      await call('patch', `/my-tasks/${task._id}`, 'memberA', {
        status: 'TODO',
        blocker: '',
        version: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call('post', `/sprints/${second.body.data._id}/action`, 'leadA', {
        action: 'start',
      })
    ).status,
  ).toBe(200);
});

test('stand-ups and team assignment reuse reporting relationships with restricted access', async () => {
  const body = {
    leader: users.leadA.id,
    yesterday: 'Design complete',
    today: 'Implementation',
    blockers: 'Need review',
  };
  expect((await call('post', '/standups', 'memberB', body)).status).toBe(403);
  expect((await call('post', '/standups', 'memberA', body)).status).toBe(200);
  expect(
    (await call('post', '/standups', 'memberA', { ...body, today: 'Tests' }))
      .status,
  ).toBe(200);
  expect(await TeamStandup.countDocuments({ employee: users.memberA.id })).toBe(
    1,
  );
  expect(
    (await call('post', '/members', 'leadA', { employee: users.memberB.id }))
      .status,
  ).toBe(403);
  const moved = await call(
    'post',
    `/members?leader=${users.leadB.id}`,
    'admin',
    { employee: users.memberA.id },
  );
  expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  expect(
    (
      await EmployeeProfile.findOne({ user: users.memberA.id })
    ).manager.toString(),
  ).toBe(users.leadB.id);
  expect(
    await TeamTask.countDocuments({
      leader: users.leadA.id,
      assignedTo: users.memberA.id,
      status: { $ne: 'DONE' },
    }),
  ).toBe(0);
  expect((await call('post', '/standups', 'memberA', body)).status).toBe(403);
});

test('Team Leaders retain employee attendance/reporting and monitoring but lose CRM and HR administration, including stale grants', async () => {
  const { Role } = await import('../src/models/Role.js');
  await Role.updateOne({ name: 'team_leader' }, { $set: { label: 'Team Leader', permissions: ['*', 'crm.leads.view', 'hrms.read', 'hrms.approve', 'users.read'] } }, { upsert: true });
  const own = (method, path, body) => { const agent = request(app); return agent[method](`/api/v1${path}`).set('Origin', origin).auth(tokens.leadA, { type: 'bearer' }).send(body); };
  const me = await own('get', '/auth/me');
  expect(me.body.data.permissions).toContain('hrms.self');
  expect(me.body.data.permissions).toContain('team.workspace.manage');
  expect(me.body.data.permissions).not.toContain('*');
  expect(me.body.data.permissions.some((value) => value.startsWith('crm.'))).toBe(false);
  for (const path of ['/crm/leads', '/crm/dashboard', '/hrms/dashboard', '/hrms/employees', '/hrms/approvals/pending', '/users']) expect((await own('get', path)).status).toBe(403);
  expect((await call('get', '/workspace', 'leadA')).status).toBe(200);
  const dashboard = await own('get', '/hrms/employee-dashboard');
  expect(dashboard.status).toBe(200); expect(dashboard.body.data.employee.id).toBe(users.leadA.id);
  expect((await own('post', '/hrms/attendance/check-in', {})).status).toBe(201);
  expect((await own('post', '/hrms/attendance/check-out', {})).status).toBe(409);
  expect((await own('post', '/hrms/daily-reports', { summary: 'Completed team planning and reviewed delivery', completedTasks: ['Reviewed sprint board'], blockers: 'None' })).status).toBe(201);
  expect((await own('post', '/hrms/attendance/check-out', {})).status).toBe(200);
  const monitored = await request(app).get(`/api/v1/hrms/employees/${users.leadA.id}/monitoring`).auth(tokens.admin, { type: 'bearer' });
  expect(monitored.status).toBe(200); expect(monitored.body.data.summary.reportedDays).toBe(1);
});

test('employee task updates, reassignment and archiving stay synchronized with the Team Leader board', async () => {
  const created = await call('post', '/tasks', 'leadB', { ...taskBody(), title: 'Shared delivery task' });
  expect(created.status).toBe(201); const assigned = created.body.data;
  const employeeTasks = await call('get', '/my-work?limit=6', 'memberA');
  expect(employeeTasks.body.data.tasks.some((item) => item._id === assigned._id)).toBe(true);
  expect(employeeTasks.body.data.pagination.limit).toBe(6);
  expect((await call('patch', `/my-tasks/${assigned._id}`, 'memberA', { status: 'REVIEW', blocker: '', version: 0 })).status).toBe(200);
  const board = await call('get', '/tasks', 'leadB');
  expect(board.body.data.items.find((item) => item._id === assigned._id).status).toBe('REVIEW');
  expect((await call('post', '/standups', 'memberA', { leader: users.leadB.id, yesterday: 'Completed shared task', today: 'Address review comments', blockers: '' })).status).toBe(200);
  const team = await call('get', '/workspace', 'leadB');
  expect(team.body.data.standups.some((item) => item.employee._id === users.memberA.id && item.today === 'Address review comments')).toBe(true);
  expect((await call('patch', `/tasks/${assigned._id}`, 'leadB', { assignedTo: users.memberB.id, version: 1 })).status).toBe(200);
  expect((await call('get', '/my-work', 'memberA')).body.data.tasks.some((item) => item._id === assigned._id)).toBe(false);
  expect((await call('get', '/my-work', 'memberB')).body.data.tasks.some((item) => item._id === assigned._id)).toBe(true);
  expect((await call('patch', `/my-tasks/${assigned._id}`, 'memberA', { status: 'DONE', blocker: '', version: 2 })).status).toBe(404);
  expect((await call('patch', `/my-tasks/${assigned._id}`, 'memberB', { status: 'BLOCKED', blocker: 'Need final review', version: 2 })).status).toBe(200);
  const { Notification } = await import('../src/models/Notification.js');
  expect(await Notification.exists({ recipient: users.leadB.id, type: 'team_task_progress', entityId: assigned._id })).toBeTruthy();
  expect(await Notification.exists({ recipient: users.memberB.id, type: 'team_task_assigned', link: '/employee#tasks' })).toBeTruthy();
  expect((await call('delete', `/tasks/${assigned._id}`, 'leadB', { version: 3 })).status).toBe(200);
  expect((await call('get', '/my-work', 'memberB')).body.data.tasks.some((item) => item._id === assigned._id)).toBe(false);
});

test('company administrators cannot open or operate the Team Leader workspace', async () => {
  for (const actor of ['admin', 'super', 'manager', 'hr']) {
    expect((await call('get', '/workspace', actor)).status).toBe(403);
    expect((await call('get', '/leaders', actor)).status).toBe(403);
    expect((await call('get', '/tasks', actor)).status).toBe(403);
    expect((await call('post', '/tasks', actor, taskBody())).status).toBe(403);
  }
});
