import { AppError } from '../utils/errors.js';
export function scaled(value, places = 2) {
  const text = String(value ?? '0');
  if (!new RegExp(`^\\d{1,10}(?:\\.\\d{1,${places}})?$`).test(text))
    throw new AppError(
      400,
      `Use a non-negative decimal with at most ${places} decimal places`,
    );
  const [whole, fraction = ''] = text.split('.');
  return (
    BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'))
  );
}
export function safeMinor(value) {
  if (value > 10000000000000n || value < 0n)
    throw new AppError(400, 'Financial amount is outside supported limits');
  return Number(value);
}
export const minor = (value) => safeMinor(scaled(value));
export const roundRatio = (value, divisor) => (value + divisor / 2n) / divisor;
export function invoiceAmounts(lines, taxType, otherCharges = '0') {
  let subtotal = 0n,
    discount = 0n,
    tax = 0n;
  const items = lines.map((line) => {
    const quantity = scaled(line.quantity ?? '1', 4),
      rate = scaled(line.rate),
      reduction = scaled(line.discount ?? '0'),
      rateBps = scaled(line.taxRate ?? '0');
    if (!quantity || rateBps > 10000n)
      throw new AppError(
        400,
        'Quantity must be positive and tax rate must be between 0 and 100',
      );
    const base = roundRatio(quantity * rate, 10000n);
    if (reduction > base)
      throw new AppError(400, 'Line discount cannot exceed its value');
    const taxable = base - reduction;
    // Split intra-state GST at the line level; preserve the exact line tax total.
    const lineTax =
      taxType === 'EXEMPT' ? 0n : roundRatio(taxable * rateBps, 10000n);
    subtotal += base;
    discount += reduction;
    tax += lineTax;
    return {
      description: line.description,
      quantity: String(line.quantity ?? '1'),
      rateMinor: safeMinor(rate),
      discountMinor: safeMinor(reduction),
      taxableMinor: safeMinor(taxable),
      taxRate: String(line.taxRate ?? '0'),
      taxMinor: safeMinor(lineTax),
      amountMinor: safeMinor(taxable + lineTax),
    };
  });
  const cgst = taxType === 'INTRA_STATE' ? tax / 2n : 0n,
    sgst = taxType === 'INTRA_STATE' ? tax - cgst : 0n,
    igst = taxType === 'INTER_STATE' ? tax : 0n;
  const other = scaled(otherCharges);
  return {
    items,
    subtotalMinor: safeMinor(subtotal),
    discountMinor: safeMinor(discount),
    taxableMinor: safeMinor(subtotal - discount),
    cgstMinor: safeMinor(cgst),
    sgstMinor: safeMinor(sgst),
    igstMinor: safeMinor(igst),
    taxMinor: safeMinor(tax),
    otherChargesMinor: safeMinor(other),
    totalMinor: safeMinor(subtotal - discount + tax + other),
  };
}
export function legacyMinor(value) {
  // Existing Number-based invoices are rounded once when entering the minor-unit ledger.
  return minor(Number(value || 0).toFixed(2));
}
export function invoiceState(invoice, now = new Date()) {
  const total = invoice.totalMinor ?? legacyMinor(invoice.grandTotal);
  const paid = invoice.paidMinor ?? (invoice.status === 'Paid' ? total : 0);
  const balance = Math.max(0, total - paid);
  const day = new Date(
    `${new Date(now.getTime() + 19800000).toISOString().slice(0, 10)}T00:00:00+05:30`,
  );
  const age = Math.max(
    0,
    Math.floor((day - new Date(invoice.dueDate)) / 86400000),
  );
  const issued = !['Draft', 'Cancelled'].includes(invoice.status);
  const status =
    invoice.status === 'Cancelled'
      ? 'CANCELLED'
      : invoice.status === 'Draft'
        ? 'DRAFT'
        : balance === 0
          ? 'PAID'
          : paid > 0
            ? 'PARTIALLY_PAID'
            : new Date(invoice.dueDate) < day
              ? 'OVERDUE'
              : 'SENT';
  return {
    totalMinor: total,
    paidMinor: paid,
    balanceMinor: issued ? balance : 0,
    settlementBalanceMinor: balance,
    financeStatus: status,
    daysOverdue: issued && balance ? age : 0,
    bucket:
      age <= 30 ? '0–30' : age <= 60 ? '31–60' : age <= 90 ? '61–90' : '90+',
  };
}
