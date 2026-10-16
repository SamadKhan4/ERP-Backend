import { z } from 'zod';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { followUpSchema } from '../validators/crmValidator.js';
import { followUpStatuses, priorities } from '../../shared/crm.js';
import { id } from '../services/crmAccessService.js';
import { findLead } from '../services/crmLeadService.js';
import { transaction } from '../services/crmTransactionService.js';
import {
  addFollowUp,
  followUpScope,
  indiaToday,
  joinedScope,
  mutateFollowUp,
} from '../services/crmFollowUpService.js';
export async function listFollowUps(req, res) {
  const query = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      tab: z
        .enum(['today', 'upcoming', 'overdue', 'completed', 'all'])
        .default('all'),
      status: z.enum(followUpStatuses).optional(),
    })
    .parse(req.query);
  const today = indiaToday();
  const tomorrow = new Date(today.getTime() + 86400000);
  const now = new Date();
  const base = {
    deletedAt: null,
    ...followUpScope(req),
    ...(req.params.id ? { lead: id(req.params.id) } : {}),
  };
  if (req.params.id) await findLead(req, req.params.id);
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...({
      today: { status: 'PENDING', scheduledAt: { $gte: today, $lt: tomorrow } },
      upcoming: { status: 'PENDING', scheduledAt: { $gte: tomorrow } },
      overdue: { status: 'PENDING', scheduledAt: { $lt: now } },
      completed: { status: 'COMPLETED' },
    }[query.tab] || {}),
  };
  const result = await CRMFollowUp.aggregate([
    { $match: base },
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
    {
      $facet: {
        items: [
          { $match: filter },
          { $sort: { scheduledAt: 1, _id: 1 } },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          {
            $lookup: {
              from: 'users',
              localField: 'assignedTo',
              foreignField: '_id',
              pipeline: [{ $project: { name: 1 } }],
              as: 'owner',
            },
          },
          {
            $project: {
              followUpId: 1,
              type: 1,
              scheduledAt: 1,
              priority: 1,
              notes: 1,
              outcome: 1,
              status: 1,
              completedAt: 1,
              assignedTo: { $arrayElemAt: ['$owner', 0] },
              lead: {
                _id: '$lead._id',
                leadId: '$lead.leadId',
                companyName: '$lead.companyName',
              },
            },
          },
        ],
        total: [{ $match: filter }, { $count: 'count' }],
        summary: [
          {
            $group: {
              _id: null,
              today: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$status', 'PENDING'] },
                        { $gte: ['$scheduledAt', today] },
                        { $lt: ['$scheduledAt', tomorrow] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              overdue: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$status', 'PENDING'] },
                        { $lt: ['$scheduledAt', now] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              upcoming: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$status', 'PENDING'] },
                        { $gte: ['$scheduledAt', tomorrow] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              completedToday: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$status', 'COMPLETED'] },
                        { $gte: ['$completedAt', today] },
                        { $lt: ['$completedAt', tomorrow] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);
  const total = result[0]?.total[0]?.count || 0;
  res.json({
    success: true,
    data: {
      items: result[0]?.items || [],
      summary: result[0]?.summary[0] || {},
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
  });
}
export async function createFollowUp(req, res) {
  const input = followUpSchema.parse({
    ...req.body,
    ...(req.params.id ? { lead: req.params.id } : {}),
  });
  const data = await transaction(async (session) => {
    const lead = await findLead(req, input.lead, session);
    return addFollowUp(req, lead, input, session);
  });
  res.status(201).json({ success: true, message: 'Follow-up scheduled', data });
}
const future = z.coerce
  .date()
  .refine((value) => value > new Date(), 'Choose a future date');
export async function completeFollowUp(req, res) {
  const input = z
    .object({
      outcome: z.string().trim().min(1).max(3000),
      nextFollowUpAt: future.optional(),
      nextNotes: z.string().max(3000).optional(),
    })
    .strict()
    .parse(req.body);
  res.json({
    success: true,
    message: 'Follow-up completed',
    data: await mutateFollowUp(req, 'complete', input),
  });
}
export async function rescheduleFollowUp(req, res) {
  const input = z
    .object({ scheduledAt: future, notes: z.string().max(3000).optional() })
    .strict()
    .parse(req.body);
  res.json({
    success: true,
    message: 'Follow-up rescheduled',
    data: await mutateFollowUp(req, 'reschedule', input),
  });
}
export async function editFollowUp(req, res) {
  const input = z
    .object({
      notes: z.string().max(3000).optional(),
      priority: z.enum(priorities).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0)
    .parse(req.body);
  res.json({
    success: true,
    message: 'Follow-up updated',
    data: await mutateFollowUp(req, 'edit', input),
  });
}
export async function cancelFollowUp(req, res) {
  res.json({
    success: true,
    message: 'Follow-up cancelled',
    data: await mutateFollowUp(req, 'cancel', {}),
  });
}
