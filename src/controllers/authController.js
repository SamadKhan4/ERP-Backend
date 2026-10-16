import * as service from '../services/authService.js';
import { publicUser } from '../services/tokenService.js';
import { env } from '../config/env.js';
import {
  loginSchema,
  changeSchema,
  resetSchema,
  emailSchema,
} from '../validators/authValidator.js';
const cookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAME_SITE,
  path: '/api/v1/auth',
};
function sessionResponse(res, session) {
  res.cookie('refreshToken', session.refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 86400000,
  });
  res.json({
    success: true,
    data: { user: session.user, accessToken: session.accessToken },
  });
}
export const login = async (req, res) =>
  sessionResponse(res, await service.login(loginSchema.parse(req.body)));
export const refresh = async (req, res) =>
  sessionResponse(res, await service.refresh(req.cookies.refreshToken));
export const logout = async (req, res) => {
  await service.logout(req.cookies.refreshToken);
  res.clearCookie('refreshToken', cookieOptions);
  res.json({ success: true });
};
export const me = async (req, res) =>
  res.json({ success: true, data: await publicUser(req.user) });
export const changePassword = async (req, res) => {
  await service.changePassword(req.user, changeSchema.parse(req.body));
  res.clearCookie('refreshToken', cookieOptions);
  res.json({ success: true });
};
export const forgotPassword = async (req, res) => {
  await service.forgotPassword(emailSchema.parse(req.body).email);
  res.json({
    success: true,
    message: 'If the account exists, reset instructions will be delivered.',
  });
};
export const resetPassword = async (req, res) => {
  await service.resetPassword(resetSchema.parse(req.body));
  res.clearCookie('refreshToken', cookieOptions);
  res.json({ success: true });
};
