import { z } from 'zod';
import { LeadActivity } from '../models/LeadActivity.js';
import { activitySchema } from '../validators/crmValidator.js';
import { findLead } from '../services/crmLeadService.js';
import { id } from '../services/crmAccessService.js';
import { joinedScope } from '../services/crmFollowUpService.js';
import {
  recordChange,
  transaction,
} from '../services/crmTransactionService.js';
import { activityTypes } from '../../shared/crm.js';
export async function listActivities(req, res) {
  const { page, limit, type } = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      type: z.enum(activityTypes).optional(),
    })
    .parse(req.query);
  if (req.params.id) await findLead(req, req.params.id);
  const result = await LeadActivity.aggregate([
    ...(type ? [{ $match: { type } }] : []),
    ...(req.params.id ? [{ $match: { lead: id(req.params.id) } }] : []),
    {
      $lookup: {
        from: 'leads',
        localField: 'lead',
        foreignField: '_id',
        as: 'lead',
      },
    },
    { $unwind: '$lead' },
    { $match: joinedScope(req) },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        items: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: 'users',
              localField: 'performedBy',
              foreignField: '_id',
              pipeline: [{ $project: { name: 1 } }],
              as: 'actor',
            },
          },
          {
            $project: {
              type: 1,
              title: 1,
              description: 1,
              metadata: 1,
              createdAt: 1,
              actor: { $arrayElemAt: ['$actor', 0] },
              lead: {
                _id: '$lead._id',
                leadId: '$lead.leadId',
                companyName: '$lead.companyName',
              },
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);
  const total = result[0]?.total[0]?.count || 0;
  res.json({
    success: true,
    data: {
      items: result[0]?.items || [],
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
  });
}
export async function addActivity(req, res) {
  const input = activitySchema.parse(req.body);
  await transaction(async (session) => {
    const lead = await findLead(req, req.params.id, session);
    await recordChange(
      req,
      lead,
      input.type,
      input.title,
      input.scheduledAt ? { scheduledAt: input.scheduledAt } : {},
      session,
      input.description,
    );
    await lead.save({ session });
  });
  res
    .status(201)
    .json({ success: true, message: 'Activity logged successfully' });
}
