# Make It Real — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure ekho into a monorepo with `@ekho/relay` and `@ekho/sdk` packages, add comprehensive test suite with Vitest.

**Architecture:** npm workspaces monorepo. The relay package contains the Fastify server, DB, routes, sweep, migrations, and operator UI. The SDK package contains the agent client and adapter with zero runtime deps. Vitest workspace runs tests across both packages.

**Tech Stack:** npm workspaces, Vitest, TypeScript with declarations, tsx

---

### Task 1: Create monorepo root scaffolding

**Files:**
- Create: `packages/relay/.gitkeep` (directory marker)
- Create: `packages/sdk/.gitkeep` (directory marker)
- Create: `tsconfig.base.json`
- Modify: `package.json` (root workspace config)

**Step 1: Create package directories**

```bash
mkdir -p packages/relay packages/sdk
```

**Step 2: Create shared tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

**Step 3: Convert root package.json to workspace manager**

```json
{
  "name": "ekho",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "npm run dev -w @ekho/relay",
    "start": "npm run start -w @ekho/relay",
    "setup": "npm run setup -w @ekho/relay",
    "build": "npm run build -w @ekho/sdk && npm run build -w @ekho/relay",
    "typecheck": "npm run typecheck -w @ekho/relay && npm run typecheck -w @ekho/sdk",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.2.1",
    "tsx": "^4.19.4"
  }
}
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: scaffold monorepo workspace structure"
```

---

