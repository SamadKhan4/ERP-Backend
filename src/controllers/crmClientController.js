import { z } from 'zod';
import { Lead } from '../models/Lead.js';
import { Client } from '../models/Client.js';
import { Project } from '../models/Project.js';
import { Quotation } from '../models/Quotation.js';
import { Invoice } from '../models/Invoice.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { leadSchema, objectId } from '../validators/crmValidator.js';
import { serviceCatalog } from '../../../shared/crm.js';
import { findLead } from '../services/crmLeadService.js';
import { has, id, leadScope } from '../services/crmAccessService.js';
import {
  numberFor,
  recordChange,
  transaction,
} from '../services/crmTransactionService.js';
import { AppError } from '../utils/errors.js';
const clientInput = leadSchema.pick({
  companyName: true,
  contactPerson: true,
  phone: true,
  whatsapp: true,
  email: true,
  website: true,
  address: true,
  industry: true,
  leadSource: true,
  interestedServices: true,
});
export async function convert(req, res) {
  const input = z
    .object({ client: clientInput, existingClientId: objectId.optional() })
    .strict()
    .parse(req.body);
  const data = await transaction(async (session) => {
    const lead = await findLead(req, req.params.id, session);
    if (lead.convertedClientId)
      throw new AppError(409, 'This lead has already been converted');
    let client;
    if (input.existingClientId) {
      client = await Client.findOne({
        _id: input.existingClientId,
        ...(!has(req.crmPermissions, 'crm.leads.view')
          ? { assignedTo: { $in: req.crmTeamIds } }
          : {}),
      }).session(session);
      if (!client)
        throw new AppError(404, 'Client not found or outside your scope');
    } else {
      const matches = [
        {
          companyName: {
            $regex: `^${input.client.companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            $options: 'i',
          },
        },
        ...(input.client.phone ? [{ phone: input.client.phone }] : []),
        ...(input.client.email ? [{ email: input.client.email }] : []),
      ];
      if (await Client.exists({ $or: matches }).session(session))
        throw new AppError(
          409,
          'Possible existing client. Review and explicitly link the existing client.',
        );
      [client] = await Client.create(
        [
          {
            ...input.client,
            assignedTo: lead.assignedTo,
            currency: lead.currency,
            originatingLead: lead._id,
            clientId: await numberFor('crm-client', 'ADB/CLIENT/', session),
            createdBy: req.user._id,
          },
        ],
        { session },
      );
    }
    lead.convertedClientId = client._id;
    lead.convertedAt = new Date();
    lead.stage = lead.status = 'WON';
    lead.wonAt ||= new Date();
    lead.probability = 100;
    await Quotation.updateMany(
      { lead: lead._id },
      { $set: { clientRef: client._id } },
      { session },
    );
    await Invoice.updateMany(
      { lead: lead._id },
      { $set: { clientRef: client._id } },
      { session },
    );
    await CRMFollowUp.updateMany(
      { lead: lead._id },
      { $set: { client: client._id } },
      { session },
    );
    await recordChange(
      req,
      lead,
      'CONVERTED_TO_CLIENT',
      'Lead converted to client',
      {
        client: client._id,
        clientId: client.clientId,
        linkedExisting: Boolean(input.existingClientId),
      },
      session,
    );
    await lead.save({ session });
    return { lead, client };
  });
  res
    .status(201)
    .json({ success: true, message: 'Lead converted successfully', data });
}
export async function clientDetail(req, res) {
  const client = await Client.findById(id(req.params.id)).lean();
  if (!client) throw new AppError(404, 'Client not found');
  const leads = await Lead.find({
    convertedClientId: client._id,
    deletedAt: null,
    ...leadScope(req),
  })
    .select('_id leadId companyName leadSource assignedTo')
    .populate('assignedTo', 'name')
    .lean();
  if (!leads.length)
    throw new AppError(404, 'Client not found or access denied');
  const ids = leads.map((lead) => lead._id);
  const [projects, quotations, invoices] = await Promise.all([
    Project.find({ clientRef: client._id, lead: { $in: ids } })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
    has(req.crmPermissions, 'quotations.read')
      ? Quotation.find({
          clientRef: client._id,
          lead: { $in: ids },
          deletedAt: null,
        })
          .select(
            'quotationNumber title status subtotal gstRate grandTotal lead',
          )
          .limit(50)
          .lean()
      : [],
    has(req.crmPermissions, 'invoices.read')
      ? Invoice.find({
          clientRef: client._id,
          lead: { $in: ids },
          deletedAt: null,
        })
          .select('invoiceNumber status grandTotal quotation project')
          .limit(50)
          .lean()
      : [],
  ]);
  res.json({
    success: true,
    data: { client, leads, projects, quotations, invoices },
  });
}
export async function clientSearch(req, res) {
  const { search } = z
    .object({ search: z.string().max(100).default('') })
    .parse(req.query);
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const items = await Client.find({
    ...(!has(req.crmPermissions, 'crm.leads.view')
      ? { assignedTo: { $in: req.crmTeamIds } }
      : {}),
    ...(search ? { companyName: { $regex: escaped, $options: 'i' } } : {}),
  })
    .select('_id clientId companyName phone email')
    .limit(20)
    .lean();
  res.json({ success: true, data: { items } });
}
export async function leadQuotations(req, res) {
  const lead = await findLead(req, req.params.id);
  const { page } = z
    .object({ page: z.coerce.number().int().min(1).default(1) })
    .parse(req.query);
  const filter = { lead: lead._id, deletedAt: null };
  const [items, total] = await Promise.all([
    Quotation.find(filter)
      .select(
        'quotationNumber title status grandTotal clientRef lead createdAt services',
      )
      .sort({ createdAt: -1 })
      .skip((page - 1) * 20)
      .limit(20)
      .lean(),
    Quotation.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: {
      items,
      pagination: { page, limit: 20, total, totalPages: Math.ceil(total / 20) },
    },
  });
}
export async function quotationContext(req, res, next) {
  req.crmLead = await findLead(req, req.params.id);
  next();
}
export async function createProject(req, res) {
  const input = z
    .object({
      lead: objectId,
      title: z.string().trim().min(1).max(180),
      service: z.enum(serviceCatalog.map((item) => item.id)),
      quotation: objectId.optional(),
      billingType: z.enum(['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
      amount: z.coerce.number().min(0).max(1e10),
      startDate: z.coerce.date().optional(),
      nextBillingAt: z.coerce.date().optional(),
      notes: z.string().max(3000).optional(),
    })
    .strict()
    .parse(req.body);
  if (input.billingType !== 'ONE_TIME' && !input.nextBillingAt)
    throw new AppError(400, 'Recurring services require a next billing date');
  const data = await transaction(async (session) => {
    const lead = await findLead(req, input.lead, session);
    if (String(lead.convertedClientId) !== req.params.id)
      throw new AppError(409, 'Convert this lead to the selected client first');
    if (
      input.quotation &&
      !(await Quotation.exists({
        _id: input.quotation,
        lead: lead._id,
        deletedAt: null,
      }).session(session))
    )
      throw new AppError(400, 'Quotation does not belong to this lead');
    const [project] = await Project.create(
      [
        {
          ...input,
          lead: lead._id,
          clientRef: lead.convertedClientId,
          currency: lead.currency,
          assignedTo: lead.assignedTo,
          projectId: await numberFor('erp-project', 'ADB/PROJECT/', session),
          createdBy: req.user._id,
        },
      ],
      { session },
    );
    await recordChange(
      req,
      lead,
      'LEAD_UPDATED',
      'Project / service created',
      {
        project: project._id,
        projectId: project.projectId,
        billingType: project.billingType,
      },
      session,
    );
    await lead.save({ session });
    return project;
  });
  res
    .status(201)
    .json({ success: true, message: 'Project / service created', data });
}
