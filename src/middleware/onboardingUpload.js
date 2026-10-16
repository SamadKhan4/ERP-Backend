import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

import { documentRoots } from '../services/documentStorageService.js';
export const onboardingUploadRoot = documentRoots.onboarding;

const extensions = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE, files: 1, fields: 5 },
  fileFilter: (req, file, callback) => {
    if (!extensions[file.mimetype]) return callback(new AppError(400, 'Only PDF, JPG and PNG documents are allowed'));
    callback(null, true);
  },
}).single('file');

export function onboardingUpload(req, res, next) {
  upload(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'Document exceeds the configured size limit'));
    return next(error);
  });
}
