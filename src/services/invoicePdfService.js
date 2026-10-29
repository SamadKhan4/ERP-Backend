import { brandedInvoicePdf } from './brandedInvoicePdfService.js';
import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { logoImage, watermarkImage } from '../assets/pdfBrandAssets.js';

const require = createRequire(import.meta.url);
const currencyBoldFontPath =
  require.resolve('@fontsource/inter/files/inter-latin-ext-700-normal.woff');
const navy = '#082f55';
const cyan = '#159bd8';
const pale = '#f2f7fa';
const ink = '#17191c';
const amountText = (value) =>
  Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const dateText = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

function drawMoney(doc, value, x, y, width, fontSize = 10) {
  const amount = amountText(value);
  doc.font('CurrencyBold').fontSize(fontSize);
  const symbolWidth = doc.widthOfString('₹');
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const amountWidth = doc.widthOfString(amount);
  const startX = x + width - symbolWidth - amountWidth - 1;
  doc.font('CurrencyBold').text('₹', startX, y - 2, { lineBreak: false });
  doc
    .font('Helvetica-Bold')
    .text(amount, startX + symbolWidth + 1, y, { lineBreak: false });
}

function infoRow(
  doc,
  label,
  value,
  x,
  y,
  labelWidth,
  valueWidth,
  line = false,
) {
  doc
    .fillColor('#4f5357')
    .font('Helvetica')
    .fontSize(8.5)
    .text(label, x, y, { width: labelWidth });
  doc
    .fillColor(ink)
    .fontSize(8)
    .text(value || '-', x + labelWidth + 8, y, {
      width: valueWidth,
      height: 13,
      ellipsis: true,
    });
  if (line)
    doc
      .moveTo(x + labelWidth + 6, y + 12)
      .lineTo(x + labelWidth + valueWidth + 8, y + 12)
      .lineWidth(0.5)
      .strokeColor('#65696d')
      .stroke();
}

