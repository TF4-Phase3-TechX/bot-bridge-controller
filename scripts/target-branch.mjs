import { validBranch } from './branch-sync.mjs';

// Validate Git branch syntax, not an organization-specific list of branch names.
export function validTargetBranch(branch) {
  return validBranch(branch) && !branch.startsWith('-') && branch !== 'HEAD';
}
