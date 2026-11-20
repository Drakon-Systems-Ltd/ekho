import { createRequire } from "node:module";

/**
 * The connector's own package version (the one `ekho-mcp` prints at start-up),
 * also sent as `adapter_version` on heartbeats (#97). Resolved relative to this
 * module, so it is the installed package's package.json, never one found
 * through the working directory.
 */
export const CONNECTOR_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
