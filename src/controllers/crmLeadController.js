import { z } from 'zod';
import { Lead } from '../models/Lead.js';
import { User } from '../models/User.js';
import { CRMSettings } from '../models/CRMSettings.js';
import { Role } from '../models/Role.js';
import {
  stages,
  priorities,
  temperatures,
  sources,
  lostReasons,
  serviceCatalog,
} from '../../shared/crm.js';
import {
  createLeadSchema,
  updateLeadSchema,
  listSchema,
  objectId,
  stageSchema,
} from '../validators/crmValidator.js';
import * as service from '../services/crmLeadService.js';
import {
  leadScope,
  has,
  validateAssignee,
} from '../services/crmAccessService.js';
import { transaction } from '../services/crmTransactionService.js';

export async function metadata(req, res) {
  leadScope(req);
  const settings = await CRMSettings.findById('crm').lean();
  res.json({
    success: true,
    data: {
      stages,
      priorities,
      temperatures,
      sources: settings?.sources || sources,
      lostReasons: settings?.lostReasons || lostReasons,
      serviceCatalog,
      tags: settings?.tags || [],
      stageLabels: settings?.stageLabels || {},
      defaultFollowUpDays: settings?.defaultFollowUpDays || 1,
      permissions: req.crmPermissions,
    },
  });
}
export async function assignees(req, res) {
  leadScope(req);
  const query = z
    .object({
      search: z.string().max(100).default(''),
      page: z.coerce.number().int().min(1).default(1),
    })
    .parse(req.query);
  const roles = await Role.find({
    permissions: {
      $in: ['*', 'crm.leads.view', 'crm.leads.view_own', 'crm.leads.view_team'],
    },
  })
    .select('name')
    .lean();
  const filter = {
    active: true,
    role: {
      $in: [
        ...new Set([
          'super_admin',
          'admin',
          'manager',
          'executive',
          ...roles.filter((role) => role.name !== 'team_leader').map((role) => role.name),
        ]),
      ],
    },
    ...(!has(req.crmPermissions, 'crm.leads.view')
      ? { _id: { $in: req.crmTeamIds } }
      : {}),
    ...(query.search
      ? { name: { $regex: service.escape(query.search), $options: 'i' } }
      : {}),
  };
  const items = await User.find(filter)
    .select('_id name role')
    .sort({ name: 1 })
    .skip((query.page - 1) * 50)
    .limit(50)
    .lean();
  res.json({
    success: true,
    data: { items, nextPage: items.length === 50 ? query.page + 1 : null },
  });
}
export async function list(req, res) {
  const query = listSchema.parse(req.query);
  const filter = service.leadFilter(req, query);
  const [items, total] = await Promise.all([
    Lead.find(filter)
      .select('-companyKey -attachments.storageName -__v')
      .populate('assignedTo', 'name')
      .sort({ [query.sort]: query.order === 'asc' ? 1 : -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    Lead.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
  });
}
export async function get(req, res) {
  const lead = await service.findLead(req, req.params.id);
  await lead.populate('assignedTo createdBy', 'name');
  const data = lead.toObject();
  delete data.companyKey;
  delete data.__v;
  data.attachments = data.attachments.map(({ storageName, ...attachment }) => {
    void storageName;
    return attachment;
  });
  res.json({ success: true, data });
}
export async function duplicates(req, res) {
  const query = z
    .object({
      companyName: z.string().max(160).default(''),
      phone: z.string().max(30).default(''),
      email: z.string().max(254).default(''),
    })
    .parse(req.query);
  const candidates = [
    { companyKey: query.companyName.toLowerCase() },
    ...(query.phone ? [{ phone: query.phone.replace(/[^\d+]/g, '') }] : []),
    ...(query.email ? [{ email: query.email.toLowerCase() }] : []),
  ];
  const items = await Lead.find({
    deletedAt: null,
    ...leadScope(req),
    $or: candidates,
  })
    .select('_id leadId companyName')
    .limit(10)
    .lean();
  res.json({ success: true, data: { items } });
}
export async function create(req, res) {
  res
    .status(201)
    .json({
      success: true,
      message: 'Lead created successfully',
      data: await service.createLead(req, createLeadSchema.parse(req.body)),
    });
}
export async function update(req, res) {
  res.json({
    success: true,
    message: 'Lead updated successfully',
    data: await service.updateLead(req, updateLeadSchema.parse(req.body)),
  });
}
export async function stage(req, res) {
  res.json({
    success: true,
    message: 'Stage updated successfully',
    data: await service.changeStage(req, stageSchema.parse(req.body)),
  });
}
export async function archive(req, res) {
  await service.archiveLead(req);
  res.json({ success: true, message: 'Lead archived' });
}
export async function assign(req, res) {
  const { assignedTo } = z
    .object({ assignedTo: objectId })
    .strict()
    .parse(req.body);
  await validateAssignee(req, assignedTo);
  const data = await transaction(async (session) => {
    const lead = await service.findLead(req, req.params.id, session);
    await service.assignLead(req, lead, assignedTo, session);
    return lead;
  });
  res.json({ success: true, message: 'Lead assigned', data });
}
export async function bulkAssign(req, res) {
  const { ids, assignedTo } = z
    .object({ ids: z.array(objectId).min(1).max(100), assignedTo: objectId })
    .strict()
    .parse(req.body);
  await validateAssignee(req, assignedTo);
  await transaction(async (session) => {
    for (const value of [...new Set(ids)]) {
      const lead = await service.findLead(req, value, session);
      await service.assignLead(req, lead, assignedTo, session);
    }
  });
  res.json({
    success: true,
    message: 'Selected leads assigned',
    data: { count: new Set(ids).size },
  });
}