### Task 2: Create @ekho/sdk package

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/src/types.ts`
- Create: `packages/sdk/src/client.ts`
- Create: `packages/sdk/src/adapter.ts`
- Create: `packages/sdk/src/index.ts`

**Step 1: Create packages/sdk/package.json**

```json
{
  "name": "@ekho/sdk",
  "version": "0.1.0",
  "description": "Agent SDK for Ekho — the private communication layer for distributed AI agents.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

**Step 2: Create packages/sdk/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

**Step 3: Create packages/sdk/src/types.ts**

Copy the types from current `agent-client.ts` and `adapter.ts`:

```typescript
export type AgentCredentials = {
  agentId: string;
  secret: string;
  relayBaseUrl: string;
  heartbeatIntervalSeconds?: number;
  pollIntervalSeconds?: number;
};

export type ActionDecision =
  | { decision: "allow" }
  | { decision: "deny" }
  | { decision: "pending_approval"; approval_id: string };

export type InboxMessage = {
  message_id: string;
  conversation_id: string;
  correlation_id: string;
  sender_agent_id: string;
  message_type: string;
  priority: string;
  body: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
  deadline_at: string;
};

export type ControlMessage = {
  control_id: string;
  action: string;
  reason: string;
};

export type SendMessagePayload = {
  recipient: { kind: "agent" | "group" | "broadcast"; id?: string };
  message_type: "direct" | "broadcast" | "alert" | "handoff" | "claim" | "complete" | "heartbeat" | "control";
  priority?: "low" | "normal" | "high" | "urgent";
  ttl_seconds?: number;
  requires_approval?: boolean;
  body: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  conversation_id: string;
  correlation_id: string;
};

export type HeartbeatPayload = {
  status: "healthy" | "degraded" | "busy" | "idle";
  active_conversation_ids?: string[];
  metrics?: Record<string, unknown>;
};

export type ProposeActionPayload = {
  conversation_id: string;
  action_type: string;
  summary: string;
  risk_level: "low" | "medium" | "high" | "critical";
  payload: Record<string, unknown>;
};

export type ActionResultPayload = {
  approval_id: string;
  result: "executed" | "cancelled" | "failed";
  completed_at: string;
  output?: Record<string, unknown>;
};
```

**Step 4: Create packages/sdk/src/client.ts**

Copy from current `src/agent-client.ts` but:
- Remove `import { config } from "./config"` — this is the key decoupling
- Import types from `./types` instead of defining inline
- Default `pollIntervalSeconds` to 5 and `heartbeatIntervalSeconds` to 30 directly (no server config dependency)

```typescript
import crypto from "node:crypto";
import type { AgentCredentials, ActionDecision, SendMessagePayload, HeartbeatPayload, ProposeActionPayload, ActionResultPayload } from "./types";

export { type AgentCredentials, type ActionDecision };

const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_HEARTBEAT_INTERVAL = 30;

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export class EkhoAgentClient {
  constructor(private readonly credentials: AgentCredentials) {}

  private signedHeaders(method: string, signaturePath: string, body: string) {
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const payload = `${method}\n${signaturePath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
    const signature = crypto.createHmac("sha256", this.credentials.secret).update(payload).digest("hex");
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": this.credentials.agentId,
      "x-ekho-agent-secret": this.credentials.secret,
      "x-ekho-timestamp": timestamp,
      "x-ekho-nonce": nonce,
      "x-ekho-signature": signature
    };
  }

  private async request<T>(method: string, routePath: string, payload?: unknown): Promise<T> {
    const body = payload ? JSON.stringify(payload) : "";
    const signaturePath = routePath.split("?")[0] ?? routePath;
    const response = await fetch(`${this.credentials.relayBaseUrl}${routePath}`, {
      method,
      headers: this.signedHeaders(method, signaturePath, body),
      body: method === "GET" ? undefined : body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ekho request failed for ${routePath}: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  get agentId() { return this.credentials.agentId; }
  get pollIntervalSeconds() { return this.credentials.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL; }
  get heartbeatIntervalSeconds() { return this.credentials.heartbeatIntervalSeconds ?? DEFAULT_HEARTBEAT_INTERVAL; }

  sendMessage(payload: SendMessagePayload) {
    return this.request<{ message_id: string; status: string; queued_at: string }>("POST", "/v1/messages", payload);
  }

  getInbox(limit = 25) {
    return this.request<{ messages: Array<Record<string, unknown>>; controls: Array<Record<string, unknown>> }>("GET", `/v1/inbox?limit=${limit}`);
  }

  ackMessages(acks: Array<{ message_id: string; status: "received"; received_at: string }>) {
    return this.request<{ updated: number }>("POST", "/v1/acks", { acks });
  }

  heartbeat(payload: HeartbeatPayload) {
    return this.request<{ ok: boolean; next_heartbeat_due_seconds: number }>("POST", "/v1/heartbeats", payload);
  }

  proposeAction(payload: ProposeActionPayload) {
    return this.request<ActionDecision>("POST", "/v1/actions/propose", payload);
  }

  getApproval(approvalId: string) {
    return this.request<{
      id: string; status: string; action_type: string; risk_level: string;
      summary: string; requested_at: string; resolved_at: string | null;
    }>("GET", `/v1/actions/${approvalId}`);
  }

  actionResult(payload: ActionResultPayload) {
    return this.request<{ ok: boolean }>("POST", "/v1/actions/result", payload);
  }
}
```

**Step 5: Create packages/sdk/src/adapter.ts**

Copy from current `src/adapter.ts` but import from local types/client:

```typescript
import { EkhoAgentClient } from "./client";
import type { AgentCredentials, InboxMessage, ControlMessage, SendMessagePayload, ProposeActionPayload, ActionResultPayload } from "./types";

export type AdapterHooks = {
  onMessage?: (message: InboxMessage, adapter: EkhoAgentAdapter) => Promise<void>;
  beforeAction?: (action: ProposeActionPayload, adapter: EkhoAgentAdapter) => Promise<void>;
  onControl?: (control: ControlMessage, adapter: EkhoAgentAdapter) => Promise<void>;
  onApprovalPending?: (approvalId: string, adapter: EkhoAgentAdapter) => Promise<void>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EkhoAgentAdapter {
  private readonly client: EkhoAgentClient;
  private readonly hooks: AdapterHooks;
  private running = false;
  private paused = false;
  private activeConversationIds = new Set<string>();

  constructor(credentials: AgentCredentials, hooks: AdapterHooks = {}) {
    this.client = new EkhoAgentClient(credentials);
    this.hooks = hooks;
  }

  get agentId() { return this.client.agentId; }

  async start() {
    if (this.running) return;
    this.running = true;
    void this.heartbeatLoop();
    void this.inboxLoop();
  }

  stop() { this.running = false; }

  async send(payload: SendMessagePayload) {
    return this.client.sendMessage(payload);
  }

  async proposeAction(action: ProposeActionPayload) {
    if (this.hooks.beforeAction) await this.hooks.beforeAction(action, this);
    if (this.paused) throw new Error("agent is paused by control plane");

    const decision = await this.client.proposeAction(action);
    if (decision.decision === "allow") return decision;
    if (decision.decision === "deny") throw new Error("action denied by Ekho policy");

    if (this.hooks.onApprovalPending) await this.hooks.onApprovalPending(decision.approval_id, this);

    while (this.running) {
      const approval = await this.client.getApproval(decision.approval_id);
      if (approval.status === "approved" || approval.status === "executed") return decision;
      if (approval.status === "rejected" || approval.status === "cancelled" || approval.status === "expired") {
        throw new Error(`action ${approval.status} by operator`);
      }
      await sleep(1500);
    }
    throw new Error("adapter stopped while waiting for approval");
  }

  async reportActionResult(payload: ActionResultPayload) {
    return this.client.actionResult(payload);
  }

  private async heartbeatLoop() {
    while (this.running) {
      try {
        await this.client.heartbeat({
          status: this.paused ? "degraded" : "healthy",
          active_conversation_ids: [...this.activeConversationIds],
          metrics: { paused: this.paused }
        });
      } catch (error) {
        console.error("[ekho-adapter] heartbeat failed", error);
      }
      await sleep(this.client.heartbeatIntervalSeconds * 1000);
    }
  }

  private async inboxLoop() {
    while (this.running) {
      try {
        const inbox = await this.client.getInbox();
        for (const control of inbox.controls as ControlMessage[]) await this.handleControl(control);
        for (const raw of inbox.messages as InboxMessage[]) {
          this.activeConversationIds.add(raw.conversation_id);
          if (this.hooks.onMessage) await this.hooks.onMessage(raw, this);
          await this.client.ackMessages([
            { message_id: raw.message_id, status: "received", received_at: new Date().toISOString() }
          ]);
        }
      } catch (error) {
        console.error("[ekho-adapter] inbox loop failed", error);
      }
      await sleep(this.client.pollIntervalSeconds * 1000);
    }
  }

  private async handleControl(control: ControlMessage) {
    if (control.action === "pause" || control.action === "quarantine") this.paused = true;
    if (control.action === "resume") this.paused = false;
    if (this.hooks.onControl) await this.hooks.onControl(control, this);
  }
}
```

**Step 6: Create packages/sdk/src/index.ts**

```typescript
export { EkhoAgentClient } from "./client";
export { EkhoAgentAdapter } from "./adapter";
export type { AdapterHooks } from "./adapter";
export type {
  AgentCredentials,
  ActionDecision,
  InboxMessage,
  ControlMessage,
  SendMessagePayload,
  HeartbeatPayload,
  ProposeActionPayload,
  ActionResultPayload
} from "./types";
```

**Step 7: Build and verify**

```bash
cd packages/sdk && npx tsc --noEmit
```
Expected: no errors

**Step 8: Commit**

```bash
git add packages/sdk/ && git commit -m "feat: create @ekho/sdk package with client and adapter"
```

---

### Task 3: Move relay code into packages/relay

**Files:**
- Move: `src/` → `packages/relay/src/`
- Move: `migrations/` → `packages/relay/migrations/`
- Move: `frontend/` → `packages/relay/frontend/`
- Move: `ui-dist/` → `packages/relay/ui-dist/`
- Move: `vite.config.mjs` → `packages/relay/vite.config.mjs`
- Move: `.env.example` → `packages/relay/.env.example`
- Create: `packages/relay/package.json`
- Create: `packages/relay/tsconfig.json`
- Delete: old root `tsconfig.json`

**Step 1: Move files**

```bash
mv src packages/relay/src
mv migrations packages/relay/migrations
mv frontend packages/relay/frontend
mv ui-dist packages/relay/ui-dist
mv vite.config.mjs packages/relay/vite.config.mjs
mv .env.example packages/relay/.env.example
```

**Step 2: Create packages/relay/package.json**

```json
{
  "name": "@ekho/relay",
  "version": "0.1.0",
  "description": "Ekho relay server — private communication and control layer for distributed AI agents.",
  "main": "src/server.ts",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "setup": "tsx src/setup.ts",
    "doctor": "tsx src/setup.ts --doctor",
    "typecheck": "tsc --noEmit",
    "agent:demo": "tsx src/demo-agent.ts",
    "ui:dev": "vite",
    "ui:build": "vite build --config vite.config.mjs",
    "build": "npm run ui:build && npm run typecheck",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/static": "^9.0.0",
    "better-sqlite3": "^12.8.0",
    "dotenv": "^17.4.0",
    "fastify": "^5.8.4",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.14"
  }
}
```

**Step 3: Create packages/relay/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

**Step 4: Fix path references in relay code**

The three `process.cwd()` references must resolve relative to the relay package root, not the monorepo root. Change them to use `__dirname`:

**packages/relay/src/config.ts** — change dbPath:
```typescript
// Change from:
dbPath: path.resolve(process.cwd(), process.env.EKHO_DB_PATH ?? "./data/ekho.sqlite"),
// Change to:
dbPath: path.resolve(process.env.EKHO_DB_PATH ?? path.join(__dirname, "..", "data", "ekho.sqlite")),
```

**packages/relay/src/db.ts** — change migrations path:
```typescript
// Change from:
const migrationsDir = path.join(process.cwd(), "migrations");
// Change to:
const migrationsDir = path.join(__dirname, "..", "migrations");
```

**packages/relay/src/server.ts** — change ui-dist path:
```typescript
// Change from:
const uiRoot = path.join(process.cwd(), "ui-dist");
// Change to:
const uiRoot = path.join(__dirname, "..", "ui-dist");
```

**Step 5: Remove old agent-client.ts and adapter.ts from relay**

These now live in @ekho/sdk. Delete them from packages/relay/src/:
```bash
rm packages/relay/src/agent-client.ts packages/relay/src/adapter.ts
```

**Step 6: Update demo-agent.ts to import from @ekho/sdk**

```typescript
// Change from:
import { EkhoAgentAdapter } from "./adapter";
// Change to:
import { EkhoAgentAdapter } from "@ekho/sdk";
```

Note: For this import to work, we need to add `@ekho/sdk` as a dependency of `@ekho/relay` in package.json, OR (simpler for a demo script) just import from the relative path `../../sdk/src/index`. Better: add workspace dependency.

Add to packages/relay/package.json dependencies:
```json
"@ekho/sdk": "*"
```

**Step 7: Delete old root tsconfig.json**

```bash
rm tsconfig.json
```

**Step 8: Run npm install from root to wire up workspaces**

```bash
cd /path/to/ekho && npm install
```

**Step 9: Verify typecheck**

```bash
npm run typecheck -w @ekho/relay
npm run typecheck -w @ekho/sdk
```
Expected: both pass

**Step 10: Commit**

```bash
git add -A && git commit -m "refactor: move relay code into packages/relay, fix path resolution"
```

---

### Task 4: Set up Vitest workspace

**Files:**
- Create: `vitest.workspace.ts`
- Modify: root `package.json` (already has vitest in devDeps from Task 1)

**Step 1: Create vitest.workspace.ts at repo root**

```typescript
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/relay",
  "packages/sdk"
]);
```

**Step 2: Verify vitest runs (no tests yet)**

```bash
npx vitest run
```
Expected: "No test files found" or similar — no errors

**Step 3: Commit**

```bash
git add vitest.workspace.ts && git commit -m "feat: add Vitest workspace configuration"
```

---

### Task 5: Relay integration test infrastructure

**Files:**
- Create: `packages/relay/tests/setup.ts`
- Create: `packages/relay/vitest.config.ts`

**Step 1: Create packages/relay/vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000
  }
});
```

