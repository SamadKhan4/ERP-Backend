import { randomUUID } from 'node:crypto';
import { ScheduledReport } from '../models/ReportConfiguration.js';
import { User } from '../models/User.js';
import { permissionsFor } from '../services/permissionService.js';
import { mailTransport } from '../services/mailTransportService.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { executeReport } from './reportService.js';
import { renderReportExport, recordGeneration } from './reportExportService.js';
import { requireReportPermission } from './reportAccessService.js';
export function nextSchedule(frequency, now = new Date()) {
  const india = new Date(now.getTime() + 19800000);
  let year = india.getUTCFullYear(),
    month = india.getUTCMonth(),
    day = india.getUTCDate();
  if (frequency === 'MONTHLY') {
    month += 1;
    day = 1;
  } else day += frequency === 'WEEKLY' ? 7 : 1;
  // 09:00 IST, daily / same weekday / first of next month.
  return new Date(Date.UTC(year, month, day, 3, 30));
}
export async function processReportSchedules(limit = 5) {
  if (env.MAIL_DELIVERY !== 'smtp') return;
  for (let index = 0; index < limit; index++) {
    const lease = randomUUID(),
      now = new Date();
    const schedule = await ScheduledReport.findOneAndUpdate(
      {
        status: 'ACTIVE',
        nextRunAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lease, lockedUntil: new Date(Date.now() + 300000) } },
      { new: true },
    );
    if (!schedule) return;
    const filter = { _id: schedule._id, lease };
    try {
      const user = await User.findById(schedule.createdBy);
      if (!user?.active) throw new Error('Account unavailable');
      const req = { user, reportPermissions: await permissionsFor(user) };
      requireReportPermission(req, 'reports.schedule');
      requireReportPermission(req, 'reports.generate');
      if (
        schedule.recipients.length !== 1 ||
        schedule.recipients[0].toLowerCase() !== user.email.toLowerCase()
      )
        throw new Error('Recipient changed');
      // Permission and scope are recalculated at delivery time, never restored from saved input.
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const start = new Date(`${today}T00:00:00Z`);
      if (schedule.frequency === 'MONTHLY') {
        start.setUTCDate(1);
        start.setUTCMonth(start.getUTCMonth() - 1);
      } else
        start.setUTCDate(
          start.getUTCDate() - (schedule.frequency === 'WEEKLY' ? 7 : 1),
        );
      const end = new Date(`${today}T00:00:00Z`);
      end.setUTCDate(
        schedule.frequency === 'MONTHLY' ? 0 : end.getUTCDate() - 1,
      );
      const data = await executeReport(
        req,
        schedule.reportKey,
        {
          ...schedule.filters,
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
        },
        { exportData: true },
      );
      const file = await renderReportExport(data, schedule.format);
      const result = await mailTransport().sendMail({
        from: env.MAIL_FROM,
        to: user.email,
        subject: `AdBorn ERP Report: ${schedule.name}`,
        text: `${data.report.title}\nScope: ${data.scope}\nPeriod: ${data.filters.from} to ${data.filters.to}\n${data.dateBasis}\nAttached report generated from current authorized ERP data.`,
        attachments: [
          {
            filename: file.filename,
            content: file.buffer,
            contentType: file.mime,
          },
        ],
      });
      if (!result.accepted?.length) throw new Error('SMTP declined recipient');
      await recordGeneration(req, data, schedule.format, 'SENT');
      await ScheduledReport.updateOne(filter, {
        $set: {
          lastRunAt: now,
          nextRunAt: nextSchedule(schedule.frequency, now),
        },
        $unset: { lease: 1, lockedUntil: 1, lastError: 1 },
      });
    } catch {
      await ScheduledReport.updateOne(filter, {
        $set: {
          status: 'PAUSED',
          lastError:
            'Delivery paused. Check current permissions, recipient, filters and SMTP configuration before resuming.',
        },
        $unset: { lease: 1, lockedUntil: 1 },
      });
      logger.warn(
        { event: 'reports.schedule_failed', schedule: schedule.id },
        'Scheduled report paused',
      );
    }
  }
}
export function startReportScheduler() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processReportSchedules();
    } catch {
      logger.warn(
        { event: 'reports.scheduler_error' },
        'Report scheduler unavailable',
      );
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
