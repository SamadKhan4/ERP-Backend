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

export const invoiceCompanies = {
  GST: {
    companyName: 'ABCO Computers',
    gstin: '27AAXCA5017F1ZI',
    stateCode: '27',
  },
  NON_GST: { companyName: 'AdBorn Solutions', gstin: '' },
};
export function invoiceCompanySnapshot(type, settings = {}) {
  return { ...settings, ...invoiceCompanies[type] };
}
