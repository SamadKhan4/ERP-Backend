import {
  authorizeReport,
  resolveReportScope,
  hasReportPermission,
} from './reportAccessService.js';
import { reportFilters } from './reportValidator.js';
import { buildReportQuery } from './reportQueryBuilders.js';
import { AppError } from '../utils/errors.js';
export async function executeReport(
  req,
  key,
  input,
  { exportData = false, maxRows = 5000 } = {},
) {
  const report = authorizeReport(req, key, { exportData });
  const filters = reportFilters.parse(input);
  if (report.unavailable)
    return {
      report,
      scope: 'UNAVAILABLE',
      unavailable: report.unavailable,
      rows: [],
      summary: { records: 0 },
      chart: [],
      pagination: { page: 1, total: 0, totalPages: 0 },
    };
  if (filters.sort && !report.columns.includes(filters.sort))
    throw new AppError(400, 'Invalid sort column');
  const access = await resolveReportScope(req, report);
  const { Model, pipeline, dateBasis } = await buildReportQuery(
    req,
    report,
    filters,
    access,
  );
  const sort = {
    [filters.sort || report.columns[0]]: filters.order === 'asc' ? 1 : -1,
    _id: 1,
  };
  const group = report.preset?.group;
  const chartField = group
    ? 'label'
    : report.columns.includes('status')
      ? 'status'
      : report.columns.includes('stage')
        ? 'stage'
        : report.columns.includes('department')
          ? 'department'
          : null;
  const result = await Model.aggregate([
    ...pipeline,
    {
      $facet: {
        rows: [
          { $sort: sort },
          { $skip: exportData ? 0 : (filters.page - 1) * filters.limit },
          { $limit: exportData ? maxRows + 1 : filters.limit },
          {
            $project: Object.fromEntries([
              ['_id', 0],
              ...report.columns.map((column) => [column, 1]),
            ]),
          },
        ],
        total: [{ $count: 'count' }],
        summary: [
          {
            $group: {
              _id: null,
              records: { $sum: group ? '$count' : 1 },
              ...(group && report.preset.sum
                ? { amount: { $sum: '$amount' } }
                : {}),
            },
          },
        ],
        chart: chartField
          ? [
              {
                $group: {
                  _id: `$${chartField}`,
                  value: { $sum: group ? '$count' : 1 },
                },
              },
              { $sort: { value: -1 } },
              { $limit: 20 },
              {
                $project: {
                  _id: 0,
                  label: { $ifNull: ['$_id', 'Not assigned'] },
                  value: 1,
                },
              },
            ]
          : [{ $match: { $expr: false } }],
      },
    },
  ]).option({ maxTimeMS: 20000, allowDiskUse: true });
  const data = result[0],
    total = data.total[0]?.count || 0;
  if (exportData && total > maxRows)
    throw new AppError(
      422,
      `Export exceeds ${maxRows} rows; narrow the filters`,
    );
  // Cross-currency totals are deliberately excluded; amounts remain per-currency rows.
  const summary = { records: data.summary[0]?.records || 0, rows: total };
  return {
    report: {
      ...report,
      canExport:
        hasReportPermission(req.reportPermissions, 'reports.export') &&
        hasReportPermission(
          req.reportPermissions,
          `reports.${report.category}.export`,
        ),
    },
    filters,
    scope: access.scope,
    dateBasis,
    rows: data.rows,
    summary,
    chart: data.chart,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages: Math.ceil(total / filters.limit),
    },
    generatedAt: new Date(),
  };
}
