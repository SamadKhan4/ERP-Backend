import { User } from '../models/User.js';
import { EmployeeProfile } from '../models/EmployeeProfile.js';
import { permissionsFor, has, id } from './crmAccessService.js';
import { AppError } from '../utils/errors.js';
export const indiaDate = () =>
  new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export async function teamAccess(req, res, next) {
  req.teamPermissions = await permissionsFor(req.user);
  next();
}
export const requireTeam = (permission) => (req, res, next) => {
  if (!has(req.teamPermissions, permission))
    throw new AppError(403, 'Team workspace permission denied');
  next();
};
export async function resolveTeam(req) {
  const leaderId = req.query.leader ? id(req.query.leader) : req.user._id;
  if (
    String(leaderId) !== req.user.id &&
    !has(req.teamPermissions, 'team.members.manage')
  )
    throw new AppError(403, 'You cannot access another leader’s team');
  const leader = await User.findOne({
    _id: leaderId,
    role: 'team_leader',
    active: true,
  })
    .select('_id name department')
    .lean();
  if (!leader) throw new AppError(400, 'Select an active Team Leader');
  const profiles = await EmployeeProfile.find({ manager: leader._id })
    .select('user')
    .lean();
  const members = await User.find({
    _id: { $in: profiles.map((profile) => profile.user) },
    active: true,
    role: { $in: ['employee', 'executive', 'lead_caller'] },
  })
    .select('_id name email department role')
    .sort({ name: 1 })
    .lean();
  return {
    leader,
    members,
    ids: [leader._id, ...members.map((member) => member._id)],
  };
}
export async function requireMyTeam(req, leaderId) {
  const profile = await EmployeeProfile.exists({
    user: req.user._id,
    manager: leaderId,
  });
  if (String(leaderId) !== req.user.id && !profile)
    throw new AppError(403, 'You are not a member of this team');
}
