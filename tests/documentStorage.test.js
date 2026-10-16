import { afterEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
const { settings } = vi.hoisted(() => ({ settings: {
  STORAGE_DRIVER: 'cloudinary', UPLOAD_DIR: 'uploads', MAX_FILE_SIZE: 10485760,
  UPLOAD_TOKEN_MINUTES: 20, CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret',
} }));
vi.mock('../src/config/env.js', () => ({ env: settings }));
import { storeDocument, readDocument, removeDocument, cleanupDocument } from '../src/services/documentStorageService.js';
import { FileDeletionJob } from '../src/models/FileDeletionJob.js';
const pdf = Buffer.from('%PDF-1.4\nStorage verification\n%%EOF');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('Cloudinary lifecycle uses signed authenticated raw storage and expiring downloads', async () => {
  let stored;
  const fetch = vi.fn(async (url, options) => {
    if (url.endsWith('/upload')) {
      const body = options.body;
      stored = body.get('public_id');
      expect(body.get('type')).toBe('authenticated');
      expect(body.get('overwrite')).toBe('false');
      const unsigned = ['overwrite', 'public_id', 'timestamp', 'type'].map((key) => `${key}=${body.get(key)}`).join('&');
      expect(body.get('signature')).toBe(createHash('sha1').update(unsigned + settings.CLOUDINARY_API_SECRET).digest('hex'));
      return { ok: true, json: async () => ({ public_id: stored }) };
    }
    if (url.includes('/download?')) {
      const params = new URL(url).searchParams;
      expect(params.get('public_id')).toBe(stored);
      expect(params.get('type')).toBe('authenticated');
      expect(Number(params.get('expires_at')) - Number(params.get('timestamp'))).toBe(1200);
      return { ok: true, arrayBuffer: async () => pdf };
    }
    expect(options.body.get('public_id')).toBe(stored);
    expect(options.body.get('type')).toBe('authenticated');
    return { ok: true, json: async () => ({ result: 'ok' }) };
  });
  vi.stubGlobal('fetch', fetch);
  const name = await storeDocument('crm', pdf);
  expect(name).toMatch(/^cloudinary:erp\/crm\//);
  expect(await readDocument('crm', name)).toEqual(pdf);
  await removeDocument('crm', name);
  expect(fetch).toHaveBeenCalledTimes(3);
});
test('invalid contents, over-limit files and unsafe identifiers never reach Cloudinary', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(storeDocument('crm', Buffer.from('invalid'))).rejects.toThrow(/Only PDF/);
  await expect(storeDocument('onboarding', Buffer.alloc(settings.MAX_FILE_SIZE + 1))).rejects.toThrow(/size limit/);
  await expect(readDocument('crm', 'cloudinary:../../secret')).rejects.toThrow(/Invalid cloud/);
  await expect(readDocument('crm', '../secret')).rejects.toThrow(/Invalid stored/);
  expect(fetch).not.toHaveBeenCalled();
});
test('provider failures are sanitized and failed deletion stays queued', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive provider details')));
  await expect(storeDocument('onboarding', pdf)).rejects.toThrow('Document storage is unavailable; please retry');
  const create = vi.spyOn(FileDeletionJob, 'create').mockResolvedValue({ _id: 'queued-job' });
  const remove = vi.spyOn(FileDeletionJob, 'deleteOne');
  await cleanupDocument('onboarding', 'cloudinary:erp/onboarding/abcd-1234');
  expect(create).toHaveBeenCalledWith({ kind: 'onboarding', name: 'cloudinary:erp/onboarding/abcd-1234' });
  expect(remove).not.toHaveBeenCalled();
});
