import { Router } from 'express';
import multer from 'multer';
import { AppError } from '../utils/errors.js';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../middleware/authenticate.js';
import { env } from '../config/env.js';
import { mailAccess, requireMail } from '../mailbox/mailAccess.js';
import * as c from '../mailbox/mailController.js';
export const mailboxRouter = Router();
mailboxRouter.use(authenticate, mailAccess);
const limit = (max, windowMs = 60000) =>
  rateLimit({
    windowMs,
    limit: max,
    keyGenerator: (req) => String(req.user._id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
const sendLimit = limit(30, 3600000);
const storage = {
  _handleFile(req, file, cb) {
    let done = false,
      size = 0;
    const chunks = [];
    file.stream.on('data', (chunk) => {
      if (done) return;
      req.mailUploadBytes = (req.mailUploadBytes || 0) + chunk.length;
      if (req.mailUploadBytes > env.MAX_FILE_SIZE) {
        done = true;
        cb(
          new AppError(
            413,
            'Combined attachments exceed configured size limit',
          ),
        );
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    });
    file.stream.on('end', () => {
      if (!done) {
        done = true;
        cb(null, { buffer: Buffer.concat(chunks), size });
      }
    });
    file.stream.on('error', (error) => {
      if (!done) {
        done = true;
        cb(error);
      }
    });
  },
  _removeFile(req, file, cb) {
    delete file.buffer;
    cb(null);
  },
};
const upload = multer({
  storage,
  limits: {
    fileSize: env.MAX_FILE_SIZE,
    files: 10,
    fields: 3,
    fieldSize: 524288,
  },
}).array('attachments', 10);
mailboxRouter.get('/accounts', c.accounts);
mailboxRouter.post('/accounts/connect', limit(5, 900000), c.connect);
mailboxRouter.get('/accounts/:id', c.account);
mailboxRouter.post('/accounts/:id/test', limit(3), c.test);
mailboxRouter.post('/accounts/:id/sync', limit(5), c.sync);
mailboxRouter.delete('/accounts/:id/disconnect', c.disconnect);
mailboxRouter.patch('/accounts/:id/settings', c.settings);
mailboxRouter.get('/messages', c.list);
mailboxRouter.get('/messages/:id', c.message);
mailboxRouter.get('/messages/:id/html', c.html);
mailboxRouter.get('/messages/:id/related', c.related);
mailboxRouter.get('/threads/:key', c.thread);
mailboxRouter.post('/send', requireMail('send'), sendLimit, upload, c.send);
mailboxRouter.post(
  '/drafts',
  requireMail('compose'),
  limit(30),
  upload,
  c.draft,
);
for (const mode of ['reply', 'reply-all'])
  mailboxRouter.post(
    `/messages/:id/${mode}`,
    requireMail('reply'),
    sendLimit,
    upload,
    (req, res) => {
      req.params.mode = mode;
      return c.reply(req, res);
    },
  );
mailboxRouter.post(
  '/messages/:id/forward',
  requireMail('forward'),
  sendLimit,
  upload,
  c.forward,
);
for (const flag of ['read', 'star'])
  mailboxRouter.patch(`/messages/:id/${flag}`, (req, res) => {
    req.params.flag = flag;
    return c.flags(req, res);
  });
for (const action of ['archive', 'trash', 'spam', 'restore'])
  mailboxRouter.post(`/messages/:id/${action}`, (req, res) => {
    req.params.action = action;
    return c.move(req, res);
  });
mailboxRouter.get(
  '/attachments/:id/:attachmentId',
  requireMail('download_attachment'),
  c.download,
);
mailboxRouter.post('/messages/:id/link', c.link);
mailboxRouter.patch('/messages/:id/labels', c.labels);
mailboxRouter.get('/jobs', c.jobs);
mailboxRouter.get('/contacts', c.contacts);
mailboxRouter.get(
  '/admin/accounts',
  requireMail('admin.accounts.view_metadata'),
  c.adminAccounts,
);
mailboxRouter.patch(
  '/admin/accounts/:id',
  requireMail('admin.accounts.manage'),
  c.adminUpdate,
);
mailboxRouter.get(
  '/admin/accounts/:id/access',
  requireMail('shared.manage_permissions'),
  c.grants,
);
mailboxRouter.put(
  '/admin/accounts/:id/access',
  requireMail('shared.assign'),
  requireMail('shared.manage_permissions'),
  c.grants,
);
