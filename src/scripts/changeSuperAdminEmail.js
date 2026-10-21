import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
const email = z
  .email()
  .transform((value) => value.toLowerCase())
  .parse(process.argv[2]);
try {
  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 7000,
    autoIndex: false,
    autoCreate: false,
  });
  const users = mongoose.connection.db.collection('users');
  const admins = await users
    .find(
      { role: 'super_admin', active: true },
      { projection: { _id: 1, email: 1 } },
    )
    .limit(2)
    .toArray();
  if (admins.length !== 1)
    throw new Error(
      'Expected exactly one active Super Admin. No account was changed.',
    );
  const admin = admins[0];
  if (admin.email === email) {
    console.log('Super Admin already uses this login email.');
  } else {
    await mongoose.connection.transaction(async (session) => {
      if (await users.findOne({ email, _id: { $ne: admin._id } }, { session }))
        throw new Error(
          'Email belongs to another ERP account. No account was changed.',
        );
      const changed = await users.updateOne(
        {
          _id: admin._id,
          role: 'super_admin',
          active: true,
          email: admin.email,
        },
        {
          $set: { email, updatedAt: new Date() },
          $inc: { tokenVersion: 1 },
          $unset: { resetHash: '', resetExpires: '' },
        },
        { session },
      );
      if (changed.modifiedCount !== 1)
        throw new Error('Account changed concurrently; retry.');
      await mongoose.connection.db
        .collection('sessions')
        .deleteMany({ user: admin._id }, { session });
      await mongoose.connection.db
        .collection('auditlogs')
        .insertOne(
          {
            user: admin._id,
            action: 'user.super_admin_login_email_changed',
            entityType: 'user',
            entityId: admin._id,
            details: { previousEmail: admin.email, email },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          { session },
        );
    });
    console.log(
      `Super Admin login updated to ${email}. Password and mailbox ownership unchanged. Sign in again.`,
    );
  }
} catch (error) {
  console.error(
    ['Expected exactly one', 'Email belongs', 'Account changed'].some(
      (prefix) => error.message.startsWith(prefix),
    )
      ? error.message
      : 'Email update failed. Check database connectivity and MongoDB replica-set support; no partial change was committed.',
  );
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
