import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { logoImage, watermarkImage } from '../assets/pdfBrandAssets.js';

const require = createRequire(import.meta.url);
const currencyBoldFontPath = require.resolve('@fontsource/inter/files/inter-latin-ext-700-normal.woff');
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
const money = (value) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const serviceName = (value) => ({
  web: 'WEBSITE DEVELOPMENT', social_media: 'SOCIAL MEDIA MANAGEMENT', seo: 'SEARCH ENGINE OPTIMIZATION',
  graphics: 'GRAPHICS DESIGN', video: 'VIDEO PRODUCTION', meta_ads: 'META ADS', google_ads: 'GOOGLE ADS',
}[value] || String(value).replaceAll('_', ' ').toUpperCase());

function drawMoney(doc, value, x, y, width, fontSize = 10) {
  const amount = money(value);
  doc.font('CurrencyBold').fontSize(fontSize);
  const symbolWidth = doc.widthOfString('₹');
  doc.font('Helvetica-Bold').fontSize(fontSize);
  const amountWidth = doc.widthOfString(amount);
  const startX = x + width - symbolWidth - amountWidth - 1;
  doc.font('CurrencyBold').text('₹', startX, y - 2, { lineBreak: false });
  doc.font('Helvetica-Bold').text(amount, startX + symbolWidth + 1, y, { lineBreak: false });
}

function roundedPanel(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 10).fill(pale);
}

function partyBox(doc, heading, party, x, y, width) {
  roundedPanel(doc, x, y, width, 118);
  doc.fillColor(cyan).font('Helvetica').fontSize(12).text(heading, x + 10, y + 12);
  const rows = [
    ['Client / Company:', party.company],
    ['Contact Person:', party.contactPerson],
    ['Contact No.:', party.contactNumber],
    ['Email:', party.email],
  ];
  rows.forEach(([label, value], index) => {
    const rowY = y + 38 + index * 20;
    doc.fillColor('#5b5f62').fontSize(8.5).text(label, x + 10, rowY, { width: 98 });
    doc.fillColor(ink).fontSize(8).text(value || '-', x + 108, rowY, { width: width - 118, ellipsis: true });
    doc.moveTo(x + 106, rowY + 12).lineTo(x + width - 10, rowY + 12).lineWidth(0.5).strokeColor('#64686b').stroke();
  });
}

function drawPageChrome(doc, quotation, pageNumber, pageCount) {
  doc.rect(20, 30, 414, 5).fill(navy);
  doc.rect(434, 30, 108, 5).fill(cyan);
  doc.save().opacity(0.1).image(watermarkImage, 420, -4, { width: 142 }).restore();
  doc.image(logoImage, 20, 54, { width: 190 });
  doc.moveTo(20, 118).lineTo(542, 118).lineWidth(0.7).strokeColor('#c9ced2').stroke();
  if (pageNumber === 1) {
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text('QUOTATION', 20, 136);
    doc.rect(20, 161, 54, 2).fill(cyan);
    partyBox(doc, 'QUOTATION FROM', companyParty, 20, 174, 255);
    partyBox(doc, 'QUOTATION TO', quotation.client, 285, 174, 257);
  }
  doc.fillColor('#7d8b97').font('Helvetica').fontSize(6.5).text(`PAGE ${pageNumber} / ${pageCount}`, 470, 798, { width: 70, align: 'right' });
  doc.rect(0, 816, 562, 26).fill(navy);
  doc.fillColor('#fff').font('Helvetica').fontSize(7.5).text('+91 7488049134', 22, 826, { lineBreak: false });
  doc.text('info@adbornsolutions.com', 135, 826, { lineBreak: false });
  doc.text('adbornsolutions.com', 300, 826, { lineBreak: false });
  doc.text('Nagpur, Maharashtra, India', 420, 826, { lineBreak: false });
}