export function streamInvoicePdf(res, invoice) {
  if (invoice.invoiceType)
    return brandedInvoicePdf(invoice).then((buffer) =>
      res
        .type('application/pdf')
        .attachment(`invoice-${invoice._id || 'download'}.pdf`)
        .send(buffer),
    );
  const doc = new PDFDocument({
    size: [562, 842],
    margin: 0,
    info: { Title: invoice.invoiceNumber, Author: 'AdBorn Solutions' },
  });
  doc.registerFont('CurrencyBold', currencyBoldFontPath);

  doc.rect(20, 30, 414, 5).fill(navy);
  doc.rect(434, 30, 108, 5).fill('#2bb7e8');
  doc
    .save()
    .opacity(0.1)
    .image(watermarkImage, 420, -4, { width: 142 })
    .restore();
  doc.image(logoImage, 20, 54, { width: 190 });
  doc
    .moveTo(20, 118)
    .lineTo(542, 118)
    .lineWidth(0.7)
    .strokeColor('#c9ced2')
    .stroke();

  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(24)
    .text('INVOICE', 20, 139);
  doc.rect(20, 176, 54, 2).fill('#2bb7e8');
  doc
    .fillColor(ink)
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      'Thank you for choosing AdBorn Solutions.\nWe appreciate your business and look forward to a successful\npartnership',
      20,
      186,
      { width: 250, lineGap: 3 },
    );

  doc.roundedRect(285, 128, 257, 90, 10).fill(pale);
  [
    ['INVOICE NO.', invoice.invoiceNumber],
    ['DATE', dateText(invoice.invoiceDate)],
    ['DUE DATE', dateText(invoice.dueDate)],
  ].forEach(([label, value], index) => {
    const y = 143 + index * 26;
    doc
      .fillColor(index === 0 ? cyan : '#4c5054')
      .font(index === 0 ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(10.5)
      .text(label, 295, y);
    doc
      .fillColor('#41464b')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(':', 392, y);
    doc
      .fillColor(ink)
      .font('Helvetica')
      .fontSize(8)
      .text(value, 405, y, { width: 125, ellipsis: true });
  });

  doc.roundedRect(20, 232, 255, 29, 10).fill(pale);
  doc
    .fillColor(cyan)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('BILL TO', 30, 242);
  const clientRows = [
    ['Client / Company:', invoice.client.company],
    ['Contact Person:', invoice.client.contactPerson],
    ['ADDRESS:', invoice.client.address],
    ['Contact No.:', invoice.client.contactNumber],
    ['Email:', invoice.client.email],
  ];
  clientRows.forEach(([label, value], index) =>
    infoRow(doc, label, value, 30, 274 + index * 21, 104, 125, true),
  );

  doc.roundedRect(285, 232, 257, 143, 10).fill(pale);
  doc
    .fillColor(cyan)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('PAYMENT DETAILS', 295, 245);
  const paymentRows = [
    ['Bank Name', invoice.paymentDetails.bankName],
    ['Account Number', invoice.paymentDetails.accountNumber],
    ['IFSC Code', invoice.paymentDetails.ifscCode],
    ['Branch', invoice.paymentDetails.branch],
  ];
  paymentRows.forEach(([label, value], index) => {
    const y = 278 + index * 26;
    doc
      .fillColor('#454a4f')
      .font('Helvetica')
      .fontSize(10.5)
      .text(label, 295, y, { width: 112 });
    doc.font('Helvetica-Bold').text(':', 410, y);
    doc
      .fillColor(ink)
      .font('Helvetica')
      .fontSize(8)
      .text(value || '-', 422, y + 1, { width: 107, ellipsis: true });
  });

  let y = 385;
  doc.roundedRect(20, y, 522, 34, 6).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('NO.', 30, y + 11);
  doc.text('SERVICE DETAILS', 88, y + 11);
  doc.text('Amount', 452, y + 11, { width: 66, align: 'right' });
  y += 34;
  invoice.items.slice(0, 6).forEach((item, index) => {
    if (index % 2) doc.rect(20, y, 522, 34).fill(pale);
    doc
      .fillColor(cyan)
      .font('Helvetica')
      .fontSize(10)
      .text(String(index + 1).padStart(2, '0'), 30, y + 11);
    doc
      .fillColor(ink)
      .fontSize(9)
      .text(item.title, 88, y + 10, { width: 325, height: 18, ellipsis: true });
    drawMoney(doc, item.amount, 420, y + 10, 98);
    y += 34;
  });
  doc
    .moveTo(20, y)
    .lineTo(542, y)
    .lineWidth(0.7)
    .strokeColor('#b5bdc4')
    .stroke();

  const totalsY = Math.max(y + 6, 625);
  const totalsX = 322;
  doc.rect(totalsX, totalsY, 220, 58).fill(pale);
  doc
    .fillColor(cyan)
    .font('Helvetica')
    .fontSize(9)
    .text('SUBTOTAL', totalsX + 10, totalsY + 12);
  doc.fillColor(ink);
  drawMoney(doc, invoice.subtotal, totalsX + 118, totalsY + 12, 82, 9);
  doc
    .fillColor(ink)
    .font('Helvetica')
    .text(`GST ${invoice.gstRate}%`, totalsX + 10, totalsY + 35);
  drawMoney(doc, invoice.gstAmount, totalsX + 118, totalsY + 35, 82, 9);
  doc.rect(totalsX, totalsY + 58, 220, 48).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica')
    .fontSize(11)
    .text('GRAND TOTAL', totalsX + 10, totalsY + 70);
  drawMoney(doc, invoice.grandTotal, totalsX + 108, totalsY + 70, 92, 11);
  doc
    .font('Helvetica')
    .fontSize(5)
    .text(
      `GST calculated at ${invoice.gstRate}% (subject to applicability).`,
      totalsX + 10,
      totalsY + 91,
    );

  doc
    .moveTo(20, 752)
    .lineTo(152, 752)
    .lineWidth(0.8)
    .strokeColor('#6a6e72')
    .stroke();
  doc
    .fillColor('#333')
    .font('Helvetica')
    .fontSize(8)
    .text('Authorized Signatory', 39, 760);
  doc
    .fillColor(ink)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text('AdBorn Solutions', 34, 777);
  doc.rect(0, 816, 562, 26).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica')
    .fontSize(7.5)
    .text('+91 7488049134', 22, 826, { lineBreak: false });
  doc.text('info@adbornsolutions.com', 135, 826, { lineBreak: false });
  doc.text('adbornsolutions.com', 300, 826, { lineBreak: false });
  doc.text('Nagpur, Maharashtra, India', 420, 826, { lineBreak: false });
  const terms = invoice.paymentTerms ?? invoice.companySnapshot?.terms ?? '';
  if (terms) {
    doc.addPage({ margin: 38 });
    doc
      .fillColor(navy)
      .font('Helvetica-Bold')
      .fontSize(14)
      .text('TERMS & CONDITIONS', 38, 38, { width: 486 });
    doc
      .fillColor(ink)
      .font('Helvetica')
      .fontSize(10)
      .text(terms, 38, 70, { width: 486 });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${invoice.invoiceNumber}.pdf"`,
  );
  doc.on('error', (error) => res.destroy(error));
  doc.pipe(res);
  doc.end();
}
