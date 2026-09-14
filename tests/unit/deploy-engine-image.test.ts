import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The hosted engine image + AWS stack (deploy/engine.Dockerfile,
 * deploy/aws/*) are text the gate can read. What is pinned:
 *   - the Playwright base image matches the installed playwright version
 *     (a mismatch means the container's Chromium and the driver disagree
 *     — the classic silent "browser closed" on a fresh box);
 *   - the image never carries a .env or private/ data, and the stack has
 *     no inbound port;
 *   - the secret file the deploy script uploads is gitignored.
 * UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("hosted engine image (UNIT_CONFIRMED)", () => {
  const dockerfile = read("deploy/engine.Dockerfile");

  it("pins Playwright's own image at the installed playwright version", () => {
    const installed = JSON.parse(read("node_modules/playwright/package.json")) as { version: string };
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${installed.version}-noble`);
  });

  it("ships the source tree + tsx (the child launcher), points every stateful path at /data, and runs the scheduler", () => {
    expect(dockerfile).toMatch(/^COPY src \.\/src$/m);
    // NODE_ENV=production makes `npm ci` skip devDependencies — and tsx is one.
    expect(dockerfile).toMatch(/^RUN npm ci --include=dev/m);
    expect(dockerfile).not.toMatch(/npm ci --omit=dev/);
    for (const env of ["TENANTS_ROOT=/data/tenants", "PRIVATE_DIR=/data/private", "DATABASE_PATH=/data/engine/app.sqlite", "ARTIFACTS_DIR=/data/artifacts", "BROWSER_CHANNEL=chromium", "DOTENV_OVERRIDE=false"]) {
      expect(dockerfile).toContain(env);
    }
    expect(dockerfile).toMatch(/CMD \["node", "node_modules\/tsx\/dist\/cli\.mjs", "src\/tenants\/cli\.ts", "scheduler"/);
  });

  it("never copies a .env, private/, data/ or artifacts into the image", () => {
    expect(dockerfile).not.toMatch(/^COPY \.env/m);
    expect(dockerfile).not.toMatch(/^COPY (private|data|artifacts)\b/m);
    expect(dockerfile).not.toMatch(/^COPY \. /m);
    const ignore = read(".dockerignore");
    for (const p of ["private", "data", "artifacts", ".git", "node_modules"]) expect(ignore.split(/\r?\n/)).toContain(p);
  });
});

describe("hosted engine AWS stack (UNIT_CONFIRMED)", () => {
  const template = read("deploy/aws/engine-ec2.yaml");
  const script = read("deploy/aws/deploy.sh");

  it("has no inbound port: egress-only security group, SSM for the operator shell", () => {
    expect(template).not.toContain("SecurityGroupIngress");
    expect(template).toContain("SecurityGroupEgress");
    expect(template).toContain("AmazonSSMManagedInstanceCore");
    expect(template).not.toMatch(/KeyName/);
  });

  it("the env reaches the container only from the Secrets Manager secret, with the root volume encrypted and kept", () => {
    expect(template).toContain("secretsmanager:GetSecretValue");
    expect(template).toContain("--env-file /etc/dispatch/engine.env");
    expect(template).toContain("Encrypted: true");
    expect(template).toContain("DeleteOnTermination: false");
    expect(template).toContain("-v /data/dispatch:/data");
  });

  it("the deploy script uploads a gitignored env file and refuses one without the master key or with the operator's CDP URL", () => {
    expect(script).toContain("deploy/aws/.env.engine");
    expect(script).toMatch(/TENANT_MASTER_KEY=\[0-9a-fA-F\]\\\{64\\\}/);
    expect(script).toContain("AGENT_CDP_URL");
    const gitignore = read(".gitignore").split(/\r?\n/);
    expect(gitignore.some((l) => l === ".env*" || l === "deploy/aws/.env.engine" || l === ".env.*")).toBe(true);
  });
});
