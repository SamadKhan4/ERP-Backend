export const importFields = [
  [
    'companyName',
    'Company Name',
    ['company', 'company name', 'business', 'business name'],
  ],
  [
    'contactPerson',
    'Contact Person',
    ['contact', 'contact person', 'contact name', 'name'],
  ],
  [
    'phone',
    'Phone',
    ['phone', 'mobile', 'phone number', 'mobile number', 'contact number'],
  ],
  ['whatsapp', 'WhatsApp', ['whatsapp', 'whatsapp number']],
  ['email', 'Email', ['email', 'email address']],
  ['website', 'Website', ['website', 'url']],
  ['industry', 'Industry', ['industry', 'sector']],
  ['leadSource', 'Lead Source', ['source', 'lead source']],
  [
    'interestedServices',
    'Interested Services',
    ['services', 'interested services', 'service'],
  ],
  [
    'estimatedBudget',
    'Estimated Budget',
    ['budget', 'estimated budget', 'estimated value', 'value'],
  ],
  ['currency', 'Currency', ['currency']],
  [
    'assignedEmail',
    'Assigned Employee Email',
    ['assigned email', 'assigned employee email', 'owner email', 'sales email'],
  ],
  ['stage', 'Stage', ['stage', 'status', 'lead stage']],
  ['priority', 'Priority', ['priority']],
  ['temperature', 'Temperature', ['temperature']],
  ['probability', 'Probability', ['probability', 'probability %']],
  [
    'expectedClosingDate',
    'Expected Closing Date',
    ['expected closing date', 'closing date'],
  ],
  [
    'nextFollowUpAt',
    'Next Follow-up',
    ['next follow up', 'next follow-up', 'follow up date'],
  ],
  ['address.addressLine', 'Address', ['address', 'address line']],
  ['address.city', 'City', ['city']],
  ['address.state', 'State', ['state']],
  ['address.country', 'Country', ['country']],
  ['address.pincode', 'Pincode', ['pincode', 'postal code', 'zip']],
  ['notes', 'Notes', ['notes', 'remarks']],
  ['tags', 'Tags', ['tags']],
  ['lostReason', 'Lost Reason', ['lost reason']],
  ['lostDetail', 'Lost Details', ['lost details', 'lost reason details']],
];
export const normalizeHeader = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export function suggestMapping(headers) {
  return Object.fromEntries(
    importFields
      .map(([field, , aliases]) => [
        field,
        headers.findIndex((header) =>
          [field, ...aliases].some(
            (alias) => normalizeHeader(alias) === normalizeHeader(header),
          ),
        ),
      ])
      .filter(([, index]) => index >= 0),
  );
}
