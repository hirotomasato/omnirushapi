// The end-to-end suites, against one stub upstream/manager and one real gateway.
//
//   npm run e2e
//
// Each suite leaves its accounts enabled or disabled as it needs; they share a database, so
// they run in order and the last one may leave accounts behind — the database is scratch.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATEWAY_PORT, STUB_PORT, createChecker, makeHelpers, startGateway, startStub } from "./harness.js";
import { run as runDialects } from "./suite-dialects.js";
import { run as runLogin } from "./suite-login.js";
import { run as runPlain } from "./suite-plain.js";
import type { Context } from "./suite-plain.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const { check, failures } = createChecker();

const stub = await startStub(STUB_PORT);
const gateway = await startGateway({ projectRoot, port: GATEWAY_PORT });

/** The CLI, run against the gateway this harness started. */
const cli = (...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("npm", ["run", "--silent", "gateway", "--", ...args], {
      cwd: projectRoot,
      env: { ...gateway.env, AI_GATEWAY_URL: gateway.base },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => resolve({ status: code, stdout, stderr }));
  });

const context: Context = {
  base: gateway.base,
  stubBase: `http://127.0.0.1:${STUB_PORT}`,
  helpers: makeHelpers(gateway.base),
  cli,
  check,
};

const suites: [string, (context: Context) => Promise<void>][] = [
  ["plain path", runPlain],
  ["cross-dialect", runDialects],
  ["device login and renewal", runLogin],
];

for (const [name, run] of suites) {
  console.log(`\n--- ${name} ---`);
  await run(context);
}

await gateway.stop();
await stub.close();

const failed = failures();
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
