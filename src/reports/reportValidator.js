import { z } from 'zod';
const id = z.string().regex(/^[a-f\d]{24}$/i);
export const reportFilters = z
  .object({
    search: z.string().trim().max(100).default(''),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    department: z.string().trim().min(1).max(100).optional(),
    employee: id.optional(),
    manager: id.optional(),
    role: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(40)
      .optional(),
    status: z.string().trim().max(80).optional(),
    designation: z.string().trim().max(120).optional(),
    employmentType: z
      .enum(['full_time', 'part_time', 'contract', 'intern'])
      .optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
      .max(40)
      .optional(),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ['from', 'to'])
      if (
        value[field] &&
        (Number.isNaN(Date.parse(value[field])) ||
          new Date(value[field]).toISOString().slice(0, 10) !== value[field])
      )
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'Invalid date',
        });
    if (value.from && value.to && value.from > value.to)
      context.addIssue({ code: 'custom', message: 'Invalid date range' });
  });
export const catalogFilters = z
  .object({
    from: reportFilters.shape.from,
    to: reportFilters.shape.to,
    department: reportFilters.shape.department,
    search: z.string().trim().max(100).optional(),
    category: z
      .enum([
        'users',
        'departments',
        'projects',
        'hr',
        'finance',
        'crm',
        'management',
      ])
      .optional(),
    type: z.string().max(50).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(12),
    sort: z.enum(['recommended', 'name']).default('recommended'),
    status: z.enum(['available', 'unavailable']).optional(),
    roleAccess: z
      .enum(['OWN', 'TEAM', 'DEPARTMENT', 'ASSIGNED', 'ALL'])
      .optional(),
  })
  .strict();
export const exportSchema = z
  .object({
    filters: reportFilters.default({}),
    format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
    columns: z.array(z.string().max(40)).min(1).max(25).optional(),
  })
  .strict();
export const savedSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    reportKey: z.string().max(80),
    filters: reportFilters.default({}),
    columns: z.array(z.string().max(40)).min(1).max(25),
    sort: z
      .object({ field: z.string().max(40), order: z.enum(['asc', 'desc']) })
      .strict()
      .optional(),
    chart: z.enum(['bar', 'line', 'area', 'pie']).default('bar'),
    visibility: z
      .enum(['PRIVATE', 'TEAM', 'DEPARTMENT', 'GLOBAL'])
      .default('PRIVATE'),
  })
  .strict();
export const scheduleSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    reportKey: z.string().max(80),
    filters: reportFilters.default({}),
    format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
    recipients: z.array(z.string().email()).min(1).max(1),
    status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE'),
  })
  .strict();
