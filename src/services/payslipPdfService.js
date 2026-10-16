import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { logoImage, watermarkImage } from '../assets/pdfBrandAssets.js';

const require = createRequire(import.meta.url);
const currencyFontPath = require.resolve('@fontsource/inter/files/inter-latin-ext-700-normal.woff');

const navy = '#0b2f55';
const blue = '#0789d1';
const cyan = '#20b4e8';
const pale = '#f3f8fc';
const border = '#dce7ef';
const ink = '#17324b';
const muted = '#6d8295';

const moneyText = (value) => Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const titleCase = (value) => String(value || 'Not assigned')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (letter) => letter.toUpperCase());

const periodText = (run) => new Date(Date.UTC(Number(run.data?.year), Number(run.data?.month || 1) - 1, 1))
  .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function amountInWords(value) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  if (!amount) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const underThousand = (number) => {
    const words = [];
    if (number >= 100) {
      words.push(`${ones[Math.floor(number / 100)]} Hundred`);
      number %= 100;
    }
    if (number >= 20) {
      words.push(tens[Math.floor(number / 10)]);
      number %= 10;
    }
    if (number) words.push(ones[number]);
    return words.join(' ');
  };
  const parts = [];
  let remaining = amount;
  const groups = [['Crore', 10000000], ['Lakh', 100000], ['Thousand', 1000]];
  groups.forEach(([label, divisor]) => {
    const count = Math.floor(remaining / divisor);
    if (count) parts.push(`${underThousand(count)} ${label}`);
    remaining %= divisor;
  });
  if (remaining) parts.push(underThousand(remaining));
  return `${parts.join(' ')} Rupees Only`;
}

function drawMoney(doc, value, x, y, width, options = {}) {
  const size = options.size || 10;
  const color = options.color || ink;
  const amount = moneyText(value);
  doc.font('CurrencyBold').fontSize(size);
  const symbolWidth = doc.widthOfString('\u20b9');
  doc.font('Helvetica-Bold').fontSize(size);
  const amountWidth = doc.widthOfString(amount);
  const startX = options.align === 'left' ? x : x + width - symbolWidth - amountWidth - 2;
  doc.fillColor(color).font('CurrencyBold').text('\u20b9', startX, y - 1, { lineBreak: false });
  doc.font('Helvetica-Bold').text(amount, startX + symbolWidth + 2, y, { lineBreak: false });
}

function drawEmployeeField(doc, label, value, x, y, width) {
  doc.fillColor(muted).font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x, y, { width });
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text(value || '-', x, y + 13, {
    width,
    height: 14,
    ellipsis: true,
  });
}

function drawSummaryCard(doc, label, value, x, y, width) {
  doc.roundedRect(x, y, width, 56, 8).fillAndStroke('#ffffff', border);
  doc.fillColor(muted).font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x + 12, y + 11, { width: width - 24 });
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text(value, x + 12, y + 29, { width: width - 24 });
}

function drawSummaryMoneyCard(doc, label, value, x, y, width) {
  doc.roundedRect(x, y, width, 56, 8).fillAndStroke('#ffffff', border);
  doc.fillColor(muted).font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x + 12, y + 11, { width: width - 24 });
  drawMoney(doc, value, x + 12, y + 29, width - 24, { size: 13, align: 'left' });
}

