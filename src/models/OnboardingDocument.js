import mongoose from 'mongoose';
import { env } from '../config/env.js';

export const onboardingDocumentTypes = [
  'identity_proof',
  'address_proof',
  'profile_photo',
  'education',
  'bank_proof',
  'experience',
  'offer_letter',
  'other',
];

const schema = new mongoose.Schema(
  {
    onboarding: { type: mongoose.Schema.Types.ObjectId, ref: 'HRMSRecord', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    type: { type: String, enum: onboardingDocumentTypes, required: true, index: true },
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    storedName: { type: String, required: true, unique: true, select: false },
    mimeType: { type: String, required: true, enum: ['application/pdf', 'image/jpeg', 'image/png'] },
    size: { type: Number, required: true, min: 1, max: env.MAX_FILE_SIZE },
    status: { type: String, enum: ['Pending', 'Verified', 'Rejected'], default: 'Pending', index: true },
    note: { type: String, trim: true, maxlength: 500 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: Date,
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ onboarding: 1, type: 1, deletedAt: 1, createdAt: -1 });

export const OnboardingDocument = mongoose.model('OnboardingDocument', schema);
