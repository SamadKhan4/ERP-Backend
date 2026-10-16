import { z } from 'zod';
import {
  stages,
  priorities,
  temperatures,
  serviceCatalog,
  manualActivityTypes,
  followUpTypes,
} from './crm.js';
export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
export const phone = z
  .string()
  .trim()
  .max(30)
  .refine(
    (value) => !value || /^[+\d\s().-]{7,30}$/.test(value),
    'Invalid phone',
  )
  .transform((value) => value.replace(/[^\d+]/g, ''));
const optionalText = (max) => z.string().trim().max(max).default('');
export const leadSchema = z
  .object({
    companyName: z.string().trim().min(1).max(160),
    contactPerson: optionalText(120),
    phone: phone.default(''),
    whatsapp: phone.default(''),
    email: z
      .union([z.email(), z.literal('')])
      .transform((value) => value.toLowerCase())
      .default(''),
    website: z
      .union([z.url({ protocol: /^https?$/ }), z.literal('')])
      .default(''),
    industry: optionalText(120),
    address: z
      .object({
        addressLine: optionalText(300),
        city: optionalText(100),
        state: optionalText(100),
        country: optionalText(100),
        pincode: optionalText(20),
      })
      .strict()
      .default({}),
    leadSource: z.string().trim().min(1).max(80),
    interestedServices: z
      .array(z.enum(serviceCatalog.map((item) => item.id)))
      .max(7)
      .default([]),
    estimatedBudget: z.coerce.number().min(0).max(1e10).default(0),
    currency: z.enum(['INR', 'USD', 'EUR', 'GBP']).default('INR'),
    assignedTo: objectId.nullable().optional(),
    priority: z.enum(priorities).default('MEDIUM'),
    temperature: z.enum(temperatures).default('WARM'),
    expectedClosingDate: z.coerce.date().nullable().optional(),
    nextFollowUpAt: z.coerce.date().nullable().optional(),
    probability: z.coerce.number().min(0).max(100).default(0),
    notes: optionalText(5000),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  })
  .strict();
export const createLeadSchema = leadSchema.extend({
  stage: z.enum(stages).default('NEW'),
  lostReason: optionalText(100),
  lostDetail: optionalText(1000),
});
export const updateLeadSchema = z
  .object(
    Object.fromEntries(
      Object.entries(leadSchema.shape).map(([key, schema]) => [
        key,
        (schema instanceof z.ZodDefault
          ? schema.removeDefault()
          : schema
        ).optional(),
      ]),
    ),
  )
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No changes supplied');
export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(100).optional(),
    stage: z.enum(stages).optional(),
    source: z.string().max(80).optional(),
    priority: z.enum(priorities).optional(),
    temperature: z.enum(temperatures).optional(),
    assignedTo: objectId.optional(),
    service: z.enum(serviceCatalog.map((item) => item.id)).optional(),
    city: z.string().max(100).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    followFrom: z.coerce.date().optional(),
    followTo: z.coerce.date().optional(),
    closeFrom: z.coerce.date().optional(),
    closeTo: z.coerce.date().optional(),
    sort: z
      .enum([
        'createdAt',
        'companyName',
        'estimatedBudget',
        'nextFollowUpAt',
        'updatedAt',
      ])
      .default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .refine(
    (value) => !value.from || !value.to || value.to >= value.from,
    'Invalid date range',
  );
export const stageSchema = z
  .object({
    stage: z.enum(stages),
    lostReason: optionalText(100),
    lostDetail: optionalText(1000),
  })
  .strict();
export const activitySchema = z
  .object({
    type: z.enum(manualActivityTypes),
    title: z.string().trim().min(1).max(180),
    description: optionalText(5000),
    scheduledAt: z.coerce.date().optional(),
  })
  .strict();
export const followUpSchema = z
  .object({
    lead: objectId,
    assignedTo: objectId.optional(),
    type: z.enum(followUpTypes),
    scheduledAt: z.coerce.date(),
    priority: z.enum(priorities).default('MEDIUM'),
    notes: optionalText(3000),
  })
  .strict();