export function createPayslipDocument({ run, entry, profile = {} }) {
  // A legacy payroll entry may outlive its optional employee profile.
  profile ??= {};
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    info: {
      Title: `Salary Slip - ${entry.employeeName} - ${periodText(run)}`,
      Author: 'AdBorn Solutions',
      Subject: 'Employee salary slip',
    },
  });
  doc.registerFont('CurrencyBold', currencyFontPath);

  const pageWidth = doc.page.width;
  const left = 34;
  const contentWidth = pageWidth - 68;
  const manualAdjustment = Number(entry.snapshot?.manualAdjustment || 0);
  const professionalTax = Number(entry.snapshot?.professionalTax || 0);
  const leaveDeduction = Number(entry.snapshot?.leaveDeduction ?? Math.max(0, Number(entry.deductions || 0) - professionalTax));
  const positiveAdjustment = Math.max(0, manualAdjustment);
  const negativeAdjustment = Math.max(0, -manualAdjustment);

  doc.rect(0, 0, pageWidth, 9).fill(navy);
  doc.rect(pageWidth - 145, 0, 145, 9).fill(cyan);
  doc.save().opacity(0.055).image(watermarkImage, 420, 20, { width: 165 }).restore();
  doc.image(logoImage, left, 29, { width: 164 });
  doc.fillColor(muted).font('Helvetica').fontSize(7.5)
    .text('Nagpur, Maharashtra, India', left, 88)
    .text('+91 7488049134  |  info@adbornsolutions.com  |  adbornsolutions.com', left, 100);

  doc.fillColor(navy).font('Helvetica-Bold').fontSize(22).text('SALARY SLIP', 365, 35, { width: 196, align: 'right' });
  doc.fillColor(blue).font('Helvetica-Bold').fontSize(9).text(periodText(run).toUpperCase(), 365, 66, { width: 196, align: 'right' });
  doc.fillColor(muted).font('Helvetica').fontSize(7.5).text(`Slip ID  ${String(entry._id).slice(-8).toUpperCase()}`, 365, 84, { width: 196, align: 'right' });

  doc.roundedRect(left, 123, contentWidth, 57, 10).fill(navy);
  doc.fillColor('#9fdcf7').font('Helvetica').fontSize(8).text('NET PAYABLE SALARY', left + 18, 137);
  drawMoney(doc, entry.net, left + 18, 151, 205, { size: 17, color: '#ffffff', align: 'left' });
  doc.fillColor('#c9e9f8').font('Helvetica').fontSize(7.5).text(amountInWords(entry.net), left + 238, 143, { width: contentWidth - 256, align: 'right' });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5).text(String(run.status || 'Approved').toUpperCase(), left + 410, 158, { width: 98, align: 'right' });

  doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text('EMPLOYEE DETAILS', left, 204);
  doc.rect(left, 222, contentWidth, 105).fillAndStroke(pale, border);
  const colWidth = (contentWidth - 48) / 3;
  const fields = [
    ['Employee Name', entry.employeeName],
    ['Employee ID', profile.employeeCode || String(entry.employee).slice(-8).toUpperCase()],
    ['Department', titleCase(entry.department)],
    ['Designation', profile.designation || 'Employee'],
    ['Employment Type', titleCase(profile.employmentType || 'full_time')],
    ['Pay Period', periodText(run)],
  ];
  fields.forEach(([label, value], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    drawEmployeeField(doc, label, value, left + 16 + column * (colWidth + 8), 238 + row * 44, colWidth);
  });

  const tableY = 352;
  const halfWidth = contentWidth / 2;
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text('SALARY BREAKDOWN', left, tableY - 20);
  doc.roundedRect(left, tableY, contentWidth, 202, 9).fillAndStroke('#ffffff', border);
  doc.rect(left, tableY, contentWidth, 35).fill(navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5)
    .text('EARNINGS', left + 14, tableY + 13)
    .text('AMOUNT', left + halfWidth - 80, tableY + 13, { width: 65, align: 'right' })
    .text('DEDUCTIONS', left + halfWidth + 14, tableY + 13)
    .text('AMOUNT', left + contentWidth - 80, tableY + 13, { width: 65, align: 'right' });
  doc.moveTo(left + halfWidth, tableY).lineTo(left + halfWidth, tableY + 202).lineWidth(0.6).strokeColor(border).stroke();

  const rows = [
    [['Monthly Base Salary', entry.gross], ['Approved Leave Deduction', leaveDeduction]],
    [['Additional Adjustment', positiveAdjustment], ['Professional Tax', professionalTax]],
    [['', 0], ['Other Adjustment', negativeAdjustment]],
  ];
  rows.forEach((row, index) => {
    const y = tableY + 49 + index * 42;
    if (index) doc.rect(left, y - 10, contentWidth, 42).fill(pale);
    row.forEach(([label, value], side) => {
      const x = left + side * halfWidth;
      if (!label) return;
      doc.fillColor(ink).font('Helvetica').fontSize(8.5).text(label, x + 14, y, { width: halfWidth - 105 });
      drawMoney(doc, value, x + halfWidth - 92, y - 1, 77, { size: 8.5 });
    });
  });

  const totalY = tableY + 164;
  doc.moveTo(left, totalY).lineTo(left + contentWidth, totalY).lineWidth(0.7).strokeColor(border).stroke();
  doc.fillColor(blue).font('Helvetica-Bold').fontSize(8.5).text('TOTAL EARNINGS', left + 14, totalY + 15);
  drawMoney(doc, Number(entry.gross) + positiveAdjustment, left + halfWidth - 105, totalY + 14, 90, { size: 9 });
  doc.fillColor('#c04d55').font('Helvetica-Bold').fontSize(8.5).text('TOTAL DEDUCTIONS', left + halfWidth + 14, totalY + 15);
  drawMoney(doc, leaveDeduction + professionalTax + negativeAdjustment, left + contentWidth - 105, totalY + 14, 90, { size: 9, color: '#c04d55' });

  doc.fillColor(navy).font('Helvetica-Bold').fontSize(11).text('LEAVE & PAY SUMMARY', left, 566);
  const cardGap = 10;
  const cardWidth = (contentWidth - cardGap * 2) / 3;
  drawSummaryCard(doc, 'Calendar Days', String(entry.snapshot?.daysInMonth || '-'), left, 584, cardWidth);
  drawSummaryCard(doc, 'Approved Leave Days', `${Number(entry.snapshot?.totalLeaveDays || 0)} days`, left + cardWidth + cardGap, 584, cardWidth);
  drawSummaryMoneyCard(doc, 'Per-Day Salary', entry.snapshot?.perDayAmount || 0, left + (cardWidth + cardGap) * 2, 584, cardWidth);

  const noteY = 658;
  doc.roundedRect(left, noteY, contentWidth, 76, 9).fillAndStroke(pale, border);
  doc.fillColor(blue).font('Helvetica-Bold').fontSize(8).text('HR NOTE', left + 14, noteY + 13);
  doc.fillColor(ink).font('Helvetica').fontSize(8.5).text(entry.snapshot?.note || 'Salary processed as per the approved payroll and leave records.', left + 14, noteY + 30, {
    width: contentWidth - 28,
    height: 32,
    ellipsis: true,
    lineGap: 3,
  });

  doc.moveTo(left, 757).lineTo(left + 150, 757).lineWidth(0.7).strokeColor('#9aabb9').stroke();
  doc.fillColor(muted).font('Helvetica').fontSize(7.5).text('Authorized Signatory', left, 765, { width: 150, align: 'center' });
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(9).text('AdBorn Solutions', left, 779, { width: 150, align: 'center' });
  doc.fillColor(muted).font('Helvetica').fontSize(7).text('This is a computer-generated salary slip and does not require a physical signature.', 245, 767, { width: 316, align: 'right' });
  doc.fillColor(muted).text(`Generated on ${new Date().toLocaleDateString('en-IN')}`, 245, 782, { width: 316, align: 'right' });

  doc.rect(0, 814, pageWidth, 28).fill(navy);
  doc.fillColor('#ffffff').font('Helvetica').fontSize(7.5).text('CONFIDENTIAL EMPLOYEE DOCUMENT', left, 824);
  doc.text('AdBorn ERP  |  Salary & Payroll', 365, 824, { width: 196, align: 'right' });
  return doc;
}

export function streamPayslipPdf(res, payload) {
  const doc = createPayslipDocument(payload);
  doc.on('error', (error) => res.destroy(error));
  doc.pipe(res);
  doc.end();
}

export function createPayslipPdfBuffer(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = createPayslipDocument(payload);
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
