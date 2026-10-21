import mongoose from 'mongoose';
import { z } from 'zod';
import { Quotation, quotationServices } from '../models/Quotation.js';
import { Counter } from '../models/Counter.js';
import { AuditLog } from '../models/AuditLog.js';
import { AppError } from '../utils/errors.js';
import { streamQuotationPdf } from '../services/quotationPdfService.js';
import { transaction, recordChange } from '../services/crmTransactionService.js';
import { Lead } from '../models/Lead.js';
import { Notification } from '../models/Notification.js';

const party = z.object({
  company: z.string().trim().min(1).max(160),
  contactPerson: z.string().trim().min(1).max(120),
  contactNumber: z.string().trim().min(5).max(30),
  email: z.string().trim().email().max(254).or(z.literal('')).optional(),
});
const bodySchema = z.object({
  services: z.array(z.enum(quotationServices)).min(1).max(quotationServices.length).optional(),
  service: z.enum(quotationServices).optional(),
  title: z.string().trim().min(2).max(180),
  client: party,
  secondaryClient: party.optional(),
  items: z.array(z.object({
    service: z.enum(quotationServices).optional(),
    description: z.string().trim().min(1).max(300),
    amount: z.coerce.number().min(0).max(100000000),
  })).min(1).max(quotationServices.length * 6),
  terms: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  gstRate: z.coerce.number().min(0).max(100).default(18),
  status: z.enum(['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired']).default('Draft'),
  validUntil: z.coerce.date().optional(),
  notes: z.string().trim().max(1500).optional(),
}).strict().superRefine((value, context) => {
  if (!value.services?.length && !value.service) context.addIssue({ code: 'custom', path: ['services'], message: 'Select at least one service' });
});
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired']).optional(),
  service: z.enum(quotationServices).optional(),
  search: z.string().trim().max(80).optional(),
}).strict();

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const totals = (items, gstRate) => {
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const gstAmount = Math.round((subtotal * gstRate) / 100 * 100) / 100;
  return { subtotal, gstAmount, grandTotal: subtotal + gstAmount };
};
const normalizeInput = (input) => {
  const services = input.services?.length ? [...new Set(input.services)] : [input.service];
  const items = input.items.map((item) => ({ ...item, service: item.service || services[0] }));
  for (const service of services) {
    const count = items.filter((item) => item.service === service).length;
    if (!count || count > 6) throw new AppError(400, 'Each selected service requires 1-6 price breakdown rows');
  }
  if (items.some((item) => !services.includes(item.service))) throw new AppError(400, 'Price breakdown contains an unselected service');
  return { services, items };
};
const ensureId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'Invalid quotation identifier');
};
async function findQuotation(id) {
  ensureId(id);
  const quotation = await Quotation.findOne({ _id: id, deletedAt: null });
  if (!quotation) throw new AppError(404, 'Quotation not found');
  return quotation;
}
async function audit(req, action, quotation, session) {
  await AuditLog.create([{ user: req.user.id, action, entityType: 'quotation', entityId: quotation._id, details: { quotationNumber: quotation.quotationNumber, status: quotation.status } }], { session });
}
async function nextQuotationNumber(session) {
  const year = new Date().getFullYear();
  const counter = await Counter.findByIdAndUpdate(`quotation-${year}`, { $inc: { value: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true, session });
  return `ADB-Q-${year}-${String(counter.value).padStart(4, '0')}`;
}

export async function listQuotations(req, res) {
  const query = listSchema.parse(req.query);
  const filter = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...((query.service || query.search) ? { $and: [
      ...(query.service ? [{ $or: [{ services: query.service }, { service: query.service }] }] : []),
      ...(query.search ? [{ $or: [
        { quotationNumber: { $regex: escapeRegExp(query.search), $options: 'i' } },
        { title: { $regex: escapeRegExp(query.search), $options: 'i' } },
        { 'client.company': { $regex: escapeRegExp(query.search), $options: 'i' } },
      ] }] : []),
    ] } : {}),
  };
  const [items, total] = await Promise.all([
    Quotation.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    Quotation.countDocuments(filter),
  ]);
  res.json({ success: true, data: { items, pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } } });
}

export async function getQuotation(req, res) {
  res.json({ success: true, data: await findQuotation(req.params.id) });
}

export async function createQuotation(req, res) {
  const input = bodySchema.parse(req.body);
  const { services, items } = normalizeInput(input);
  if (req.crmLead) {
    const quotation = await transaction(async (session) => {
      const lead = await Lead.findById(req.crmLead._id).session(session);
      const [record] = await Quotation.create([{ ...input, items, services, service: services[0], ...totals(items, input.gstRate), quotationNumber: await nextQuotationNumber(session), lead: lead._id, clientRef: lead.convertedClientId, salesPerson: lead.assignedTo, createdBy: req.user.id, updatedBy: req.user.id }], { session });
      await recordChange(req, lead, 'QUOTATION_CREATED', `Quotation created: ${record.quotationNumber}`, { quotation: record._id, quotationNumber: record.quotationNumber }, session);
      if (record.status === 'Sent') await recordChange(req, lead, 'QUOTATION_SENT', 'Quotation sent', { quotation: record._id }, session);
      await lead.save({ session }); return record;
    });
    return res.status(201).json({ success: true, message: 'Quotation created successfully', data: quotation });
  }
  const quotation = await Quotation.create({
    ...input,
    items,
    services,
    service: services[0],
    ...totals(items, input.gstRate),
    quotationNumber: await nextQuotationNumber(),
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  await audit(req, 'quotation.created', quotation);
  res.status(201).json({ success: true, message: 'Quotation created successfully', data: quotation });
}

export async function updateQuotation(req, res) {
  const input = bodySchema.parse(req.body);
  const { services, items } = normalizeInput(input);
  const quotation = await findQuotation(req.params.id);
  const previousStatus = quotation.status;
  Object.assign(quotation, input, { items, services, service: services[0] }, totals(items, input.gstRate), { updatedBy: req.user.id });
  if (quotation.lead) {
    await transaction(async (session) => {
      await quotation.save({ session });
      await audit(req, 'quotation.updated', quotation, session);
      const lead = await Lead.findById(quotation.lead).session(session);
      if (!lead) return;
      await recordChange(req, lead, quotation.status === 'Sent' ? 'QUOTATION_SENT' : 'LEAD_UPDATED', `Quotation ${quotation.status.toLowerCase()}: ${quotation.quotationNumber}`, { quotation: quotation._id, status: quotation.status }, session);
      if (quotation.status === 'Accepted' && previousStatus !== 'Accepted' && lead.assignedTo) await Notification.create([{ recipient: lead.assignedTo, type: 'crm_quotation_accepted', title: 'Quotation accepted', message: quotation.quotationNumber, link: `/crm/leads/${lead.id}`, createdBy: req.user._id }], { session });
      await lead.save({ session });
    });
  } else { await quotation.save(); await audit(req, 'quotation.updated', quotation); }
  res.json({ success: true, message: 'Quotation updated successfully', data: quotation });
}

export async function deleteQuotation(req, res) {
  const quotation = await findQuotation(req.params.id);
  quotation.deletedAt = new Date();
  quotation.updatedBy = req.user.id;
  await quotation.save();
  await audit(req, 'quotation.archived', quotation);
  res.json({ success: true, message: 'Quotation archived successfully' });
}

export async function downloadQuotation(req, res) {
  const quotation = await findQuotation(req.params.id);
  await audit(req, 'quotation.downloaded', quotation);
  streamQuotationPdf(res, quotation.toObject());
}
