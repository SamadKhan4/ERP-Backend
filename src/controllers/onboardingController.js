import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { OnboardingDocument, onboardingDocumentTypes } from '../models/OnboardingDocument.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { User } from '../models/User.js';
import { AuditLog } from '../models/AuditLog.js';
import { departments } from '../constants/departments.js';
import { AppError } from '../utils/errors.js';
import { nextEmployeeCode } from '../services/employeeCodeService.js';
import { onboardingUploadRoot } from '../middleware/onboardingUpload.js';

export const requiredOnboardingDocuments = [
  'identity_proof',
  'address_proof',
  'profile_photo',
  'education',
  'bank_proof',
];

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid identifier');
const optionalText = (max = 200) => z.string().trim().max(max).optional();
const onboardingSchema = z.object({
  personal: z.object({
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    dateOfBirth: z.coerce.date(),
    phone: z.string().trim().min(7).max(30),
    alternatePhone: optionalText(30),
    gender: optionalText(40),
    bloodGroup: optionalText(10),
    maritalStatus: optionalText(40),
  }).strict(),
  employment: z.object({
    department: z.enum(departments.map(({ id }) => id)),
    designation: z.string().trim().min(2).max(120),
    employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).default('full_time'),
    joiningDate: z.coerce.date(),
    manager: objectId.optional(),
    workLocation: z.string().trim().min(2).max(120),
  }).strict(),
  address: z.object({
    current: z.string().trim().min(5).max(500),
    permanent: z.string().trim().min(5).max(500),
  }).strict(),
  emergencyContact: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30),
    relationship: z.string().trim().min(2).max(60),
  }).strict(),
  education: z.array(z.object({
    qualification: z.string().trim().min(1).max(120),
    institute: z.string().trim().min(1).max(180),
    year: z.coerce.number().int().min(1950).max(2200),
  }).strict()).max(10).default([]),
  experience: z.array(z.object({
    company: z.string().trim().min(1).max(180),
    designation: z.string().trim().min(1).max(120),
    years: z.coerce.number().min(0).max(60),
  }).strict()).max(20).default([]),
}).strict();

const employeeCreationSchema = z.object({
  temporaryPassword: z.string().min(12).max(128),
  role: z.enum(['employee', 'team_leader']).default('employee'),
}).strict();

function ensureId(value) {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, 'Invalid onboarding identifier');
}

async function getRecord(id) {
  ensureId(id);
  const record = await HRMSRecord.findOne({ _id: id, module: 'onboarding', deletedAt: null });
  if (!record) throw new AppError(404, 'Onboarding record not found');
  return record;
}

async function getEmployeeRecord(employeeId) {
  const record = await HRMSRecord.findOne({ module: 'onboarding', employee: employeeId, deletedAt: null });
  if (!record) throw new AppError(404, 'Your onboarding record is not available');
  return record;
}

async function audit(req, action, entityId, details) {
  await AuditLog.create({ user: req.user.id, action, entityType: 'onboarding', entityId, details });
}

const documentView = (document) => {
  const value = document.toObject ? document.toObject() : { ...document };
  delete value.storedName;
  return value;
};

function progressFor(documents) {
  const latest = new Map();
  for (const document of documents) if (!latest.has(document.type)) latest.set(document.type, document);
  const verified = new Set([...latest.values()].filter(({ status }) => status === 'Verified').map(({ type }) => type));
  return Math.round((3 + requiredOnboardingDocuments.filter((type) => verified.has(type)).length) / (3 + requiredOnboardingDocuments.length) * 100);
}

