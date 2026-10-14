import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDatabase } from '../config/db.js';
import { User } from '../models/User.js';
import { syncRoles } from '../services/roleService.js';
import { password } from '../validators/authValidator.js';
import { logger } from '../config/logger.js';
const validation = z
  .object({
    ADMIN_EMAIL: z.email().transform((v) => v.toLowerCase()),
    ADMIN_PASSWORD: password,
  })
  .safeParse(process.env);
if (!validation.success) {
  const fields = new Set(validation.error.issues.map((issue) => issue.path[0]));
  if (fields.has('ADMIN_EMAIL'))
    logger.error(
      'ADMIN_EMAIL must be a valid email address in backend/.env.development.',
    );
  if (fields.has('ADMIN_PASSWORD'))
    logger.error(
      'ADMIN_PASSWORD must contain 12–128 characters, including uppercase, lowercase, and a digit, in backend/.env.development.',
    );
  logger.flush();
  process.exitCode = 1;
} else {
  const credentials = validation.data;
  try {
    await connectDatabase();
    await User.init();
    await syncRoles();
    const existing = await User.findOne({ email: credentials.ADMIN_EMAIL });
    if (existing && existing.role !== 'super_admin')
      throw new Error('Account exists with another role');
    if (!existing) {
      if (await User.exists({ role: 'super_admin', active: true }))
        throw new Error('An initial Super Admin already exists');
      await User.create({
        name: 'Super Admin',
        email: credentials.ADMIN_EMAIL,
        passwordHash: await bcrypt.hash(credentials.ADMIN_PASSWORD, 12),
        role: 'super_admin',
      });
    }
    logger.info(
      existing
        ? 'Super Admin already provisioned; credentials unchanged.'
        : 'Super Admin provisioned.',
    );
  } catch (error) {
    const expected = [
      'Account exists with another role',
      'An initial Super Admin already exists',
    ];
    logger.error(
      expected.includes(error.message)
        ? error.message
        : 'Admin provisioning failed. Check MongoDB connectivity and role configuration.',
    );
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
