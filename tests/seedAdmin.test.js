import { test, expect } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
const exec = promisify(execFile);

test('admin CLI provisions once after connecting and preserves existing credentials', async () => {
  const database = await MongoMemoryServer.create();
  const connection = mongoose.createConnection();
  const options = {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MONGO_URI: database.getUri(),
      CLIENT_URL: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'a'.repeat(64),
      JWT_REFRESH_SECRET: 'b'.repeat(64),
      COOKIE_SECURE: 'false',
      ADMIN_EMAIL: 'seed@example.test',
      ADMIN_PASSWORD: 'StrongPassword123',
    },
  };
  const script = fileURLToPath(
    new URL('../src/scripts/seedAdmin.js', import.meta.url),
  );
  try {
    expect((await exec(process.execPath, [script], options)).stdout).toContain(
      'Super Admin provisioned.',
    );
    await connection.openUri(database.getUri());
    const first = await connection.db
      .collection('users')
      .findOne({ email: 'seed@example.test' });
    expect(first.role).toBe('super_admin');
    expect((await exec(process.execPath, [script], options)).stdout).toContain(
      'already provisioned',
    );
    const second = await connection.db
      .collection('users')
      .findOne({ email: 'seed@example.test' });
    expect(second.passwordHash).toBe(first.passwordHash);
    expect(await connection.db.collection('users').countDocuments()).toBe(1);
    expect(await connection.db.collection('roles').countDocuments()).toBe(9);
    await expect(
      exec(process.execPath, [script], {
        env: { ...options.env, ADMIN_PASSWORD: 'short' },
      }),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('12–128 characters'),
    });
  } finally {
    await connection.close();
    await database.stop();
  }
}, 120000);
