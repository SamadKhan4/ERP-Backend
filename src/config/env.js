import dotenv from 'dotenv';
import { z } from 'zod';
const mode = process.env.NODE_ENV || 'development';
dotenv.config({
  path: new URL(`../../.env.${mode}`, import.meta.url),
  quiet: true,
});
export const env = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default('development'),
    HOST: z.string().default('0.0.0.0'),
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
    CRM_UPLOAD_DIR: z.string().optional(),
    STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
    UPLOAD_DIR: z.string().default('uploads'),
    MAX_FILE_SIZE: z.coerce.number().int().min(1).max(50 * 1024 * 1024).default(10485760),
    UPLOAD_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(20),
    CLOUDINARY_CLOUD_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).or(z.literal('')).optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
  })
  .parse(process.env);
if (env.STORAGE_DRIVER === 'cloudinary' && (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET))
  throw new Error('Cloudinary storage requires cloud name, API key and API secret');
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
