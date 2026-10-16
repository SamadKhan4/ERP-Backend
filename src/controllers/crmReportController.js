import { once } from 'node:events';
import { Lead } from '../models/Lead.js';
import { listSchema } from '../validators/crmValidator.js';
import { analytics } from '../services/crmAnalyticsService.js';
import { leadFilter } from '../services/crmLeadService.js';
import { AppError } from '../utils/errors.js';
const reportKeys = {
  'lead-source': 'sources',
  conversion: 'funnel',
  pipeline: 'currencies',
  'won-lost': 'losses',
  performance: 'performance',
  'service-interest': 'services',
  aging: 'aging',
  followup: 'followups',
};
export async function dashboard(req, res) {
  res.json({
    success: true,
    data: await analytics(req, listSchema.parse(req.query)),
  });
}
export async function report(req, res) {
  if (!reportKeys[req.params.kind])
    throw new AppError(404, 'Unknown CRM report');
  const query = listSchema.parse(req.query);
  const data = await analytics(req, query);
  const rows = data[reportKeys[req.params.kind]];
  res.json({
    success: true,
    data: {
      items: rows.slice(
        (query.page - 1) * query.limit,
        query.page * query.limit,
      ),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: rows.length,
        totalPages: Math.ceil(rows.length / query.limit),
      },
      totals: data.totals,
      basis: data.basis,
    },
  });
}
export const csvCell = (value) => {
  let text =
    typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export async function exportLeads(req, res) {
  const query = listSchema.parse(req.query);
  const filter = leadFilter(req, query);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment('crm-leads.csv');
  const fields = [
    'leadId',
    'companyName',
    'contactPerson',
    'phone',
    'email',
    'leadSource',
    'stage',
    'priority',
    'temperature',
    'estimatedBudget',
    'currency',
    'nextFollowUpAt',
    'createdAt',
  ];
  res.write(`${fields.map(csvCell).join(',')}\r\n`);
  const cursor = Lead.find(filter)
    .select(fields.join(' '))
    .sort({ createdAt: -1 })
    .lean()
    .cursor({ batchSize: 100 });
  try {
    for await (const lead of cursor) {
      if (res.destroyed) break;
      if (
        !res.write(
          `${fields.map((field) => csvCell(lead[field] instanceof Date ? lead[field].toISOString() : lead[field])).join(',')}\r\n`,
        )
      )
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
  } finally {
    await cursor.close();
  }
  res.end();
}
export async function exportReport(req, res) {
  if (!reportKeys[req.params.kind])
    throw new AppError(404, 'Unknown CRM report');
  const data = await analytics(req, listSchema.parse(req.query));
  const rows = data[reportKeys[req.params.kind]];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`crm-${req.params.kind}.csv`);
  res.send(
    [
      keys.map(csvCell).join(','),
      ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(',')),
    ].join('\r\n'),
  );
}
