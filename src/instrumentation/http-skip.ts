/**
 * Shared skip list for HTTP client instrumentation.
 * Keep in sync with traccia-py `instrumentation/requests.py`.
 */

const SKIP_URL_SUBSTRINGS = [
  "/v1/traces",
  "/v2/traces",
  "/api/v1/traces",
  "/api/v2/traces",
  "/v1/metrics",
  "/v2/metrics",
  "/api/v1/metrics",
  "/api/v2/metrics",
  "/api/v1/eval-runtime/",
  "/api/v1/prompt-runtime/",
  "/api/v1/agents/",
  "/api/v1/policy/",
];

export function shouldSkipHttp(url: string): boolean {
  if (!url) {
    return false;
  }
  if (SKIP_URL_SUBSTRINGS.some((path) => url.includes(path))) {
    return true;
  }
  const normalized = url.replace(/\/+$/, "");
  if (url.includes("/agents/") && (normalized.endsWith("/status") || url.includes("/blocks"))) {
    return true;
  }
  return false;
}
