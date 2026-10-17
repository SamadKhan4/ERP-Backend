import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
const key = () => {
  const raw = Buffer.from(env.MAIL_CREDENTIAL_ENCRYPTION_KEY || '', 'base64');
  if (raw.length !== 32)
    throw new AppError(503, 'Mailbox encryption key is not configured');
  return raw;
};
export function encryptMailSecret(password) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(), iv);
  const text = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${text.toString('base64')}`;
}
export function decryptMailSecret(value) {
  try {
    const [version, iv, tag, text] = String(value).split('.');
    if (version !== 'v1') throw new Error();
    const cipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(iv, 'base64'),
    );
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(text, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(422, 'Mailbox credentials require reconnecting');
  }
}
