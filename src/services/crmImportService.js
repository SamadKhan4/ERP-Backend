import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CRMImportBatch } from '../models/CRMImportBatch.js';
import { Lead } from '../models/Lead.js';
import { User } from '../models/User.js';
import { CRMSettings } from '../models/CRMSettings.js';
import { sources, serviceCatalog, lostReasons } from '../../shared/crm.js';
import {
  importFields,
  suggestMapping,
  normalizeHeader,
} from '../../shared/crmImport.js';
import { createLeadSchema, objectId } from '../validators/crmValidator.js';
import { createLead } from './crmLeadService.js';
import { has, id, validateAssignee } from './crmAccessService.js';
import { AppError } from '../utils/errors.js';
export const importConfigSchema = z
  .object({
    mapping: z.partialRecord(
      z.enum(importFields.map(([key]) => key)),
      z.number().int().min(0).max(49),
    ),
    defaults: z
      .object({
        leadSource: z.string().max(80).default('Website'),
        assignedTo: objectId.optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
        temperature: z.enum(['COLD', 'WARM', 'HOT']).default('WARM'),
      })
      .strict(),
  })
  .strict();
async function validateArchive(buffer) {
  await new Promise((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error)
        return reject(new AppError(400, 'Upload a valid .xlsx workbook'));
      let size = 0,
        count = 0;
      zip.on('error', () =>
        reject(new AppError(400, 'Invalid workbook archive')),
      );
      zip.on('entry', (entry) => {
        size += entry.uncompressedSize;
        count++;
        if (
          size > 20 * 1024 * 1024 ||
          count > 200 ||
          entry.uncompressedSize > 10 * 1024 * 1024 ||
          /vbaProject|externalLinks|\.\.\//i.test(entry.fileName)
        ) {
          zip.close();
          return reject(
            new AppError(
              400,
              'Workbook is too large or contains unsupported macros/external links',
            ),
          );
        }
        zip.readEntry();
      });
      zip.on('end', resolve);
      zip.readEntry();
    }),
  );
}
export async function parseWorkbook(req, file) {
  if (!file || !/\.xlsx$/i.test(file.originalname))
    throw new AppError(400, 'Upload an Excel .xlsx file');
  await validateArchive(file.buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer);
  } catch {
    throw new AppError(
      400,
      'Unable to read this workbook. Save it as an unencrypted .xlsx file.',
    );
  }
  const sheet = workbook.worksheets.find(
    (item) => item.state === 'visible' && item.actualRowCount > 0,
  );
  if (!sheet || sheet.rowCount < 2)
    throw new AppError(
      400,
      'The first populated sheet needs a header row and at least one lead',
    );
  if (sheet.rowCount > 501 || sheet.columnCount > 50)
    throw new AppError(
      400,
      'Import at most 500 rows and 50 columns per workbook',
    );
  const headers = Array.from(
    { length: sheet.columnCount },
    (_, index) =>
      sheet
        .getRow(1)
        .getCell(index + 1)
        .text.trim()
        .slice(0, 100) || `Column ${index + 1}`,
  );
  const rows = [];
  let textBytes = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const source = sheet.getRow(rowNumber);
    const formulaColumns = [];
    const cells = headers.map((_, index) => {
      const cell = source.getCell(index + 1);
      if (
        cell.value &&
        typeof cell.value === 'object' &&
        ('formula' in cell.value || 'sharedFormula' in cell.value)
      )
        formulaColumns.push(index);
      return (cell.value instanceof Date ? cell.value.toISOString() : cell.text)
        .trim()
        .slice(0, 6000);
    });
    textBytes += cells.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    if (textBytes > 2 * 1024 * 1024) throw new AppError(400, 'Workbook data exceeds 2 MB of text. Split it into smaller imports.');
    if (cells.some(Boolean) || formulaColumns.length)
      rows.push({ row: rowNumber, cells, formulaColumns });
  }
  if (!rows.length) throw new AppError(400, 'The sheet contains no lead data');
  const batch = await CRMImportBatch.create({
    createdBy: req.user._id,
    filename: file.originalname.slice(0, 180),
    sheetName: sheet.name,
    headers,
    rows,
    results: [],
    expiresAt: new Date(Date.now() + 86400000),
  });
  return {
    batchId: batch.id,
    filename: batch.filename,
    sheetName: batch.sheetName,
    headers,
    mapping: suggestMapping(headers),
    total: rows.length,
    sample: rows.slice(0, 10).map(({ row, cells }) => ({ row, cells })),
  };
}
export async function importBatch(req) {
  const batch = await CRMImportBatch.findOne({
    _id: id(req.params.batchId),
    createdBy: req.user._id,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!batch)
    throw new AppError(
      404,
      'Import preview expired or unavailable. Upload the workbook again.',
    );
  return batch;
}
export async function validateRows(req, batch, config) {
  const indexes = Object.values(config.mapping);
  if (config.mapping.companyName === undefined)
    throw new AppError(400, 'Map the Company Name column');
  if (
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index >= batch.headers.length)
  )
    throw new AppError(400, 'Map each Excel column to at most one field');
  const settings = await CRMSettings.findById('crm').lean();
  const sourceValues = settings?.sources || sources;
  const reasonValues = settings?.lostReasons || lostReasons;
  const seenPhones = new Set();
  const seenEmails = new Set();
  const results = [];
  for (const row of batch.rows) {
    const prior = batch.results.find(
      (item) => item.row === row.row && item.status === 'IMPORTED',
    );
    if (prior) {
      results.push({
        row: row.row,
        companyName: row.cells[config.mapping.companyName],
        status: 'IMPORTED',
        leadId: prior.leadId,
      });
      continue;
    }
    const input = { ...config.defaults, address: {} };
    const errors = [];
    const warnings = [];
    for (const [field, index] of Object.entries(config.mapping)) {
      const value = row.cells[index];
      if (row.formulaColumns.includes(index)) {
        errors.push(`${field}: replace formulas with values`);
        continue;
      }
      if (!value) continue;
      if (field.startsWith('address.')) input.address[field.slice(8)] = value;
      else if (field === 'interestedServices')
        input[field] = value
          .split(/[,;]/)
          .map(
            (entry) =>
              serviceCatalog.find((service) =>
                [service.id, service.label].some(
                  (name) => normalizeHeader(name) === normalizeHeader(entry),
                ),
              )?.id || entry.trim(),
          );
      else if (field === 'tags')
        input[field] = value
          .split(/[,;]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      else if (['stage', 'priority', 'temperature', 'currency'].includes(field))
        input[field] = value.toUpperCase().replaceAll(/[- ]/g, '_');
      else if (field === 'leadSource')
        input[field] =
          sourceValues.find(
            (entry) => entry.toLowerCase() === value.toLowerCase(),
          ) || value;
      else input[field] = value;
    }
    if (input.assignedEmail) {
      const user = await User.findOne({
        email: input.assignedEmail.toLowerCase(),
        active: true,
      })
        .select('_id')
        .lean();
      if (!user) errors.push('Assigned employee email was not found');
      else input.assignedTo = String(user._id);
      delete input.assignedEmail;
    }
    if (
      input.assignedTo &&
      input.assignedTo !== req.user.id &&
      !has(req.crmPermissions, 'crm.leads.assign')
    )
      errors.push('You cannot assign leads to another employee');
    if (input.assignedTo) {
      try {
        await validateAssignee(req, input.assignedTo);
      } catch (error) {
        if (error.status) errors.push(error.message);
        else throw error;
      }
    }
    const parsed = createLeadSchema.safeParse(input);
    if (!parsed.success)
      errors.push(
        ...parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    if (parsed.success) {
      const value = parsed.data;
      if (!sourceValues.includes(value.leadSource))
        errors.push('Unknown lead source');
      if (
        value.stage === 'LOST' &&
        (!reasonValues.includes(value.lostReason) ||
          (value.lostReason === 'Other' && !value.lostDetail))
      )
        errors.push('Lost leads need a valid reason and Other needs details');
      if (
        (value.phone && seenPhones.has(value.phone)) ||
        (value.email && seenEmails.has(value.email))
      )
        errors.push('Duplicate phone/email within this workbook');
      if (value.phone) seenPhones.add(value.phone);
      if (value.email) seenEmails.add(value.email);
      const contacts = [
        ...(value.phone ? [{ phone: value.phone }] : []),
        ...(value.email ? [{ email: value.email }] : []),
      ];
      if (
        contacts.length &&
        (await Lead.exists({
          deletedAt: null,
          $or: contacts,
          importKey: { $ne: `${batch._id}:${row.row}` },
        }))
      )
        errors.push('A lead with this phone/email already exists');
      if (
        await Lead.exists({
          deletedAt: null,
          companyKey: value.companyName.toLowerCase(),
          importKey: { $ne: `${batch._id}:${row.row}` },
        })
      )
        warnings.push('Possible duplicate company; review before importing');
      results.push({
        row: row.row,
        companyName: value.companyName,
        status: errors.length ? 'INVALID' : 'VALID',
        errors,
        warnings,
        input: value,
      });
    } else
      results.push({
        row: row.row,
        companyName: input.companyName || '',
        status: 'INVALID',
        errors,
        warnings,
      });
  }
  return results;
}
export const configHash = (config) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        mapping: Object.fromEntries(Object.entries(config.mapping).sort()),
        defaults: config.defaults,
      }),
    )
    .digest('hex');
