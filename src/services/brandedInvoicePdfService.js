import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { logoImage } from '../assets/pdfBrandAssets.js';
const abcoLogo = fileURLToPath(
  new URL('../assets/invoices/ABCO_Logo.png', import.meta.url),
);
const date = (value) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
export function brandedInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const gst = invoice.invoiceType === 'GST',
      brand = gst ? 'ABCO Computers' : 'AdBorn Solutions',
      dark = gst ? '#2c1d1d' : '#082f55',
      accent = gst ? '#ff1019' : '#159bd8',
      pale = gst ? '#fff8f8' : '#f2f7fa',
      company = invoice.companySnapshot || {};
    const doc = new PDFDocument({
        size: [562, 842],
        margin: 0,
        info: { Title: invoice.invoiceNumber, Author: brand },
      }),
      chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const text = (
      value,
      x,
      y,
      width = 240,
      size = 9,
      bold = false,
      color = '#202020',
      height = 26,
    ) =>
      doc
        .fillColor(color)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(size)
        .text(String(value || '-'), x, y, { width, height, ellipsis: true });
    const cash = (value, x, y, width = 95, size = 10, color = '#202020') => {
      const number = Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      doc
        .fillColor(color)
        .font('Helvetica-Bold')
        .fontSize(size)
        .text(number, x, y, { width, align: 'right', lineBreak: false });
    };
    doc.rect(20, 30, 414, 5).fill(dark);
    doc.rect(434, 30, 108, 5).fill(accent);
    if (gst) {
      doc
        .save()
        .opacity(0.045)
        .image(abcoLogo, 365, 52, { width: 180 })
        .restore();
      doc.image(abcoLogo, 22, 55, { fit: [190, 46] });
    } else doc.image(logoImage, 20, 54, { width: 190 });
    doc
      .moveTo(20, 118)
      .lineTo(542, 118)
      .lineWidth(0.7)
      .strokeColor('#c9ced2')
      .stroke();
    text('INVOICE', 20, 137, 250, 29, true, '#000', 38);
    doc.rect(20, 176, 54, 2).fill(accent);
    text(
      `Thank you for choosing ${brand}.\nWe appreciate your business and look forward to a successful partnership.`,
      20,
      186,
      250,
      8.5,
      false,
      '#202020',
      52,
    );
    doc.roundedRect(285, 128, 257, 116, 10).fill(pale);
    [
      ['INVOICE NO.', invoice.invoiceNumber],
      ['DATE', date(invoice.invoiceDate)],
      ['DUE DATE', date(invoice.dueDate)],
      ...(gst
        ? [['GST No.', company.gstin || 'Not provided']]
        : [['ISSUED BY', brand]]),
    ].forEach(([key, value], i) => {
      text(
        key,
        295,
        142 + i * 25,
        94,
        10,
        false,
        i === 0 ? '#810000' : '#454545',
        18,
      );
      text(':', 392, 142 + i * 25, 10, 10);
      text(value, 404, 143 + i * 25, 128, 8, false, '#202020', 21);
    });
    doc.roundedRect(20, 254, 255, 29, 10).fill(pale);
    text('BILL TO', 30, 263, 220, 11, false, gst ? '#810000' : accent);
    const rows = [
      ['Client / Company:', invoice.client.company],
      ['Contact Person:', invoice.client.contactPerson],
      ['ADDRESS:', invoice.client.address],
      ['Contact No.:', invoice.client.contactNumber],
      [
        gst ? 'GST No.:' : 'Email:',
        gst ? invoice.gstin || 'Not supplied' : invoice.client.email,
      ],
    ];
    rows.forEach(([key, value], i) => {
      text(key, 30, 295 + i * 21, 105, 8, false, '#555', 19);
      text(value, 139, 295 + i * 21, 132, 8, false, '#202020', 19);
      doc
        .moveTo(139, 310 + i * 21)
        .lineTo(275, 310 + i * 21)
        .lineWidth(0.5)
        .strokeColor('#888')
        .stroke();
    });
    doc.roundedRect(285, 254, 257, 143, 10).fill(pale);
    text('PAYMENT DETAILS', 295, 267, 230, 11, false, gst ? '#810000' : accent);
    [
      ['Bank Name', invoice.paymentDetails?.bankName || company.bankName],
      [
        'Account Number',
        invoice.paymentDetails?.accountNumber || company.accountNumber,
      ],
      ['IFSC Code', invoice.paymentDetails?.ifscCode || company.ifscCode],
      ['Branch', invoice.paymentDetails?.branch || company.branch],
    ].forEach(([key, value], i) => {
      text(key, 295, 293 + i * 26, 110, 10);
      text(':', 409, 293 + i * 26, 10, 10);
      text(value, 422, 294 + i * 26, 108, 8);
    });
    let y = 407;
    doc.roundedRect(20, y, 522, 34, 6).fill(dark);
    text('NO.', 30, y + 11, 45, 10, false, '#fff', 18);
    text('SERVICE DETAILS', 90, y + 11, 310, 10, false, '#fff', 18);
    text('Amount', 452, y + 11, 68, 10, false, '#fff', 18);
    y += 34;
    const lines = invoice.lineItems?.length
      ? invoice.lineItems.map((line) => ({
          title: `${line.description}${line.quantity !== '1' ? ` (Qty ${line.quantity})` : ''}`,
          amount: line.taxableMinor / 100,
        }))
      : invoice.items;
    lines.forEach((item, i) => {
      const height = 34;
      if (i % 2) doc.rect(20, y, 522, height).fill(pale);
      text(
        String(i + 1).padStart(2, '0'),
        30,
        y + 11,
        45,
        10,
        false,
        gst ? '#810000' : accent,
        20,
      );
      text(item.title, 90, y + 9, 320, 8.5, false, '#202020', 27);
      cash(item.amount, 421, y + 10, 98, 9);
      y += height;
    });
    doc
      .moveTo(20, y)
      .lineTo(542, y)
      .strokeColor('#bbb')
      .lineWidth(0.6)
      .stroke();
    const totals = [
      ['SUBTOTAL', invoice.subtotal],
      ...(gst
        ? [
            [
              invoice.taxType === 'INTRA_STATE'
                ? 'CGST + SGST'
                : invoice.taxType === 'INTER_STATE'
                  ? 'IGST'
                  : `GST ${invoice.gstRate}%`,
              invoice.gstAmount,
            ],
          ]
        : []),
      ...(invoice.otherChargesMinor
        ? [['OTHER CHARGES', invoice.otherChargesMinor / 100]]
        : []),
    ];
    const totalY = Math.max(y + 6, 646);
    totals.forEach(([title, value], i) => {
      doc.rect(322, totalY + i * 24, 220, 24).fill(pale);
      text(
        title,
        332,
        totalY + i * 24 + 8,
        110,
        8,
        false,
        i === 0 ? (gst ? '#810000' : accent) : '#222',
        15,
      );
      cash(value, 440, totalY + i * 24 + 6, 90, 9);
    });
    const grandY = totalY + totals.length * 24;
    doc.rect(322, grandY, 220, 44).fill(dark);
    text('GRAND TOTAL', 332, grandY + 11, 106, 9, false, '#fff', 15);
    cash(invoice.grandTotal, 437, grandY + 10, 94, 10, '#fff');
    text(
      gst ? 'GST included as calculated above.' : 'No GST charged.',
      332,
      grandY + 30,
      200,
      5,
      false,
      '#fff',
      10,
    );
    doc
      .moveTo(20, 752)
      .lineTo(154, 752)
      .lineWidth(0.8)
      .strokeColor('#555')
      .stroke();
    text('Authorized Signatory', 40, 760, 135, 8);
    text(brand, 34, 777, 190, 11, true);
    doc.rect(0, 816, 562, 26).fill(dark);
    text(
      gst ? '+91 1729703783' : '+91 7488049134',
      20,
      826,
      110,
      7.3,
      false,
      '#fff',
      12,
    );
    text('info@adbornsolutions.com', 132, 826, 159, 7.3, false, '#fff', 12);
    text('adbornsolutions.com', 290, 826, 120, 7.3, false, '#fff', 12);
    text('Nagpur, Maharashtra, India', 417, 826, 143, 7.3, false, '#fff', 12);
    const details = [
      invoice.paymentTerms || company.terms,
      invoice.notes,
      invoice.reference ? `Reference: ${invoice.reference}` : '',
      invoice.financeVersion
        ? `Paid: INR ${((invoice.paidMinor || 0) / 100).toFixed(2)} | Balance: INR ${(Math.max(0, (invoice.totalMinor || 0) - (invoice.paidMinor || 0)) / 100).toFixed(2)}`
        : '',
      gst && invoice.taxType === 'INTRA_STATE'
        ? `CGST: INR ${((invoice.cgstMinor || 0) / 100).toFixed(2)} | SGST: INR ${((invoice.sgstMinor || 0) / 100).toFixed(2)}`
        : '',
      invoice.discountMinor
        ? `Discount applied: INR ${(invoice.discountMinor / 100).toFixed(2)}`
        : '',
    ].filter(Boolean);
    if (details.length) {
      doc.addPage({ margin: 38 });
      text(`${brand} | Invoice Details`, 38, 38, 480, 17, true, dark);
      let dy = 78;
      for (const value of details) {
        doc.font('Helvetica').fontSize(10);
        const h = doc.heightOfString(value, { width: 486 });
        if (dy + h > 780) {
          doc.addPage({ margin: 38 });
          dy = 38;
        }
        doc.fillColor('#24364b').text(value, 38, dy, { width: 486 });
        dy += h + 16;
      }
    }
    doc.end();
  });
}
