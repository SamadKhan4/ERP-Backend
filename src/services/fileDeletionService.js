import { unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileDeletionJob } from '../models/FileDeletionJob.js';
import { onboardingUploadRoot } from '../middleware/onboardingUpload.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
const roots = {
  onboarding: onboardingUploadRoot,
  crm: resolve(
    env.CRM_UPLOAD_DIR ||
      fileURLToPath(new URL('../../.crm-files/', import.meta.url)),
  ),
  reset: fileURLToPath(new URL('../../.reset-mail/', import.meta.url)),
};
export async function cleanDeletedFiles(filter = {}, limit = 100) {
  const jobs = await FileDeletionJob.find(filter)
    .sort({ _id: 1 })
    .limit(limit)
    .lean();
  for (const job of jobs) {
    try {
      if (
        !roots[job.kind] ||
        basename(job.name) !== job.name ||
        ['.', '..'].includes(job.name)
      )
        throw new Error('Invalid stored filename');
      try {
        await unlink(resolve(roots[job.kind], job.name));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await FileDeletionJob.deleteOne({ _id: job._id });
    } catch (error) {
      logger.warn(
        {
          event: 'account.file_cleanup_retry',
          job: job._id,
          error: error.code || error.message,
        },
        'File cleanup will be retried',
      );
    }
  }
}
export function startFileDeletionWorker() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanDeletedFiles();
    } catch (error) {
      logger.warn({ err: error }, 'File cleanup unavailable');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
