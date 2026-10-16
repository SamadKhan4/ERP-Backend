import multer from 'multer';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import {
  commitRows,
  importBatch,
  importConfigSchema,
  parseWorkbook,
  validateRows,
} from '../services/crmImportService.js';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('file');
export const receiveWorkbook = (req, res, next) =>
  upload(req, res, (error) =>
    error
      ? next(new AppError(400, 'Upload one .xlsx file up to 5 MB'))
      : next(),
  );
export async function preview(req, res) {
  res
    .status(201)
    .json({ success: true, data: await parseWorkbook(req, req.file) });
}
export async function validate(req, res) {
  const config = importConfigSchema.parse(req.body);
  const batch = await importBatch(req);
  const rows = await validateRows(req, batch, config);
  res.json({
    success: true,
    data: {
      rows: rows.map(({ input, ...row }) => {
        void input;
        return row;
      }),
      valid: rows.filter((row) => row.status === 'VALID').length,
      invalid: rows.filter((row) => row.status === 'INVALID').length,
    },
  });
}
export async function commit(req, res) {
  const body = importConfigSchema
    .extend({
      rows: z.array(z.number().int().min(2).max(501)).min(1).max(25),
      allowCompanyDuplicates: z.boolean().default(false),
    })
    .parse(req.body);
  const batch = await importBatch(req);
  const results = await commitRows(
    req,
    batch,
    { mapping: body.mapping, defaults: body.defaults },
    [...new Set(body.rows)],
    body.allowCompanyDuplicates,
  );
  res.json({
    success: true,
    message: 'Import batch processed',
    data: { results },
  });
}
