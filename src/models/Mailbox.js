import mongoose from 'mongoose';
const ref = (model) => ({ type: mongoose.Schema.Types.ObjectId, ref: model });
const account = new mongoose.Schema(
  {
    user: { ...ref('User'), immutable: true },
    emailAddress: {
      type: String,
      lowercase: true,
      required: true,
      unique: true,
      immutable: true,
    },
    displayName: String,
    type: {
      type: String,
      enum: ['PERSONAL', 'SHARED'],
      required: true,
      immutable: true,
    },
    provider: { type: String, default: 'HOSTINGER', enum: ['HOSTINGER'] },
    encryptedPassword: { type: String, select: false },
    isActive: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false },
    backfillKind: String,
    backfillRequested: { type: Boolean, default: false },
    signature: { type: String, maxlength: 4000, default: '' },
    lastSyncAt: Date,
    lastSuccessfulSyncAt: Date,
    syncStatus: {
      type: String,
      enum: [
        'PENDING',
        'SYNCING',
        'CONNECTED',
        'ERROR',
        'REAUTH_REQUIRED',
        'DISCONNECTED',
      ],
      default: 'PENDING',
    },
    syncError: String,
    nextSyncAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    lease: String,
    lockedUntil: Date,
    revision: { type: Number, default: 0 },
    createdBy: ref('User'),
    updatedBy: ref('User'),
  },
  { timestamps: true },
);
account.pre('validate', function () {
  if (this.type === 'PERSONAL' && !this.user)
    this.invalidate('user', 'Personal mailbox owner required');
});
account.index({ user: 1, type: 1 });
account.index({ isActive: 1, nextSyncAt: 1, lockedUntil: 1 });
export const MailAccount = mongoose.model('MailAccount', account);
const shared = new mongoose.Schema(
  {
    mailAccount: { ...ref('MailAccount'), required: true },
    user: { ...ref('User'), required: true },
    permissions: [
      {
        type: String,
        enum: ['READ', 'SEND', 'REPLY', 'FORWARD', 'ARCHIVE', 'TRASH'],
      },
    ],
    active: { type: Boolean, default: true },
    updatedBy: ref('User'),
  },
  { timestamps: true },
);
shared.index({ mailAccount: 1, user: 1 }, { unique: true });
shared.index({ user: 1, active: 1 });
export const SharedMailboxAccess = mongoose.model(
  'SharedMailboxAccess',
  shared,
);
const folder = new mongoose.Schema(
  {
    mailAccount: { ...ref('MailAccount'), required: true },
    path: { type: String, required: true },
    kind: String,
    uidValidity: String,
    bootstrapUid: Number,
    oldestUid: { type: Number, default: 1 },
    highestUid: { type: Number, default: 0 },
    reconcileOffset: { type: Number, default: 1 },
    reconcileStartedAt: Date,
    lastReconciledAt: Date,
  },
  { timestamps: true },
);
folder.index({ mailAccount: 1, path: 1 }, { unique: true });
export const MailFolder = mongoose.model('MailFolder', folder);
const message = new mongoose.Schema(
  {
    mailAccount: { ...ref('MailAccount'), required: true },
    providerMessageId: String,
    uid: { type: Number, required: true },
    uidValidity: { type: String, required: true },
    folder: { type: String, required: true },
    folderKind: String,
    messageIdHeader: String,
    threadKey: String,
    from: { address: String, name: String },
    replyTo: [{ address: String, name: String, _id: false }],
    to: [{ address: String, name: String, _id: false }],
    cc: [{ address: String, name: String, _id: false }],
    bcc: [{ address: String, name: String, _id: false }],
    subject: String,
    snippet: String,
    textBody: { type: String, select: false },
    htmlBody: { type: String, select: false },
    receivedAt: Date,
    sentAt: Date,
    isRead: Boolean,
    isStarred: Boolean,
    isDraft: Boolean,
    providerPresent: { type: Boolean, default: true },
    oversized: Boolean,
    parseFailed: Boolean,
    lastSeenAt: Date,
    attachments: [
      { fileName: String, mime: String, size: Number, partIndex: Number },
    ],
    inReplyTo: String,
    references: [String],
    linkedLead: ref('Lead'),
    linkedClient: ref('Client'),
    linkedProject: ref('Project'),
    linkedQuotation: ref('Quotation'),
    linkedInvoice: ref('Invoice'),
    labels: [String],
  },
  { timestamps: true },
);
message.index(
  { mailAccount: 1, folder: 1, uidValidity: 1, uid: 1 },
  { unique: true },
);
message.index({
  mailAccount: 1,
  folderKind: 1,
  providerPresent: 1,
  receivedAt: -1,
});
message.index({ mailAccount: 1, isStarred: 1, receivedAt: -1 });
message.index({ mailAccount: 1, threadKey: 1 });
message.index({ mailAccount: 1, messageIdHeader: 1 });
export const MailMessage = mongoose.model('MailMessage', message);
const send = new mongoose.Schema(
  {
    mailAccount: { ...ref('MailAccount'), required: true },
    user: { ...ref('User'), required: true },
    operation: {
      type: String,
      enum: ['SEND', 'REPLY', 'FORWARD'],
      default: 'SEND',
    },
    businessLinks: {
      lead: ref('Lead'),
      client: ref('Client'),
      project: ref('Project'),
      quotation: ref('Quotation'),
      invoice: ref('Invoice'),
    },
    sourceMessage: ref('MailMessage'),
    draftMessage: ref('MailMessage'),
    messageIdHeader: String,
    idempotencyKey: { type: String, required: true, unique: true },
    fingerprint: String,
    payload: { type: mongoose.Schema.Types.Mixed, select: false },
    status: {
      type: String,
      enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'CANCELLED'],
      default: 'PENDING',
    },
    attempts: { type: Number, default: 0 },
    lockedUntil: Date,
    lease: String,
    nextAttemptAt: { type: Date, default: Date.now },
    sentAt: Date,
    sentCopySaved: { type: Boolean, default: false },
    lastError: String,
  },
  { timestamps: true },
);
send.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });
send.index({ mailAccount: 1, user: 1, createdAt: -1 });
export const MailSendJob = mongoose.model('MailSendJob', send);

export const MailRateWindow = mongoose.model(
  'MailRateWindow',
  new mongoose.Schema({
    _id: String,
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, expires: 0 },
  }),
);
