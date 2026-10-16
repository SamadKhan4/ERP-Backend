import { z } from 'zod';
const ref = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid identifier')
  .nullable()
  .optional();
const fields = {
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .min(2)
    .max(30)
    .regex(/^[a-z\d_-]+$/i, 'Use letters, numbers, underscores or hyphens')
    .transform((value) => value.toUpperCase()),
  description: z.string().trim().max(2000).default(''),
  departmentHead: ref,
  reportingManager: ref,
  parentDepartment: ref,
  location: z.string().trim().max(180).default(''),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
};
export const createDepartmentSchema = z.object(fields).strict();
export const updateDepartmentSchema = z
  .object(
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value.optional()]),
    ),
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const departmentListSchema = z
  .object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    sort: z.enum(['name', 'newest', 'oldest']).default('name'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();
export const memberListSchema = z
  .object({
    search: z.string().trim().max(100).default(''),
    active: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const assignmentSchema = z
  .object({
    employee: z.string().regex(/^[a-f\d]{24}$/i),
    department: z.string().min(1).max(100).optional(),
    designation: z.string().trim().min(1).max(120),
    manager: ref,
  })
  .strict();
