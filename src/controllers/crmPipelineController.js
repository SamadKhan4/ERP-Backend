import { Lead } from '../models/Lead.js';
import { listSchema } from '../validators/crmValidator.js';
import { leadFilter } from '../services/crmLeadService.js';
export async function pipeline(req, res) {
  const filter = leadFilter(req, listSchema.parse(req.query));
  const stages = await Lead.aggregate([
    { $match: filter },
    {
      $group: {
        _id: { stage: '$stage', currency: '$currency' },
        count: { $sum: 1 },
        value: { $sum: '$estimatedBudget' },
      },
    },
  ]);
  res.json({ success: true, data: { stages } });
}