function drawServiceTable(doc, service, items, isFirstPage) {
  const headingY = isFirstPage ? 312 : 146;
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(16).text(serviceName(service), 20, headingY, { width: 522, height: 22, ellipsis: true });
  doc.rect(20, headingY + 26, 54, 2).fill(cyan);
  let y = headingY + 42;
  doc.roundedRect(20, y, 522, 34, 6).fill(navy);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10).text('NO.', 30, y + 11);
  doc.text('SERVICE DETAILS', 88, y + 11);
  doc.text('Amount', 430, y + 11, { width: 88, align: 'right' });
  y += 34;
  items.slice(0, 6).forEach((item, index) => {
    const height = 34;
    if (index % 2) doc.rect(20, y, 522, height).fill(pale);
    doc.fillColor('#1593d0').font('Helvetica').fontSize(10).text(String(index + 1).padStart(2, '0'), 30, y + 11);
    doc.fillColor(ink).fontSize(9).text(item.description, 88, y + 10, { width: 330, height: 18, ellipsis: true });
    drawMoney(doc, item.amount, 430, y + 10, 88);
    y += height;
  });
  doc.moveTo(20, y).lineTo(542, y).lineWidth(0.7).strokeColor('#b5bdc4').stroke();
  return y;
}

function drawFinalSummary(doc, quotation, tableBottom) {
  const bottomY = Math.min(Math.max(tableBottom + 10, 600), 650);
  doc.fillColor('#168fd0').font('Helvetica').fontSize(11).text('TERMS & CONDITIONS', 20, bottomY + 2);
  quotation.terms.slice(0, 10).forEach((term, index) => {
    doc.circle(23, bottomY + 26 + index * 13, 2).fill('#209bd4');
    doc.fillColor(ink).fontSize(6.5).text(term, 30, bottomY + 22 + index * 13, { width: 275, height: 11, ellipsis: true });
  });
  const totalsX = 322;
  doc.rect(totalsX, bottomY, 220, 58).fill(pale);
  doc.fillColor('#168fd0').fontSize(9).text('SUBTOTAL', totalsX + 10, bottomY + 12);
  doc.fillColor(ink);
  drawMoney(doc, quotation.subtotal, totalsX + 120, bottomY + 12, 80, 9);
  doc.fillColor(ink).font('Helvetica').text(`GST ${quotation.gstRate}%`, totalsX + 10, bottomY + 35);
  drawMoney(doc, quotation.gstAmount, totalsX + 120, bottomY + 35, 80, 9);
  doc.rect(totalsX, bottomY + 58, 220, 48).fill(navy);
  doc.fillColor('#fff').font('Helvetica').fontSize(11).text('GRAND TOTAL', totalsX + 10, bottomY + 70);
  drawMoney(doc, quotation.grandTotal, totalsX + 112, bottomY + 70, 88, 11);
  doc.font('Helvetica').fontSize(5).text(`GST calculated at ${quotation.gstRate}% (subject to applicability).`, totalsX + 10, bottomY + 91);
  doc.fillColor('#444').fontSize(7).text('Warm regards', 20, 770);
  doc.fillColor(ink).font('Helvetica-Bold').fontSize(10).text('Team AdBorn Solutions', 20, 784);
}

export function streamQuotationPdf(res, quotation) {
  const selectedServices = quotation.services?.length ? quotation.services : [quotation.service];
  const doc = new PDFDocument({ autoFirstPage: false, size: [562, 842], margin: 0, info: { Title: quotation.quotationNumber, Author: 'AdBorn Solutions' } });
  doc.registerFont('CurrencyBold', currencyBoldFontPath);
  selectedServices.forEach((service, index) => {
    doc.addPage({ size: [562, 842], margin: 0 });
    drawPageChrome(doc, quotation, index + 1, selectedServices.length);
    const items = quotation.items.filter((item) => (item.service || selectedServices[0]) === service);
    const tableBottom = drawServiceTable(doc, service, items, index === 0);
    if (index === selectedServices.length - 1) drawFinalSummary(doc, quotation, tableBottom);
    else doc.fillColor('#60778c').font('Helvetica').fontSize(8).text('Quotation continues on the next service page.', 20, 770);
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${quotation.quotationNumber}.pdf"`);
  doc.on('error', (error) => res.destroy(error));
  doc.pipe(res);
  doc.end();
}
