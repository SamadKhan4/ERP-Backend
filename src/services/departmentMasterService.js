import mongoose from 'mongoose';
import { Department } from '../models/Department.js';
import { Counter } from '../models/Counter.js';
import { departments as legacyDepartments } from '../constants/departments.js';
import { AppError } from '../utils/errors.js';

export async function departmentNumber(session) {
  const row = await Counter.findByIdAndUpdate(
    'department',
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  );
  return `ADB/DEPT/${String(row.value).padStart(3, '0')}`;
}
let initializing;
export async function ensureDepartmentMasters() {
  if (initializing) return initializing;
  initializing = (async () => {
    const initialized = await Counter.exists({ _id: 'department-masters-initialized' });
    const bdeInitialized = await Counter.exists({ _id: 'department-bde-initialized' });
    if (initialized && bdeInitialized) return;
    for (const item of legacyDepartments) {
      if (initialized && (item.id !== 'bde' || bdeInitialized)) continue;
      if (await Department.exists({ key: item.id })) continue;
      try {
        await Department.updateOne(
          { key: item.id },
          {
            $setOnInsert: {
              key: item.id,
              name: item.name,
              nameKey: item.name.toLowerCase(),
              code:
                {
                  social_media: 'SM',
                  web_dev: 'WEB',
                  graphics: 'GFX',
                  video_editing: 'VID',
                  seo: 'SEO',
                }[item.id] || item.id.toUpperCase(),
              departmentId: await departmentNumber(),
              status: 'ACTIVE',
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    await Counter.updateOne(
      { _id: 'department-bde-initialized' },
      { $setOnInsert: { value: 1 } },
      { upsert: true },
    );
    await Counter.updateOne(
      { _id: 'department-masters-initialized' },
      { $setOnInsert: { value: 1 } },
      { upsert: true },
    );
  })();
  try {
    await initializing;
  } finally {
    initializing = null;
  }
}
export async function resolveDepartment(
  value,
  { active = false, session } = {},
) {
  await ensureDepartmentMasters();
  const filter = mongoose.isValidObjectId(value)
    ? { $or: [{ _id: value }, { key: value }] }
    : { key: value };
  const department = await Department.findOne(filter).session(session || null);
  if (!department) throw new AppError(400, 'Department does not exist');
  if (active && department.status !== 'ACTIVE')
    throw new AppError(
      409,
      'Inactive departments cannot receive new employees',
    );
  return department;
}
export function departmentReferenceHooks(schema, requireActive = true) {
  schema.pre('validate', async function () {
    if (!this.department || (!this.isNew && !this.isModified('department')))
      return;
    const department = await resolveDepartment(this.department, {
      active: requireActive,
      session: this.$session(),
    });
    this.department = department.key;
    this.departmentId = department._id;
  });
  schema.pre(['findOneAndUpdate', 'updateOne'], async function () {
    const update = this.getUpdate();
    const fields = update?.$set || update;
    if (!fields?.department) return;
    const existing = await this.model
      .findOne(this.getQuery())
      .select('department')
      .session(this.getOptions().session || null)
      .lean();
    const department = await resolveDepartment(fields.department, {
      active: requireActive && existing?.department !== fields.department,
      session: this.getOptions().session,
    });
    fields.department = department.key;
    fields.departmentId = department._id;
  });
}
export async function migrateDepartmentReferences() {
  await ensureDepartmentMasters();
  // Backfill custom legacy keys as real masters without rewriting historical keys.
  const keys = new Set();
  if (mongoose.models.HRMSRecord)
    for (const key of await mongoose.models.HRMSRecord.distinct('data.code', {
      module: 'departments',
      'data.code': { $type: 'string', $ne: '' },
    }))
      keys.add(key);
  for (const name of [
    'User',
    'EmployeeProfile',
    'HRMSRecord',
    'PayrollEntry',
  ]) {
    if (mongoose.models[name])
      for (const key of await mongoose.models[name].distinct('department', {
        department: { $type: 'string', $ne: '' },
      }))
        keys.add(key);
  }
  for (const key of keys) {
    if (await Department.exists({ key })) continue;
    const old = mongoose.models.HRMSRecord
      ? await mongoose.models.HRMSRecord.findOne({
          module: 'departments',
          'data.code': key,
        }).lean()
      : null;
    const name =
      old?.title ||
      key
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
    const baseCode =
      key
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '_')
        .slice(0, 24) || 'LEGACY';
    const code = (await Department.exists({ code: baseCode }))
      ? `${baseCode}_${new mongoose.Types.ObjectId().toString().slice(-5)}`
      : baseCode;
    const nameKey = name.toLowerCase().replace(/\s+/g, ' ');
    try {
      await Department.create({
        key,
        name: (await Department.exists({ nameKey }))
          ? `${name} (${code})`
          : name,
        nameKey: (await Department.exists({ nameKey }))
          ? `${nameKey} (${code.toLowerCase()})`
          : nameKey,
        code,
        departmentId: await departmentNumber(),
        description: old?.data?.description || '',
        departmentHead: old?.data?.head,
        status:
          old?.deletedAt || old?.status === 'Inactive' ? 'INACTIVE' : 'ACTIVE',
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }
  for (const department of await Department.find().lean()) {
    for (const name of ['User', 'EmployeeProfile']) {
      const Model = mongoose.models[name];
      if (Model)
        await Model.collection.updateMany(
          { department: department.key },
          { $set: { departmentId: department._id } },
        );
    }
  }
}
