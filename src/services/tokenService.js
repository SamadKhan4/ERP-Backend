import jwt from 'jsonwebtoken';
import { randomUUID, createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { Session } from '../models/Session.js';
import { permissionsFor } from './permissionService.js';
export const hashToken = (token) =>
  createHash('sha256').update(token).digest('hex');
export const publicUser = async (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  department: user.department || null,
  permissions: await permissionsFor(user),
});
export const verifyToken = (token, type) =>
  jwt.verify(
    token,
    type === 'access' ? env.JWT_ACCESS_SECRET : env.JWT_REFRESH_SECRET,
    { algorithms: ['HS256'], issuer: 'adborn-erp', audience: type },
  );
export async function issueSession(user) {
  const options = {
    issuer: 'adborn-erp',
    subject: user.id,
    algorithm: 'HS256',
  };
  const accessToken = jwt.sign(
    { version: user.tokenVersion },
    env.JWT_ACCESS_SECRET,
    { ...options, audience: 'access', expiresIn: '7d' },
  );
  const refreshToken = jwt.sign(
    { version: user.tokenVersion },
    env.JWT_REFRESH_SECRET,
    { ...options, audience: 'refresh', jwtid: randomUUID(), expiresIn: '7d' },
  );
  await Session.create({
    user: user.id,
    tokenHash: hashToken(refreshToken),
    expires: new Date(Date.now() + 7 * 86400000),
  });
  return { accessToken, refreshToken, user: await publicUser(user) };
}
