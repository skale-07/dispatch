import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Azure hosting set (deploy/azure/*, frontend/public/staticwebapp.config.json)
 * is text the gate can read. Pinned, in the same spirit as the AWS test:
 *   - the VM has NO inbound path (the NSG's only inbound rule denies all,
 *     password auth off), reads its env only from Key Vault through its
 *     managed identity, keeps the data disk when the VM goes;
 *   - the deploy script uploads a gitignored env file, refuses one without
 *     the master key or with the operator's CDP URL, builds in ACR (no local
 *     Docker), and never prints the site token;
 *   - the Static Web Apps config carries the SAME response headers as
 *     vercel.json (one CSP, two hosts, no drift) and the SPA fallback.
 * UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("hosted engine on Azure (UNIT_CONFIRMED)", () => {
  const bicep = read("deploy/azure/engine-vm.bicep");
  const script = read("deploy/azure/deploy.sh");

  it("has no inbound path: the only inbound NSG rule is a deny, password auth is off, access is run-command", () => {
    // Each security rule is `name: '…' properties: { … }`; read direction + access per rule.
    const rules = [...bicep.matchAll(/name: '(\w+)'\s*\n\s*properties: \{([^}]*)\}/g)]
      .map((m) => ({ name: m[1]!, body: m[2]! }))
      .filter((r) => /direction: '/.test(r.body));
    const inbound = rules.filter((r) => /direction: 'Inbound'/.test(r.body));
    expect(inbound.map((r) => r.name)).toEqual(["DenyAllInbound"]);
    expect(inbound[0]!.body).toMatch(/access: 'Deny'/);
    expect(bicep).not.toMatch(/destinationPortRange: '22'/);
    expect(bicep).toContain("disablePasswordAuthentication: true");
    expect(bicep).toContain("az vm run-command invoke");
    expect(script).toContain("run-command invoke");
  });

  it("the env reaches the container only from Key Vault via the managed identity; the image is pulled with the same identity", () => {
    expect(bicep).toContain("identity: { type: 'SystemAssigned' }");
    expect(bicep).toContain("az login --identity");
    expect(bicep).toContain("az keyvault secret show");
    expect(bicep).toContain("--env-file /etc/dispatch/engine.env");
    expect(bicep).toContain("-v /data/dispatch:/data");
    // AcrPull + Key Vault Secrets User, scoped to the existing registry and vault.
    expect(bicep).toContain("7f951dda-4ed3-4680-a7ca-43fe172d538d");
    expect(bicep).toContain("4633458b-17de-408a-b874-0445c86b69e6");
    expect(bicep).toMatch(/registries@[\d-]+' existing/);
    expect(bicep).toMatch(/vaults@[\d-]+' existing/);
    // No secret value ever lives in the template.
    expect(bicep).not.toMatch(/TENANT_MASTER_KEY=|SUPABASE_SERVICE_ROLE_KEY=|BROWSER_USE_API_KEY=/);
  });

  it("the data disk outlives the VM and is encrypted; the OS disk goes with it", () => {
    expect(bicep).toContain("deleteOption: 'Detach'");
    expect(bicep).toContain("EncryptionAtRestWithPlatformKey");
    expect(bicep).toContain("/dev/disk/azure/scsi1/lun0");
  });

  it("the deploy script uploads a gitignored env file, refuses a bad one, builds remotely, and never echoes the site token", () => {
    expect(script).toContain("deploy/azure/.env.engine");
    expect(script).toMatch(/TENANT_MASTER_KEY=\[0-9a-fA-F\]\\\{64\\\}/);
    expect(script).toContain("AGENT_CDP_URL");
    expect(script).toContain("az acr build");
    expect(script).not.toMatch(/docker (build|push)/);
    expect(script).toContain("az keyvault secret set");
    expect(script).not.toMatch(/echo .*\$token/);
    expect(script).toContain("VITE_CONSOLE_ENABLED=true");
    const gitignore = read(".gitignore").split(/\r?\n/);
    expect(gitignore.some((l) => l === ".env*" || l === ".env.*")).toBe(true);
    expect(gitignore.some((l) => l === "private/**" || l === "private/" || l === "private")).toBe(true);
    // The remote build uploads the repo context to ACR: env files in ANY directory stay out of it.
    const dockerignore = read(".dockerignore").split(/\r?\n/);
    expect(dockerignore).toContain("**/.env");
    expect(dockerignore).toContain("**/.env.*");
  });
});

describe("public site on Azure Static Web Apps (UNIT_CONFIRMED)", () => {
  const swa = JSON.parse(read("frontend/public/staticwebapp.config.json")) as {
    navigationFallback: { rewrite: string; exclude: string[] };
    globalHeaders: Record<string, string>;
  };
  const vercel = JSON.parse(read("frontend/vercel.json")) as {
    rewrites: Array<{ source: string; destination: string }>;
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };

  it("deep links rewrite to the SPA, assets excluded", () => {
    expect(swa.navigationFallback.rewrite).toBe("/index.html");
    expect(swa.navigationFallback.exclude).toContain("/assets/*");
    expect(vercel.rewrites[0]).toEqual({ source: "/(.*)", destination: "/index.html" });
  });

  it("carries exactly the headers vercel.json carries — one CSP, no drift between hosts", () => {
    const fromVercel = Object.fromEntries(vercel.headers[0]!.headers.map((h) => [h.key, h.value]));
    expect(swa.globalHeaders).toEqual(fromVercel);
  });

  it("the CSP allows both remote-browser live views to be embedded, Supabase to be called, and nothing to frame the app", () => {
    const csp = swa.globalHeaders["Content-Security-Policy"]!;
    const frameSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("frame-src"))!;
    expect(frameSrc).toContain("https://*.browserbase.com");
    expect(frameSrc).toContain("https://live.browser-use.com");
    expect(csp).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co");
    expect(csp).toContain("object-src 'none'");
    expect(swa.globalHeaders["X-Frame-Options"]).toBe("DENY");
  });

  it("the launch checklist and the Azure runbook name the Azure path, not Vercel, as the deploy", () => {
    expect(read("docs/roadmap/launch-checklist-2026-09-14.md")).toMatch(/Static Web Apps/);
    expect(read("deploy/azure/README.md")).toMatch(/site-push/);
  });
});
