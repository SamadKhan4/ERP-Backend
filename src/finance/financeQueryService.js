import { Invoice } from '../models/Invoice.js';
import {
  FinancePayment,
  FinanceExpense,
  FinanceRecurring,
} from '../models/Finance.js';
import { financeScope, financeId } from './financeAccess.js';
import { minor } from './financeMoney.js';
export const indiaDay = () =>
  new Date(
    `${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}T00:00:00+05:30`,
  );
export const dateRange = (query, field) =>
  query.from || query.to
    ? {
        [field]: {
          ...(query.from ? { $gte: query.from } : {}),
          ...(query.to ? { $lt: new Date(query.to.getTime() + 86400000) } : {}),
        },
      }
    : {};
export function invoiceStages(
  req,
  query = {},
  { outstanding = false, range = true } = {},
) {
  const stages = [
    {
      $match: {
        $and: [
          { deletedAt: null },
          financeScope(req, 'invoices'),
          query.client ? { clientRef: financeId(query.client) } : {},
          query.project ? { project: financeId(query.project) } : {},
          range ? dateRange(query, 'invoiceDate') : {},
        ],
      },
    },
  ];
  stages.push({
    $set: {
      totalMinor: {
        $ifNull: [
          '$totalMinor',
          { $toLong: { $round: [{ $multiply: ['$grandTotal', 100] }, 0] } },
        ],
      },
    },
  });
  stages.push({
    $set: {
      paidMinor: {
        $ifNull: [
          '$paidMinor',
          { $cond: [{ $eq: ['$status', 'Paid'] }, '$totalMinor', 0] },
        ],
      },
      issued: { $not: [{ $in: ['$status', ['Draft', 'Cancelled']] }] },
    },
  });
  stages.push({
    $set: {
      settlementBalanceMinor: {
        $max: [0, { $subtract: ['$totalMinor', '$paidMinor'] }],
      },
      daysOverdue: {
        $max: [
          0,
          {
            $floor: {
              $divide: [{ $subtract: [indiaDay(), '$dueDate'] }, 86400000],
            },
          },
        ],
      },
    },
  });
  stages.push({
    $set: {
      balanceMinor: { $cond: ['$issued', '$settlementBalanceMinor', 0] },
      financeStatus: {
        $switch: {
          branches: [
            { case: { $eq: ['$status', 'Draft'] }, then: 'DRAFT' },
            { case: { $eq: ['$status', 'Cancelled'] }, then: 'CANCELLED' },
            { case: { $eq: ['$settlementBalanceMinor', 0] }, then: 'PAID' },
            { case: { $gt: ['$paidMinor', 0] }, then: 'PARTIALLY_PAID' },
            { case: { $lt: ['$dueDate', indiaDay()] }, then: 'OVERDUE' },
          ],
          default: 'SENT',
        },
      },
      bucket: {
        $switch: {
          branches: [30, 60, 90].map((days, index) => ({
            case: { $lte: ['$daysOverdue', days] },
            then: ['0–30', '31–60', '61–90'][index],
          })),
          default: '90+',
        },
      },
    },
  });
  const matches = [];
  if (query.status) matches.push({ financeStatus: query.status });
  if (outstanding) matches.push({ issued: true, balanceMinor: { $gt: 0 } });
  if (query.minAmount)
    matches.push({ totalMinor: { $gte: minor(query.minAmount) } });
  if (query.maxAmount)
    matches.push({ totalMinor: { $lte: minor(query.maxAmount) } });
  if (query.due === 'overdue' || query.due === 'severe')
    matches.push({
      issued: true,
      balanceMinor: { $gt: 0 },
      dueDate: {
        $lt:
          query.due === 'severe'
            ? new Date(indiaDay().getTime() - 90 * 86400000)
            : indiaDay(),
      },
    });
  if (query.due === 'today')
    matches.push({
      balanceMinor: { $gt: 0 },
      dueDate: {
        $gte: indiaDay(),
        $lt: new Date(indiaDay().getTime() + 86400000),
      },
    });
  if (query.due === 'upcoming')
    matches.push({
      balanceMinor: { $gt: 0 },
      dueDate: { $gte: new Date(indiaDay().getTime() + 86400000) },
    });
  if (query.search) {
    const regex = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matches.push({
      $or: [
        { invoiceNumber: { $regex: regex, $options: 'i' } },
        { 'client.company': { $regex: regex, $options: 'i' } },
      ],
    });
  }
  if (matches.length) stages.push({ $match: { $and: matches } });
  return stages;
}
const invoiceProjection = {
  subtotalMinor: 1,
  taxableMinor: 1,
  taxMinor: 1,
  cgstMinor: 1,
  sgstMinor: 1,
  igstMinor: 1,
  gstAmount: 1,
  gstin: 1,
  stateCode: 1,
  invoiceNumber: 1,
  clientRef: 1,
  'client.company': 1,
  'client.email': 1,
  invoiceDate: 1,
  dueDate: 1,
  totalMinor: 1,
  paidMinor: 1,
  balanceMinor: 1,
  financeStatus: 1,
  daysOverdue: 1,
  bucket: 1,
  project: 1,
  service: 1,
  revision: 1,
  recurringService: 1,
  createdAt: 1,
};
export async function queryFinanceInvoices(req, query, options = {}) {
  const page = query.page || 1,
    limit = query.limit || 20;
  const data = await Invoice.aggregate([
    ...invoiceStages(req, query, options),
    ...(options.issuedOnly ? [{ $match: { issued: true } }] : []),
    {
      $facet: {
        items: [
          {
            $sort: {
              [query.sort === 'date'
                ? 'invoiceDate'
                : query.sort || 'createdAt']: query.order === 'asc' ? 1 : -1,
              _id: 1,
            },
          },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $project: invoiceProjection },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]).option({ maxTimeMS: 20000 });
  const total = data[0].total[0]?.count || 0;
  return {
    items: data[0].items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}
export async function accessibleInvoiceIds(req) {
  return Invoice.distinct('_id', {
    deletedAt: null,
    ...financeScope(req, 'invoices'),
  });
}
export async function financeDashboard(req, query) {
  const invoiceIds = req.financeScope.ids
    ? await accessibleInvoiceIds(req)
    : null;
  const payMatch = {
    ...(invoiceIds ? { invoice: { $in: invoiceIds } } : {}),
    ...(query.client ? { client: financeId(query.client) } : {}),
  };
  const expenseMatch = {
    $and: [
      financeScope(req, 'expenses'),
      dateRange(query, 'date'),
      ...(query.department ? [{ department: query.department }] : []),
      ...(query.client ? [{ client: financeId(query.client) }] : []),
    ],
  };
  const month = (field) => ({
    $dateToString: { date: field, format: '%Y-%m', timezone: 'Asia/Kolkata' },
  });
  const [
    billed,
    receivables,
    payments,
    reversals,
    expenses,
    paidExpenses,
    recurring,
    recent,
    recentPayments,
  ] = await Promise.all([
    Invoice.aggregate([
      ...invoiceStages(req, query),
      { $match: { issued: true } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                billedMinor: { $sum: '$totalMinor' },
                count: { $sum: 1 },
                legacyPaidMinor: {
                  $sum: {
                    $ifNull: [
                      '$legacyPaidMinor',
                      {
                        $cond: [
                          {
                            $and: [
                              { $eq: ['$status', 'Paid'] },
                              {
                                $eq: [
                                  { $ifNull: ['$financeVersion', null] },
                                  null,
                                ],
                              },
                            ],
                          },
                          '$totalMinor',
                          0,
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ],
          months: [
            {
              $group: {
                _id: month('$invoiceDate'),
                billedMinor: { $sum: '$totalMinor' },
              },
            },
            { $sort: { _id: 1 } },
          ],
          services: [
            {
              $group: {
                _id: { $ifNull: ['$service', 'Unallocated'] },
                value: { $sum: '$totalMinor' },
              },
            },
            { $sort: { value: -1 } },
            { $limit: 10 },
          ],
          clients: [
            {
              $group: {
                _id: { $ifNull: ['$clientRef', '$client.company'] },
                company: { $first: '$client.company' },
                billedMinor: { $sum: '$totalMinor' },
                paidMinor: { $sum: '$paidMinor' },
                balanceMinor: { $sum: '$balanceMinor' },
              },
            },
            { $sort: { billedMinor: -1 } },
            { $limit: 8 },
          ],
          statuses: [{ $group: { _id: '$financeStatus', value: { $sum: 1 } } }],
        },
      },
    ]),
    Invoice.aggregate([
      ...invoiceStages(req, query, { range: false, outstanding: true }),
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                outstandingMinor: { $sum: '$balanceMinor' },
                overdueMinor: {
                  $sum: {
                    $cond: [
                      { $lt: ['$dueDate', indiaDay()] },
                      '$balanceMinor',
                      0,
                    ],
                  },
                },
                dueToday: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ['$dueDate', indiaDay()] },
                          {
                            $lt: [
                              '$dueDate',
                              new Date(indiaDay().getTime() + 86400000),
                            ],
                          },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                partiallyPaid: {
                  $sum: { $cond: [{ $gt: ['$paidMinor', 0] }, 1, 0] },
                },
              },
            },
          ],
          aging: [
            { $group: { _id: '$bucket', value: { $sum: '$balanceMinor' } } },
          ],
        },
      },
    ]),
    FinancePayment.aggregate([
      { $match: { ...payMatch, ...dateRange(query, 'paymentDate') } },
      {
        $group: {
          _id: month('$paymentDate'),
          receivedMinor: { $sum: '$amountMinor' },
        },
      },
    ]),
    FinancePayment.aggregate([
      {
        $match: {
          ...payMatch,
          status: 'REVERSED',
          ...dateRange(query, 'reversedAt'),
        },
      },
      {
        $group: {
          _id: month('$reversedAt'),
          reversedMinor: { $sum: '$amountMinor' },
        },
      },
    ]),
    FinanceExpense.aggregate([
      {
        $match: {
          $and: [expenseMatch, { status: { $in: ['APPROVED', 'PAID'] } }],
        },
      },
      {
        $facet: {
          totals: [
            { $group: { _id: null, expenseMinor: { $sum: '$totalMinor' } } },
          ],
          months: [
            {
              $group: {
                _id: month('$date'),
                expenseMinor: { $sum: '$totalMinor' },
              },
            },
          ],
          categories: [
            { $group: { _id: '$category', value: { $sum: '$totalMinor' } } },
          ],
        },
      },
    ]),
    FinanceExpense.aggregate([
      {
        $match: {
          $and: [
            financeScope(req, 'expenses'),
            { status: 'PAID' },
            dateRange(query, 'paidAt'),
          ],
        },
      },
      { $group: { _id: null, paidExpenseMinor: { $sum: '$totalMinor' } } },
    ]),
    FinanceRecurring.countDocuments({
      ...financeScope(req, 'recurring'),
      status: 'ACTIVE',
    }),
    queryFinanceInvoices(
      req,
      { ...query, page: 1, limit: 6, sort: 'dueDate', order: 'asc' },
      { outstanding: true, range: false },
    ),
    FinancePayment.find({ ...payMatch, ...dateRange(query, 'paymentDate') })
      .select('paymentId amountMinor paymentDate status method invoice')
      .sort({ paymentDate: -1 })
      .limit(6)
      .lean(),
  ]);
  const months = new Map();
  for (const [rows, keys] of [
    [billed[0].months, ['billedMinor']],
    [payments, ['receivedMinor']],
    [reversals, ['reversedMinor']],
    [expenses[0].months, ['expenseMinor']],
  ])
    for (const row of rows) {
      const current = months.get(row._id) || {
        month: row._id,
        billedMinor: 0,
        receivedMinor: 0,
        reversedMinor: 0,
        expenseMinor: 0,
      };
      for (const key of keys) current[key] = Number(row[key] || 0);
      months.set(row._id, current);
    }
  const receivedMinor = payments.reduce(
      (sum, row) => sum + Number(row.receivedMinor),
      0,
    ),
    reversedMinor = reversals.reduce(
      (sum, row) => sum + Number(row.reversedMinor),
      0,
    ),
    paidExpenseMinor = Number(paidExpenses[0]?.paidExpenseMinor || 0);
  return {
    scope: req.financeScope.scope,
    totals: {
      billedMinor: Number(billed[0].totals[0]?.billedMinor || 0),
      invoices: billed[0].totals[0]?.count || 0,
      legacyPaidMinor: Number(billed[0].totals[0]?.legacyPaidMinor || 0),
      collectedMinor: receivedMinor - reversedMinor,
      receivedMinor,
      reversedMinor,
      outstandingMinor: Number(receivables[0].totals[0]?.outstandingMinor || 0),
      overdueMinor: Number(receivables[0].totals[0]?.overdueMinor || 0),
      dueToday: receivables[0].totals[0]?.dueToday || 0,
      partiallyPaid: receivables[0].totals[0]?.partiallyPaid || 0,
      expenseMinor: Number(expenses[0].totals[0]?.expenseMinor || 0),
      paidExpenseMinor,
      netCashMinor: receivedMinor - reversedMinor - paidExpenseMinor,
      recurring,
    },
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    services: billed[0].services,
    clients: billed[0].clients,
    expenseCategories: expenses[0].categories,
    aging: receivables[0].aging,
    statuses: billed[0].statuses,
    outstanding: recent.items,
    recentPayments,
    basis:
      'INR. Billing/expenses use document dates; collections use receipt dates minus reversals on reversal dates. Cash outflow uses paid expense dates. Receivables are current balances across all dates. Legacy Paid invoices are not fabricated cash receipts.',
  };
}
export async function clientLedger(req, client, query) {
  const invoices = await Invoice.aggregate([
    ...invoiceStages(req, { client }, { range: false }),
    { $match: { issued: true } },
    {
      $project: {
        _id: 1,
        invoiceNumber: 1,
        invoiceDate: 1,
        totalMinor: 1,
        legacyPaidMinor: {
          $ifNull: [
            '$legacyPaidMinor',
            {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'Paid'] },
                    { $eq: [{ $ifNull: ['$financeVersion', null] }, null] },
                  ],
                },
                '$totalMinor',
                0,
              ],
            },
          ],
        },
      },
    },
  ]);
  const payments = await FinancePayment.find({
    invoice: { $in: invoices.map((row) => row._id) },
  })
    .select('paymentId amountMinor paymentDate status reversedAt invoice')
    .lean();
  const events = invoices.flatMap((row) => [
    {
      date: row.invoiceDate,
      reference: row.invoiceNumber,
      particular: 'Invoice',
      debitMinor: Number(row.totalMinor),
      creditMinor: 0,
    },
    ...(row.legacyPaidMinor
      ? [
          {
            date: row.invoiceDate,
            reference: row.invoiceNumber,
            particular: 'Legacy settlement — receipt date unavailable',
            debitMinor: 0,
            creditMinor: Number(row.legacyPaidMinor),
          },
        ]
      : []),
  ]);
  for (const row of payments) {
    events.push({
      date: row.paymentDate,
      reference: row.paymentId,
      particular: 'Payment',
      debitMinor: 0,
      creditMinor: row.amountMinor,
    });
    if (row.status === 'REVERSED')
      events.push({
        date: row.reversedAt,
        reference: row.paymentId,
        particular: 'Payment reversal',
        debitMinor: row.amountMinor,
        creditMinor: 0,
      });
  }
  events.sort(
    (a, b) =>
      new Date(a.date) - new Date(b.date) ||
      a.reference.localeCompare(b.reference) ||
      (a.particular === 'Invoice' ? -1 : 1),
  );
  let balance = 0n,
    opening = 0n;
  const rows = [];
  for (const event of events) {
    balance += BigInt(event.debitMinor) - BigInt(event.creditMinor);
    if (query.from && new Date(event.date) < query.from) opening = balance;
    if (
      (!query.from || new Date(event.date) >= query.from) &&
      (!query.to ||
        new Date(event.date) < new Date(query.to.getTime() + 86400000))
    )
      rows.push({ ...event, balanceMinor: Number(balance) });
  }
  const page = query.page || 1,
    limit = query.limit || 20;
  return {
    openingMinor: Number(opening),
    closingMinor: rows.at(-1)?.balanceMinor ?? Number(opening),
    items: rows.slice((page - 1) * limit, page * limit),
    pagination: {
      page,
      limit,
      total: rows.length,
      totalPages: Math.ceil(rows.length / limit),
    },
  };
}
