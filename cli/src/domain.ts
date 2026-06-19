import {
  intro,
  outro,
  text,
  confirm,
  spinner,
  note,
  cancel,
  isCancel,
} from "@clack/prompts";
import { WHOAMI_PATH } from "@railgate/shared";
import {
  loadConfig,
  saveConfig,
  type RailgateConfig,
  type RailwayServiceRef,
} from "./config.js";
import { GraphQLError } from "./railway/api.js";
import {
  createCustomDomain,
  getCustomDomain,
  deleteCustomDomain,
  upsertVariables,
  deleteVariable,
  redeployService,
  type CustomDomainInfo,
  DNS_RECORD_PROPAGATED,
  CERT_VALID,
  CERT_ISSUE_FAILED,
} from "./railway/domains.js";

/** Must match the public port in the embedded template config ("<hasDomain>:8080"). */
const RELAY_TARGET_PORT = 8080;

const WATCH_TIMEOUT_MS = 10 * 60_000;
const WATCH_POLL_MS = 5_000;

// ── Domain normalization ──

export interface NormalizedWildcard {
  /** "*.tunnels.example.com" — what gets registered with Railway. */
  domain: string;
  /** "tunnels.example.com" — what the relay uses as BASE_DOMAIN. */
  baseDomain: string;
  /** True when we added the leading "*." for the user. */
  prefixed: boolean;
}

/**
 * Accept "*.tunnels.example.com", "tunnels.example.com", or either with a
 * scheme/trailing slash pasted in. railgate needs a wildcard (each tunnel is
 * a subdomain), so a bare domain gets "*." prepended.
 */
export function normalizeWildcardDomain(
  input: string
): NormalizedWildcard | { error: string } {
  let raw = input.trim().toLowerCase();
  raw = raw.replace(/^[a-z+]+:\/\//, "");
  raw = raw.replace(/\/.*$/, "");
  raw = raw.replace(/\.$/, "");

  let prefixed = false;
  let base = raw;
  if (raw.startsWith("*.")) {
    base = raw.slice(2);
  } else if (raw.startsWith("*")) {
    return { error: `"${input}" is not a valid domain` };
  } else {
    prefixed = true;
  }

  if (
    base.includes("*") ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(base)
  ) {
    return { error: `"${input}" is not a valid domain` };
  }
  if (base.split(".").length < 2) {
    return { error: `"${input}" needs at least two labels (e.g. tunnels.example.com)` };
  }

  return { domain: `*.${base}`, baseDomain: base, prefixed };
}

// ── Shared helpers ──

function requireRailwayRef(cfg: RailgateConfig | null): {
  cfg: RailgateConfig;
  railway: RailwayServiceRef;
} {
  if (!cfg) {
    cancel(
      "No railgate config found. Run `npx railgate setup` first."
    );
    process.exit(1);
  }
  if (!cfg.railway) {
    cancel(
      "Custom domain commands need a relay deployed through `railgate setup` (the\n" +
        "default OAuth flow), which records the Railway project IDs. Your config was\n" +
        "created manually — bind the domain in the Railway dashboard instead, then\n" +
        "set BASE_DOMAIN on the relay and re-run `railgate setup --manual`."
    );
    process.exit(1);
  }
  return { cfg, railway: cfg.railway };
}

async function exitIfCancel<T>(value: T | symbol): Promise<T> {
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as T;
}

function friendlyCreateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/not available/i.test(message)) {
    return "Railway says that domain is not available — it may already be attached to another service.";
  }
  if (/overlaps with existing wildcard/i.test(message)) {
    return "That domain overlaps with a wildcard domain registered elsewhere on Railway.";
  }
  if (/limit for custom domains/i.test(message)) {
    return "Your Railway plan's custom domain limit is reached. Remove a domain or upgrade the plan.";
  }
  if (/not a valid domain/i.test(message)) {
    return `Railway rejected the domain: ${message}`;
  }
  return `Couldn't register the domain with Railway: ${message}`;
}

/**
 * Render the DNS records the user must create. Combines the records Railway
 * returns with the ownership-verification TXT record (required before Railway
 * will issue the wildcard certificate — without it the domain never routes).
 */
