import multer from 'multer';
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppError } from '../utils/errors.js';
import { findLead } from '../services/crmLeadService.js';
import {
  recordChange,
  transaction,
} from '../services/crmTransactionService.js';
import { env } from '../config/env.js';
import { objectId } from '../validators/crmValidator.js';
const directory = env.CRM_UPLOAD_DIR
  ? resolve(env.CRM_UPLOAD_DIR)
  : fileURLToPath(new URL('../../.crm-files/', import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('file');
export const receiveDocument = (req, res, next) =>
  upload(req, res, (error) =>
    error
      ? next(
          new AppError(
            400,
            error.code === 'LIMIT_FILE_SIZE'
              ? 'File must be at most 5 MB'
              : 'Invalid attachment upload',
          ),
        )
      : next(),
  );
export async function addDocument(req, res) {
  const lead = await findLead(req, req.params.id);
  if (!req.file || lead.attachments.length >= 20)
    throw new AppError(
      400,
      'Upload one document; maximum 20 documents per lead',
    );
  const bytes = req.file.buffer;
  const mimeType =
    bytes.subarray(0, 5).toString() === '%PDF-'
      ? 'application/pdf'
      : bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? 'image/jpeg'
          : null;
  if (!mimeType)
    throw new AppError(400, 'Only PDF, PNG, and JPEG files are accepted');
  const storageName = randomUUID();
  const name =
    req.file.originalname.replace(/[^a-zA-Z0-9 ._-]/g, '_').slice(0, 160) ||
    'document';
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, storageName), bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await transaction(async (session) => {
      const current = await findLead(req, req.params.id, session);
      if (current.attachments.length >= 20)
        throw new AppError(409, 'Maximum 20 documents per lead');
      current.attachments.push({
        name,
        storageName,
        mimeType,
        size: bytes.length,
        addedBy: req.user._id,
        addedAt: new Date(),
      });
      await recordChange(
        req,
        current,
        'DOCUMENT_ADDED',
        'Document uploaded',
        { name, size: bytes.length },
        session,
      );
      await current.save({ session });
    });
  } catch (error) {
    await unlink(resolve(directory, storageName));
    throw error;
  }
  res.status(201).json({ success: true, message: 'Document uploaded' });
}
export async function downloadDocument(req, res) {
  objectId.parse(req.params.documentId);
  const lead = await findLead(req, req.params.id);
  const attachment = lead.attachments.id(req.params.documentId);
  if (!attachment) throw new AppError(404, 'Document not found');
  let bytes;
  try {
    bytes = await readFile(resolve(directory, attachment.storageName));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new AppError(404, 'Document file unavailable');
    throw error;
  }
  res.set('Content-Type', attachment.mimeType);
  res.set('X-Content-Type-Options', 'nosniff');
  res.attachment(attachment.name);
  res.send(bytes);
}
