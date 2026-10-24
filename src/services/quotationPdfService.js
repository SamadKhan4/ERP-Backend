import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { logoImage, watermarkImage } from '../assets/pdfBrandAssets.js';

const require = createRequire(import.meta.url);
const currencyBoldFontPath =
  require.resolve('@fontsource/inter/files/inter-latin-ext-700-normal.woff');
const navy = '#082f55';
const cyan = '#2bb7e8';
const pale = '#f2f7fa';
const ink = '#17191c';
const companyParty = {
  company: 'AdBorn Solutions',
  contactPerson: 'Team AdBorn Solutions',
  contactNumber: '+91 7488049134',
  email: 'info@adbornsolutions.com',
};
const money = (value) =>
  Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const serviceName = (value) =>
  ({
    web: 'WEBSITE DEVELOPMENT',
    social_media: 'SOCIAL MEDIA MANAGEMENT',
    seo: 'SEARCH ENGINE OPTIMIZATION',
    graphics: 'GRAPHICS DESIGN',
    video: 'VIDEO PRODUCTION',
    meta_ads: 'META ADS',
    google_ads: 'GOOGLE ADS',
  })[value] || String(value).replaceAll('_', ' ').toUpperCase();

function drawMoney(doc, value, x, y, width, fontSize = 10) {
  const amount = money(value);
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

function roundedPanel(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 10).fill(pale);
}

function partyBox(doc, heading, party, x, y, width) {
  roundedPanel(doc, x, y, width, 118);
  doc
    .fillColor(cyan)
    .font('Helvetica')
    .fontSize(12)
    .text(heading, x + 10, y + 12);
  const rows = [
    ['Client / Company:', party.company],
    ['Contact Person:', party.contactPerson],
    ['Contact No.:', party.contactNumber],
    ['Email:', party.email],
  ];
  rows.forEach(([label, value], index) => {
    const rowY = y + 38 + index * 20;
    doc
      .fillColor('#5b5f62')
      .fontSize(8.5)
      .text(label, x + 10, rowY, { width: 98 });
    doc
      .fillColor(ink)
      .fontSize(8)
      .text(value || '-', x + 108, rowY, {
        width: width - 118,
        ellipsis: true,
      });
    doc
      .moveTo(x + 106, rowY + 12)
      .lineTo(x + width - 10, rowY + 12)
      .lineWidth(0.5)
      .strokeColor('#64686b')
      .stroke();
  });
}

function drawPageChrome(doc, quotation, pageNumber, pageCount) {
  doc.rect(20, 30, 414, 5).fill(navy);
  doc.rect(434, 30, 108, 5).fill(cyan);
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
  if (pageNumber === 1) {
    doc
      .fillColor('#000')
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('QUOTATION', 20, 136);
    doc.rect(20, 161, 54, 2).fill(cyan);
    partyBox(doc, 'QUOTATION FROM', companyParty, 20, 174, 255);
    partyBox(doc, 'QUOTATION TO', quotation.client, 285, 174, 257);
  }
  doc
    .fillColor('#7d8b97')
    .font('Helvetica')
    .fontSize(6.5)
    .text(`PAGE ${pageNumber} / ${pageCount}`, 470, 798, {
      width: 70,
      align: 'right',
    });
  doc.rect(0, 816, 562, 26).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica')
    .fontSize(7.5)
    .text('+91 7488049134', 22, 826, { lineBreak: false });
  doc.text('info@adbornsolutions.com', 135, 826, { lineBreak: false });
  doc.text('adbornsolutions.com', 300, 826, { lineBreak: false });
  doc.text('Nagpur, Maharashtra, India', 420, 826, { lineBreak: false });
}

function tableHeight(doc, service, items) {
  doc.font('Helvetica-Bold').fontSize(14);
  const heading = doc.heightOfString(serviceName(service), { width: 522 });
  return (
    heading +
    24 +
    30 +
    items.reduce((sum, item) => {
      doc.font('Helvetica').fontSize(9);
      return (
        sum +
        Math.max(30, doc.heightOfString(item.description, { width: 330 }) + 18)
      );
    }, 0) +
    34 +
    20
  );
}

