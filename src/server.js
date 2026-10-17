import { startMailboxWorker } from './mailbox/mailSyncService.js';
import { runMailSend } from './mailbox/mailSendService.js';
let stopMailboxWorker=()=>{};
import { startProjectAutomation } from './projects/projectAutomation.js';
let stopProjectAutomation = () => {};
import mongoose from 'mongoose';
import { logger } from './config/logger.js';
import { app } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { startAttendanceAutomation } from './services/attendanceAutomationService.js';
import { startCRMReminders } from './services/crmReminderService.js';
import { startFileDeletionWorker } from './services/fileDeletionService.js';
import { startMailWorker } from './services/mailService.js';
import { startReportScheduler } from './reports/reportScheduleService.js';
import { startFinanceAutomation } from './finance/financeAutomation.js';
let stopFinanceAutomation = () => {};
let stopReportScheduler = () => {};
let stopMailWorker = () => {};
let stopFileDeletionWorker = () => {};
let stopCRMReminders = () => {};
let retry;
let stopAttendanceAutomation = () => {};
async function connect() {
  try {
    await connectDatabase();
    logger.info('MongoDB connected');
    stopAttendanceAutomation = startAttendanceAutomation();
    stopCRMReminders = startCRMReminders();
    stopFileDeletionWorker = startFileDeletionWorker();
    stopMailWorker = startMailWorker();
  stopMailboxWorker=startMailboxWorker(runMailSend);
    stopReportScheduler = startReportScheduler();
    stopFinanceAutomation = startFinanceAutomation();
    stopProjectAutomation = startProjectAutomation();
  } catch (err) {
    logger.warn(
      { err, event: 'database.retry' },
      'MongoDB unavailable; retrying in 5 seconds',
    );
    retry = setTimeout(connect, 5000);
  }
}
if (env.NODE_ENV === 'production') {
  await connectDatabase();
  logger.info({ event: 'database.connected' }, 'MongoDB connected');
  stopAttendanceAutomation = startAttendanceAutomation();
  stopCRMReminders = startCRMReminders();
  stopFileDeletionWorker = startFileDeletionWorker();
  stopMailWorker = startMailWorker();
  stopMailboxWorker=startMailboxWorker(runMailSend);
  stopReportScheduler = startReportScheduler();
  stopFinanceAutomation = startFinanceAutomation();
  stopProjectAutomation = startProjectAutomation();
} else void connect();
const server = app.listen(env.PORT, env.HOST, () =>
  logger.info(`Backend listening on http://${env.HOST}:${env.PORT}`),
);
async function shutdown() {
  logger.info(
    { event: 'server.shutdown' },
    'Shutting down HTTP server and MongoDB',
  );
  clearTimeout(retry);
  stopAttendanceAutomation();
  stopCRMReminders();
  stopFileDeletionWorker();
  stopMailWorker();
  stopMailboxWorker();
  stopReportScheduler();
  stopFinanceAutomation();
  stopProjectAutomation();
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