**Step 2: Create packages/relay/tests/setup.ts**

Test helper that:
- Creates a temp SQLite DB
- Builds a Fastify server instance (not listening, uses inject)
- Bootstraps a fleet with an operator
- Provides helper to enroll agents
- Cleans up after each test

```typescript
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";

// Override config BEFORE importing db/routes
function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");
  process.env.EKHO_DB_PATH = dbPath;
  process.env.EKHO_OPERATOR_SESSION_SECRET = "test-secret";
  process.env.EKHO_DELIVERY_TIMEOUT_SECONDS = "2";
  process.env.EKHO_SWEEP_INTERVAL_MS = "500";
  process.env.EKHO_RATE_LIMIT_WINDOW_SECONDS = "5";
  process.env.EKHO_RATE_LIMIT_MAX_MESSAGES = "5";
  process.env.EKHO_HEARTBEAT_TIMEOUT_SECONDS = "3";
  process.env.EKHO_HEARTBEAT_LIVENESS_THRESHOLD = "2";
  process.env.EKHO_RATE_LIMIT_VIOLATION_THRESHOLD = "3";
  process.env.EKHO_RATE_LIMIT_VIOLATION_WINDOW_SECONDS = "60";
  return { tmpDir, dbPath };
}

export async function createTestRelay() {
  const env = setupTestEnv();

  // Dynamic import so env is set before modules load config
  const { EkhoDb } = await import("../src/db");
  const { registerAgentRoutes } = await import("../src/routes-agent");
  const { registerOperatorRoutes } = await import("../src/routes-operator");
  const { sign } = await import("../src/utils");

  const db = new EkhoDb();
  const app = fastify({ logger: false });

  const uiRoot = path.join(__dirname, "..", "ui-dist");
  if (fs.existsSync(uiRoot)) {
    await app.register(fastifyStatic, { root: uiRoot, prefix: "/ui/" });
  }

  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);

  // Bootstrap fleet + operator
  const { fleetId, operatorId } = db.createBootstrap("test-fleet", "admin@test.com", "testpassword1");
  const tokenCore = `${operatorId}.${fleetId}`;
  const operatorToken = `${tokenCore}.${sign("test-secret", tokenCore)}`;

  async function enrollAgent(displayName: string) {
    const enrollmentToken = db.issueEnrollmentToken(fleetId, operatorId);
    const res = await app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: {
        fleet_id: fleetId,
        token: enrollmentToken,
        display_name: displayName,
        runtime: "custom"
      }
    });
    return JSON.parse(res.body) as { agent_id: string; secret: string };
  }

  function signedHeaders(agentId: string, secret: string, method: string, urlPath: string, body: string) {
    const crypto = require("node:crypto");
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const sha256 = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
    const payload = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${sha256(body)}`;
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return {
      "content-type": "application/json",
      "x-ekho-agent-id": agentId,
      "x-ekho-agent-secret": secret,
      "x-ekho-timestamp": timestamp,
      "x-ekho-nonce": nonce,
      "x-ekho-signature": signature
    };
  }

  async function agentRequest(agentId: string, secret: string, method: string, url: string, payload?: unknown) {
    const body = payload ? JSON.stringify(payload) : "";
    const signaturePath = url.split("?")[0];
    const res = await app.inject({
      method: method as any,
      url,
      headers: signedHeaders(agentId, secret, method, signaturePath, body),
      payload: payload ?? undefined
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function operatorRequest(method: string, url: string, payload?: unknown) {
    const res = await app.inject({
      method: method as any,
      url,
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      payload: payload ?? undefined
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  function cleanup() {
    app.close();
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }

  return { app, db, fleetId, operatorId, operatorToken, enrollAgent, agentRequest, operatorRequest, cleanup };
}
```

**Step 3: Commit**

```bash
git add packages/relay/tests/ packages/relay/vitest.config.ts && git commit -m "feat: add relay test infrastructure"
```

---

### Task 6: Write relay integration tests — enrollment and messaging

**Files:**
- Create: `packages/relay/tests/relay.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestRelay } from "./setup";

describe("Relay integration", () => {
  let relay: Awaited<ReturnType<typeof createTestRelay>>;

  beforeEach(async () => { relay = await createTestRelay(); });
  afterEach(() => relay.cleanup());

  describe("enrollment", () => {
    it("enrolls an agent with a valid token", async () => {
      const agent = await relay.enrollAgent("test-agent-1");
      expect(agent.agent_id).toMatch(/^agent_/);
      expect(agent.secret).toBeTruthy();
    });

    it("rejects enrollment with invalid token", async () => {
      const res = await relay.app.inject({
        method: "POST",
        url: "/v1/enroll",
        payload: { fleet_id: relay.fleetId, token: "invalid", display_name: "bad", runtime: "custom" }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("message lifecycle", () => {
    it("sends a message and delivers to recipient inbox", async () => {
      const sender = await relay.enrollAgent("sender");
      const receiver = await relay.enrollAgent("receiver");

      const sendRes = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        priority: "normal",
        body: { text: "hello" },
        conversation_id: "conv-1",
        correlation_id: "corr-1"
      });
      expect(sendRes.status).toBe(200);
      expect(sendRes.body.message_id).toMatch(/^msg_/);

      const inboxRes = await relay.agentRequest(receiver.agent_id, receiver.secret, "GET", "/v1/inbox");
      expect(inboxRes.status).toBe(200);
      expect(inboxRes.body.messages).toHaveLength(1);
      expect(inboxRes.body.messages[0].body.text).toBe("hello");

      const ackRes = await relay.agentRequest(receiver.agent_id, receiver.secret, "POST", "/v1/acks", {
        acks: [{ message_id: sendRes.body.message_id, status: "received", received_at: new Date().toISOString() }]
      });
      expect(ackRes.status).toBe(200);
      expect(ackRes.body.updated).toBe(1);
    });

    it("does not deliver to wrong agent", async () => {
      const sender = await relay.enrollAgent("sender");
      const receiver = await relay.enrollAgent("receiver");
      const other = await relay.enrollAgent("other");

      await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "secret" },
        conversation_id: "conv-2",
        correlation_id: "corr-2"
      });

      const otherInbox = await relay.agentRequest(other.agent_id, other.secret, "GET", "/v1/inbox");
      expect(otherInbox.body.messages).toHaveLength(0);
    });
  });

  describe("heartbeat", () => {
    it("records heartbeat and updates agent status", async () => {
      const agent = await relay.enrollAgent("heartbeat-agent");
      const res = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/heartbeats", {
        status: "healthy",
        active_conversation_ids: [],
        metrics: {}
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("rate limiting", () => {
    it("returns 429 after exceeding message limit", async () => {
      const sender = await relay.enrollAgent("rate-sender");
      const receiver = await relay.enrollAgent("rate-receiver");

      for (let i = 0; i < 5; i++) {
        const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
          recipient: { kind: "agent", id: receiver.agent_id },
          message_type: "direct",
          body: { i },
          conversation_id: `conv-rate-${i}`,
          correlation_id: `corr-rate-${i}`
        });
        expect(res.status).toBe(200);
      }

      const blocked = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "too many" },
        conversation_id: "conv-rate-blocked",
        correlation_id: "corr-rate-blocked"
      });
      expect(blocked.status).toBe(429);
    });
  });

  describe("policy engine", () => {
    it("blocks message when deny policy matches", async () => {
      const sender = await relay.enrollAgent("policy-sender");
      const receiver = await relay.enrollAgent("policy-receiver");

      await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "block-sender",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { sender_agent_id: sender.agent_id } },
        enabled: true
      });

      const res = await relay.agentRequest(sender.agent_id, sender.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: receiver.agent_id },
        message_type: "direct",
        body: { text: "should be blocked" },
        conversation_id: "conv-policy",
        correlation_id: "corr-policy"
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("blocked by policy");
    });
  });

  describe("operator", () => {
    it("returns fleet overview", async () => {
      await relay.enrollAgent("overview-agent");
      const res = await relay.operatorRequest("GET", "/v1/operator/overview");
      expect(res.status).toBe(200);
      expect(res.body.agents.length).toBeGreaterThan(0);
      expect(res.body).toHaveProperty("deadLetterCount");
      expect(res.body).toHaveProperty("quarantinedAgentCount");
    });

    it("lists and manages policies", async () => {
      const createRes = await relay.operatorRequest("POST", "/v1/operator/policies", {
        name: "test-policy",
        scope_kind: "fleet",
        rule: { action: "deny", conditions: { message_type: "broadcast" } },
        enabled: true
      });
      expect(createRes.status).toBe(201);

      const listRes = await relay.operatorRequest("GET", "/v1/operator/policies");
      expect(listRes.body.policies.length).toBeGreaterThan(0);

      const deleteRes = await relay.operatorRequest("DELETE", `/v1/operator/policies/${createRes.body.policyId}`);
      expect(deleteRes.status).toBe(200);
    });

    it("quarantines and resumes an agent", async () => {
      const agent = await relay.enrollAgent("quarantine-agent");
      const qRes = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/quarantine`, {
        reason: "test quarantine"
      });
      expect(qRes.status).toBe(200);

      const blocked = await relay.agentRequest(agent.agent_id, agent.secret, "POST", "/v1/messages", {
        recipient: { kind: "agent", id: agent.agent_id },
        message_type: "direct",
        body: { text: "should fail" },
        conversation_id: "conv-q",
        correlation_id: "corr-q"
      });
      expect(blocked.status).toBe(403);

      const resumeRes = await relay.operatorRequest("POST", `/v1/operator/agents/${agent.agent_id}/resume`, {
        reason: "test resume"
      });
      expect(resumeRes.status).toBe(200);
    });
  });
});
```

**Step 2: Run tests**

```bash
npx vitest run --workspace packages/relay
```
Expected: all tests pass

**Step 3: Commit**

```bash
git add packages/relay/tests/ && git commit -m "test: add relay integration tests"
```

---

### Task 7: Write SDK tests

**Files:**
- Create: `packages/sdk/tests/setup.ts`
- Create: `packages/sdk/tests/client.test.ts`
- Create: `packages/sdk/vitest.config.ts`

**Step 1: Create packages/sdk/vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000
  }
});
```

**Step 2: Create packages/sdk/tests/setup.ts**

This starts a real relay server instance for SDK tests:

```typescript
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export async function createTestRelayForSdk() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ekho-sdk-test-"));
  const dbPath = path.join(tmpDir, "test.sqlite");

  process.env.EKHO_DB_PATH = dbPath;
  process.env.EKHO_OPERATOR_SESSION_SECRET = "test-secret";
  process.env.EKHO_DELIVERY_TIMEOUT_SECONDS = "2";
  process.env.EKHO_SWEEP_INTERVAL_MS = "60000";
  process.env.EKHO_RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.EKHO_RATE_LIMIT_MAX_MESSAGES = "100";

  // Dynamic import to pick up env
  const { EkhoDb } = await import("@ekho/relay/src/db");
  const fastify = (await import("fastify")).default;
  const { registerAgentRoutes } = await import("@ekho/relay/src/routes-agent");
  const { registerOperatorRoutes } = await import("@ekho/relay/src/routes-operator");
  const { sign } = await import("@ekho/relay/src/utils");

  const db = new EkhoDb();
  const app = fastify({ logger: false });
  await registerAgentRoutes(app);
  await registerOperatorRoutes(app);

  // Listen on random port
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { fleetId, operatorId } = db.createBootstrap("sdk-test-fleet", "admin@test.com", "testpassword1");

  async function enrollAgent(displayName: string) {
    const enrollmentToken = db.issueEnrollmentToken(fleetId, operatorId);
    const tokenCore = `${operatorId}.${fleetId}`;
    const operatorToken = `${tokenCore}.${sign("test-secret", tokenCore)}`;

    const res = await fetch(`${baseUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fleet_id: fleetId,
        token: enrollmentToken,
        display_name: displayName,
        runtime: "custom"
      })
    });
    const body = await res.json() as { agent_id: string; secret: string };
    return { ...body, relayBaseUrl: baseUrl };
  }

  function cleanup() {
    app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl, fleetId, enrollAgent, cleanup };
}
```

**Step 3: Create packages/sdk/tests/client.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EkhoAgentClient, EkhoAgentAdapter } from "../src/index";
import { createTestRelayForSdk } from "./setup";

describe("@ekho/sdk", () => {
  let relay: Awaited<ReturnType<typeof createTestRelayForSdk>>;

  beforeAll(async () => { relay = await createTestRelayForSdk(); });
  afterAll(() => relay.cleanup());

  describe("EkhoAgentClient", () => {
    it("sends a message and retrieves it from inbox", async () => {
      const senderCreds = await relay.enrollAgent("sdk-sender");
      const receiverCreds = await relay.enrollAgent("sdk-receiver");

      const sender = new EkhoAgentClient({
        agentId: senderCreds.agent_id,
        secret: senderCreds.secret,
        relayBaseUrl: senderCreds.relayBaseUrl
      });

      const receiver = new EkhoAgentClient({
        agentId: receiverCreds.agent_id,
        secret: receiverCreds.secret,
        relayBaseUrl: receiverCreds.relayBaseUrl
      });

      const sent = await sender.sendMessage({
        recipient: { kind: "agent", id: receiverCreds.agent_id },
        message_type: "direct",
        body: { text: "sdk test" },
        conversation_id: "sdk-conv-1",
        correlation_id: "sdk-corr-1"
      });
      expect(sent.message_id).toBeTruthy();

      const inbox = await receiver.getInbox();
      expect(inbox.messages).toHaveLength(1);

      const ackResult = await receiver.ackMessages([
        { message_id: sent.message_id, status: "received", received_at: new Date().toISOString() }
      ]);
      expect(ackResult.updated).toBe(1);
    });

    it("sends heartbeat successfully", async () => {
      const creds = await relay.enrollAgent("sdk-heartbeat");
      const client = new EkhoAgentClient({
        agentId: creds.agent_id,
        secret: creds.secret,
        relayBaseUrl: creds.relayBaseUrl
      });

      const result = await client.heartbeat({ status: "healthy" });
      expect(result.ok).toBe(true);
    });

    it("rejects invalid credentials", async () => {
      const client = new EkhoAgentClient({
        agentId: "fake-agent",
        secret: "fake-secret",
        relayBaseUrl: relay.baseUrl
      });

      await expect(client.heartbeat({ status: "healthy" })).rejects.toThrow("401");
    });
  });

  describe("EkhoAgentAdapter", () => {
    it("receives messages via onMessage hook", async () => {
      const senderCreds = await relay.enrollAgent("adapter-sender");
      const receiverCreds = await relay.enrollAgent("adapter-receiver");

      const received: Array<Record<string, unknown>> = [];

      const adapter = new EkhoAgentAdapter(
        { agentId: receiverCreds.agent_id, secret: receiverCreds.secret, relayBaseUrl: receiverCreds.relayBaseUrl, pollIntervalSeconds: 1 },
        { async onMessage(msg) { received.push(msg); } }
      );

      await adapter.start();

      const sender = new EkhoAgentClient({
        agentId: senderCreds.agent_id,
        secret: senderCreds.secret,
        relayBaseUrl: senderCreds.relayBaseUrl
      });

      await sender.sendMessage({
        recipient: { kind: "agent", id: receiverCreds.agent_id },
        message_type: "direct",
        body: { text: "adapter test" },
        conversation_id: "adapter-conv",
        correlation_id: "adapter-corr"
      });

      // Wait for poll cycle
      await new Promise((r) => setTimeout(r, 2500));
      adapter.stop();

      expect(received).toHaveLength(1);
      expect((received[0] as { body: { text: string } }).body.text).toBe("adapter test");
    });
  });
});
```

**Step 4: Run SDK tests**

```bash
npx vitest run --workspace packages/sdk
```
Expected: all tests pass

**Step 5: Commit**

```bash
git add packages/sdk/tests/ packages/sdk/vitest.config.ts && git commit -m "test: add SDK integration tests"
```

---

### Task 8: Run full test suite and clean up

**Step 1: Run all tests from root**

```bash
npx vitest run
```
Expected: both relay and SDK tests pass

**Step 2: Verify root scripts work**

```bash
npm run typecheck
npm run build -w @ekho/sdk
```

**Step 3: Clean up old files at root that were moved**

Verify nothing remains at root that should have moved. Check for orphaned files:

```bash
# These should NOT exist at root anymore:
ls src/ migrations/ frontend/ ui-dist/ vite.config.mjs .env.example tsconfig.json 2>&1
```
Expected: "No such file or directory" for all

**Step 4: Update .gitignore if needed**

Ensure `dist/` and `data/` are covered for the new structure.

**Step 5: Final commit**

```bash
git add -A && git commit -m "chore: clean up monorepo migration, verify full test suite"
```

---

## File Summary

| Action | File |
|--------|------|
| Create | `packages/sdk/package.json` |
| Create | `packages/sdk/tsconfig.json` |
| Create | `packages/sdk/vitest.config.ts` |
| Create | `packages/sdk/src/index.ts` |
| Create | `packages/sdk/src/client.ts` |
| Create | `packages/sdk/src/adapter.ts` |
| Create | `packages/sdk/src/types.ts` |
| Create | `packages/sdk/tests/setup.ts` |
| Create | `packages/sdk/tests/client.test.ts` |
| Create | `packages/relay/package.json` |
| Create | `packages/relay/tsconfig.json` |
| Create | `packages/relay/vitest.config.ts` |
| Create | `packages/relay/tests/setup.ts` |
| Create | `packages/relay/tests/relay.test.ts` |
| Create | `tsconfig.base.json` |
| Create | `vitest.workspace.ts` |
| Modify | `package.json` (root → workspace manager) |
| Move | `src/` → `packages/relay/src/` |
| Move | `migrations/` → `packages/relay/migrations/` |
| Move | `frontend/` → `packages/relay/frontend/` |
| Move | `ui-dist/` → `packages/relay/ui-dist/` |
| Move | `vite.config.mjs` → `packages/relay/vite.config.mjs` |
| Move | `.env.example` → `packages/relay/.env.example` |
| Modify | `packages/relay/src/config.ts` (fix path resolution) |
| Modify | `packages/relay/src/db.ts` (fix migration path) |
| Modify | `packages/relay/src/server.ts` (fix ui-dist path) |
| Modify | `packages/relay/src/demo-agent.ts` (import from @ekho/sdk) |
| Delete | `src/agent-client.ts` (moved to SDK) |
| Delete | `src/adapter.ts` (moved to SDK) |
| Delete | `tsconfig.json` (replaced by tsconfig.base.json + per-package) |
