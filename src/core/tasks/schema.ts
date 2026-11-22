import { z } from 'zod';
export const taskPolicyShape = {
  priority:z.number().int().min(-100).max(100).optional(),
  acceptanceCriteria:z.array(z.string().trim().min(1).max(2000)).max(32).optional(),
  requiredCapabilities:z.array(z.string().min(1)).max(64).optional(),
  inputArtifactIds:z.array(z.string().min(1)).max(64).optional(),
  modelId:z.string().min(1).optional(), reviewRequired:z.boolean().optional(),
};
export const taskPolicySchema=z.object(taskPolicyShape);