export async function createOnboarding(req, res) {
  const data = onboardingSchema.parse(req.body);
  const email = data.personal.email;
  const duplicate = await Promise.all([
    User.exists({ email }),
    HRMSRecord.exists({ module: 'onboarding', deletedAt: null, status: { $ne: 'Cancelled' }, 'data.personal.email': email }),
  ]);
  if (duplicate.some(Boolean)) throw new AppError(409, 'This email already belongs to an employee or onboarding case');
  const record = await HRMSRecord.create({
    module: 'onboarding',
    title: data.personal.fullName,
    department: data.employment.department,
    status: 'Unassigned',
    effectiveDate: data.employment.joiningDate,
    data: {
      ...data,
      requiredDocuments: requiredOnboardingDocuments,
      tasks: [
        { id: 'personal-details', label: 'Personal details completed', required: true, completed: true },
        { id: 'employment-details', label: 'Employment details completed', required: true, completed: true },
        { id: 'emergency-details', label: 'Emergency and address details completed', required: true, completed: true },
      ],
      progress: progressFor([]),
    },
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  await audit(req, 'hrms.onboarding.created', record._id, { email });
  res.status(201).json({ success: true, message: 'Onboarding created as unassigned', data: record });
}

export async function listOnboarding(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const filter = { module: 'onboarding', deletedAt: null, ...(req.query.status ? { status: req.query.status } : {}), ...(req.user.role === 'team_leader' ? { department: req.user.department } : {}) };
  const [items, total] = await Promise.all([
    HRMSRecord.find(filter).populate('employee', 'name email department active').sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    HRMSRecord.countDocuments(filter),
  ]);
  res.json({ success: true, message: 'Onboarding cases fetched successfully', data: { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
}

export async function getOnboarding(req, res) {
  const record = await getRecord(req.params.id);
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, message: 'Onboarding details fetched successfully', data: { onboarding: record, documents: documents.map(documentView), requiredDocuments: requiredOnboardingDocuments } });
}

export async function updateOnboarding(req, res) {
  const record = await getRecord(req.params.id);
  if (record.status === 'Completed') throw new AppError(409, 'Completed onboarding is locked');
  const merged = {
    personal: { ...record.data.personal, ...req.body.personal },
    employment: { ...record.data.employment, ...req.body.employment },
    address: { ...record.data.address, ...req.body.address },
    emergencyContact: { ...record.data.emergencyContact, ...req.body.emergencyContact },
    education: req.body.education ?? record.data.education,
    experience: req.body.experience ?? record.data.experience,
  };
  const data = onboardingSchema.parse(merged);
  if (record.employee && data.personal.email !== record.data.personal.email) throw new AppError(409, 'Login email cannot be changed after employee creation');
  if (data.personal.email !== record.data.personal.email && (await User.exists({ email: data.personal.email }))) throw new AppError(409, 'Email already belongs to an employee');
  record.title = data.personal.fullName;
  record.department = data.employment.department;
  record.effectiveDate = data.employment.joiningDate;
  record.data = { ...record.data, ...data };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, 'hrms.onboarding.updated', record._id);
  res.json({ success: true, message: 'Onboarding details updated successfully', data: record });
}

export async function uploadDocument(req, res) {
  try {
    const record = await getRecord(req.params.id);
    if (record.status === 'Completed') throw new AppError(409, 'Completed onboarding is locked');
    const type = z.enum(onboardingDocumentTypes).parse(req.body.type);
    if (!req.file) throw new AppError(400, 'Document file is required');
    const document = await OnboardingDocument.create({ onboarding: record._id, employee: record.employee, type, originalName: req.file.originalname, storedName: req.file.filename, mimeType: req.file.mimetype, size: req.file.size, uploadedBy: req.user.id });
    const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
    record.data = { ...record.data, progress: progressFor(documents) };
    await record.save();
    await audit(req, 'hrms.onboarding.document_uploaded', record._id, { document: document._id, type });
    res.status(201).json({ success: true, message: 'Document uploaded successfully', data: documentView(document) });
  } catch (error) {
    if (req.file?.filename) await unlink(join(onboardingUploadRoot, req.file.filename)).catch(() => {});
    throw error;
  }
}

export async function verifyDocument(req, res) {
  const input = z.object({ status: z.enum(['Verified', 'Rejected']), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
  const record = await getRecord(req.params.id);
  if (record.status === 'Completed') throw new AppError(409, 'Completed onboarding is locked');
  ensureId(req.params.documentId);
  const document = await OnboardingDocument.findOneAndUpdate(
    { _id: req.params.documentId, onboarding: record._id, deletedAt: null },
    { ...input, verifiedBy: req.user.id, verifiedAt: new Date() },
    { new: true, runValidators: true },
  );
  if (!document) throw new AppError(404, 'Onboarding document not found');
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
  record.data = { ...record.data, progress: progressFor(documents) };
  await record.save();
  await audit(req, 'hrms.onboarding.document_reviewed', record._id, { document: document._id, status: input.status });
  res.json({ success: true, message: `Document ${input.status.toLowerCase()} successfully`, data: documentView(document) });
}

export async function downloadDocument(req, res) {
  const record = await getRecord(req.params.id);
  ensureId(req.params.documentId);
  const document = await OnboardingDocument.findOne({ _id: req.params.documentId, onboarding: record._id, deletedAt: null }).select('+storedName');
  if (!document) throw new AppError(404, 'Onboarding document not found');
  await audit(req, 'hrms.onboarding.document_downloaded', record._id, { document: document._id });
  res.download(join(onboardingUploadRoot, document.storedName), document.originalName);
}

export async function deleteDocument(req, res) {
  const record = await getRecord(req.params.id);
  if (record.status === 'Completed') throw new AppError(409, 'Completed onboarding is locked');
  ensureId(req.params.documentId);
  const document = await OnboardingDocument.findOne({ _id: req.params.documentId, onboarding: record._id, deletedAt: null }).select('+storedName');
  if (!document) throw new AppError(404, 'Onboarding document not found');
  document.deletedAt = new Date();
  await document.save();
  await unlink(join(onboardingUploadRoot, document.storedName)).catch(() => {});
  await audit(req, 'hrms.onboarding.document_removed', record._id, { document: document._id });
  res.json({ success: true, message: 'Document removed successfully' });
}

export async function deleteOnboarding(req, res) {
  const record = await getRecord(req.params.id);
  if (record.employee) throw new AppError(409, 'Onboarding linked to an employee cannot be deleted');
  if (record.status !== 'Unassigned') throw new AppError(409, 'Only an unassigned onboarding form can be deleted');
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).select('+storedName');
  record.deletedAt = new Date();
  record.updatedBy = req.user.id;
  await Promise.all([
    record.save(),
    OnboardingDocument.updateMany({ onboarding: record._id, deletedAt: null }, { deletedAt: new Date() }),
    ...documents.map((document) => unlink(join(onboardingUploadRoot, document.storedName)).catch(() => {})),
  ]);
  await audit(req, 'hrms.onboarding.deleted', record._id);
  res.json({ success: true, message: 'Onboarding form deleted successfully' });
}

export async function getMyOnboarding(req, res) {
  const record = await getEmployeeRecord(req.user.id);
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, message: 'Your onboarding details fetched successfully', data: { onboarding: record, documents: documents.map(documentView), requiredDocuments: requiredOnboardingDocuments } });
}

export async function uploadMyDocument(req, res) {
  try {
    const record = await getEmployeeRecord(req.user.id);
    if (record.status === 'Completed') throw new AppError(409, 'Your onboarding is already completed');
    const type = z.enum(onboardingDocumentTypes).parse(req.body.type);
    if (!req.file) throw new AppError(400, 'Document file is required');
    const document = await OnboardingDocument.create({ onboarding: record._id, employee: req.user.id, type, originalName: req.file.originalname, storedName: req.file.filename, mimeType: req.file.mimetype, size: req.file.size, uploadedBy: req.user.id });
    const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
    record.data = { ...record.data, progress: progressFor(documents) };
    await record.save();
    await audit(req, 'hrms.onboarding.document_uploaded_by_employee', record._id, { document: document._id, type });
    res.status(201).json({ success: true, message: 'Document uploaded successfully and is awaiting HR verification', data: documentView(document) });
  } catch (error) {
    if (req.file?.filename) await unlink(join(onboardingUploadRoot, req.file.filename)).catch(() => {});
    throw error;
  }
}

export async function downloadMyDocument(req, res) {
  const record = await getEmployeeRecord(req.user.id);
  ensureId(req.params.documentId);
  const document = await OnboardingDocument.findOne({ _id: req.params.documentId, onboarding: record._id, deletedAt: null }).select('+storedName');
  if (!document) throw new AppError(404, 'Onboarding document not found');
  res.download(join(onboardingUploadRoot, document.storedName), document.originalName);
}

export async function deleteMyDocument(req, res) {
  const record = await getEmployeeRecord(req.user.id);
  if (record.status === 'Completed') throw new AppError(409, 'Your onboarding is already completed');
  ensureId(req.params.documentId);
  const document = await OnboardingDocument.findOne({ _id: req.params.documentId, onboarding: record._id, uploadedBy: req.user.id, status: { $ne: 'Verified' }, deletedAt: null }).select('+storedName');
  if (!document) throw new AppError(404, 'Only your pending or rejected document can be removed');
  document.deletedAt = new Date();
  await document.save();
  await unlink(join(onboardingUploadRoot, document.storedName)).catch(() => {});
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
  record.data = { ...record.data, progress: progressFor(documents) };
  await record.save();
  await audit(req, 'hrms.onboarding.document_removed_by_employee', record._id, { document: document._id });
  res.json({ success: true, message: 'Document removed successfully' });
}

export async function completeOnboarding(req, res) {
  z.object({}).strict().parse(req.body || {});
  const record = await getRecord(req.params.id);
  if (record.status === 'Completed') return res.json({ success: true, message: 'Onboarding was already completed', data: record });
  const documents = await OnboardingDocument.find({ onboarding: record._id, deletedAt: null }).sort({ createdAt: -1 }).lean();
  const latest = new Map();
  for (const document of documents) if (!latest.has(document.type)) latest.set(document.type, document);
  const missing = requiredOnboardingDocuments.filter((type) => latest.get(type)?.status !== 'Verified');
  if (missing.length) throw new AppError(409, `Verify required documents first: ${missing.join(', ')}`);
  const incompleteTasks = (record.data.tasks || []).filter((task) => task.required !== false && !task.completed);
  if (incompleteTasks.length) throw new AppError(409, 'Complete required onboarding tasks first');
  record.status = 'Completed';
  record.data = { ...record.data, progress: 100, completedAt: new Date(), completedBy: req.user.id };
  record.updatedBy = req.user.id;
  await record.save();
  await audit(req, 'hrms.onboarding.completed', record._id);
  res.json({ success: true, message: 'Onboarding completed successfully', data: record });
}

export async function createEmployeeFromOnboarding(req, res) {
  const input = employeeCreationSchema.parse(req.body);
  const record = await getRecord(req.params.id);
  if (record.employee) {
    const [employee, profile] = await Promise.all([
      User.findById(record.employee).select('name email role department active').lean(),
      EmployeeProfile.findOne({ user: record.employee }).lean(),
    ]);
    return res.json({ success: true, message: 'Employee was already created from this onboarding', data: { onboarding: record, employee, profile } });
  }
  if (!['Unassigned', 'In Progress', 'Onboarded', 'Completed'].includes(record.status)) throw new AppError(409, 'This onboarding case cannot create an employee');
  const email = record.data.personal.email;
  if (await User.exists({ email })) throw new AppError(409, 'ERP user already exists for this email');
  const user = await User.create({ name: record.data.personal.fullName, email, passwordHash: await bcrypt.hash(input.temporaryPassword, 12), role: input.role, department: record.data.employment.department, active: true });
  try {
    const profile = await EmployeeProfile.create({
      user: user._id,
      employeeCode: await nextEmployeeCode(),
      designation: record.data.employment.designation,
      department: record.data.employment.department,
      employmentType: record.data.employment.employmentType,
      joiningDate: record.data.employment.joiningDate,
      dateOfBirth: record.data.personal.dateOfBirth,
      gender: record.data.personal.gender,
      bloodGroup: record.data.personal.bloodGroup,
      maritalStatus: record.data.personal.maritalStatus,
      phone: record.data.personal.phone,
      alternatePhone: record.data.personal.alternatePhone,
      manager: record.data.employment.manager,
      workLocation: record.data.employment.workLocation,
      address: record.data.address,
      emergencyContact: record.data.emergencyContact,
      education: record.data.education,
      experience: record.data.experience,
    });
    record.employee = user._id;
    record.status = ['Onboarded', 'Completed'].includes(record.status) ? 'Completed' : 'In Progress';
    record.data = { ...record.data, employeeCreatedAt: new Date(), employeeCreatedBy: req.user.id };
    record.updatedBy = req.user.id;
    await Promise.all([record.save(), OnboardingDocument.updateMany({ onboarding: record._id, deletedAt: null }, { employee: user._id })]);
    await audit(req, 'hrms.employee.created_from_onboarding', record._id, { employee: user._id });
    res.status(201).json({ success: true, message: 'Employee ID and login credentials created successfully', data: { onboarding: record, employee: { _id: user._id, name: user.name, email: user.email, role: user.role, department: user.department, active: user.active }, profile } });
  } catch (error) {
    await Promise.all([User.deleteOne({ _id: user._id }), EmployeeProfile.deleteOne({ user: user._id }), OnboardingDocument.updateMany({ onboarding: record._id }, { $unset: { employee: 1 } })]);
    throw error;
  }
}

export function blockDirectEmployeeCreation(req, res) {
  res.status(409).json({ success: false, error: { message: 'Create an onboarding form first, then select it to create the employee' } });
}
