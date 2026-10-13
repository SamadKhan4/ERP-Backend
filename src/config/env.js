import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config({ path: new URL('../../.env', import.meta.url), quiet: true });
export const env = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().default(5000),
    CLIENT_URL: z.string().min(1),
    MONGO_URI: z.string().startsWith('mongodb'),
    JWT_ACCESS_SECRET: z.string().min(48),
    JWT_REFRESH_SECRET: z.string().min(48),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    RESET_DELIVERY: z.enum(['file', 'smtp']).default('file'),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    PASSWORD_RESET_URL: z.string().optional(),
    ONBOARDING_UPLOAD_DIR: z.string().optional(),
  })
  .parse(process.env);
if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET)
  throw new Error('JWT secrets must differ');
if (
  env.NODE_ENV === 'production' &&
  (!env.COOKIE_SECURE ||
    env.RESET_DELIVERY !== 'smtp' ||
    !env.SMTP_URL ||
    !env.MAIL_FROM ||
    !env.PASSWORD_RESET_URL?.startsWith('https://'))
)
  throw new Error(
    'Production requires secure cookies and SMTP password reset configuration',
  );
if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE)
  throw new Error('SameSite=None requires secure cookies');
