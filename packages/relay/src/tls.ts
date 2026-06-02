import fs from "node:fs";
import { config } from "./config";

/**
 * Build Fastify HTTPS options from the configured cert/key paths.
 *
 * Returns null when TLS is not configured (the relay then serves plain HTTP,
 * intended to sit behind a TLS-terminating proxy). If exactly one of cert/key
 * is set, that's a misconfiguration and we fail loudly rather than silently
 * falling back to HTTP.
 */
export function buildHttpsOptions(
  certPath: string | undefined = config.tlsCertPath,
  keyPath: string | undefined = config.tlsKeyPath
): { key: Buffer; cert: Buffer } | null {
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error(
      "TLS is misconfigured: set BOTH EKHO_TLS_CERT_PATH and EKHO_TLS_KEY_PATH, or neither."
    );
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}
