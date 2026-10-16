import { Lead } from '../models/Lead.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { leadFilter } from './crmLeadService.js';
import {
  followUpScope,
  indiaToday,
  joinedScope,
} from './crmFollowUpService.js';
const countIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const eq = (value) => ({ $eq: ['$stage', value] });
const open = { $not: [{ $in: ['$stage', ['WON', 'LOST']] }] };
export async function analytics(req, query) {
  const now = new Date();
  const today = indiaToday();
  const tomorrow = new Date(today.getTime() + 86400000);
  const match = leadFilter(req, query);
  const [result, followups] = await Promise.all([
    Lead.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                new: countIf(eq('NEW')),
                open: countIf(open),
                qualified: countIf(eq('QUALIFIED')),
                won: countIf(eq('WON')),
                lost: countIf(eq('LOST')),
              },
            },
          ],
          currencies: [
            {
              $group: {
                _id: '$currency',
                pipelineValue: {
                  $sum: { $cond: [open, '$estimatedBudget', 0] },
                },
                wonValue: {
                  $sum: { $cond: [eq('WON'), '$estimatedBudget', 0] },
                },
              },
            },
          ],
          funnel: [{ $group: { _id: '$stage', count: { $sum: 1 } } }],
          sources: [
            {
              $group: {
                _id: '$leadSource',
                count: { $sum: 1 },
                won: countIf(eq('WON')),
              },
            },
            { $sort: { count: -1 } },
          ],
          performance: [
            {
              $group: {
                _id: { owner: '$assignedTo', currency: '$currency' },
                assigned: { $sum: 1 },
                new: countIf(eq('NEW')),
                contacted: countIf(eq('CONTACTED')),
                qualified: countIf(eq('QUALIFIED')),
                proposals: countIf(eq('PROPOSAL_SENT')),
                won: countIf(eq('WON')),
                lost: countIf(eq('LOST')),
                pipelineValue: {
                  $sum: { $cond: [open, '$estimatedBudget', 0] },
                },
                wonValue: {
                  $sum: { $cond: [eq('WON'), '$estimatedBudget', 0] },
                },
              },
            },
            { $sort: { assigned: -1 } },
            {
              $lookup: {
                from: 'users',
                localField: '_id.owner',
                foreignField: '_id',
                pipeline: [{ $project: { name: 1 } }],
                as: 'employee',
              },
            },
            {
              $set: {
                name: {
                  $ifNull: [
                    { $arrayElemAt: ['$employee.name', 0] },
                    'Unassigned',
                  ],
                },
              },
            },
            { $unset: 'employee' },
          ],
          trend: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: '%Y-%m',
                    date: '$createdAt',
                    timezone: 'Asia/Kolkata',
                  },
                },
                new: { $sum: 1 },
                won: countIf(eq('WON')),
                lost: countIf(eq('LOST')),
              },
            },
            { $sort: { _id: 1 } },
          ],
          services: [
            { $unwind: '$interestedServices' },
            {
              $group: {
                _id: '$interestedServices',
                count: { $sum: 1 },
                won: countIf(eq('WON')),
              },
            },
            { $sort: { count: -1 } },
          ],
          aging: [
            {
              $set: {
                age: {
                  $floor: {
                    $divide: [{ $subtract: [now, '$createdAt'] }, 86400000],
                  },
                },
                idle: {
                  $floor: {
                    $divide: [
                      {
                        $subtract: [
                          now,
                          { $ifNull: ['$lastActivityAt', '$createdAt'] },
                        ],
                      },
                      86400000,
                    ],
                  },
                },
              },
            },
            {
              $bucket: {
                groupBy: '$age',
                boundaries: [0, 8, 16, 31, 61],
                default: '60+',
                output: {
                  count: { $sum: 1 },
                  stale: countIf({ $and: [open, { $gte: ['$idle', 15] }] }),
                },
              },
            },
          ],
          losses: [
            { $match: { stage: 'LOST' } },
            { $group: { _id: '$lostReason', count: { $sum: 1 } } },
          ],
        },
      },
    ]),
    CRMFollowUp.aggregate([
      {
        $match: {
          deletedAt: null,
          ...followUpScope(req),
          ...(query.assignedTo
            ? {
                assignedTo: (await import('./crmAccessService.js')).id(
                  query.assignedTo,
                ),
              }
            : {}),
          ...(query.from || query.to
            ? {
                scheduledAt: {
                  ...(query.from ? { $gte: query.from } : {}),
                  ...(query.to ? { $lte: query.to } : {}),
                },
              }
            : {}),
        },
      },
      {
        $lookup: {
          from: 'leads',
          localField: 'lead',
          foreignField: '_id',
          as: 'lead',
        },
      },
      { $unwind: '$lead' },
      {
        $match: {
          ...joinedScope(req),
          ...(query.source ? { 'lead.leadSource': query.source } : {}),
          ...(query.service
            ? { 'lead.interestedServices': query.service }
            : {}),
          ...(query.stage ? { 'lead.stage': query.stage } : {}),
        },
      },
      {
        $group: {
          _id: '$assignedTo',
          total: { $sum: 1 },
          pending: countIf({ $eq: ['$status', 'PENDING'] }),
          completed: countIf({ $eq: ['$status', 'COMPLETED'] }),
          overdue: countIf({
            $and: [
              { $eq: ['$status', 'PENDING'] },
              { $lt: ['$scheduledAt', now] },
            ],
          }),
          today: countIf({
            $and: [
              { $eq: ['$status', 'PENDING'] },
              { $gte: ['$scheduledAt', today] },
              { $lt: ['$scheduledAt', tomorrow] },
            ],
          }),
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { name: 1 } }],
          as: 'employee',
        },
      },
      {
        $set: {
          name: {
            $ifNull: [{ $arrayElemAt: ['$employee.name', 0] }, 'Unassigned'],
          },
        },
      },
      { $unset: 'employee' },
    ]),
  ]);
  const data = result[0];
  const totals = data.totals[0] || {
    total: 0,
    new: 0,
    open: 0,
    qualified: 0,
    won: 0,
    lost: 0,
  };
  totals.conversionRate = totals.total
    ? Math.round((totals.won / totals.total) * 1000) / 10
    : 0;
  totals.followupsToday = followups.reduce((sum, item) => sum + item.today, 0);
  totals.overdueFollowups = followups.reduce(
    (sum, item) => sum + item.overdue,
    0,
  );
  for (const row of data.performance) {
    const follow = followups.find(
      (item) => String(item._id) === String(row._id.owner),
    );
    row.pendingFollowups = follow?.pending || 0;
    row.overdueFollowups = follow?.overdue || 0;
    row.conversionRate = row.assigned
      ? Math.round((row.won / row.assigned) * 1000) / 10
      : 0;
  }
  return {
    ...data,
    totals,
    followups,
    generatedAt: now,
    basis:
      'Lead metrics use leads created in the selected period. Follow-up metrics use scheduled dates in the selected period. Values remain separated by currency; no performance ranking is inferred.',
  };
}
