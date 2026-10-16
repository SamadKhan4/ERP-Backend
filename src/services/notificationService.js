import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';

const leaveLabel = (value) =>
  String(value || 'leave').replaceAll('_', ' ');

export async function notifyLeaveReviewers({ employee, record }) {
  const reviewers = await User.find({
    active: true,
    _id: { $ne: employee._id },
    $or: [
      { role: { $in: ['super_admin', 'admin', 'manager', 'hr'] } },
    ],
  }).select('_id');
  if (!reviewers.length) return;
  await Notification.insertMany(
    reviewers.map(({ _id }) => ({
      recipient: _id,
      type: 'leave_request',
      title: 'New leave request',
      message: `${employee.name} requested ${leaveLabel(record.data.leaveType)} leave.`,
      link: '/hrms/leave',
      entityType: 'leave',
      entityId: record._id,
      createdBy: employee._id,
    })),
  );
}

export async function notifyLeaveDecision({ record, reviewer, decision, reason }) {
  const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'kept pending';
  const detail = reason ? ` Reason: ${reason}` : '';
  await Notification.create({
    recipient: record.employee,
    type: 'leave_status',
    title: `Leave request ${status}`,
    message: `Your ${leaveLabel(record.data.leaveType)} leave request was ${status}.${detail}`,
    link: '/employee#leave-requests',
    entityType: 'leave',
    entityId: record._id,
    createdBy: reviewer._id,
  });
}

export async function notifyPayrollPublished({ employee, run, entry, publisher }) {
  const month = new Date(Date.UTC(run.data.year, run.data.month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  await Notification.create({
    recipient: employee._id,
    type: 'payslip_available',
    title: `${month} payslip available`,
    message: `Your salary slip is ready. Payable amount: ₹${Number(entry.net).toLocaleString('en-IN')}.`,
    link: '/employee#payslips',
    entityType: 'payroll-runs',
    entityId: run._id,
    createdBy: publisher._id,
  });
}
