#!/usr/bin/env bun
/**
 * The whole local stack under one command, on one origin.
 *
 * ```bash
 * bun run dev:all            # sandbox gateway + Docusaurus — open http://127.0.0.1:3001
 * bun run dev:all --gateway  # the real gateway instead of the sandbox; needs .env and AWS
 * bun run dev:all --reset    # sandbox only: throw away yesterday's drafts and reseed from docs/
 * ```
 *
 * Local development wants two processes — a gateway and Docusaurus — that have to agree about
 * ports, and a stale one from the last session is invisible until a request lands on it. This
 * starts them together, prefixes their output so you can tell who said what, and tears both down
 * when either exits.
 *
 * There is no third process putting them on one origin any more: the Docusaurus dev server does
 * that itself, proxying everything the gateway owns (`apps/docs/src/dev/gateway-proxy.ts`). One
 * origin matters because in production the gateway serves the site, so every call the browser
 * makes is a relative path — and there is no CORS anywhere in this repository, deliberately.
 *
 * The default gateway is the **sandbox** (`dev:cms`), because it is the half that runs without an
 * AWS account or a GitHub App. `--gateway` swaps in the real service for working against real
 * infrastructure.
 */
const SITE_PORT = 3001;
const SANDBOX_PORT = 4300;
const GATEWAY_PORT = 3000;

/**
 * Docusaurus binds `localhost`, which on an IPv6-capable machine — every dev container — resolves
 * to `::1` alone, while its proxy forwards to `127.0.0.1`. Naming the address makes the two agree
 * instead of leaving half the stack unreachable.
 */
const SITE_HOST = '127.0.0.1';

const useRealGateway = process.argv.includes('--gateway');
const resetSandbox = process.argv.includes('--reset');

const siteOrigin = `http://${SITE_HOST}:${String(SITE_PORT)}`;
const gatewayPort = useRealGateway ? GATEWAY_PORT : SANDBOX_PORT;

interface ProcessSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly env: Record<string, string>;
  /** Relative to the repository root. Defaults to the root itself. */
  readonly cwd?: string;
}

const repoRoot = new URL('../..', import.meta.url).pathname;

const gatewaySpec: ProcessSpec = useRealGateway
  ? { name: 'gateway', command: ['bun', 'run', 'dev'], env: {} }
  : {
      name: 'sandbox',
      command: ['bun', 'run', 'scripts/dev/serve-cms.ts', ...(resetSandbox ? ['--reset'] : [])],
      env: {},
    };

/**
 * Docusaurus is started through its own CLI rather than `docs:start`, for the `--host` above. Its
 * `prestart` hook is the publisher bundle, which this script builds once for both processes.
 *
 * `GATEWAY_ORIGIN` is what makes its port a working origin rather than a site with no API behind
 * it: the dev server proxies everything the gateway owns to whichever gateway this run started.
 * See `apps/docs/src/dev/gateway-proxy.ts`.
 */
const SPECS: readonly ProcessSpec[] = [
  gatewaySpec,
  {
    name: 'site',
    command: ['bun', 'x', 'docusaurus', 'start', '--port', String(SITE_PORT), '--host', SITE_HOST],
    cwd: 'apps/docs',
    env: { GATEWAY_ORIGIN: `http://127.0.0.1:${String(gatewayPort)}` },
  },
];

const PORTS: readonly (readonly [number, string])[] = [
  [gatewayPort, gatewaySpec.name],
  [SITE_PORT, 'site'],
];

const useColor = process.env['NO_COLOR'] === undefined && process.stdout.isTTY;
const COLORS = ['\u001b[36m', '\u001b[35m', '\u001b[33m'];
const RESET = '\u001b[0m';
const labelWidth = Math.max(...SPECS.map((spec) => spec.name.length));

function labelFor(name: string, index: number): string {
  const padded = name.padEnd(labelWidth);
  return useColor ? `${COLORS[index % COLORS.length] ?? ''}${padded}${RESET} |` : `${padded} |`;
}

/** Prefixes a child's output line by line, so interleaved logs stay attributable. */
async function relay(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      console.log(`${label} ${line}`);
    }
  }
  if (pending !== '') {
    console.log(`${label} ${pending}`);
  }
}

/**
 * A port held by something else means one of these processes will die seconds from now with a
 * message buried under two others. Say so up front instead.
 */
function busyPorts(): string[] {
  return PORTS.filter(([port]) => {
    try {
      void Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') }).stop(true);
      return false;
    } catch {
      return true;
    }
  }).map(([port, name]) => `${String(port)} (${name})`);
}

const busy = busyPorts();
if (busy.length > 0) {
  console.error(`Already in use: port ${busy.join(', port ')}.`);
  console.error('Stop what is holding it — a stack from an earlier session, most likely.');
  process.exit(1);
}

// Both the sandbox and `/publisher` on the site serve this bundle, and neither builds it here.
const publisher = Bun.spawnSync({
  cmd: ['bun', 'run', 'scripts/build/build-publisher.ts'],
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (publisher.exitCode !== 0) {
  process.exit(publisher.exitCode);
}

const children = SPECS.map((spec, index) => {
  const child = Bun.spawn({
    cmd: [...spec.command],
    cwd: spec.cwd === undefined ? repoRoot : `${repoRoot}/${spec.cwd}`,
    env: { ...process.env, ...spec.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const label = labelFor(spec.name, index);
  void relay(child.stdout, label);
  void relay(child.stderr, label);
  return { spec, child };
});

/** An object rather than a `let`: a flag flipped inside a signal handler is not a narrowed type. */
const state = { stopping: false };

/**
 * SIGTERM rather than SIGKILL: `bun run` forwards it, so the sandbox gets to flush its draft state
 * before the process goes away.
 */
function shutdown(): void {
  state.stopping = true;
  for (const { child } of children) {
    child.kill();
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, shutdown);
}

console.log(`The local stack is on ${siteOrigin} — open that one.`);
console.log(`  ${'site'.padEnd(labelWidth)}  :${String(SITE_PORT)} (Docusaurus, hot reload)`);
console.log(`  ${gatewaySpec.name.padEnd(labelWidth)}  :${String(gatewayPort)} (behind the site)`);
if (!useRealGateway) {
  console.log('  real gateway instead of the sandbox: bun run dev:all --gateway');
}

/**
 * One process exiting takes the other with it. A stack missing its gateway answers every API call
 * with a proxy error, which reads like a bug in whatever you were working on.
 */
const first = await Promise.race(
  children.map(async ({ spec, child }) => ({ spec, code: await child.exited })),
);
const stoppedByHand = state.stopping;

if (!stoppedByHand) {
  console.error(`\n${first.spec.name} exited (${String(first.code)}) — stopping the rest.`);
  shutdown();
}

await Promise.all(children.map(({ child }) => child.exited));
process.exit(stoppedByHand ? 0 : first.code);
