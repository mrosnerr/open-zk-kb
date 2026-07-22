export type KnowledgeApplicability =
  | { type: 'project-local'; project: string }
  | { type: 'global' }
  | { type: 'unclassified'; reason: 'missing' | 'multiple-projects' | 'conflict' };

export interface VisibilityOptions {
  project: string;
  client?: string;
}

export function parseKnowledgeApplicability(tags: string[]): KnowledgeApplicability {
  const projects = tags
    .filter(tag => tag.startsWith('project:'))
    .map(tag => tag.slice('project:'.length))
    .filter(project => project.length > 0);
  const global = tags.includes('scope:global');

  if (global && projects.length === 0) return { type: 'global' };
  if (!global && projects.length === 1) return { type: 'project-local', project: projects[0] };
  if (global && projects.length > 0) return { type: 'unclassified', reason: 'conflict' };
  if (projects.length > 1) return { type: 'unclassified', reason: 'multiple-projects' };
  return { type: 'unclassified', reason: 'missing' };
}