function drawServiceTable(doc, service, items, headingY, total) {
  doc
    .fillColor(ink)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(serviceName(service), 20, headingY, { width: 522 });
  let y = doc.y + 24;
  doc.roundedRect(20, y, 522, 30, 6).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text('NO.', 30, y + 10);
  doc.text('SERVICE DETAILS', 88, y + 10);
  doc.text('Amount', 430, y + 10, { width: 88, align: 'right' });
  y += 30;
  items.forEach((item, index) => {
    doc.font('Helvetica').fontSize(9);
    const height = Math.max(
      30,
      doc.heightOfString(item.description, { width: 330 }) + 18,
    );
    if (index % 2) doc.rect(20, y, 522, height).fill(pale);
    doc
      .fillColor('#1593d0')
      .text(String(index + 1).padStart(2, '0'), 30, y + 9);
    doc.fillColor(ink).text(item.description, 88, y + 9, { width: 330 });
    if (item.amount !== null && item.amount !== undefined && item.amount !== '')
      drawMoney(doc, item.amount, 430, y + 10, 88, 9);
    y += height;
  });
  doc.rect(20, y, 522, 34).fill(navy);
  doc
    .fillColor('#fff')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text('SERVICE TOTAL', 30, y + 11);
  drawMoney(doc, total, 420, y + 11, 98, 10);
  return y + 54;
}

export function streamQuotationPdf(res, quotation) {
  const selectedServices = quotation.services?.length
    ? quotation.services
    : [quotation.service];
  const doc = new PDFDocument({
    autoFirstPage: false,
    size: [562, 842],
    margin: 0,
    info: { Title: quotation.quotationNumber, Author: 'AdBorn Solutions' },
  });
  doc.registerFont('CurrencyBold', currencyBoldFontPath);
  const measureDoc = new PDFDocument({ size: [562, 842], margin: 0 });
  // Plan pages before rendering so the footer always has the correct page count.
  const pages = [{ tables: [], terms: [], start: 312 }];
  let page = pages[0];
  let y = page.start;
  for (const service of selectedServices) {
    const items = quotation.items.filter(
      (item) => (item.service || selectedServices[0]) === service,
    );
    const height = tableHeight(measureDoc, service, items);
    if (y + height > 758) {
      page = { tables: [], terms: [], start: 146 };
      pages.push(page);
      y = page.start;
    }
    const total =
      quotation.serviceTotals?.find((entry) => entry.service === service)
        ?.total ??
      items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    page.tables.push({ service, items, total, y });
    y += height;
  }
  for (const term of quotation.terms || []) {
    measureDoc.font('Helvetica').fontSize(8);
    const height = measureDoc.heightOfString(term, { width: 492 }) + 8;
    const heading = page.terms.length ? 0 : 28;
    if (y + heading + height > 750) {
      page = { tables: [], terms: [], start: 146 };
      pages.push(page);
      y = page.start;
    }
    if (!page.terms.length) {
      page.termsY = y;
      y += 28;
    }
    page.terms.push({ text: term, y });
    y += height;
  }
  if (y + 38 > 790) {
    page = { tables: [], terms: [], start: 146 };
    pages.push(page);
    y = page.start;
  }
  page.signY = y + 8;
  pages.forEach((page, index) => {
    doc.addPage({ size: [562, 842], margin: 0 });
    drawPageChrome(doc, quotation, index + 1, pages.length);
    for (const table of page.tables)
      drawServiceTable(doc, table.service, table.items, table.y, table.total);
    if (page.terms.length) {
      doc
        .fillColor('#168fd0')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('TERMS & CONDITIONS', 20, page.termsY);
      for (const term of page.terms) {
        doc.circle(23, term.y + 4, 2).fill(cyan);
        doc
          .fillColor(ink)
          .font('Helvetica')
          .fontSize(8)
          .text(term.text, 36, term.y, { width: 492 });
      }
    }
    if (page.signY) {
      doc
        .fillColor('#444')
        .font('Helvetica')
        .fontSize(7)
        .text('Warm regards', 20, page.signY);
      doc
        .fillColor(ink)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Team AdBorn Solutions', 20, page.signY + 14);
    }
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${quotation.quotationNumber}.pdf"`,
  );
  doc.on('error', (error) => res.destroy(error));
  doc.pipe(res);
  doc.end();
}
