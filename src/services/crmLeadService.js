import { Lead } from '../models/Lead.js';
import { Quotation } from '../models/Quotation.js';
import { CRMSettings } from '../models/CRMSettings.js';
import { Notification } from '../models/Notification.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { sources, lostReasons } from '../../../shared/crm.js';
import { AppError } from '../utils/errors.js';
import { has, id, leadScope, validateAssignee } from './crmAccessService.js';
import {
  transaction,
  numberFor,
  recordChange,
} from './crmTransactionService.js';

export const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function findLead(req, value, session) {
  const lead = await Lead.findOne({
    _id: id(value),
    deletedAt: null,
    ...leadScope(req),
  }).session(session || null);
  if (!lead) throw new AppError(404, 'Lead not found or access denied');
  return lead;
}
export function leadFilter(req, query) {
  const filter = { deletedAt: null, ...leadScope(req) };
  const and = [];
  if (query.assignedTo) and.push({ assignedTo: id(query.assignedTo) });
  for (const [key, field] of Object.entries({
    stage: 'stage',
    source: 'leadSource',
    priority: 'priority',
    temperature: 'temperature',
    service: 'interestedServices',
    city: 'address.city',
  }))
    if (query[key]) filter[field] = query[key];
  if (query.search)
    and.push({
      $or: [
        'leadId',
        'companyName',
        'contactPerson',
        'phone',
        'whatsapp',
        'email',
      ].map((field) => ({
        [field]: { $regex: escape(query.search), $options: 'i' },
      })),
    });
  for (const [field, from, to] of [
    ['createdAt', query.from, query.to],
    ['nextFollowUpAt', query.followFrom, query.followTo],
    ['expectedClosingDate', query.closeFrom, query.closeTo],
  ]) {
    if (from || to)
      filter[field] = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
  }
  if (and.length) filter.$and = and;
  return filter;
}
export async function validateSource(value) {
  const settings = await CRMSettings.findById('crm').lean();
  if (!(settings?.sources || sources).includes(value))
    throw new AppError(400, 'Unknown lead source');
}
export async function validateLoss(input) {
  if (input.stage !== 'LOST') return;
  const settings = await CRMSettings.findById('crm').lean();
  if (!(settings?.lostReasons || lostReasons).includes(input.lostReason))
    throw new AppError(400, 'Select a lost reason');
  if (input.lostReason === 'Other' && !input.lostDetail?.trim())
    throw new AppError(400, 'Describe the lost reason');
}
export async function notifyAssignment(req, lead, previous, session) {
  if (!lead.assignedTo || String(previous) === String(lead.assignedTo)) return;
  await Notification.create(
    [
      {
        recipient: lead.assignedTo,
        type: 'crm_assigned',
        title: previous ? 'Lead reassigned to you' : 'New lead assigned',
        message: `${lead.leadId}: ${lead.companyName}`,
        link: `/crm/leads/${lead._id}`,
        entityType: 'lead',
        entityId: lead._id,
        createdBy: req.user._id,
      },
    ],
    { session },
  );
}
export async function syncNextFollowUp(lead, session) {
  const next = await CRMFollowUp.findOne({
    lead: lead._id,
    deletedAt: null,
    status: 'PENDING',
  })
    .sort({ scheduledAt: 1 })
    .session(session);
  lead.nextFollowUpAt = next?.scheduledAt || null;
}
async function scheduleInitial(req, lead, scheduledAt, session) {
  if (!scheduledAt) return;
  if (!lead.assignedTo)
    throw new AppError(400, 'Assign an owner before scheduling a follow-up');
  await CRMFollowUp.create(
    [
      {
        followUpId: await numberFor('crm-followup', 'ADB/FUP/', session),
        lead: lead._id,
        assignedTo: lead.assignedTo,
        type: 'CALL',
        scheduledAt,
        priority: lead.priority,
        notes: 'Initial lead follow-up',
        createdBy: req.user._id,
      },
    ],
    { session },
  );
  await recordChange(
    req,
    lead,
    'FOLLOW_UP',
    'Initial follow-up scheduled',
    { scheduledAt },
    session,
  );
}
export async function createLead(req, input, internal = {}) {
  await validateSource(input.leadSource);
  await validateLoss(input);
  const assignedTo = input.assignedTo || req.user.id;
  if (
    String(assignedTo) !== req.user.id &&
    !has(req.crmPermissions, 'crm.leads.assign')
  )
    throw new AppError(403, 'Assignment permission required');
  await validateAssignee(req, assignedTo);
  return transaction(async (session) => {
    const [lead] = await Lead.create(
      [
        {
          ...input,
          ...(internal.importKey ? { importKey: internal.importKey } : {}),
          assignedTo,
          status: input.stage,
          companyKey: input.companyName.toLowerCase(),
          leadId: await numberFor('crm-lead', 'ADB/LEAD/', session),
          createdBy: req.user._id,
          ...(input.stage === 'WON' ? { wonAt: new Date() } : {}),
          ...(input.stage === 'LOST' ? { lostAt: new Date() } : {}),
        },
      ],
      { session },
    );
    await recordChange(
      req,
      lead,
      'LEAD_CREATED',
      'Lead created',
      { companyName: lead.companyName, stage: lead.stage },
      session,
    );
    await notifyAssignment(req, lead, null, session);
    if (input.nextFollowUpAt) {
      if (!has(req.crmPermissions, 'crm.followups.create'))
        throw new AppError(403, 'Follow-up creation permission required');
      await scheduleInitial(req, lead, input.nextFollowUpAt, session);
    }
    await lead.save({ session });
    return lead;
  });
}
export async function updateLead(req, input) {
  if (input.leadSource) await validateSource(input.leadSource);
  if ('assignedTo' in input || 'nextFollowUpAt' in input)
    throw new AppError(
      400,
      'Use assignment or follow-up actions to change owner or schedule',
    );
  return transaction(async (session) => {
    const lead = await findLead(req, req.params.id, session);
    const before = Object.fromEntries(
      Object.keys(input).map((key) => [key, lead.get(key)]),
    );
    Object.assign(
      lead,
      input,
      input.companyName ? { companyKey: input.companyName.toLowerCase() } : {},
    );
    await recordChange(
      req,
      lead,
      'LEAD_UPDATED',
      'Lead updated',
      { before, after: input },
      session,
    );
    await lead.save({ session });
    return lead;
  });
}
export async function assignLead(req, lead, assignedTo, session) {
  const before = lead.assignedTo;
  lead.assignedTo = assignedTo;
  await CRMFollowUp.updateMany(
    { lead: lead._id, status: 'PENDING', deletedAt: null },
    { $set: { assignedTo } },
    { session },
  );
  await recordChange(
    req,
    lead,
    'ASSIGNED',
    'Lead owner changed',
    { oldOwner: before, newOwner: assignedTo },
    session,
  );
  await notifyAssignment(req, lead, before, session);
  await lead.save({ session });
}
export async function changeStage(req, input) {
  await validateLoss(input);
  return transaction(async (session) => {
    const lead = await findLead(req, req.params.id, session);
    if (lead.convertedClientId && input.stage !== 'WON')
      throw new AppError(409, 'Converted leads must remain won');
    const before = lead.stage;
    lead.stage = lead.status = input.stage;
    if (input.stage === 'LOST')
      Object.assign(lead, {
        lostReason: input.lostReason,
        lostDetail: input.lostDetail,
        lostAt: new Date(),
      });
    if (input.stage === 'WON') {
      lead.wonAt = new Date();
      lead.probability = 100;
    }
    await recordChange(
      req,
      lead,
      ['WON', 'LOST', 'PROPOSAL_SENT'].includes(input.stage)
        ? input.stage
        : 'STATUS_CHANGED',
      `Stage changed to ${input.stage}`,
      {
        before,
        after: input.stage,
        lostReason: input.lostReason,
        lostDetail: input.lostDetail,
      },
      session,
    );
    if (input.stage === 'WON' && lead.assignedTo)
      await Notification.create(
        [
          {
            recipient: lead.assignedTo,
            type: 'crm_won',
            title: 'Lead won',
            message: `${lead.leadId}: ${lead.companyName}`,
            link: `/crm/leads/${lead.id}`,
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    await lead.save({ session });
    return lead;
  });
}
export async function archiveLead(req) {
  return transaction(async (session) => {
    const lead = await findLead(req, req.params.id, session);
    if (
      lead.convertedClientId ||
      (await Quotation.exists({ lead: lead._id }).session(session))
    )
      throw new AppError(
        409,
        'Converted or financially connected leads cannot be archived',
      );
    lead.deletedAt = new Date();
    lead.deletedBy = req.user._id;
    await CRMFollowUp.updateMany(
      { lead: lead._id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } },
      { session },
    );
    await recordChange(
      req,
      lead,
      'LEAD_UPDATED',
      'Lead archived',
      { deletedAt: lead.deletedAt },
      session,
    );
    await lead.save({ session });
  });
}
