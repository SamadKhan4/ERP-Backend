import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { FileDeletionJob } from '../models/FileDeletionJob.js';

export const documentRoots = {
  crm: resolve(env.CRM_UPLOAD_DIR || fileURLToPath(new URL('../../.crm-files/', import.meta.url))),
  onboarding: resolve(env.ONBOARDING_UPLOAD_DIR || fileURLToPath(new URL(`../../${env.UPLOAD_DIR}/onboarding/`, import.meta.url))),
};
const cloudPrefix = 'cloudinary:';
const endpoint = (action) => `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/${action}`;
function signed(parameters) {
  const values = { ...parameters, timestamp: Math.floor(Date.now() / 1000) };
  const text = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join('&');
  return { ...values, api_key: env.CLOUDINARY_API_KEY, signature: createHash('sha1').update(text + env.CLOUDINARY_API_SECRET).digest('hex') };
}
async function cloudRequest(action, parameters, bytes) {
  const body = new FormData();
  for (const [key, value] of Object.entries(signed(parameters))) body.append(key, String(value));
  if (bytes) body.append('file', new Blob([bytes]), 'document');
  let response;
  try {
    response = await fetch(endpoint(action), { method: 'POST', body, signal: AbortSignal.timeout(60000) });
  } catch { throw new AppError(502, 'Document storage is unavailable; please retry'); }
  if (!response.ok) throw new AppError(502, 'Document storage request failed; please retry');
  return response.json();
}
function localPath(kind, name) {
  if (!documentRoots[kind] || basename(name) !== name || ['.', '..'].includes(name)) throw new Error('Invalid stored filename');
  return resolve(documentRoots[kind], name);
}
function publicId(name) {
  const value = name.slice(cloudPrefix.length);
  if (!/^erp\/(crm|onboarding)\/[a-f0-9-]+$/.test(value)) throw new Error('Invalid cloud document identifier');
  return value;
}
export function documentMime(bytes) {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  throw new AppError(400, 'Only PDF, PNG and JPEG documents are accepted');
}
export async function storeDocument(kind, bytes) {
  if (!documentRoots[kind]) throw new Error('Invalid document kind');
  if (bytes.length > env.MAX_FILE_SIZE) throw new AppError(413, 'Document exceeds the configured size limit');
  documentMime(bytes);
  const name = randomUUID();
  if (env.STORAGE_DRIVER === 'cloudinary') {
    const id = `erp/${kind}/${name}`;
    const result = await cloudRequest('upload', { public_id: id, type: 'authenticated', overwrite: false }, bytes);
    if (result.public_id !== id) throw new AppError(502, 'Unexpected document storage response');
    return cloudPrefix + id;
  }
  await mkdir(documentRoots[kind], { recursive: true });
  await writeFile(localPath(kind, name), bytes, { flag: 'wx', mode: 0o600 });
  return name;
}
export async function readDocument(kind, name) {
  if (name.startsWith(cloudPrefix)) {
    const params = signed({ public_id: publicId(name), type: 'authenticated', expires_at: Math.floor(Date.now() / 1000) + env.UPLOAD_TOKEN_MINUTES * 60 });
    let response;
    try { response = await fetch(`${endpoint('download')}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(60000) }); }
    catch { throw new AppError(502, 'Document storage is unavailable; please retry'); }
    if (!response.ok) throw new AppError(response.status === 404 ? 404 : 502, 'Document file unavailable');
    return Buffer.from(await response.arrayBuffer());
  }
  try { return await readFile(localPath(kind, name)); }
  catch (error) { if (error.code === 'ENOENT') throw new AppError(404, 'Document file unavailable'); throw error; }
}
export async function removeDocument(kind, name) {
  if (name.startsWith(cloudPrefix)) {
    const result = await cloudRequest('destroy', { public_id: publicId(name), type: 'authenticated', invalidate: true });
    if (!['ok', 'not found'].includes(result.result)) throw new AppError(502, 'Document deletion failed');
    return;
  }
  try { await unlink(localPath(kind, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Persist cleanup before contacting storage so failed deletes survive restarts.
export async function cleanupDocument(kind, name) {
  const job = await FileDeletionJob.create({ kind, name });
  try {
    await removeDocument(kind, name);
    await FileDeletionJob.deleteOne({ _id: job._id });
  } catch { /* The existing cleanup worker retries this durable job. */ }
}
