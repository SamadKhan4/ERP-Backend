import mongoose from 'mongoose';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { Lead } from '../models/Lead.js';
import { Notification } from '../models/Notification.js';
import { transaction } from './crmTransactionService.js';
import { logger } from '../config/logger.js';
export async function sendCRMReminders() {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 60000);
  const records = await CRMFollowUp.find({
    deletedAt: null,
    status: 'PENDING',
    $or: [
      { scheduledAt: { $lte: soon, $gte: now }, notifiedAt: null },
      { scheduledAt: { $lt: now }, overdueNotifiedAt: null },
    ],
  })
    .select('_id')
    .limit(100)
    .lean();
  for (const record of records)
    await transaction(async (session) => {
      const followup = await CRMFollowUp.findOne({
        _id: record._id,
        status: 'PENDING',
        deletedAt: null,
      }).session(session);
      if (!followup) return;
      const overdue = followup.scheduledAt < now;
      const flag = overdue ? 'overdueNotifiedAt' : 'notifiedAt';
      if (followup[flag]) return;
      const lead = await Lead.findOne({
        _id: followup.lead,
        deletedAt: null,
      }).session(session);
      if (!lead) return;
      await Notification.create(
        [
          {
            recipient: followup.assignedTo,
            type: overdue ? 'crm_followup_overdue' : 'crm_followup_due',
            title: overdue ? 'Follow-up overdue' : 'Follow-up due soon',
            message: `${lead.leadId}: ${lead.companyName} · ${followup.type}`,
            link: `/crm/leads/${lead.id}`,
            entityType: 'crm-followup',
            entityId: followup._id,
          },
        ],
        { session },
      );
      followup[flag] = now;
      await followup.save({ session });
    });
}
export function startCRMReminders() {
  let running = false;
  const tick = async () => {
    if (running || mongoose.connection.readyState !== 1) return;
    running = true;
    try {
      await sendCRMReminders();
    } catch (error) {
      logger.error({ err: error }, 'CRM reminder delivery failed');
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
