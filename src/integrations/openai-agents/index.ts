/**
 * Traccia integration for OpenAI Agents SDK.
 */

let installed = false;

/**
 * Install Traccia tracing for OpenAI Agents SDK.
 */
export function install(enabled?: boolean): boolean {
  if (installed) {
    return true;
  }

  if (enabled === false) {
    return false;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const agents = require("agents");
    if (!agents || !agents.addTraceProcessor) {
      return false;
    }

    // Create and register the processor
    const { TracciaAgentsTracingProcessor } = require("./processor");
    const processor = new TracciaAgentsTracingProcessor();
    agents.addTraceProcessor(processor);

    installed = true;
    return true;
  } catch (e) {
    // Agents SDK not installed, skip silently
    return false;
  }
}