export async function commitRows(
  req,
  batch,
  config,
  rows,
  allowCompanyDuplicates,
) {
  const hash = configHash(config);
  const locked = await CRMImportBatch.findOneAndUpdate(
    {
      _id: batch._id,
      createdBy: req.user._id,
      $or: [{ configHash: null }, { configHash: hash }],
    },
    { $set: { configHash: hash } },
    { new: true },
  );
  if (!locked)
    throw new AppError(
      409,
      'Mapping changed after import started. Upload a new workbook to use a different mapping.',
    );
  const validated = await validateRows(req, batch, config);
  const results = [];
  for (const rowNumber of rows) {
    const row = validated.find((entry) => entry.row === rowNumber);
    if (!row) throw new AppError(400, 'Unknown worksheet row');
    const importKey = `${batch._id}:${rowNumber}`;
    let existing = await Lead.findOne({
      importKey,
      createdBy: req.user._id,
    }).select('_id leadId');
    if (existing) {
      results.push({
        row: rowNumber,
        status: 'IMPORTED',
        leadId: existing.leadId,
        lead: existing._id,
        message: 'Already imported',
      });
      continue;
    }
    if (
      row.status !== 'VALID' ||
      (row.warnings?.length && !allowCompanyDuplicates)
    ) {
      results.push({
        row: rowNumber,
        status: 'SKIPPED',
        message:
          row.errors?.join('; ') || 'Review the duplicate company warning',
      });
      continue;
    }
    try {
      existing = await createLead(req, row.input, { importKey });
      const result = {
        row: rowNumber,
        status: 'IMPORTED',
        lead: existing._id,
        leadId: existing.leadId,
        message: 'Lead created',
      };
      await CRMImportBatch.updateOne(
        { _id: batch._id, 'results.row': { $ne: rowNumber } },
        { $push: { results: result } },
      );
      results.push(result);
    } catch (error) {
      existing = await Lead.findOne({
        importKey,
        createdBy: req.user._id,
      }).select('_id leadId');
      if (existing)
        results.push({
          row: rowNumber,
          status: 'IMPORTED',
          lead: existing._id,
          leadId: existing.leadId,
          message: 'Already imported',
        });
      else if (error.status && error.status < 500)
        results.push({
          row: rowNumber,
          status: 'FAILED',
          message: error.message,
        });
      else throw error;
    }
  }
  return results;
}
