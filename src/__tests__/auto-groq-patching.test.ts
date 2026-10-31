import { startTracing, stopTracing } from '../auto';
import { patchGroq, patchGroqEsm } from '../instrumentation/groq';
import { trackPendingSettle } from '../governance/pep';

jest.mock('../exporter/otlp-exporter');
jest.mock('../exporter/http-exporter');
jest.mock('../instrumentation/gemini', () => ({ patchGemini: jest.fn() }));
jest.mock('../instrumentation/axios', () => ({ patchAxios: jest.fn() }));
jest.mock('../instrumentation/groq', () => ({
  patchGroq: jest.fn(() => true),
  patchGroqEsm: jest.fn(),
}));

jest.mock('../config/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    tracing: { use_otlp: true },
    exporters: { enable_console: false },
    instrumentation: { enable_patching: true, enable_costs: false },
    rate_limiting: {},
    logging: {},
    advanced: {},
  }),
  findConfigFile: jest.fn().mockReturnValue(undefined),
  ENV_VAR_MAPPING: {},
}));

describe('startTracing Groq patching', () => {
  beforeEach(async () => {
    await stopTracing();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await stopTracing();
  });

  it("waits for groq-sdk's ES module build to be patched before returning", async () => {
    let finishEsm: (patched: boolean) => void = () => undefined;
    (patchGroqEsm as jest.Mock).mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishEsm = resolve;
      })
    );
    let started = false;
    const starting = startTracing({ apiKey: 'test' }).then(() => {
      started = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(patchGroq).toHaveBeenCalledTimes(1);
    expect(patchGroqEsm).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);

    finishEsm(true);
    await starting;
    expect(started).toBe(true);
  });

  it('stopTracing waits for governance settles still in flight', async () => {
    (patchGroqEsm as jest.Mock).mockResolvedValue(true);
    await startTracing({ apiKey: 'test' });
    let finish: () => void = () => undefined;
    trackPendingSettle(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    let stopped = false;
    const stopping = stopTracing().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('still starts when the ES module build cannot be patched', async () => {
    (patchGroqEsm as jest.Mock).mockRejectedValue(new Error('import failed'));
    await expect(startTracing({ apiKey: 'test' })).resolves.toBeDefined();
  });
});
