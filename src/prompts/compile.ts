/**
 * {{var}} compile contract (parity with dashboard + Python SDK).
 */

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function extractVariableNames(text: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const re = new RegExp(VAR_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text || '')) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

export function extractFromBody(
  promptType: string,
  body: Record<string, unknown>,
): string[] {
  if (promptType === 'text') {
    return extractVariableNames(String(body.text ?? ''));
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const msg of (body.messages as Array<Record<string, unknown>>) || []) {
    const content = typeof msg?.content === 'string' ? msg.content : '';
    for (const name of extractVariableNames(content)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

export function compileString(
  template: string,
  variables: Record<string, unknown>,
  required?: string[],
): { text: string; extras: string[] } {
  const req = required ?? extractVariableNames(template);
  const missing = req.filter((n) => variables[n] === undefined || variables[n] === null);
  if (missing.length) {
    throw new CompileError(`Missing required variables: ${missing.join(', ')}`);
  }
  const used = new Set(extractVariableNames(template));
  const extras = Object.keys(variables).filter((k) => !used.has(k));
  const text = template.replace(new RegExp(VAR_RE.source, 'g'), (_m, name: string) =>
    String(variables[name]),
  );
  return { text, extras };
}

export function compileBody(
  promptType: string,
  body: Record<string, unknown>,
  variables: Record<string, unknown>,
  declared?: Array<Record<string, unknown>>,
): { compiled: Record<string, unknown>; extras: string[] } {
  let required: string[] | undefined;
  if (declared?.length) {
    required = declared
      .map((d) => (typeof d.name === 'string' ? d.name : null))
      .filter((n): n is string => !!n);
  } else {
    required = extractFromBody(promptType, body);
  }
  const used = new Set(required || []);

  if (promptType === 'text') {
    const { text } = compileString(String(body.text ?? ''), variables, required);
    const extras = Object.keys(variables).filter((k) => !used.has(k));
    return { compiled: { text }, extras };
  }

  const messagesOut: Array<Record<string, unknown>> = [];
  let reqOnce: string[] | undefined = required;
  for (const msg of (body.messages as Array<Record<string, unknown>>) || []) {
    if (!msg || typeof msg !== 'object') continue;
    const { text: content } = compileString(String(msg.content ?? ''), variables, reqOnce);
    reqOnce = undefined;
    messagesOut.push({ ...msg, content });
  }
  const extras = Object.keys(variables).filter((k) => !used.has(k));
  return { compiled: { messages: messagesOut }, extras };
}
