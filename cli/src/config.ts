import fs from "fs";
import path from "path";
import { homedir } from "os";

export interface RailgateConfig {
  /** WebSocket URL of the relay (ws:// or wss://) */
  relayUrl: string;
  /** Shared secret for relay auth. Optional when relay runs in open mode. */
  token?: string;
  /** Public hostname the relay serves tunnels under. Captured at setup time. */
  baseDomain?: string;
  /** http or https — the scheme of public tunnel URLs. */
  protocol?: "http" | "https";
  /** Wire protocol version recorded at setup time. */
  protocolVersion?: number;
}

export interface ResolveFlags {
  relay?: string;
  token?: string;
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "railgate") : path.join(homedir(), ".config", "railgate");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function loadConfig(): RailgateConfig | null {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return JSON.parse(raw) as RailgateConfig;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export function saveConfig(cfg: RailgateConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * Resolve effective config by merging flags > env vars > config file.
 * Returns null if neither a relay URL nor a saved config exists — caller
 * should print a "run setup first" hint.
 */
export function resolveConfig(flags: ResolveFlags = {}): RailgateConfig | null {
  const file = loadConfig();
  const relayUrl = flags.relay ?? process.env.RAILGATE_RELAY_URL ?? file?.relayUrl;
  const token = flags.token ?? process.env.RAILGATE_TOKEN ?? file?.token;
  if (!relayUrl) return null;
  return {
    relayUrl,
    token,
    baseDomain: file?.baseDomain,
    protocol: file?.protocol,
    protocolVersion: file?.protocolVersion,
  };
}
