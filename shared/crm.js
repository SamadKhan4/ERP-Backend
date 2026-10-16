export const stages = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'FOLLOW_UP',
  'WON',
  'LOST',
  'ON_HOLD',
];
export const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const temperatures = ['COLD', 'WARM', 'HOT'];
export const sources = [
  'Website',
  'Google',
  'Meta Ads',
  'Instagram',
  'LinkedIn',
  'Referral',
  'BNI',
  'Cold Calling',
  'WhatsApp',
  'Existing Client',
  'Walk-in',
  'Other',
];
export const lostReasons = [
  'Budget',
  'No Response',
  'Competitor',
  'Not Interested',
  'Requirement Changed',
  'Timing',
  'Pricing',
  'Duplicate',
  'Invalid Lead',
  'Other',
];
export const followUpTypes = [
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'MEETING',
  'DEMO',
  'PROPOSAL',
  'PAYMENT_FOLLOW_UP',
  'OTHER',
];
export const followUpStatuses = [
  'PENDING',
  'COMPLETED',
  'MISSED',
  'RESCHEDULED',
  'CANCELLED',
];
export const activityTypes = [
  'LEAD_CREATED',
  'LEAD_UPDATED',
  'ASSIGNED',
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'MEETING',
  'DEMO',
  'NOTE',
  'FOLLOW_UP',
  'PROPOSAL_SENT',
  'STATUS_CHANGED',
  'QUOTATION_CREATED',
  'QUOTATION_SENT',
  'WON',
  'LOST',
  'CONVERTED_TO_CLIENT',
  'DOCUMENT_ADDED',
];
export const manualActivityTypes = [
  'CALL',
  'WHATSAPP',
  'EMAIL',
  'MEETING',
  'DEMO',
  'NOTE',
];
export const serviceCatalog = [
  { id: 'web', label: 'Website Development' },
  { id: 'social_media', label: 'Social Media Management' },
  { id: 'seo', label: 'SEO' },
  { id: 'graphics', label: 'Graphics Design' },
  { id: 'video', label: 'Video Production' },
  { id: 'meta_ads', label: 'Meta Ads' },
  { id: 'google_ads', label: 'Google Ads' },
];
export const crmPermissions = [
  'crm.leads.import',
  'crm.dashboard.view',
  'crm.leads.view',
  'crm.leads.view_own',
  'crm.leads.view_team',
  'crm.leads.create',
  'crm.leads.edit',
  'crm.leads.delete',
  'crm.leads.assign',
  'crm.leads.bulk_assign',
  'crm.leads.change_stage',
  'crm.leads.convert',
  'crm.followups.view',
  'crm.followups.view_own',
  'crm.followups.create',
  'crm.followups.edit',
  'crm.followups.complete',
  'crm.followups.delete',
  'crm.activities.view',
  'crm.pipeline.view',
  'crm.pipeline.manage',
  'crm.reports.view',
  'crm.reports.export',
  'crm.settings.manage',
];
export const label = (value) =>
  String(value || '')
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
