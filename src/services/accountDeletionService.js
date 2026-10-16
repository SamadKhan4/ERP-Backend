import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Session } from '../models/Session.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { HRMSRecord } from '../models/HRMSRecord.js';
import { LeaveLedger } from '../models/LeaveLedger.js';
import { PayrollEntry } from '../models/PayrollEntry.js';
import { OnboardingDocument } from '../models/OnboardingDocument.js';
import { Lead } from '../models/Lead.js';
import { Client } from '../models/Client.js';
import { Project } from '../models/Project.js';
import { Quotation } from '../models/Quotation.js';
import { Invoice } from '../models/Invoice.js';
import { CRMFollowUp } from '../models/CRMFollowUp.js';
import { CRMImportBatch } from '../models/CRMImportBatch.js';
import { LeadActivity } from '../models/LeadActivity.js';
import { TeamTask, TeamSprint, TeamStandup } from '../models/TeamWork.js';
import { Notification } from '../models/Notification.js';
import { AuditLog } from '../models/AuditLog.js';
import { FileDeletionJob } from '../models/FileDeletionJob.js';
import { cleanDeletedFiles } from './fileDeletionService.js';
import { Department } from '../models/Department.js';
import { AppError } from '../utils/errors.js';

const managed = {
  super_admin: ['admin', 'manager', 'hr'],
  admin: ['manager', 'hr'],
  manager: ['hr'],
};
const staff = ['executive', 'team_leader', 'employee', 'lead_caller'];
const employees = {
  super_admin: ['admin', 'manager', 'hr', ...staff],
  admin: ['manager', 'hr', ...staff],
  hr: staff,
};
const ids = (rows) => rows.map((row) => row._id);

function scrubReferences(value, removed) {
  if (value instanceof mongoose.Types.ObjectId || typeof value === 'string')
    return removed.has(String(value)) ? undefined : value;
  if (Array.isArray(value))
    return value
      .filter(
        (item) =>
          !(
            item &&
            typeof item === 'object' &&
            Object.entries(item).some(
              ([key, entry]) =>
                [
                  'employee',
                  'employeeId',
                  'user',
                  'userId',
                  'by',
                  'recordedBy',
                  'completedBy',
                ].includes(key) && removed.has(String(entry)),
            )
          ),
      )
      .map((item) => scrubReferences(item, removed))
      .filter((item) => item !== undefined);
  if (
    value &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  )
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, scrubReferences(entry, removed)])
        .filter(([, entry]) => entry !== undefined),
    );
  return value;
}

