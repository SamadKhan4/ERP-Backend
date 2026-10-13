import { mkdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export const onboardingUploadRoot = resolve(
  env.ONBOARDING_UPLOAD_DIR?.trim() || fileURLToPath(new URL('../../uploads/onboarding', import.meta.url)),
);
mkdirSync(onboardingUploadRoot, { recursive: true });

const extensions = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: onboardingUploadRoot,
    filename: (req, file, callback) => callback(null, `${randomUUID()}${extensions[file.mimetype] || extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => {
    if (!extensions[file.mimetype]) return callback(new AppError(400, 'Only PDF, JPG and PNG documents are allowed'));
    callback(null, true);
  },
}).single('file');

export function onboardingUpload(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'Document must be 5 MB or smaller'));
    return next(error);
  });
}
