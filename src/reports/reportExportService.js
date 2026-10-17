import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { AuditLog } from '../models/AuditLog.js';
import { ReportGenerationLog } from '../models/ReportConfiguration.js';
import { AppError } from '../utils/errors.js';
export const cellValue = (value) =>
  value instanceof Date
    ? value.toISOString()
    : value === null || value === undefined
      ? ''
      : String(value);
const formulaSafe = (value) =>
  /^(?:\s*[=+\-@]|[\t\r\n])/.test(value) ? `'${value}` : value;
const csv = (value) =>
  `"${formulaSafe(cellValue(value)).replaceAll('"', '""')}"`;
export async function renderReportExport(data, format, selected) {
  if (data.unavailable) throw new AppError(409, data.unavailable);
  const columns = selected || data.report.columns;
  if (columns.some((column) => !data.report.columns.includes(column)))
    throw new AppError(400, 'Invalid export column');
  let buffer, mime;
  if (format === 'csv') {
    buffer = Buffer.from(
      '\uFEFF' +
        [
          columns.map(csv).join(','),
          ...data.rows.map((row) =>
            columns.map((column) => csv(row[column])).join(','),
          ),
        ].join('\r\n'),
    );
    mime = 'text/csv; charset=utf-8';
  } else if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');
    sheet.columns = columns.map((column) => ({
      header: column,
      key: column,
      width: 24,
    }));
    for (const row of data.rows)
      sheet.addRow(
        Object.fromEntries(
          columns.map((column) => [
            column,
            typeof row[column] === 'number'
              ? row[column]
              : formulaSafe(cellValue(row[column])),
          ]),
        ),
      );
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF087DDA' },
    };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (format === 'pdf') {
    if (data.rows.length > 1000)
      throw new AppError(
        422,
        'PDF export is limited to 1000 rows; narrow the filters or use XLSX',
      );
    buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({
          size: 'A4',
          layout: 'landscape',
          margin: 30,
        }),
        chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const width = (doc.page.width - 60) / columns.length;
      const header = () => {
        doc
          .fillColor('#173958')
          .font('Helvetica-Bold')
          .fontSize(16)
          .text(`AdBorn ERP | ${data.report.title}`);
        doc
          .font('Helvetica')
          .fontSize(8)
          .text(
            `Scope: ${data.scope} | ${data.dateBasis || ''} | Generated ${new Date().toISOString()}`,
            { width: doc.page.width - 60 },
          );
        doc.moveDown();
        const y = doc.y;
        columns.forEach((column, index) =>
          doc
            .font('Helvetica-Bold')
            .fontSize(7)
            .text(column, 30 + index * width, y, {
              width: width - 5,
              height: 25,
              ellipsis: true,
            }),
        );
        doc.y = y + 30;
      };
      header();
      for (const row of data.rows) {
        if (doc.y > doc.page.height - 65) {
          doc.addPage();
          header();
        }
        const y = doc.y;
        columns.forEach((column, index) =>
          doc
            .font('Helvetica')
            .fontSize(7)
            .text(cellValue(row[column]), 30 + index * width, y, {
              width: width - 5,
              height: 24,
              ellipsis: true,
            }),
        );
        doc.y = y + 29;
      }
      if (!data.rows.length)
        doc.text('No data available for the selected filters.');
      doc.end();
    });
    mime = 'application/pdf';
  } else throw new AppError(400, 'Unsupported export format');
  return { buffer, mime, filename: `${data.report.key}.${format}` };
}
export async function recordGeneration(
  req,
  data,
  format,
  status = 'GENERATED',
) {
  await ReportGenerationLog.create({
    user: req.user._id,
    reportKey: data.report.key,
    title: data.report.title,
    category: data.report.category,
    scope: data.scope,
    format,
    status,
    rows: data.rows.length,
  });
  await AuditLog.create({
    user: req.user._id,
    action: 'reports.export',
    entityType: 'reports',
    details: {
      reportKey: data.report.key,
      scope: data.scope,
      format,
      rows: data.rows.length,
    },
  });
}
