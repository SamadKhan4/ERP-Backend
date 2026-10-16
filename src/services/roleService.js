import {
  roles,
  roleDefinitions,
  rolePermissionDefaults,
} from '../constants/roles.js';
import { Role } from '../models/Role.js';
import { User } from '../models/User.js';

export async function syncRoles() {
  if (await User.exists({ role: { $nin: roles } })) {
    throw new Error(
      'Users have retired roles. Assign them a supported role and department before syncing; no automatic privilege migration is performed.',
    );
  }
  for (const { name, label } of roleDefinitions) {
    if (name === 'team_leader') {
      await Role.updateOne({ name }, { $set: { label, permissions: rolePermissionDefaults[name] }, $setOnInsert: { name } }, { upsert: true, runValidators: true });
      continue;
    }
    await Role.updateOne(
      { name },
      {
        $set: { label },
        $addToSet: {
          permissions: { $each: rolePermissionDefaults[name] || [] },
        },
        $setOnInsert: {
          name,
        },
      },
      { upsert: true, runValidators: true },
    );
  }
  await Role.deleteMany({ name: { $nin: roles } });
}
