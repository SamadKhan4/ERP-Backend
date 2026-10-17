import { z } from 'zod';
import { projectStatuses } from './projectPermissions.js';
const id = z.string().regex(/^[a-f\d]{24}$/i);
const optionalId = z.preprocess(
  (v) => (v === '' ? undefined : v),
  id.optional(),
);
const text = (max) => z.string().trim().max(max);
const date = z.preprocess(
  (v) =>
    v === '' || v === null
      ? undefined
      : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? `${v}T00:00:00+05:30`
        : v,
  z.coerce.date().optional(),
);
export const projectSchema = z
  .object({
    title: text(180).min(2),
    clientRef: optionalId,
    lead: optionalId,
    quotation: optionalId,
    service: z.preprocess(
      (v) => (v === '' ? undefined : v),
      text(80).optional(),
    ),
    projectType: text(120).default('Client Project'),
    primaryDepartment: id,
    collaboratingDepartments: z.array(id).max(20).default([]),
    projectManager: id,
    startDate: date,
    expectedStartDate: date,
    deadline: date.refine(Boolean, 'Deadline required'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    billingType: z
      .enum(['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY'])
      .default('ONE_TIME'),
    amount: z.coerce.number().min(0).max(100000000).optional(),
    description: text(5000).default(''),
    scopeOfWork: text(10000).default(''),
    tags: z.array(text(50)).max(20).default([]),
    revision: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.projectType !== 'Internal Project' && !v.clientRef)
      ctx.addIssue({
        code: 'custom',
        path: ['clientRef'],
        message: 'Client required for client work',
      });
    if (
      v.deadline &&
      (v.startDate || v.expectedStartDate) &&
      v.deadline < (v.startDate || v.expectedStartDate)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['deadline'],
        message: 'Deadline must be after the start date',
      });
  });
export const teamSchema = z
  .object({
    employee: id,
    roleInProject: text(100).min(2),
    allocationPercentage: z.coerce.number().min(0).max(100),
  })
  .strict();
export const taskSchema = z
  .object({
    title: text(180).min(2),
    description: text(5000).default(''),
    assignedTo: optionalId,
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
    startDate: date,
    dueDate: date,
    estimatedHours: z.coerce.number().min(0).max(10000).default(0),
    actualHours: z.coerce.number().min(0).max(10000).default(0),
    dependsOn: z.array(id).max(20).default([]),
    status: z
      .enum([
        'TODO',
        'IN_PROGRESS',
        'REVIEW',
        'COMPLETED',
        'BLOCKED',
        'DONE',
        'BACKLOG',
      ])
      .default('TODO'),
    version: z.number().int().min(0).optional(),
  })
  .strict();
export const milestoneSchema = z
  .object({
    title: text(180).min(2),
    description: text(5000).default(''),
    dueDate: date.refine(Boolean, 'Due date required'),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).default('PENDING'),
    progress: z.coerce.number().min(0).max(100).default(0),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: text(100).default(''),
    status: z.enum([...projectStatuses, 'DELAYED']).optional(),
    department: optionalId,
    manager: optionalId,
    client: optionalId,
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    service: z.preprocess(
      (v) => (v === '' ? undefined : v),
      text(80).optional(),
    ),
    from: date,
    to: date,
    sort: z
      .enum(['title', 'deadline', 'startDate', 'createdAt', 'priority'])
      .default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
    archived: z.enum(['true', 'false']).default('false'),
  })
  .strict();
