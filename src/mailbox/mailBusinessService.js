import { PassThrough } from 'node:stream';
import { Lead } from '../models/Lead.js';
import { Client } from '../models/Client.js';
import { Invoice } from '../models/Invoice.js';
import { Quotation } from '../models/Quotation.js';
import { LeadActivity } from '../models/LeadActivity.js';
import { AuditLog } from '../models/AuditLog.js';
import { User } from '../models/User.js';
import { loadCRMAccess, leadScope } from '../services/crmAccessService.js';
import { projectAccess, findProject } from '../projects/projectAccess.js';
import { financeAccess, financeScope } from '../finance/financeAccess.js';
import { financeInvoicePdf } from '../finance/financePdfService.js';
import { streamQuotationPdf } from '../services/quotationPdfService.js';
import { AppError } from '../utils/errors.js';
import { id } from './mailAccess.js';
export async function validateLinks(req, links) {
  const selected = {};
  if (links.lead || links.client) {
    await loadCRMAccess(req, null, () => {});
    const scope = leadScope(req);
    if (links.lead) {
      const row = await Lead.findOne({
        $and: [scope, { _id: id(links.lead), deletedAt: null }],
      }).select('_id leadId companyName');
      if (!row) throw new AppError(403, 'Lead access denied');
      selected.lead = row;
    }
    if (links.client) {
      const row = await Client.findOne({
        $and: [scope, { _id: id(links.client) }],
      }).select('_id clientId companyName email phone');
      if (!row) throw new AppError(403, 'Client access denied');
      selected.client = row;
    }
  }
  if (links.project) {
    await projectAccess(req, null, () => {});
    const p = await findProject(req, links.project);
    selected.project = { _id: p._id, title: p.title, projectId: p.projectId };
  }
  if (links.quotation) {
    if (
      !req.mailPermissions.includes('*') &&
      !req.mailPermissions.includes('quotations.read')
    )
      throw new AppError(403, 'Quotation access denied');
    const row = await Quotation.findOne({
      _id: id(links.quotation),
      deletedAt: null,
    });
    if (!row) throw new AppError(404, 'Quotation not found');
    selected.quotation = row;
  }
  if (links.invoice) {
    if (
      !req.mailPermissions.includes('*') &&
      !req.mailPermissions.includes('finance.invoices.view')
    )
      throw new AppError(403, 'Invoice access denied');
    await financeAccess(req, null, () => {});
    const row = await Invoice.findOne({
      $and: [
        financeScope(req, 'invoices'),
        { _id: id(links.invoice), deletedAt: null },
      ],
    });
    if (!row) throw new AppError(403, 'Invoice access denied');
    selected.invoice = row;
  }
  return selected;
}
export async function recordMailLinks(req, mail, links) {
  const fields = {};
  for (const key of ['lead', 'client', 'project', 'quotation', 'invoice'])
    if (links[key])
      fields[`linked${key[0].toUpperCase() + key.slice(1)}`] = id(links[key]);
  mail.set(fields);
  await mail.save();
  if (links.lead)
    await LeadActivity.create({
      lead: links.lead,
      type: 'LEAD_UPDATED',
      title: 'Email communication recorded',
      description: `Email communication recorded by ${req.user.name}`,
      performedBy: req.user._id,
    });
  if (links.project)
    await AuditLog.create({
      user: req.user._id,
      action: 'project.EMAIL_LINKED',
      entityType: 'project',
      entityId: links.project,
      details: { communication: 'Email linked to project' },
    });
}
export async function recordPdf(selected) {
  if (selected.invoice) {
    if (['Draft', 'Cancelled'].includes(selected.invoice.status))
      throw new AppError(409, 'Only issued invoices can be mailed');
    return {
      fileName: `invoice-${selected.invoice._id}.pdf`,
      mime: 'application/pdf',
      content: (await financeInvoicePdf(selected.invoice)).toString('base64'),
    };
  }
  if (selected.quotation) {
    return new Promise((resolve, reject) => {
      const stream = new PassThrough(),
        chunks = [];
      stream.setHeader = () => {};
      stream.on('data', (b) => chunks.push(b));
      stream.on('error', reject);
      stream.on('end', () =>
        resolve({
          fileName: `quotation-${selected.quotation._id}.pdf`,
          mime: 'application/pdf',
          content: Buffer.concat(chunks).toString('base64'),
        }),
      );
      streamQuotationPdf(stream, selected.quotation);
    });
  }
  throw new AppError(
    400,
    'Link an invoice or quotation before attaching its PDF',
  );
}
export async function contactSearch(req, search) {
  const regex = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    contacts = [];
  if (
    req.mailPermissions.some((p) => p === '*' || p.startsWith('crm.leads.view'))
  ) {
    await loadCRMAccess(req, null, () => {});
    for (const Model of [Lead, Client]) {
      const rows = await Model.find({
        $and: [
          leadScope(req),
          {
            $or: [
              { companyName: { $regex: regex, $options: 'i' } },
              { email: { $regex: regex, $options: 'i' } },
            ],
            email: { $ne: '' },
          },
        ],
      })
        .select('companyName email')
        .limit(10)
        .lean();
      contacts.push(
        ...rows.map((r) => ({ name: r.companyName, email: r.email })),
      );
    }
  }
  if (
    req.mailPermissions.includes('*') ||
    req.mailPermissions.includes('users.read')
  ) {
    const users = await User.find({
      active: true,
      $or: [
        { name: { $regex: regex, $options: 'i' } },
        { email: { $regex: regex, $options: 'i' } },
      ],
    })
      .select('name email')
      .limit(10)
      .lean();
    contacts.push(...users);
  }
  return contacts;
}
