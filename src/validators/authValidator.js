import { z } from 'zod';
export const password = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/[0-9]/);
export const loginSchema = z
  .object({
    email: z.email().transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(128),
  })
  .strict();
export const changeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: password,
  })
  .strict();
export const resetSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password })
  .strict();
export const emailSchema = z
  .object({ email: z.email().transform((v) => v.toLowerCase()) })
  .strict();
export const profileSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();
