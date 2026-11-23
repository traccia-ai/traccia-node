import * as path from 'path';

const GENERIC_EVAL_SCRIPTS = new Set(['task', 'eval', 'main', 'index', 'run']);

/** Title shown on the experiment. A file named task is not the title. */
export function experimentName(options: {
  name?: string;
  dataset: string;
  script: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const chosen = (options.name || '').trim();
  if (chosen) return chosen;
  const env = options.env || process.env;
  const stem = path.basename(options.script, path.extname(options.script));
  const subject = GENERIC_EVAL_SCRIPTS.has(stem.toLowerCase()) ? String(options.dataset).trim() : stem;
  const label = `${subject} eval`;
  const ref = String(env.TRACCIA_GIT_HEAD_REF || '').trim();
  const pr = String(env.TRACCIA_PR_NUMBER || '').trim();
  if (ref) return `${label} · ${ref}`;
  if (pr) return `${label} · PR ${pr}`;
  return label;
}
