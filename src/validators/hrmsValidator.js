import { z } from 'zod';
import { departments } from '../constants/departments.js';
import { hrmsResourceNames } from '../models/HRMSRecord.js';
import { AppError } from '../utils/errors.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid identifier');
const department = z.enum(departments.map(({ id }) => id));
const date = z.coerce.date();
const shortText = z.string().trim().min(1).max(180);
const optionalText = z.string().trim().max(1000).optional();

const taskSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().min(1).max(160),
  completed: z.boolean().default(false),
  required: z.boolean().default(true),
  completedAt: date.optional(),
});

const flexibleData = z.record(z.string(), z.unknown());

const resourceDataSchemas = {
  departments: z.object({
    code: z.string().trim().min(2).max(30),
    description: optionalText,
    head: objectId.optional(),
  }),
  designations: z.object({
    level: z.enum(['admin', 'manager', 'team_leader', 'executive', 'employee']),
    responsibilities: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  }),
  recruitment: z.object({
    openings: z.number().int().min(1).max(500).default(1),
    candidateCount: z.number().int().min(0).max(100000).default(0),
    stage: z.enum(['New', 'Screening', 'Interviewing', 'Offered', 'Closed']),
    description: optionalText,
    closeDate: date.optional(),
  }),
  jobs: flexibleData,
  candidates: flexibleData,
  interviews: flexibleData,
  onboarding: z.object({
    joiningDate: date,
    progress: z.number().min(0).max(100).default(0),
    tasks: z.array(taskSchema).max(100).default([]),
  }),
  offboarding: z.object({
    lastDay: date,
    progress: z.number().min(0).max(100).default(0),
    reason: optionalText,
    tasks: z.array(taskSchema).max(100).default([]),
  }),
  attendance: z.object({
    date,
    checkIn: date.optional(),
    checkOut: date.optional(),
    minutesWorked: z.number().int().min(0).max(1440).optional(),
    note: optionalText,
  }),
  'attendance-regularizations': flexibleData,
  'attendance-periods': flexibleData,
  leave: z.object({
    leaveType: z.enum(['annual', 'sick', 'casual', 'unpaid', 'work_from_home', 'other']),
    startDate: date,
    endDate: date,
    reason: z.string().trim().min(3).max(1000),
    reviewerNote: optionalText,
  }).refine((value) => value.endDate >= value.startDate, {
    message: 'End date must be on or after start date',
    path: ['endDate'],
  }),
  'leave-types': flexibleData,
  'leave-policies': flexibleData,
  'leave-adjustments': flexibleData,
  shifts: z.object({
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    hours: z.number().min(0.25).max(24),
  }),
  'shift-assignments': flexibleData,
  timesheets: z.object({
    date,
    hours: z.number().min(0).max(24),
    notes: optionalText,
  }),
  holidays: z.object({
    date,
    type: z.enum(['company', 'optional', 'regional']),
    description: optionalText,
  }),
  payroll: z.object({
    periodStart: date,
    periodEnd: date,
    employeeCount: z.number().int().min(0),
    grossAmount: z.number().min(0),
    currency: z.string().length(3).default('INR'),
  }).refine((value) => value.periodEnd >= value.periodStart, {
    message: 'Payroll period end must follow its start',
    path: ['periodEnd'],
  }),
  'payroll-runs': flexibleData,
  salary: z.object({
    appliesTo: z.string().trim().min(1).max(120),
    components: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      type: z.enum(['earning', 'deduction']),
      amount: z.number().min(0),
    })).max(50),
  }),
  'salary-structures': flexibleData,
  'salary-assignments': flexibleData,
  'salary-revisions': flexibleData,
  performance: z.object({
    participants: z.number().int().min(0),
    completion: z.number().min(0).max(100),
    period: z.string().trim().min(1).max(100),
  }),
  'performance-cycles': flexibleData,
  'performance-goals': flexibleData,
  'performance-reviews': flexibleData,
  training: z.object({
    audience: z.string().trim().min(1).max(120),
    enrolled: z.number().int().min(0).default(0),
    startsAt: date.optional(),
    description: optionalText,
  }),
  'training-programs': flexibleData,
  'training-enrollments': flexibleData,
  assets: z.object({
    assetCode: z.string().trim().min(1).max(60),
    serialNumber: z.string().trim().max(120).optional(),
    assignedTo: objectId.optional(),
    returnDue: date.optional(),
  }),
  documents: z.object({
    category: z.enum(['policy', 'template', 'employee', 'compliance', 'other']),
    version: z.string().trim().min(1).max(30),
    fileUrl: z.string().url().max(1000).optional(),
    description: optionalText,
  }),
  policies: flexibleData,
  announcements: z.object({
    detail: z.string().trim().min(1).max(3000),
    audience: z.string().trim().min(1).max(120),
    publishAt: date.optional(),
  }),
  'report-exports': flexibleData,
  settings: z.object({
    key: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,79}$/),
    value: z.union([z.string().max(1000), z.number(), z.boolean()]),
    scope: z.enum(['company', 'department', 'default']).default('company'),
  }),
};

