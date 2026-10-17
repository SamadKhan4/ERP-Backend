import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { safeFilename } from './mailProvider.js';
export const email = z
  .string()
  .trim()
  .max(254)
  .email()
  .regex(/^[^\r\n]+$/)
  .transform((v) => v.toLowerCase());
export const connectSchema = z
  .object({
    emailAddress: email,
    password: z.string().min(1).max(500),
    displayName: z
      .string()
      .trim()
      .max(120)
      .regex(/^[^\r\n]*$/)
      .default(''),
    type: z.enum(['PERSONAL', 'SHARED']).default('PERSONAL'),
  })
  .strict();
export const composeSchema = z
  .object({
    mailAccountId: z.string().regex(/^[a-f\d]{24}$/i),
    to: z.array(email).max(50).default([]),
    cc: z.array(email).max(50).default([]),
    bcc: z.array(email).max(50).default([]),
    subject: z
      .string()
      .max(200)
      .regex(/^[^\r\n]*$/)
      .default(''),
    text: z.string().max(100000).default(''),
    sourceMessage: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    draftMessage: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
    links: z
      .object({
        lead: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        client: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        project: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        quotation: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
        invoice: z
          .string()
          .regex(/^[a-f\d]{24}$/i)
          .optional(),
      })
      .strict()
      .default({}),
    attachRecordPdf: z.boolean().default(false),
  })
  .strict();
export function attachment(file) {
  const name = safeFilename(file.originalname || file.fileName);
  const bytes = file.buffer;
  const ext = name.split('.').pop().toLowerCase();
  let mime;
  if (ext === 'pdf' && bytes.subarray(0, 5).toString() === '%PDF-')
    mime = 'application/pdf';
  if (
    ['png'].includes(ext) &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    mime = 'image/png';
  if (
    ['jpg', 'jpeg'].includes(ext) &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    mime = 'image/jpeg';
  if (
    ['zip', 'docx', 'xlsx'].includes(ext) &&
    bytes.subarray(0, 2).toString() === 'PK'
  )
    mime =
      ext === 'zip'
        ? 'application/zip'
        : ext === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (['txt', 'csv'].includes(ext) && !bytes.includes(0))
    mime = ext === 'csv' ? 'text/csv' : 'text/plain';
  if (!mime)
    throw new AppError(
      400,
      'Unsupported or invalid attachment. Use PDF, images, TXT, CSV, ZIP, DOCX or XLSX.',
    );
  if (bytes.length > env.MAX_FILE_SIZE)
    throw new AppError(413, 'Attachment exceeds configured size limit');
  return {
    fileName: name,
    mime,
    content: bytes.toString('base64'),
    size: bytes.length,
  };
}
export function parseCompose(req) {
  let raw = req.body;
  if (typeof req.body.payload === 'string') {
    try {
      raw = JSON.parse(req.body.payload);
    } catch {
      throw new AppError(400, 'Invalid compose data');
    }
  }
  const input = composeSchema.parse(raw);
  const attachments = (req.files || []).map(attachment);
  if (attachments.reduce((sum, f) => sum + f.size, 0) > env.MAX_FILE_SIZE)
    throw new AppError(
      413,
      'Combined attachments exceed configured size limit',
    );
  return { ...input, attachments };
}
