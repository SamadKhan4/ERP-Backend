import { brandedInvoicePdf } from '../services/brandedInvoicePdfService.js';
import PDFDocument from 'pdfkit';
import { logoImage } from '../assets/pdfBrandAssets.js';
import { FinanceSettings } from '../models/Finance.js';
import { invoiceState } from './financeMoney.js';
import { AppError } from '../utils/errors.js';
const calendarDay = (value) =>
  new Date(new Date(value).getTime() + 19800000).toISOString().slice(0, 10);
const amount = (value) =>
  `INR ${(Number(value || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export async function financeInvoicePdf(invoice) {
  if (invoice.invoiceType) return brandedInvoicePdf(invoice);
  const company =
    invoice.companySnapshot ||
    (await FinanceSettings.findById('finance').lean());
  if (!company?.companyName)
    throw new AppError(
      409,
      'Configure Finance company settings before exporting this invoice',
    );
  const state = invoiceState(invoice);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38 }),
      chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.image(logoImage, 38, 28, { width: 145 });
    doc
      .fillColor('#0d2344')
      .font('Helvetica-Bold')
      .fontSize(23)
      .text('TAX INVOICE', 335, 35, { align: 'right', width: 220 });
    doc
      .fontSize(10)
      .text(invoice.invoiceNumber, 315, 67, { align: 'right', width: 240 });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(company.companyName, 38, 100)
      .text(company.address || '', { width: 270 })
      .text(`GSTIN: ${company.gstin || 'Not registered'}`);
    doc
      .text(`Invoice date: ${calendarDay(invoice.invoiceDate)}`, 340, 100, {
        width: 215,
        align: 'right',
      })
      .text(`Due: ${calendarDay(invoice.dueDate)}`, {
        align: 'right',
      })
      .text(`Status: ${state.financeStatus}`, { align: 'right' });
    doc.moveDown(2);
    doc.x = 38;
    doc.font('Helvetica-Bold').text('BILL TO');
    doc
      .font('Helvetica')
      .text(invoice.client.company)
      .text(invoice.client.address)
      .text(invoice.client.email)
      .text(
        `GSTIN: ${invoice.gstin || 'Not supplied'} | State: ${invoice.stateCode || 'Not supplied'}`,
      );
    doc.moveDown(2);
    const header = () => {
      const y = doc.y;
      doc.rect(38, y, 519, 28).fill('#087dda');
      doc.fillColor('white').font('Helvetica-Bold').fontSize(8);
      ['Description', 'Qty', 'Rate', 'Discount', 'GST', 'Total'].forEach(
        (label, index) =>
          doc.text(label, [46, 277, 314, 375, 436, 484][index], y + 9, {
            width: [220, 30, 55, 55, 45, 66][index],
            align: index > 0 ? 'right' : 'left',
          }),
      );
      doc.y = y + 35;
      doc.fillColor('#173958');
    };
    header();
    const lines = invoice.lineItems?.length
      ? invoice.lineItems
      : invoice.items.map((line) => ({
          description: line.title,
          quantity: '1',
          rateMinor: Math.round(line.amount * 100),
          discountMinor: 0,
          taxRate: String(invoice.gstRate),
          amountMinor: Math.round(line.amount * 100),
        }));
    for (const line of lines) {
      if (doc.y > 610) {
        doc.addPage();
        header();
      }
      const y = doc.y;
      const cells = [
        line.description,
        line.quantity,
        amount(line.rateMinor),
        amount(line.discountMinor),
        `${line.taxRate}%`,
        amount(line.amountMinor),
      ];
      cells.forEach((text, index) =>
        doc
          .font('Helvetica')
          .fontSize(8)
          .text(String(text), [46, 277, 310, 370, 435, 480][index], y, {
            width: [220, 30, 60, 60, 45, 70][index],
            height: 38,
            ellipsis: true,
            align: index > 0 ? 'right' : 'left',
          }),
      );
      doc.y = y + 46;
    }
    if (doc.y > 520) doc.addPage();
    doc.moveDown();
    for (const [label, value] of [
      ['Subtotal', invoice.subtotalMinor ?? Math.round(invoice.subtotal * 100)],
      ['Discount', invoice.discountMinor || 0],
      ['Taxable', invoice.taxableMinor ?? Math.round(invoice.subtotal * 100)],
      ['CGST', invoice.cgstMinor || 0],
      ['SGST', invoice.sgstMinor || 0],
      ['IGST', invoice.igstMinor ?? Math.round(invoice.gstAmount * 100)],
      ['Other charges', invoice.otherChargesMinor || 0],
      ['Grand total', state.totalMinor],
      ['Paid', state.paidMinor],
      ['Balance due', state.balanceMinor],
    ]) {
      const y = doc.y;
      doc
        .font(
          label === 'Grand total' || label === 'Balance due'
            ? 'Helvetica-Bold'
            : 'Helvetica',
        )
        .fontSize(9)
        .text(label, 315, y, { width: 120 });
      doc.text(amount(value), 435, y, { width: 120, align: 'right' });
      doc.y = y + 15;
    }
    doc.x = 38;
    doc.moveDown(1);
    doc.font('Helvetica-Bold').text('PAYMENT DETAILS');
    doc
      .font('Helvetica')
      .fontSize(8)
      .text(
        `${company.bankName || ''} | Account: ${company.accountNumber || ''} | IFSC: ${company.ifscCode || ''}`,
      )
      .text(
        `Branch: ${company.branch || ''}${company.upi ? ` | UPI: ${company.upi}` : ''}`,
      );
    doc.moveDown();
    doc.text(invoice.paymentTerms || company.terms || '', { width: 519 });
    if (invoice.notes) doc.text(invoice.notes, { width: 519 });
    doc.end();
  });
}