function printDnsInstructions(info: CustomDomainInfo): void {
  const rows: Array<{
    type: string;
    name: string;
    value: string;
    wildcard: boolean;
  }> = [];

  for (const r of info.status.dnsRecords) {
    const name = r.hostlabel === "" ? "@" : r.hostlabel;
    rows.push({
      type: r.recordType.replace(/^DNS_RECORD_TYPE_/, ""),
      name,
      value: r.requiredValue,
      wildcard: name.startsWith("*"),
    });
  }

  if (!info.status.verified && info.status.verificationToken) {
    rows.push({
      type: "TXT",
      name: info.status.verificationDnsHost ?? "_railway-verify",
      value: info.status.verificationToken,
      wildcard: false,
    });
  }

  // Order matters: the wildcard (`*.`) record must be created LAST. If it
  // exists before the more specific records (_acme-challenge, _railway-verify),
  // a resolver that looks one of them up first will cache the wildcard's
  // synthesized answer in its place — so the specific record looks "overridden"
  // until that cache expires (up to the record's TTL). Adding specific names
  // first means no wildcard answer is ever cached for them. Stable sort keeps
  // the relative order Railway returned within each group.
  const ordered = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) =>
      a.row.wildcard === b.row.wildcard ? a.i - b.i : a.row.wildcard ? 1 : -1
    )
    .map((x) => x.row);

  const zone = info.status.dnsRecords[0]?.zone ?? info.domain.replace(/^\*\./, "");
  const wStep = String(ordered.length).length;
  const wType = Math.max(4, ...ordered.map((r) => r.type.length));
  const wName = Math.max(4, ...ordered.map((r) => r.name.length));

  const lines = [
    `${"".padEnd(wStep + 2)}${"Type".padEnd(wType + 3)}${"Name".padEnd(wName + 3)}Value`,
    ...ordered.map((r, i) => {
      const step = `${String(i + 1).padStart(wStep)}.`;
      const base = `${step} ${r.type.padEnd(wType + 3)}${r.name.padEnd(wName + 3)}${r.value}`;
      return r.wildcard ? `${base}   ← add this one LAST` : base;
    }),
  ];

  note(
    lines.join("\n") +
      `\n\nAdd the records in the order shown — the wildcard (\`*.\`) row goes` +
      `\nlast. Adding it before the others lets DNS resolvers cache it in place` +
      `\nof the _acme-challenge / verification records, which then look` +
      `\n"overridden" until the cache expires (up to the record's TTL).` +
      `\n\nIf the Name is "@", create the record on the zone root.` +
      `\nThe TXT record proves ownership — Railway won't issue the wildcard` +
      `\ncertificate (and the domain won't route) until it's in place.`,
    `Add these DNS records to ${zone}`
  );
}

function certLabel(status: string): string {
  switch (status) {
    case CERT_VALID:
      return "issued";
    case CERT_ISSUE_FAILED:
      return "failed (will retry)";
    case "CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP":
      return "validating ownership";
    case "CERTIFICATE_STATUS_TYPE_ISSUING":
      return "issuing";
    default:
      return "pending";
  }
}

/**
 * Poll the relay's whoami until it reports the expected base domain — i.e.
 * the redeploy with the new BASE_DOMAIN has actually rolled out (the old
 * deployment keeps answering with the old value until then).
 */