export const hrmsResourceDefinitions = Object.fromEntries(
  hrmsResourceNames.map((name) => [
    name,
    {
      dataSchema: resourceDataSchemas[name],
      defaultStatus:
        name === 'attendance'
          ? 'Present'
          : name === 'settings'
            ? 'Configured'
            : 'Draft',
      payroll: [
        'payroll',
        'payroll-runs',
        'salary',
        'salary-structures',
        'salary-assignments',
        'salary-revisions',
      ].includes(name),
      employeeRequired: [
        'onboarding',
        'offboarding',
        'attendance',
        'leave',
        'timesheets',
        'salary-assignments',
        'salary-revisions',
        'performance-goals',
        'performance-reviews',
        'training-enrollments',
      ].includes(name),
    },
  ]),
);

const recordBody = z
  .object({
    title: shortText,
    department: department.optional(),
    employee: objectId.optional(),
    status: z.string().trim().min(1).max(80).optional(),
    effectiveDate: date.optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export function parseRecordCreate(resource, body) {
  const definition = hrmsResourceDefinitions[resource];
  const parsed = recordBody.parse(body);
  if (definition.employeeRequired && !parsed.employee)
    throw new AppError(400, 'Employee is required');
  return {
    ...parsed,
    status: parsed.status || definition.defaultStatus,
    data: definition.dataSchema.parse(parsed.data),
  };
}

export const recordUpdateSchema = recordBody.partial();

export function parseRecordUpdate(resource, body, existingData) {
  const definition = hrmsResourceDefinitions[resource];
  const parsed = recordUpdateSchema.parse(body);
  return {
    ...parsed,
    ...(parsed.data
      ? { data: definition.dataSchema.parse({ ...existingData, ...parsed.data }) }
      : {}),
  };
}

export const recordListSchema = z
  .object({
    cursor: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    sort: z
      .enum(['newest', 'oldest', 'effective_asc', 'effective_desc'])
      .default('newest'),
    department: department.optional(),
    status: z.string().trim().min(1).max(80).optional(),
    employee: objectId.optional(),
    search: z.string().trim().max(80).optional(),
  })
  .strict();

const employeeBodySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    temporaryPassword: z.string().min(12).max(128),
    role: z.enum(['employee', 'team_leader']).default('employee'),
    department: department.optional(),
    active: z.boolean().default(true),
    employeeCode: z.string().trim().min(2).max(30).optional(),
    designation: z.string().trim().max(120).optional(),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).default('full_time'),
    joiningDate: date.optional(),
    dateOfBirth: date.optional(),
    phone: z.string().trim().max(30).optional(),
    manager: objectId.optional(),
    address: z.string().trim().max(500).optional(),
    emergencyContact: z.object({
      name: z.string().trim().min(1).max(120),
      phone: z.string().trim().min(1).max(30),
      relationship: z.string().trim().min(1).max(60),
    }).optional(),
  })
  .strict();

export const employeeCreateSchema = employeeBodySchema;

export const employeeUpdateSchema = employeeBodySchema
  .omit({ temporaryPassword: true })
  .partial();

export const employeeListSchema = z
  .object({
    cursor: objectId.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc']).default('newest'),
    department: department.optional(),
    search: z.string().trim().max(80).optional(),
    active: z.enum(['true', 'false']).optional(),
  })
  .strict();

export { objectId };
