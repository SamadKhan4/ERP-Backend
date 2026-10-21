export const invoiceIssuer = (type) =>
  type === 'GST'
    ? { invoiceType: 'GST', issuerBrand: 'ABCO', issuerName: 'ABCO Computers' }
    : {
        invoiceType: 'NON_GST',
        issuerBrand: 'ADBORN',
        issuerName: 'AdBorn Solutions',
      };
export function resolveInvoiceType(input, hasTax) {
  return input.invoiceType || (hasTax ? 'GST' : 'NON_GST');
}
