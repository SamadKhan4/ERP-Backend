import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { Lead } from '../models/Lead.js';
import { AppError } from '../utils/errors.js';
import { has, id, leadScope, validateAssignee } from './crmAccessService.js';
import { findLead, syncNextFollowUp } from './crmLeadService.js';
import {
  numberFor,
  recordChange,
  transaction,
} from './crmTransactionService.js';
export function followUpScope(req) {
  return has(req.crmPermissions, 'crm.followups.view')
    ? {}
    : { assignedTo: req.user._id };
}
export function joinedScope(req, prefix = 'lead') {
  return Object.fromEntries(
    Object.entries({ deletedAt: null, ...leadScope(req) }).map(
      ([key, value]) => [`${prefix}.${key}`, value],
    ),
  );
}
export const indiaToday = () => {
  const date = new Date(Date.now() + 330 * 60000);
  date.setUTCHours(0, 0, 0, 0);
  return new Date(date.getTime() - 330 * 60000);
};
export async function addFollowUp(req, lead, input, session) {
  const assignedTo = input.assignedTo || lead.assignedTo;
  if (!assignedTo)
    throw new AppError(400, 'Assign an owner before scheduling a follow-up');
  if (
    !has(req.crmPermissions, 'crm.followups.view') &&
    String(assignedTo) !== req.user.id
  )
    throw new AppError(403, 'You can only schedule your own follow-ups');
  if (
    String(assignedTo) !== String(lead.assignedTo) &&
    !has(req.crmPermissions, 'crm.leads.assign')
  )
    throw new AppError(403, 'Assignment permission required');
  await validateAssignee(req, assignedTo);
  const [followUp] = await CRMFollowUp.create(
    [
      {
        ...input,
        lead: lead._id,
        client: lead.convertedClientId,
        assignedTo,
        followUpId: await numberFor('crm-followup', 'ADB/FUP/', session),
        createdBy: req.user._id,
      },
    ],
    { session },
  );
  await recordChange(
    req,
    lead,
    'FOLLOW_UP',
    'Follow-up scheduled',
    {
      followUp: followUp._id,
      scheduledAt: followUp.scheduledAt,
      type: followUp.type,
    },
    session,
    input.notes,
  );
  await syncNextFollowUp(lead, session);
  await lead.save({ session });
  return followUp;
}
export async function mutateFollowUp(req, action, input) {
  return transaction(async (session) => {
    const followUp = await CRMFollowUp.findOne({
      _id: id(req.params.id),
      deletedAt: null,
      ...followUpScope(req),
    }).session(session);
    if (!followUp) throw new AppError(404, 'Follow-up not found');
    const lead = await findLead(req, followUp.lead, session);
    if (followUp.status !== 'PENDING')
      throw new AppError(409, 'Only pending follow-ups can be changed');
    const before = followUp.toObject();
    if (action === 'complete') {
      followUp.status = 'COMPLETED';
      followUp.completedAt = new Date();
      followUp.outcome = input.outcome;
      if (input.nextFollowUpAt) {
        if (!has(req.crmPermissions, 'crm.followups.create'))
          throw new AppError(403, 'Follow-up creation permission required');
        followUp.nextFollowUpAt = input.nextFollowUpAt;
        await addFollowUp(
          req,
          lead,
          {
            assignedTo: followUp.assignedTo,
            type: followUp.type,
            scheduledAt: input.nextFollowUpAt,
            notes: input.nextNotes || '',
            priority: followUp.priority,
          },
          session,
        );
      }
    } else if (action === 'reschedule') {
      followUp.status = 'RESCHEDULED';
      followUp.rescheduledFrom = followUp.scheduledAt;
      await addFollowUp(
        req,
        lead,
        {
          assignedTo: followUp.assignedTo,
          type: followUp.type,
          scheduledAt: input.scheduledAt,
          notes: input.notes || followUp.notes,
          priority: followUp.priority,
        },
        session,
      );
    } else if (action === 'cancel') {
      followUp.status = 'CANCELLED';
      followUp.outcome = input.outcome || 'Cancelled';
    } else {
      Object.assign(followUp, input);
    }
    await followUp.save({ session });
    await syncNextFollowUp(lead, session);
    await recordChange(
      req,
      lead,
      'FOLLOW_UP',
      `Follow-up ${action === 'edit' ? 'updated' : action === 'cancel' ? 'cancelled' : action === 'complete' ? 'completed' : 'rescheduled'}`,
      {
        followUp: followUp._id,
        before: { status: before.status, scheduledAt: before.scheduledAt },
        after: { status: followUp.status, scheduledAt: followUp.scheduledAt },
        outcome: input.outcome,
      },
      session,
    );
    await lead.save({ session });
    return followUp;
  });
}
export async function accessibleLeadForRecords(req, value) {
  return Lead.findOne({ _id: id(value), deletedAt: null, ...leadScope(req) });
}
