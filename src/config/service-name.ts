import path from 'node:path';

/**
 * Resolve OTLP service.name (aligned with traccia-py auto._resolve_service_name).
 */
export function resolveServiceName(serviceName?: string): string {
  if (serviceName) {
    return serviceName;
  }

  const envName =
    process.env.OTEL_SERVICE_NAME ||
    process.env.SERVICE_NAME ||
    process.env.TRACCIA_SERVICE_NAME;
  if (envName) {
    return envName;
  }

  try {
    const cwdName = path.basename(process.cwd());
    if (cwdName) {
      return cwdName;
    }
  } catch {
    // ignore
  }

  const argv0 = process.argv[1];
  if (argv0 && argv0 !== '-c' && argv0 !== '-m') {
    const scriptName = path.basename(argv0);
    const stem = path.parse(scriptName).name;
    if (stem) {
      return stem;
    }
    if (scriptName) {
      return scriptName;
    }
  }

  return 'traccia_app';
}