export async function deleteAccount({
  actor,
  targetId,
  channel,
  confirmation,
}) {
  if (!mongoose.isValidObjectId(targetId))
    throw new AppError(400, 'Invalid user identifier');
  let result;
  try {
    result = await mongoose.connection.transaction(async (session) => {
      const target = await User.findById(targetId).session(session);
      if (!target) throw new AppError(404, 'Account not found');
      if (String(actor._id) === String(target._id))
        throw new AppError(400, 'You cannot delete your own account');
      const allowed = (channel === 'managed' ? managed : employees)[actor.role];
      if (!allowed?.includes(target.role))
        throw new AppError(403, 'You cannot delete this account');
      if (confirmation !== target.email)
        throw new AppError(
          400,
          'Type the account email to confirm permanent deletion',
        );
      const user = target._id;
      const owns = { $or: [{ createdBy: user }, { assignedTo: user }] };
      const leads = await Lead.find(owns)
        .select('_id attachments')
        .session(session)
        .lean();
      const clients = await Client.find({
        $or: [...owns.$or, { originatingLead: { $in: ids(leads) } }],
      })
        .select('_id originatingLead')
        .session(session)
        .lean();
      // Include the originating lead if a directly-owned client was converted by another user.
      const linkedLeads = await Lead.find({
        $or: [
          { convertedClientId: { $in: ids(clients) } },
          {
            _id: {
              $in: clients
                .map((client) => client.originatingLead)
                .filter(Boolean),
            },
          },
        ],
        _id: { $nin: ids(leads) },
      })
        .select('_id attachments')
        .session(session)
        .lean();
      leads.push(...linkedLeads);
      const business = [
        { lead: { $in: ids(leads) } },
        { clientRef: { $in: ids(clients) } },
      ];
      const quotations = await Quotation.find({
        $or: [...owns.$or, { salesPerson: user }, ...business],
      })
        .select('_id')
        .session(session)
        .lean();
      const projects = await Project.find({
        $or: [
          ...owns.$or,
          ...business,
          { quotation: { $in: ids(quotations) } },
        ],
      })
        .select('_id')
        .session(session)
        .lean();
      const invoices = await Invoice.find({
        $or: [
          { createdBy: user },
          ...business,
          { quotation: { $in: ids(quotations) } },
          { project: { $in: ids(projects) } },
        ],
      })
        .select('_id')
        .session(session)
        .lean();
      const hr = await HRMSRecord.find({
        $or: [
          { employee: user },
          { 'data.employeeId': { $in: [user, String(user)] } },
          { 'data.assignedTo': { $in: [user, String(user)] } },
          { module: 'onboarding', 'data.personal.email': target.email },
          { module: 'candidates', 'data.email': target.email },
          { module: 'report-exports', createdBy: user },
        ],
      })
        .select('_id')
        .session(session)
        .lean();
      // Remove dependent HR records, including soft-archived cases and corrections.
      let more;
      do {
        const references = ids(hr).flatMap((value) => [value, String(value)]);
        more = await HRMSRecord.find({
          _id: { $nin: ids(hr) },
          $or: [
            'attendanceId',
            'candidateId',
            'sourceCandidate',
            'convertedOnboarding',
            'onboardingId',
            'requestId',
          ].map((field) => ({ [`data.${field}`]: { $in: references } })),
        })
          .select('_id')
          .session(session)
          .lean();
        hr.push(...more);
      } while (more.length);
      const documents = await OnboardingDocument.find({
        $or: [{ employee: user }, { onboarding: { $in: ids(hr) } }],
      })
        .select('+storedName')
        .session(session)
        .lean();
      const sprints = await TeamSprint.find({ leader: user })
        .select('_id')
        .session(session)
        .lean();
      const tasks = await TeamTask.find({
        $or: [
          ...owns.$or,
          { leader: user },
          { sprint: { $in: ids(sprints) } },
          { project: { $in: ids(projects) } },
        ],
      })
        .select('_id sprint')
        .session(session)
        .lean();
      const followups = await CRMFollowUp.find({
        $or: [
          ...owns.$or,
          { lead: { $in: ids(leads) } },
          { client: { $in: ids(clients) } },
        ],
      })
        .select('_id')
        .session(session)
        .lean();
      const payroll = await PayrollEntry.find({ employee: user })
        .select('run')
        .session(session)
        .lean();
      const otherAttachments = await Lead.find({
        _id: { $nin: ids(leads) },
        'attachments.addedBy': user,
      })
        .select('attachments')
        .session(session)
        .lean();
      const allIds = [
        user,
        ...ids(leads),
        ...ids(clients),
        ...ids(quotations),
        ...ids(projects),
        ...ids(invoices),
        ...ids(hr),
        ...ids(documents),
        ...ids(sprints),
        ...ids(tasks),
        ...ids(followups),
        ...ids(payroll),
      ];
      const files = [
        ...documents.map((document) => ({
          kind: 'onboarding',
          name: document.storedName,
        })),
        ...leads.flatMap((lead) =>
          (lead.attachments || []).map((file) => ({
            kind: 'crm',
            name: file.storageName,
          })),
        ),
        ...otherAttachments.flatMap((lead) =>
          lead.attachments
            .filter((file) => String(file.addedBy) === String(user))
            .map((file) => ({ kind: 'crm', name: file.storageName })),
        ),
        { kind: 'reset', name: `${user}.json` },
      ].filter((file) => file.name);
      const jobs = await FileDeletionJob.create(files, {
        session,
        ordered: true,
      });
      const counts = {};
      await Lead.updateMany(
        { 'attachments.addedBy': user },
        { $pull: { attachments: { addedBy: user } } },
      ).session(session);
      const remove = async (Model, filter) => {
        counts[Model.modelName] = (
          await Model.deleteMany(filter).session(session)
        ).deletedCount;
      };
      // Run sequentially: MongoDB does not support parallel operations in a transaction.
      for (const [Model, filter] of [
        [Session, { user }],
        [EmployeeProfile, { user }],
        [HRMSRecord, { _id: { $in: ids(hr) } }],
        [OnboardingDocument, { _id: { $in: ids(documents) } }],
        [LeaveLedger, { employee: user }],
        [PayrollEntry, { employee: user }],
        [
          LeadActivity,
          { $or: [{ performedBy: user }, { lead: { $in: ids(leads) } }] },
        ],
        [CRMFollowUp, { _id: { $in: ids(followups) } }],
        [
          CRMImportBatch,
          {
            $or: [{ createdBy: user }, { 'results.lead': { $in: ids(leads) } }],
          },
        ],
        [Invoice, { _id: { $in: ids(invoices) } }],
        [Project, { _id: { $in: ids(projects) } }],
        [Quotation, { _id: { $in: ids(quotations) } }],
        [Client, { _id: { $in: ids(clients) } }],
        [Lead, { _id: { $in: ids(leads) } }],
        [TeamTask, { _id: { $in: ids(tasks) } }],
        [TeamSprint, { _id: { $in: ids(sprints) } }],
        [TeamStandup, { $or: [{ employee: user }, { leader: user }] }],
        [
          Notification,
          {
            $or: [
              { recipient: user },
              { createdBy: user },
              { entityId: { $in: allIds } },
            ],
          },
        ],
        [AuditLog, { $or: [{ user }, { entityId: { $in: allIds } }] }],
      ])
        await remove(Model, filter);
      // Shared records authored/reviewed by this user belong to other employees.
      // Keep them and transfer required attribution; clear optional references.
      for (const Model of Object.values(mongoose.models)) {
        if (Model === User) continue;
        const updates = [];
        Model.schema.eachPath((field, type) => {
          if (type.options.ref === 'User' && !field.includes('.'))
            updates.push([field, type.isRequired]);
        });
        for (const [field, required] of updates) {
          await Model.updateMany(
            { [field]: user },
            required
              ? { $set: { [field]: actor._id } }
              : { $unset: { [field]: '' } },
          ).session(session);
        }
        const mixed = [];
        Model.schema.eachPath((field, type) => {
          if (type.instance === 'Mixed') mixed.push(field);
        });
        if (mixed.length) {
          const removed = new Set(allIds.map(String));
          for await (const record of Model.find()
            .select(mixed.join(' '))
            .session(session)
            .lean()
            .cursor()) {
            const changes = {};
            for (const field of mixed) {
              const cleaned = scrubReferences(record[field], removed);
              if (JSON.stringify(cleaned) !== JSON.stringify(record[field]))
                changes[field] = cleaned ?? null;
            }
            if (Object.keys(changes).length)
              await Model.updateOne(
                { _id: record._id },
                { $set: changes },
              ).session(session);
          }
        }
      }
      for (const run of new Set(payroll.map((entry) => String(entry.run)))) {
        const [totals] = await PayrollEntry.aggregate([
          { $match: { run: new mongoose.Types.ObjectId(run) } },
          {
            $group: {
              _id: null,
              employeeCount: { $sum: 1 },
              grossAmount: { $sum: '$gross' },
              netAmount: { $sum: '$net' },
            },
          },
        ]).session(session);
        await HRMSRecord.updateOne(
          { _id: run },
          {
            $set: {
              'data.employeeCount': totals?.employeeCount || 0,
              'data.grossAmount': totals?.grossAmount || 0,
              'data.netAmount': totals?.netAmount || 0,
            },
          },
        ).session(session);
      }
      for (const sprint of new Set(
        tasks.filter((task) => task.sprint).map((task) => String(task.sprint)),
      )) {
        const [totals] = await TeamTask.aggregate([
          {
            $match: {
              sprint: new mongoose.Types.ObjectId(sprint),
              deletedAt: null,
            },
          },
          {
            $group: {
              _id: null,
              committed: { $sum: '$points' },
              completed: {
                $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, '$points', 0] },
              },
            },
          },
        ]).session(session);
        await TeamSprint.updateOne(
          { _id: sprint },
          {
            $set: {
              committedPoints: totals?.committed || 0,
              completedPoints: totals?.completed || 0,
            },
            $inc: { revision: 1 },
          },
        ).session(session);
      }
      if (target.department) {
        const department = await Department.findOne({ key: target.department }).session(session);
        if (department) await AuditLog.create([{ user: actor._id, entityType: 'department', entityId: department._id, action: 'EMPLOYEE_REMOVED', details: { reason: 'Account permanently deleted', previousDepartment: target.department } }], { session });
      }
      await remove(User, { _id: user });
      await AuditLog.create(
        [
          {
            user: actor._id,
            action: 'account.permanently_deleted',
            entityType: 'account',
            details: { counts },
          },
        ],
        { session },
      );
      return { counts, jobIds: ids(jobs) };
    });
  } catch (error) {
    if (
      error.code === 20 ||
      /Transaction numbers are only allowed/.test(error.message)
    )
      throw new AppError(
        503,
        'Permanent deletion requires MongoDB replica set support; no records were deleted',
      );
    throw error;
  }
  // The durable outbox retries filesystem failures after a restart.
  try {
    await cleanDeletedFiles(
      { _id: { $in: result.jobIds } },
      result.jobIds.length,
    );
  } catch {
    /* Worker retries. */
  }
  return {
    deleted: result.counts,
    cleanupPending: await FileDeletionJob.countDocuments({
      _id: { $in: result.jobIds },
    }),
  };
}
