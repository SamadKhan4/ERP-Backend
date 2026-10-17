import { Quotation } from '../models/Quotation.js';
import { Project } from '../models/Project.js';
import { AppError } from '../utils/errors.js';
export async function billingReferences(input) {
  if (!input.quotation && !input.project) return {};
  const quotation = input.quotation
    ? await Quotation.findOne({ _id: input.quotation, deletedAt: null })
    : null;
  const project = input.project ? await Project.findById(input.project) : null;
  if ((input.quotation && !quotation) || (input.project && !project))
    throw new AppError(400, 'Billing reference not found');
  if (
    quotation &&
    project &&
    ((quotation.clientRef &&
      project.clientRef &&
      String(quotation.clientRef) !== String(project.clientRef)) ||
      (quotation.lead &&
        project.lead &&
        String(quotation.lead) !== String(project.lead)))
  )
    throw new AppError(
      400,
      'Quotation and project must belong to the same lead',
    );
  return {
    lead: quotation?.lead || project?.lead,
    clientRef: quotation?.clientRef || project?.clientRef,
    ...(quotation ? { quotation: quotation._id } : {}),
    ...(project ? { project: project._id } : {}),
  };
}
