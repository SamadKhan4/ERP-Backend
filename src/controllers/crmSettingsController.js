import { z } from 'zod';
import { CRMSettings } from '../models/CRMSettings.js';
import { Role } from '../models/Role.js';
import { AuditLog } from '../models/AuditLog.js';
import {
  crmPermissions,
  stages,
  sources,
  lostReasons,
} from '../../../shared/crm.js';
import {
  roles,
  roleDefinitions,
  rolePermissionDefaults,
} from '../constants/roles.js';
import { transaction } from '../services/crmTransactionService.js';
import { AppError } from '../utils/errors.js';
export async function getSettings(req, res) {
  const [settings, storedRoles] = await Promise.all([
    CRMSettings.findById('crm').lean(),
    Role.find().lean(),
  ]);
  res.json({
    success: true,
    data: {
      settings: settings || {
        sources,
        lostReasons,
        tags: [],
        stageLabels: {},
        defaultFollowUpDays: 1,
      },
      permissions: crmPermissions,
      roles: roleDefinitions.filter((role) => role.name !== 'team_leader').map((role) => ({
        ...role,
        defaults: (rolePermissionDefaults[role.name] || []).filter(
          (permission) => permission === '*' || permission.startsWith('crm.'),
        ),
        grants: (
          storedRoles.find((item) => item.name === role.name)?.permissions || []
        ).filter((permission) => permission.startsWith('crm.')),
      })),
    },
  });
}
export async function updateSettings(req, res) {
  const values = z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(100)
    .transform((items) => [...new Set(items)]);
  const input = z
    .object({
      sources: values,
      lostReasons: values.refine(
        (items) => items.includes('Other'),
        'Keep Other as a lost reason',
      ),
      tags: z.array(z.string().trim().min(1).max(60)).max(100),
      stageLabels: z.record(z.enum(stages), z.string().trim().min(1).max(80)),
      defaultFollowUpDays: z.coerce.number().int().min(1).max(365),
    })
    .strict()
    .parse(req.body);
  const data = await transaction(async (session) => {
    const result = await CRMSettings.findByIdAndUpdate(
      'crm',
      { $set: input },
      { upsert: true, new: true, session },
    );
    await AuditLog.create(
      [
        {
          user: req.user.id,
          action: 'crm.settings.updated',
          entityType: 'crm-settings',
          details: input,
        },
      ],
      { session },
    );
    return result;
  });
  res.json({ success: true, message: 'CRM settings saved', data });
}
export async function grantRole(req, res) {
  const name = z.enum(roles).parse(req.params.name);
  if (name === 'team_leader') throw new AppError(403, 'CRM access is disabled for Team Leaders');
  const { permissions } = z
    .object({
      permissions: z.array(z.enum(crmPermissions)).max(crmPermissions.length),
    })
    .strict()
    .parse(req.body);
  await transaction(async (session) => {
    const role = await Role.findOne({ name }).session(session);
    const previous = role?.permissions || [];
    await Role.findOneAndUpdate(
      { name },
      {
        $set: {
          label: roleDefinitions.find((item) => item.name === name).label,
          permissions: [
            ...new Set([
              ...previous.filter(
                (permission) => !permission.startsWith('crm.'),
              ),
              ...permissions,
            ]),
          ],
        },
      },
      { upsert: true, session },
    );
    await AuditLog.create(
      [
        {
          user: req.user.id,
          action: 'crm.role.grants_changed',
          entityType: 'role',
          details: { name, before: previous, after: permissions },
        },
      ],
      { session },
    );
  });
  res.json({
    success: true,
    message:
      'Additional CRM role grants updated; built-in defaults remain active',
  });
}