async function waitForRelayBaseDomain(
  httpUrl: string,
  token: string | undefined,
  expectedBaseDomain: string,
  maxWaitMs: number
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(`${httpUrl}${WHOAMI_PATH}`, { headers });
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean; baseDomain?: string };
        if (body.ok && body.baseDomain === expectedBaseDomain) return true;
      }
    } catch {
      // Relay restarting — keep polling.
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// ── Core flows (shared between `railgate setup` and `railgate domain ...`) ──

/**
 * Register the wildcard domain with Railway, persist progress, print the DNS
 * records, then hand off to the watch/finalize loop.
 */
export async function addDomainFlow(
  cfg: RailgateConfig,
  domainInput: string
): Promise<void> {
  const railway = cfg.railway!;
  const normalized = normalizeWildcardDomain(domainInput);
  if ("error" in normalized) {
    cancel(normalized.error);
    process.exit(1);
  }
  if (normalized.prefixed) {
    note(
      `railgate serves each tunnel on its own subdomain, so the domain is\nregistered as a wildcard: ${normalized.domain}`,
      "Using wildcard"
    );
  }

  const s = spinner();
  s.start(`Registering ${normalized.domain} with Railway`);

  let created: CustomDomainInfo;
  try {
    created = await createCustomDomain({
      domain: normalized.domain,
      projectId: railway.projectId,
      environmentId: railway.environmentId,
      serviceId: railway.serviceId,
      targetPort: RELAY_TARGET_PORT,
    });
  } catch (err) {
    s.stop("Registration failed");
    cancel(friendlyCreateError(err));
    process.exit(1);
  }

  cfg.customDomain = {
    id: created.id,
    domain: normalized.domain,
    baseDomain: normalized.baseDomain,
    finalized: false,
  };
  saveConfig(cfg);

  s.stop(`Registered ${normalized.domain}`);
  printDnsInstructions(created);

  await watchAndFinalize(cfg);
}

/**
 * Poll Railway until the domain is verified and the wildcard cert is issued,
 * then point the relay at it. Safe to re-run any time via `domain status`.
 */
export async function watchAndFinalize(cfg: RailgateConfig): Promise<void> {
  const railway = cfg.railway!;
  const state = cfg.customDomain!;

  const s = spinner();
  s.start("Waiting for DNS records (Ctrl+C is safe — resume with `railgate domain status`)");

  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let ready = false;
  let warnedCertFailure = false;

  while (Date.now() < deadline) {
    let info: CustomDomainInfo;
    try {
      info = await getCustomDomain({ id: state.id, projectId: railway.projectId });
    } catch (err) {
      s.stop("Status check failed");
      const message = err instanceof Error ? err.message : String(err);
      cancel(`Couldn't fetch domain status from Railway: ${message}`);
      process.exit(1);
    }

    const records = info.status.dnsRecords;
    const propagated = records.filter((r) => r.status === DNS_RECORD_PROPAGATED).length;
    const cert = certLabel(info.status.certificateStatus);

    if (info.status.verified && info.status.certificateStatus === CERT_VALID) {
      ready = true;
      break;
    }

    if (info.status.certificateStatus === CERT_ISSUE_FAILED && !warnedCertFailure) {
      warnedCertFailure = true;
    }

    s.message(
      `Waiting for DNS — records: ${propagated}/${records.length} propagated · ` +
        `ownership: ${info.status.verified ? "verified" : "pending"} · cert: ${cert}`
    );
    await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
  }

  if (!ready) {
    s.stop("Still waiting on DNS");
    outro(
      `DNS changes can take minutes to hours to propagate.\n` +
        `Your domain is registered — nothing is lost. Once your DNS records are in\n` +
        `place, run \`railgate domain status\` to finish the setup.`
    );
    process.exit(0);
  }

  s.stop(`${state.domain} verified, certificate issued`);
  await finalizeDomain(cfg);
}

/**
 * Point the relay at the custom domain: set BASE_DOMAIN/PROTOCOL, redeploy,
 * wait for the new deployment to answer whoami, and update local config.
 */
async function finalizeDomain(cfg: RailgateConfig): Promise<void> {
  const railway = cfg.railway!;
  const state = cfg.customDomain!;

  const s = spinner();
  s.start("Pointing the relay at your domain");

  try {
    await upsertVariables({
      projectId: railway.projectId,
      environmentId: railway.environmentId,
      serviceId: railway.serviceId,
      variables: { BASE_DOMAIN: state.baseDomain, PROTOCOL: "https" },
    });
    await redeployService({
      serviceId: railway.serviceId,
      environmentId: railway.environmentId,
    });
  } catch (err) {
    s.stop("Relay update failed");
    const message = err instanceof Error ? err.message : String(err);
    cancel(
      `Couldn't apply BASE_DOMAIN to the relay: ${message}\nRe-run \`railgate domain status\` to retry.`
    );
    process.exit(1);
  }

  s.message("Relay redeploying with the new domain (up to 3 minutes)");
  const ok = await waitForRelayBaseDomain(
    `https://${railway.serviceDomain}`,
    cfg.token,
    state.baseDomain,
    180_000
  );
  if (!ok) {
    s.stop("Relay didn't confirm the new domain");
    cancel(
      `The relay redeployed but hasn't reported BASE_DOMAIN=${state.baseDomain} yet.\n` +
        `It may still be rolling out — run \`railgate domain status\` in a minute.`
    );
    process.exit(1);
  }

  cfg.baseDomain = state.baseDomain;
  cfg.protocol = "https";
  state.finalized = true;
  saveConfig(cfg);

  s.stop("Relay is serving your domain");
  outro(
    `Tunnels now get URLs like https://<name>.${state.baseDomain}\n\nTry it: npx railgate http 3000`
  );
}

// ── Commands ──

export async function runDomainAdd(domainArg?: string): Promise<void> {
  intro("railgate domain add");
  const { cfg } = requireRailwayRef(loadConfig());

  if (cfg.customDomain) {
    if (cfg.customDomain.finalized) {
      cancel(
        `${cfg.customDomain.domain} is already bound to your relay.\nRemove it first with \`railgate domain remove\`.`
      );
    } else {
      cancel(
        `${cfg.customDomain.domain} is already registered and waiting on DNS.\n` +
          `Run \`railgate domain status\` to continue, or \`railgate domain remove\` to start over.`
      );
    }
    process.exit(1);
  }

  const domainInput =
    domainArg ??
    (await exitIfCancel(
      await text({
        message: "Wildcard domain for your tunnels",
        placeholder: "*.tunnels.example.com",
        validate: (v) => (!v ? "Domain is required" : undefined),
      })
    ));

  await addDomainFlow(cfg, domainInput);
}

export async function runDomainStatus(): Promise<void> {
  intro("railgate domain status");
  const { cfg } = requireRailwayRef(loadConfig());

  if (!cfg.customDomain) {
    cancel("No custom domain is configured. Add one with `railgate domain add`.");
    process.exit(1);
  }

  if (cfg.customDomain.finalized) {
    outro(
      `${cfg.customDomain.domain} is bound and live.\nTunnel URLs: https://<name>.${cfg.customDomain.baseDomain}`
    );
    return;
  }

  // Re-print the required records (DNS instructions shouldn't be lost to scrollback).
  try {
    const info = await getCustomDomain({
      id: cfg.customDomain.id,
      projectId: cfg.railway!.projectId,
    });
    if (!(info.status.verified && info.status.certificateStatus === CERT_VALID)) {
      printDnsInstructions(info);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    cancel(`Couldn't fetch domain status from Railway: ${message}`);
    process.exit(1);
  }

  await watchAndFinalize(cfg);
}

export async function runDomainRemove(): Promise<void> {
  intro("railgate domain remove");
  const { cfg, railway } = requireRailwayRef(loadConfig());

  if (!cfg.customDomain) {
    cancel("No custom domain is configured.");
    process.exit(1);
  }

  const confirmed = await exitIfCancel(
    await confirm({
      message: `Remove ${cfg.customDomain.domain} and fall back to ${railway.serviceDomain}?`,
    })
  );
  if (!confirmed) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const s = spinner();
  s.start("Removing custom domain");

  try {
    await deleteCustomDomain(cfg.customDomain.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Domain may already be gone server-side; only fail on real errors.
    if (!(err instanceof GraphQLError && /not found/i.test(message))) {
      s.stop("Removal failed");
      cancel(`Couldn't delete the custom domain: ${message}`);
      process.exit(1);
    }
  }

  const wasFinalized = cfg.customDomain.finalized;
  if (wasFinalized) {
    s.message("Resetting relay to its Railway domain");
    try {
      for (const name of ["BASE_DOMAIN", "PROTOCOL"]) {
        await deleteVariable({
          projectId: railway.projectId,
          environmentId: railway.environmentId,
          serviceId: railway.serviceId,
          name,
        });
      }
      await redeployService({
        serviceId: railway.serviceId,
        environmentId: railway.environmentId,
      });
    } catch (err) {
      s.stop("Relay reset failed");
      const message = err instanceof Error ? err.message : String(err);
      cancel(
        `The domain was deleted but the relay still has BASE_DOMAIN set: ${message}\n` +
          `Remove the BASE_DOMAIN and PROTOCOL variables in the Railway dashboard.`
      );
      process.exit(1);
    }
  }

  cfg.customDomain = undefined;
  cfg.baseDomain = railway.serviceDomain;
  cfg.protocol = "https";
  saveConfig(cfg);

  s.stop("Custom domain removed");
  outro(`Tunnels are back on https://${railway.serviceDomain}/_t/<name>`);
}
