import { FinanceRecurring } from '../models/Finance.js';
import { Invoice } from '../models/Invoice.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { financeAccess, hasFinance } from './financeAccess.js';
import { generateRecurringInvoice } from './financeService.js';
import { indiaDay } from './financeQueryService.js';
import { logger } from '../config/logger.js';
export async function runFinanceAutomation() {
  const due = await FinanceRecurring.find({
    status: 'ACTIVE',
    autoInvoice: true,
    nextBillingDate: { $lte: new Date() },
  })
    .sort({ nextBillingDate: 1 })
    .limit(20)
    .lean();
  for (const row of due) {
    try {
      const user = await User.findById(row.createdBy);
      if (!user?.active) throw new Error('Owner unavailable');
      const req = { user };
      await financeAccess(req, {}, () => {});
      if (
        !hasFinance(req, 'finance.recurring.manage') ||
        !hasFinance(req, 'finance.invoices.create')
      )
        throw new Error('Permission revoked');
      await generateRecurringInvoice(req, row._id, row.nextBillingDate);
      await FinanceRecurring.updateOne(
        { _id: row._id },
        { $unset: { lastError: 1 } },
      );
    } catch {
      await FinanceRecurring.updateOne(
        { _id: row._id },
        {
          $set: {
            lastError:
              'Automatic billing needs review: check company/client tax settings, contract dates and owner permissions.',
            autoInvoice: false,
          },
        },
      );
    }
  }
  const invoices = await Invoice.find({
    deletedAt: null,
    status: { $nin: ['Draft', 'Cancelled', 'Paid'] },
    dueDate: { $lt: new Date(indiaDay().getTime() + 86400000) },
  })
    .select('_id invoiceNumber dueDate createdBy')
    .limit(100)
    .lean();
  const date = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  for (const row of invoices) {
    const type = row.dueDate < indiaDay() ? 'finance.overdue' : 'finance.due';
    const title = `${row.invoiceNumber} ${type.endsWith('overdue') ? 'is overdue' : 'is due today'}`;
    await Notification.updateOne(
      { recipient: row.createdBy, type: `${type}.${date}`, entityId: row._id },
      {
        $setOnInsert: {
          title,
          message: title,
          link: `/finance/invoices/${row._id}`,
          entityType: 'finance',
        },
      },
      { upsert: true },
    );
  }
}
export function startFinanceAutomation() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runFinanceAutomation();
    } catch {
      logger.warn(
        { event: 'finance.automation_error' },
        'Finance automation unavailable',
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
