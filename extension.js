const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const vscode = require("vscode");

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_TAB_TIMEOUT_MS = 15000;
const MAX_JOB_HISTORY = 200;
const CODEX_SCHEME = "openai-codex";
const CODEX_AUTHORITY = "route";
const UNINITIALIZED_CLIENT_ID = "initializing-client";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const IPC_METHOD_VERSIONS = {
  "thread-follower-start-turn": 1,
  "thread-follower-interrupt-turn": 1,
  "thread-follower-set-model-and-reasoning": 1,
  "thread-follower-set-collaboration-mode": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-set-queued-follow-ups-state": 1
};

let activeBridge = null;

function activate(context) {
  const bridge = new CodexBridge();
  activeBridge = bridge;

  context.subscriptions.push(
    vscode.commands.registerCommand("codexBridge.startServer", async () => {
      await bridge.start();
      vscode.window.showInformationMessage(
        `Codex Bridge listening on ${bridge.getServerUrl()}.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexBridge.stopServer", async () => {
      await bridge.stop();
      vscode.window.showInformationMessage("Codex Bridge stopped.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexBridge.showStatus", async () => {
      const status = bridge.getStatus();
      const details = status.running ? `Running at ${status.url}` : "Stopped";
      vscode.window.showInformationMessage(`Codex Bridge: ${details}`);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("codexBridge")) {
        return;
      }
      if (bridge.isRunning()) {
        await bridge.restart().catch((error) => {
          bridge.log(
            `Failed to restart after configuration change: ${formatError(error)}`
          );
        });
      } else if (bridge.getConfig().autoStart) {
        await bridge.start().catch((error) => {
          bridge.log(
            `Failed to start after configuration change: ${formatError(error)}`
          );
        });
      }
    })
  );

  context.subscriptions.push({
    dispose() {
      bridge.dispose();
    }
  });

  if (bridge.getConfig().autoStart) {
    void bridge.start().catch((error) => {
      bridge.log(`Failed to auto-start: ${formatError(error)}`);
    });
  }
}

async function deactivate() {
  if (activeBridge) {
    await activeBridge.stop();
  }
}

class CodexBridge {
  constructor() {
    this.output = vscode.window.createOutputChannel("Codex Bridge");
    this.server = null;
    this.serverInfo = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.requestCounter = 0;
    this.runningCliProcesses = new Set();
    this.jobs = new Map();
    this.jobOrder = [];
    this.appServerClient = null;
    this.appServerJobsByTurnId = new Map();
    this.appServerJobsByThreadId = new Map();
    this.conversationAliases = new Map();
  }

  dispose() {
    const output = this.output;
    this.output = { appendLine() {} };
    this.disposeAppServerClient();
    void this.stop().finally(() => {
      output.dispose();
    });
  }

  getConfig() {
    const config = vscode.workspace.getConfiguration("codexBridge");
    return {
      autoStart: config.get("autoStart", true),
      host: config.get("host", DEFAULT_HOST),
      port: config.get("port", DEFAULT_PORT),
      authToken: String(config.get("authToken", "")).trim(),
      requestTimeoutMs: normalizeTimeout(
        config.get("requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS),
        DEFAULT_REQUEST_TIMEOUT_MS
      ),
      tabTimeoutMs: normalizeTimeout(
        config.get("tabTimeoutMs", DEFAULT_TAB_TIMEOUT_MS),
        DEFAULT_TAB_TIMEOUT_MS
      )
    };
  }

  isRunning() {
    return this.server !== null;
  }

  getServerUrl() {
    if (!this.serverInfo) {
      const config = this.getConfig();
      return `http://${config.host}:${config.port}`;
    }
    return `http://${this.serverInfo.host}:${this.serverInfo.port}`;
  }

  getStatus() {
    const current = this.getCurrentConversation();
    return {
      running: this.isRunning(),
      url: this.getServerUrl(),
      currentConversationId: current ? current.conversationId : null,
      jobs: this.getJobSummary()
    };
  }

  log(message) {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  async start() {
    if (this.server) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async doStart() {
    const config = this.getConfig();
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });

    server.on("clientError", (error, socket) => {
      this.log(`HTTP client error: ${formatError(error)}`);
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });

    const address = server.address();
    this.server = server;
    this.serverInfo = {
      host: config.host,
      port: address && typeof address === "object" ? address.port : config.port
    };

    this.log(`Listening on ${this.getServerUrl()}`);
    if (!isLoopbackHost(config.host) && !config.authToken) {
      this.log(
        "Warning: bridge is not bound to a loopback host and no auth token is configured."
      );
    }
  }

  async stop() {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.server) {
      this.serverInfo = null;
      return;
    }

    const server = this.server;
    this.server = null;
    this.serverInfo = null;
    this.stopPromise = new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      await this.stopPromise;
      this.log("Stopped.");
    } finally {
      this.stopPromise = null;
    }

    this.disposeAppServerClient();
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async handleHttpRequest(req, res) {
    const requestId = ++this.requestCounter;
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const startedAt = Date.now();

    try {
      const config = this.getConfig();
      if (!isAuthorized(req, config.authToken)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          status: this.getStatus(),
          openConversations: this.listOpenConversations()
        });
        return;
      }

      if (method === "GET" && url.pathname === "/conversations/open") {
        sendJson(res, 200, {
          ok: true,
          conversations: this.listOpenConversations()
        });
        return;
      }

      if (method === "GET" && url.pathname === "/conversations/current") {
        sendJson(res, 200, {
          ok: true,
          conversation: this.getCurrentConversation()
        });
        return;
      }

      if (method === "GET" && url.pathname === "/jobs") {
        sendJson(res, 200, {
          ok: true,
          jobs: this.listJobs()
        });
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const job = this.getJob(jobId);
        if (!job) {
          sendJson(res, 404, { ok: false, error: "Job not found." });
          return;
        }
        sendJson(res, 200, { ok: true, job });
        return;
      }

      if (method === "POST" && url.pathname === "/conversations") {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, ...(await this.createConversation(body)) });
        return;
      }

      if (
        method === "POST" &&
        url.pathname === "/conversations/current/messages"
      ) {
        const current = this.getCurrentConversation();
        if (!current) {
          sendJson(res, 404, {
            ok: false,
            error: "No active Codex conversation tab is focused."
          });
          return;
        }
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          ...(await this.continueConversation(current.conversationId, body))
        });
        return;
      }

      const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
      if (method === "POST" && match) {
        const conversationId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req);
        sendJson(res, 200, {
          ok: true,
          ...(await this.continueConversation(conversationId, body))
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Route not found" });
    } catch (error) {
      this.log(
        `HTTP ${requestId} ${method} ${url.pathname} failed: ${formatError(error)}`
      );
      sendJson(res, 500, { ok: false, error: formatError(error) });
    } finally {
      this.log(
        `HTTP ${requestId} ${method} ${url.pathname} ${Date.now() - startedAt}ms`
      );
    }
  }

  listOpenConversations() {
    const activeTab = getActiveTab();
    const byId = new Map();

    vscode.window.tabGroups.all.forEach((group, groupIndex) => {
      group.tabs.forEach((tab, tabIndex) => {
        const parsed = parseConversationTab(tab);
        if (!parsed) {
          return;
        }

        const item = {
          conversationId: parsed.conversationId,
          title: tab.label,
          isActive: activeTab === tab,
          viewColumn: group.viewColumn,
          groupIndex,
          tabIndex,
          uri: parsed.uri.toString()
        };

        if (!byId.has(item.conversationId) || item.isActive) {
          byId.set(item.conversationId, item);
        }
      });
    });

    return Array.from(byId.values());
  }

  getCurrentConversation() {
    const activeTab = getActiveTab();
    const parsed = parseConversationTab(activeTab);
    return parsed
      ? {
          conversationId: parsed.conversationId,
          title: activeTab.label,
          uri: parsed.uri.toString()
        }
      : null;
  }

  findOpenConversation(conversationId) {
    return this.listOpenConversations().find(
      (item) => item.conversationId === conversationId
    );
  }

  getJobSummary() {
    const jobs = Array.from(this.jobs.values());
    const summary = {
      total: jobs.length,
      starting: 0,
      running: 0,
      completed: 0,
      failed: 0,
      latestJobId: this.jobOrder.length > 0 ? this.jobOrder[this.jobOrder.length - 1] : null
    };

    jobs.forEach((job) => {
      if (job.status === "starting") {
        summary.starting += 1;
      } else if (job.status === "running") {
        summary.running += 1;
      } else if (job.status === "completed") {
        summary.completed += 1;
      } else if (job.status === "failed") {
        summary.failed += 1;
      }
    });

    return summary;
  }

  listJobs() {
    return this.jobOrder
      .slice()
      .reverse()
      .map((jobId) => this.jobs.get(jobId))
      .filter(Boolean)
      .map((job) => cloneJob(job));
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  createJob(details) {
    const now = new Date().toISOString();
    const job = {
      jobId: crypto.randomUUID(),
      status: "starting",
      operation: details.operation,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      pid: null,
      cwd: details.cwd || null,
      message: details.message || null,
      conversationId: details.conversationId || null,
      openRequested:
        details.openRequested === undefined ? null : Boolean(details.openRequested),
      opened: null,
      openError: null,
      eventCount: 0,
      lastEventAt: null,
      lastEventType: null,
      lastEvent: null,
      lastStderr: null,
      exitCode: null,
      signal: null,
      error: null
    };

    this.jobs.set(job.jobId, job);
    this.jobOrder.push(job.jobId);
    this.pruneJobs();
    return job;
  }

  pruneJobs() {
    while (this.jobOrder.length > MAX_JOB_HISTORY) {
      const oldest = this.jobOrder.shift();
      if (!oldest) {
        continue;
      }
      this.jobs.delete(oldest);
    }
  }

  updateJob(job, patch) {
    if (!job) {
      return;
    }

    Object.assign(job, patch, {
      updatedAt: new Date().toISOString()
    });
  }

  recordJobEvent(job, event) {
    if (!job || !event || typeof event !== "object") {
      return;
    }

    const eventType = typeof event.type === "string" ? event.type : null;
    this.updateJob(job, {
      eventCount: job.eventCount + 1,
      lastEventAt: new Date().toISOString(),
      lastEventType: eventType,
      lastEvent: summarizeJobEvent(event)
    });
  }

  applyOpenResultToJob(job, openResult) {
    if (!job) {
      return;
    }

    this.updateJob(job, {
      openRequested: true,
      opened: openResult.opened,
      openError: openResult.openError
    });
  }

  async getAppServerClient(timeoutMs) {
    if (!this.appServerClient) {
      this.appServerClient = new CodexAppServerClient({
        log: (message) => this.log(message),
        onNotification: (notification) => this.handleAppServerNotification(notification),
        onExit: (error) => this.handleAppServerExit(error)
      });
    }

    try {
      await this.appServerClient.ensureStarted(timeoutMs);
      return this.appServerClient;
    } catch (error) {
      this.disposeAppServerClient();
      throw error;
    }
  }

  disposeAppServerClient() {
    if (!this.appServerClient) {
      return;
    }

    try {
      this.appServerClient.dispose();
    } catch {}
    this.appServerClient = null;
    this.appServerJobsByTurnId.clear();
    this.appServerJobsByThreadId.clear();
  }

  resolveConversationAlias(conversationId) {
    let current = conversationId;
    const seen = new Set();

    while (this.conversationAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.conversationAliases.get(current);
    }

    return current;
  }

  setConversationAlias(fromConversationId, toConversationId) {
    if (
      !fromConversationId ||
      !toConversationId ||
      fromConversationId === toConversationId
    ) {
      return;
    }

    this.conversationAliases.set(fromConversationId, toConversationId);
  }

  registerAppServerTurnJob(job, details) {
    if (!job || !details || !details.turnId || !details.conversationId) {
      return;
    }

    const watcher = {
      jobId: job.jobId,
      turnId: details.turnId,
      conversationId: details.conversationId,
      outputLastMessagePath: details.outputLastMessagePath || null,
      lastFinalMessage: null
    };

    this.appServerJobsByTurnId.set(details.turnId, watcher);
    this.appServerJobsByThreadId.set(details.conversationId, watcher);
    this.updateJob(job, {
      pid: details.pid == null ? job.pid : details.pid,
      conversationId: details.conversationId,
      error: null
    });
  }

  clearAppServerTurnJob(watcher) {
    if (!watcher) {
      return;
    }

    this.appServerJobsByTurnId.delete(watcher.turnId);
    const current = this.appServerJobsByThreadId.get(watcher.conversationId);
    if (current && current.turnId === watcher.turnId) {
      this.appServerJobsByThreadId.delete(watcher.conversationId);
    }
  }

  findAppServerWatcher(notification) {
    if (!notification || typeof notification !== "object") {
      return null;
    }

    const params =
      notification.params && typeof notification.params === "object"
        ? notification.params
        : {};
    const turnId =
      params.turn && typeof params.turn.id === "string" ? params.turn.id : null;
    if (turnId && this.appServerJobsByTurnId.has(turnId)) {
      return this.appServerJobsByTurnId.get(turnId);
    }

    const conversationId = getAppServerConversationId(notification);
    if (conversationId && this.appServerJobsByThreadId.has(conversationId)) {
      return this.appServerJobsByThreadId.get(conversationId);
    }

    return null;
  }

  handleAppServerNotification(notification) {
    const watcher = this.findAppServerWatcher(notification);
    if (!watcher) {
      return;
    }

    const job = this.jobs.get(watcher.jobId);
    if (!job) {
      this.clearAppServerTurnJob(watcher);
      return;
    }

    const event = toJobEventFromAppServerNotification(notification);
    this.recordJobEvent(job, event);

    if (
      notification.method === "codex/event/agent_message" &&
      notification.params &&
      typeof notification.params.message === "string" &&
      notification.params.message
    ) {
      const phase = notification.params.phase;
      if (phase == null || phase === "final_answer") {
        watcher.lastFinalMessage = notification.params.message;
      }
    }

    if (notification.method === "turn/started") {
      this.updateJob(job, {
        status: "running",
        startedAt: job.startedAt || new Date().toISOString(),
        conversationId: watcher.conversationId,
        error: null
      });
      return;
    }

    if (notification.method !== "turn/completed") {
      return;
    }

    const turn =
      notification.params && notification.params.turn ? notification.params.turn : null;
    const completedAt = new Date().toISOString();
    const succeeded = turn && turn.status === "completed";
    this.updateJob(job, {
      status: succeeded ? "completed" : "failed",
      completedAt,
      conversationId: watcher.conversationId,
      error:
        succeeded || !turn || !turn.error || typeof turn.error.message !== "string"
          ? null
          : turn.error.message
    });
    this.writeJobLastMessage(watcher, job);
    this.clearAppServerTurnJob(watcher);
  }

  handleAppServerExit(error) {
    const message = formatError(error || new Error("Codex app-server stopped."));
    const watchers = Array.from(this.appServerJobsByTurnId.values());

    watchers.forEach((watcher) => {
      const job = this.jobs.get(watcher.jobId);
      if (!job || job.status === "completed" || job.status === "failed") {
        return;
      }
      this.updateJob(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message
      });
    });

    this.disposeAppServerClient();
  }

  writeJobLastMessage(watcher, job) {
    if (
      !watcher ||
      !watcher.outputLastMessagePath ||
      typeof watcher.lastFinalMessage !== "string"
    ) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(watcher.outputLastMessagePath), {
        recursive: true
      });
      fs.writeFileSync(
        watcher.outputLastMessagePath,
        watcher.lastFinalMessage,
        "utf8"
      );
      this.updateJob(job, {
        outputLastMessagePath: watcher.outputLastMessagePath
      });
    } catch (error) {
      const message = formatError(error);
      this.log(
        `Failed to write final assistant message to ${watcher.outputLastMessagePath}: ${message}`
      );
      this.updateJob(job, {
        outputLastMessagePath: watcher.outputLastMessagePath,
        outputLastMessageError: message
      });
    }
  }

  async createConversation(body) {
    const config = this.getConfig();
    const timeoutMs = normalizeTimeout(
      body.sendTimeoutMs || body.timeoutMs,
      config.requestTimeoutMs
    );

    if (!body.message) {
      await ensureCommandExists("chatgpt.newCodexPanel");
      await vscode.commands.executeCommand("chatgpt.newCodexPanel");
      return {
        conversationId: null,
        sent: false,
        draft: true,
        opened: true
      };
    }

    const message = requireNonEmptyString(body.message, "message");
    const cwd = resolveCodexCwd(body);
    const job = this.createJob({
      operation: "create_conversation",
      cwd,
      message,
      openRequested: true
    });
    const turn = await this.startNewConversation(body, timeoutMs, job, {
      message,
      cwd
    });
    const openResult = await this.tryRevealConversation(
      turn.conversationId,
      normalizeTimeout(body.openTimeoutMs, config.tabTimeoutMs)
    );
    this.applyOpenResultToJob(job, openResult);

    return {
      conversationId: turn.conversationId,
      sent: true,
      turn,
      job: this.getJob(job.jobId),
      jobUrl: `/jobs/${job.jobId}`,
      opened: openResult.opened,
      openError: openResult.openError,
      conversation: openResult.conversation
    };
  }

  async continueConversation(conversationId, body) {
    const config = this.getConfig();
    const ensureOpen =
      body.ensureOpen === undefined ? true : Boolean(body.ensureOpen);
    const timeoutMs = normalizeTimeout(
      body.sendTimeoutMs || body.timeoutMs,
      config.requestTimeoutMs
    );
    const message = requireNonEmptyString(body.message, "message");
    const cwd = resolveCodexCwd(body);
    const job = this.createJob({
      operation: "resume_conversation",
      cwd,
      message,
      conversationId,
      openRequested: ensureOpen
    });
    const turn = await this.startTurn(conversationId, body, timeoutMs, job, {
      message,
      cwd
    });
    const effectiveConversationId = turn.conversationId;
    let openResult = { opened: false, openError: null, conversation: null };
    if (ensureOpen) {
      openResult = await this.tryRevealConversation(
        effectiveConversationId,
        normalizeTimeout(body.openTimeoutMs, config.tabTimeoutMs)
      );
      this.applyOpenResultToJob(job, openResult);
    }

    const requestedConversationId =
      typeof turn.requestedConversationId === "string"
        ? turn.requestedConversationId
        : conversationId;
    const upgradedFromConversationId =
      typeof turn.upgradedFromConversationId === "string"
        ? turn.upgradedFromConversationId
        : null;

    return {
      conversationId: effectiveConversationId,
      sent: true,
      turn,
      job: this.getJob(job.jobId),
      jobUrl: `/jobs/${job.jobId}`,
      opened: openResult.opened,
      openError: openResult.openError,
      conversation: openResult.conversation,
      requestedConversationId,
      upgradedFromConversationId
    };
  }

  async openConversationIfNeeded(conversationId, timeoutMs) {
    const existing = this.findOpenConversation(conversationId);
    if (existing) {
      return existing;
    }

    return this.revealConversation(conversationId, timeoutMs);
  }

  async revealConversation(conversationId, timeoutMs) {
    const uri = buildConversationUri(conversationId);
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        "chatgpt.conversationEditor"
      );
    } catch {
      await vscode.commands.executeCommand("vscode.open", uri);
    }

    return waitFor(() => this.findOpenConversation(conversationId), timeoutMs, 100);
  }

  async tryRevealConversation(conversationId, timeoutMs) {
    try {
      return {
        opened: true,
        openError: null,
        conversation: await this.revealConversation(conversationId, timeoutMs)
      };
    } catch (error) {
      const message = formatError(error);
      this.log(
        `Failed to reveal Codex conversation ${conversationId}: ${message}`
      );
      return {
        opened: false,
        openError: message,
        conversation: null
      };
    }
  }

  async startNewConversation(body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    if (shouldUseAppServerTransport(body)) {
      return this.startNewConversationViaAppServer(body, timeoutMs, job, {
        message,
        cwd
      });
    }
    return this.startNewConversationViaCli(body, timeoutMs, job, {
      message,
      cwd
    });
  }

  async startNewConversationViaAppServer(body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    const client = await this.getAppServerClient(timeoutMs);
    const threadStart = await client.request(
      "thread/start",
      buildThreadStartParams(body, cwd),
      timeoutMs
    );
    const conversationId =
      threadStart && threadStart.thread && typeof threadStart.thread.id === "string"
        ? threadStart.thread.id
        : null;
    if (!conversationId) {
      throw new Error("Codex app-server did not return a conversation id.");
    }

    this.recordJobEvent(job, {
      type: "thread/started",
      thread_id: conversationId,
      status:
        threadStart.thread &&
        threadStart.thread.status &&
        typeof threadStart.thread.status.type === "string"
          ? threadStart.thread.status.type
          : null
    });

    const turnStart = await client.request(
      "turn/start",
      buildTurnStartParams(conversationId, body, cwd, message),
      timeoutMs
    );
    const turnId =
      turnStart && turnStart.turn && typeof turnStart.turn.id === "string"
        ? turnStart.turn.id
        : null;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }

    this.registerAppServerTurnJob(job, {
      pid: client.getPid(),
      conversationId,
      turnId,
      outputLastMessagePath: getResolvedOptionalPath(body.outputLastMessagePath, cwd)
    });
    this.updateJob(job, {
      status: "running",
      startedAt: job && job.startedAt ? job.startedAt : new Date().toISOString(),
      pid: client.getPid(),
      conversationId,
      error: null
    });

    return {
      transport: "app-server",
      status: "started",
      pid: client.getPid(),
      eventType: "thread/started",
      turnId,
      conversationId,
      message,
      jobId: job ? job.jobId : null
    };
  }

  async startNewConversationViaCli(body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    const args = buildNewConversationCliArgs(body, cwd);
    const start = await this.startCliRun({
      args,
      cwd,
      timeoutMs,
      job,
      resolveEvent: (event, context) => {
        if (
          event &&
          event.type === "thread.started" &&
          typeof event.thread_id === "string" &&
          event.thread_id
        ) {
          return {
            conversationId: event.thread_id,
            pid: context.pid,
            eventType: event.type
          };
        }
        return null;
      }
    });

    return {
      transport: "cli",
      status: "started",
      pid: start.pid,
      eventType: start.eventType,
      conversationId: start.conversationId,
      message,
      jobId: job ? job.jobId : null
    };
  }

  async startTurn(conversationId, body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    if (shouldUseAppServerTransport(body)) {
      return this.startTurnViaAppServer(conversationId, body, timeoutMs, job, {
        message,
        cwd
      });
    }
    return this.startTurnViaCli(conversationId, body, timeoutMs, job, {
      message,
      cwd
    });
  }

  async startTurnViaAppServer(conversationId, body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    const client = await this.getAppServerClient(timeoutMs);
    const requestedConversationId = conversationId;
    const resolvedConversationId = this.resolveConversationAlias(conversationId);
    let actualConversationId = resolvedConversationId;
    let upgradedFromConversationId = null;

    if (shouldUpgradeLegacyExecConversation(body)) {
      const summary = await getConversationSummarySafe(
        client,
        actualConversationId,
        timeoutMs
      );
      if (summary && summary.source === "exec") {
        const forked = await client.request(
          "thread/fork",
          buildThreadForkParams(actualConversationId, body, cwd),
          timeoutMs
        );
        actualConversationId =
          forked && forked.thread && typeof forked.thread.id === "string"
            ? forked.thread.id
            : null;
        if (!actualConversationId) {
          throw new Error(
            "Codex app-server did not return a conversation id for the upgraded thread."
          );
        }
        upgradedFromConversationId = requestedConversationId;
        this.setConversationAlias(requestedConversationId, actualConversationId);
        this.recordJobEvent(job, {
          type: "thread/started",
          thread_id: actualConversationId,
          conversation_id: requestedConversationId
        });
      } else {
        await client.request(
          "thread/resume",
          buildThreadResumeParams(actualConversationId, body, cwd),
          timeoutMs
        );
      }
    } else {
      await client.request(
        "thread/resume",
        buildThreadResumeParams(actualConversationId, body, cwd),
        timeoutMs
      );
    }

    const turnStart = await client.request(
      "turn/start",
      buildTurnStartParams(actualConversationId, body, cwd, message),
      timeoutMs
    );
    const turnId =
      turnStart && turnStart.turn && typeof turnStart.turn.id === "string"
        ? turnStart.turn.id
        : null;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id.");
    }

    this.registerAppServerTurnJob(job, {
      pid: client.getPid(),
      conversationId: actualConversationId,
      turnId,
      outputLastMessagePath: getResolvedOptionalPath(body.outputLastMessagePath, cwd)
    });
    this.updateJob(job, {
      status: "running",
      startedAt: job && job.startedAt ? job.startedAt : new Date().toISOString(),
      pid: client.getPid(),
      conversationId: actualConversationId,
      error: null
    });

    return {
      transport: "app-server",
      status: "started",
      pid: client.getPid(),
      eventType: upgradedFromConversationId ? "thread/started" : "turn/started",
      turnId,
      conversationId: actualConversationId,
      requestedConversationId,
      upgradedFromConversationId,
      message,
      jobId: job ? job.jobId : null
    };
  }

  async startTurnViaCli(conversationId, body, timeoutMs, job, context = {}) {
    const message =
      context.message || requireNonEmptyString(body.message, "message");
    const cwd = context.cwd || resolveCodexCwd(body);
    const args = buildResumeConversationCliArgs(conversationId, body, cwd);
    const start = await this.startCliRun({
      args,
      cwd,
      timeoutMs,
      job,
      resolveEvent: (event, context) => {
        if (event && (event.type === "turn.started" || event.type === "thread.started")) {
          return {
            conversationId,
            pid: context.pid,
            eventType: event.type
          };
        }
        return null;
      }
    });

    return {
      transport: "cli",
      status: "started",
      pid: start.pid,
      eventType: start.eventType,
      conversationId,
      message,
      jobId: job ? job.jobId : null
    };
  }

  async startCliRun({ args, cwd, timeoutMs, job, resolveEvent }) {
    const executable = getCodexExecutablePath();
    const child = childProcess.spawn(executable, args, {
      cwd,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to start Codex CLI stdio pipes.");
    }

    this.runningCliProcesses.add(child);
    const stdoutLines = readline.createInterface({ input: child.stdout });
    const stderrLines = readline.createInterface({ input: child.stderr });
    const commandLabel = `${path.basename(executable)} ${args.join(" ")}`.trim();
    const pid = startablePid(child);
    const processLabel = pid == null ? commandLabel : `[pid:${pid}] ${commandLabel}`;

    this.log(`Starting Codex CLI: ${processLabel}`);
    this.updateJob(job, {
      pid,
      error: null
    });

    return await new Promise((resolve, reject) => {
      let settled = false;
      let lastError = null;
      const timer = setTimeout(() => {
        fail(new Error(`Timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.runningCliProcesses.delete(child);
        stdoutLines.removeAllListeners();
        stderrLines.removeAllListeners();
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
      };

      const maybeResolve = (value) => {
        if (settled || !value) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.updateJob(job, {
          status: "running",
          startedAt: job && job.startedAt ? job.startedAt : new Date().toISOString(),
          pid: value.pid == null ? startablePid(child) : value.pid,
          conversationId:
            value.conversationId === undefined
              ? job ? job.conversationId : null
              : value.conversationId,
          error: null
        });
        if (typeof child.unref === "function") {
          child.unref();
        }
        resolve({
          ...value,
          pid: value.pid == null ? startablePid(child) : value.pid
        });
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.updateJob(job, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: formatError(error)
        });
        cleanup();
        try {
          if (!child.killed) {
            child.kill();
          }
        } catch {}
        reject(error);
      };

      const onError = (error) => {
        lastError = error;
        this.log(`Codex CLI error (${processLabel}): ${formatError(error)}`);
        if (settled) {
          this.updateJob(job, {
            status: "failed",
            completedAt: new Date().toISOString(),
            error: formatError(error)
          });
        }
        fail(error);
      };

      const onExit = (code, signal) => {
        const detail =
          signal != null ? `signal ${signal}` : `exit code ${code == null ? "unknown" : code}`;
        this.log(`Codex CLI exited (${processLabel}): ${detail}`);
        if (settled) {
          this.updateJob(job, {
            status: code === 0 ? "completed" : "failed",
            completedAt: new Date().toISOString(),
            exitCode: code == null ? null : code,
            signal: signal == null ? null : signal,
            error:
              code === 0
                ? job ? job.error : null
                : formatError(lastError || new Error(`Codex CLI exited (${detail}).`))
          });
        }
        if (!settled) {
          fail(lastError || new Error(`Codex CLI exited before reporting startup (${detail}).`));
        }
      };

      const onClose = () => {
        cleanup();
      };

      stdoutLines.on("line", (line) => {
        const trimmed = String(line).trim();
        if (!trimmed) {
          return;
        }
        this.log(`Codex CLI stdout (${processLabel}): ${trimmed}`);
        const event = parseJsonLine(trimmed);
        if (event && event.type === "error" && typeof event.message === "string") {
          lastError = new Error(event.message);
        }
        this.recordJobEvent(job, event);
        maybeResolve(resolveEvent(event, { child, pid }));
      });

      stderrLines.on("line", (line) => {
        const trimmed = String(line).trim();
        if (!trimmed) {
          return;
        }
        this.log(`Codex CLI stderr (${processLabel}): ${trimmed}`);
        lastError = new Error(trimmed);
        this.updateJob(job, {
          lastStderr: truncateString(trimmed, 1000)
        });
      });

      child.once("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
    });
  }
}

class CodexAppServerClient {
  constructor(options = {}) {
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.onNotification =
      typeof options.onNotification === "function"
        ? options.onNotification
        : () => {};
    this.onExit =
      typeof options.onExit === "function" ? options.onExit : () => {};
    this.child = null;
    this.socket = null;
    this.socketUrl = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.startPromise = null;
    this.disposed = false;
    this.shuttingDown = false;
  }

  getPid() {
    return this.child ? startablePid(this.child) : null;
  }

  isStarted() {
    return Boolean(
      this.child &&
        this.socket &&
        this.socket.readyState === getWebSocketOpenState()
    );
  }

  async ensureStarted(timeoutMs) {
    if (this.isStarted()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart(timeoutMs);
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async doStart(timeoutMs) {
    const port = await reserveEphemeralPort();
    const url = `ws://127.0.0.1:${port}`;
    const executable = getCodexExecutablePath();
    const child = childProcess.spawn(
      executable,
      ["app-server", "--listen", url],
      {
        env: { ...process.env },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );

    this.child = child;
    this.socketUrl = url;
    this.shuttingDown = false;
    this.attachChildListeners(child);

    if (child.stderr) {
      const stderrLines = readline.createInterface({ input: child.stderr });
      stderrLines.on("line", (line) => {
        const trimmed = String(line).trim();
        if (trimmed) {
          this.log(`Codex app-server stderr: ${trimmed}`);
        }
      });
    }

    this.log(
      `Starting Codex app-server on ${url} via ${path.basename(executable)}.`
    );
    this.socket = await connectWebSocketWithRetry(url, timeoutMs);
    this.attachSocketListeners(this.socket);
    await this.request(
      "initialize",
      {
        clientInfo: {
          name: "codex-bridge",
          title: "Codex Bridge",
          version: "0.0.1"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      timeoutMs,
      { skipEnsureStarted: true }
    );
  }

  attachChildListeners(child) {
    child.once("exit", (code, signal) => {
      const message =
        signal != null
          ? `Codex app-server exited with signal ${signal}.`
          : `Codex app-server exited with code ${code == null ? "unknown" : code}.`;
      this.log(message);
      if (!this.shuttingDown && !this.disposed) {
        this.failAllPending(new Error(message));
        this.onExit(new Error(message));
      }
    });

    child.once("error", (error) => {
      const wrapped = new Error(
        `Codex app-server process error: ${formatError(error)}`
      );
      this.log(wrapped.message);
      if (!this.shuttingDown && !this.disposed) {
        this.failAllPending(wrapped);
        this.onExit(wrapped);
      }
    });
  }

  attachSocketListeners(socket) {
    socket.addEventListener("message", async (event) => {
      try {
        const text = await readWebSocketMessageText(event.data);
        const message = JSON.parse(text);
        this.handleSocketMessage(message);
      } catch (error) {
        this.log(
          `Failed to process Codex app-server message: ${formatError(error)}`
        );
      }
    });

    socket.addEventListener("close", () => {
      if (!this.shuttingDown && !this.disposed) {
        const error = new Error("Codex app-server connection closed.");
        this.failAllPending(error);
        this.onExit(error);
      }
    });

    socket.addEventListener("error", () => {
      if (!this.shuttingDown && !this.disposed) {
        const error = new Error("Codex app-server connection error.");
        this.failAllPending(error);
        this.onExit(error);
      }
    });
  }

  handleSocketMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message || JSON.stringify(message.error, null, 2)
          )
        );
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message && typeof message.method === "string") {
      this.onNotification(message);
    }
  }

  async request(method, params, timeoutMs, options = {}) {
    if (!options.skipEnsureStarted) {
      await this.ensureStarted(timeoutMs);
    }
    if (!this.socket || this.socket.readyState !== getWebSocketOpenState()) {
      throw new Error("Codex app-server is not connected.");
    }

    const id = String(this.nextRequestId++);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  failAllPending(error) {
    const pendingEntries = Array.from(this.pending.values());
    this.pending.clear();
    pendingEntries.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });
  }

  dispose() {
    this.disposed = true;
    this.shuttingDown = true;
    this.failAllPending(new Error("Codex app-server disposed."));
    if (this.socket) {
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
  }
}

class CodexIpcClient {
  constructor(options = {}) {
    this.clientType = options.clientType || "automation";
    this.output = options.output || null;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.clientId = UNINITIALIZED_CLIENT_ID;
    this.pending = new Map();
    this.disposed = false;
  }

  async connect(timeoutMs) {
    if (this.socket) {
      return;
    }

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(getCodexPipePath());
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("ipc-connect-timeout"));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onInitialError);
      };

      const onConnect = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.attachSocket(socket);
        resolve();
      };

      const onInitialError = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      socket.once("connect", onConnect);
      socket.once("error", onInitialError);
    });

    const initResponse = await this.sendRequestRaw(
      "initialize",
      { clientType: this.clientType },
      { allowUninitialized: true, timeoutMs }
    );

    if (initResponse.resultType !== "success" || !initResponse.result?.clientId) {
      throw new Error(
        initResponse.error || "Codex IPC initialize request did not succeed."
      );
    }

    this.clientId = initResponse.result.clientId;
  }

  attachSocket(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.rejectAll(error));
    socket.on("close", () => this.rejectAll(new Error("connection-closed")));
  }

  handleData(chunk) {
    if (chunk.length === 0) {
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) {
          return;
        }
        this.expectedLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
      }

      if (this.expectedLength === null || this.buffer.length < this.expectedLength) {
        return;
      }

      const frame = this.buffer.subarray(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;

      let message;
      try {
        message = JSON.parse(frame.toString("utf8"));
      } catch (error) {
        this.rejectAll(error);
        return;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case "response": {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      case "client-discovery-request":
        this.writeFrame({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: { canHandle: false }
        });
        return;
      case "request":
        this.writeFrame({
          type: "response",
          requestId: message.requestId,
          resultType: "error",
          error: "no-handler-for-request"
        });
        return;
      default:
        return;
    }
  }

  async request(method, params, options = {}) {
    const response = await this.sendRequestRaw(method, params, options);
    if (response.resultType !== "success") {
      throw new Error(response.error || `IPC request failed for ${method}`);
    }
    return response.result;
  }

  async sendRequestRaw(method, params, options = {}) {
    const timeoutMs = normalizeTimeout(
      options.timeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    if (!this.socket || !this.socket.writable) {
      throw new Error("not-connected");
    }
    if (!options.allowUninitialized && this.clientId === UNINITIALIZED_CLIENT_ID) {
      throw new Error("not-initialized");
    }

    const requestId = crypto.randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: options.allowUninitialized
        ? UNINITIALIZED_CLIENT_ID
        : this.clientId,
      version: getIpcMethodVersion(method),
      method,
      params
    };
    if (options.targetClientId) {
      message.targetClientId = options.targetClientId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("request-timeout"));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });

      try {
        this.writeFrame(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  writeFrame(message) {
    if (!this.socket || !this.socket.writable) {
      throw new Error("not-connected");
    }

    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
  }

  rejectAll(error) {
    const pendingValues = Array.from(this.pending.values());
    this.pending.clear();
    this.socket = null;
    pendingValues.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  }

  dispose() {
    const socket = this.socket;
    this.disposed = true;
    this.rejectAll(new Error("disposed"));
    if (socket) {
      socket.destroy();
    }
  }
}

async function sendCodexIpcRequest(method, params, options = {}) {
  const client = new CodexIpcClient({
    clientType: "automation",
    output: options.output
  });

  try {
    await client.connect(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    return await client.request(method, params, options);
  } finally {
    client.dispose();
  }
}

function getWebSocketConstructor() {
  const WebSocketImpl = globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") {
    throw new Error(
      "WebSocket is not available in this VS Code runtime for the Codex app-server transport."
    );
  }
  return WebSocketImpl;
}

function getWebSocketOpenState() {
  const WebSocketImpl = globalThis.WebSocket;
  return WebSocketImpl && Number.isInteger(WebSocketImpl.OPEN)
    ? WebSocketImpl.OPEN
    : 1;
}

async function connectWebSocketWithRetry(url, timeoutMs) {
  const WebSocketImpl = getWebSocketConstructor();
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const socket = await openWebSocket(url, WebSocketImpl, timeoutMs);
      return socket;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError || new Error(`Timed out connecting to ${url}.`);
}

function openWebSocket(url, WebSocketImpl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => {
      cleanup();
      try {
        socket.close();
      } catch {}
      reject(new Error(`Timed out connecting to ${url}.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (typeof socket.removeEventListener === "function") {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
      }
    };

    const onOpen = () => {
      cleanup();
      resolve(socket);
    };

    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket connection error for ${url}.`));
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function readWebSocketMessageText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data && typeof data.text === "function") {
    return await data.text();
  }
  if (data && typeof data.arrayBuffer === "function") {
    const buffer = Buffer.from(await data.arrayBuffer());
    return buffer.toString("utf8");
  }
  return String(data);
}

function reserveEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to reserve an app-server port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

function shouldUseAppServerTransport(body) {
  return !hasAppServerUnsupportedOptions(body);
}

function hasAppServerUnsupportedOptions(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  return Boolean(
    body.search ||
      body.oss ||
      getOptionalString(body.localProvider) ||
      getOptionalString(body.profile) ||
      getOptionalString(body.color) ||
      body.progressCursor ||
      normalizeStringArray(body.addDirs).length > 0 ||
      normalizeStringArray(body.enableFeatures).length > 0 ||
      normalizeStringArray(body.disableFeatures).length > 0 ||
      Array.isArray(body.config) ||
      (body.config != null &&
        (typeof body.config !== "object" || Array.isArray(body.config)))
  );
}

function shouldUpgradeLegacyExecConversation(body) {
  if (body && body.upgradeLegacyExecConversations === false) {
    return false;
  }
  return true;
}

function buildThreadStartParams(body, cwd) {
  return {
    cwd,
    approvalPolicy: getRequestedApprovalPolicy(body),
    sandbox: getRequestedSandboxMode(body),
    model: getOptionalString(body.model),
    serviceTier: normalizeServiceTier(body.serviceTier),
    config: normalizeAppServerConfig(body.config),
    baseInstructions: getOptionalString(body.baseInstructions),
    developerInstructions: getOptionalString(body.developerInstructions),
    personality: normalizePersonality(body.personality),
    ephemeral: body.ephemeral === undefined ? null : Boolean(body.ephemeral),
    persistExtendedHistory: true,
    experimentalRawEvents: false
  };
}

function buildThreadResumeParams(conversationId, body, cwd) {
  return {
    threadId: requireNonEmptyString(conversationId, "conversationId"),
    cwd,
    approvalPolicy: getRequestedApprovalPolicy(body),
    sandbox: getRequestedSandboxMode(body),
    model: getOptionalString(body.model),
    serviceTier: normalizeServiceTier(body.serviceTier),
    config: normalizeAppServerConfig(body.config),
    baseInstructions: getOptionalString(body.baseInstructions),
    developerInstructions: getOptionalString(body.developerInstructions),
    personality: normalizePersonality(body.personality),
    persistExtendedHistory: true
  };
}

function buildThreadForkParams(conversationId, body, cwd) {
  return {
    threadId: requireNonEmptyString(conversationId, "conversationId"),
    cwd,
    approvalPolicy: getRequestedApprovalPolicy(body),
    sandbox: getRequestedSandboxMode(body),
    model: getOptionalString(body.model),
    serviceTier: normalizeServiceTier(body.serviceTier),
    config: normalizeAppServerConfig(body.config),
    baseInstructions: getOptionalString(body.baseInstructions),
    developerInstructions: getOptionalString(body.developerInstructions),
    persistExtendedHistory: true
  };
}

function buildTurnStartParams(conversationId, body, cwd, message) {
  const params = {
    threadId: requireNonEmptyString(conversationId, "conversationId"),
    input: buildTurnInput(body, cwd, message)
  };

  const approvalPolicy = getRequestedApprovalPolicy(body);
  if (approvalPolicy) {
    params.approvalPolicy = approvalPolicy;
  }

  const sandboxPolicy = buildTurnSandboxPolicy(body, cwd);
  if (sandboxPolicy) {
    params.sandboxPolicy = sandboxPolicy;
  }

  const model = getOptionalString(body.model);
  if (model) {
    params.model = model;
  }

  const serviceTier = normalizeServiceTier(body.serviceTier);
  if (serviceTier) {
    params.serviceTier = serviceTier;
  }

  const personality = normalizePersonality(body.personality);
  if (personality) {
    params.personality = personality;
  }

  const outputSchemaPath = getResolvedOptionalPath(body.outputSchemaPath, cwd);
  if (outputSchemaPath) {
    params.outputSchema = readJsonFile(outputSchemaPath);
  }

  return params;
}

function buildTurnInput(body, cwd, message) {
  const input = [
    {
      type: "text",
      text: message
    }
  ];

  normalizeStringArray(body.images).forEach((imagePath) => {
    input.push({
      type: "localImage",
      path: resolveUserPath(imagePath, cwd)
    });
  });

  return input;
}

function buildTurnSandboxPolicy(body, cwd) {
  const sandbox = getRequestedSandboxMode(body);
  if (!sandbox) {
    return null;
  }

  switch (sandbox) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return {
        type: "workspaceWrite",
        writableRoots: [cwd],
        readOnlyAccess: { type: "fullAccess" },
        networkAccess: false
      };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return null;
  }
}

function getRequestedApprovalPolicy(body) {
  const direct = normalizeCliApprovalPolicy(body.approvalPolicy);
  if (direct) {
    return direct;
  }
  if (body.dangerouslyBypassApprovalsAndSandbox) {
    return "never";
  }
  if (body.fullAuto) {
    return "on-request";
  }
  return null;
}

function getRequestedSandboxMode(body) {
  const direct = normalizeCliSandboxMode(body.sandbox);
  if (direct) {
    return direct;
  }
  if (body.dangerouslyBypassApprovalsAndSandbox) {
    return "danger-full-access";
  }
  if (body.fullAuto) {
    return "workspace-write";
  }
  return null;
}

function normalizeServiceTier(value) {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return null;
  }

  switch (normalized.toLowerCase()) {
    case "fast":
    case "flex":
      return normalized.toLowerCase();
    default:
      throw new Error(
        `Unsupported serviceTier "${value}". Expected one of: fast, flex.`
      );
  }
}

function normalizePersonality(value) {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return null;
  }

  switch (normalized.toLowerCase()) {
    case "none":
    case "friendly":
    case "pragmatic":
      return normalized.toLowerCase();
    default:
      throw new Error(
        `Unsupported personality "${value}". Expected one of: none, friendly, pragmatic.`
      );
  }
}

function normalizeAppServerConfig(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  throw new Error(
    '"config" must be an object when using the Codex app-server transport.'
  );
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read JSON file at ${filePath}: ${formatError(error)}`
    );
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON file at ${filePath}: ${formatError(error)}`
    );
  }
}

async function getConversationSummarySafe(client, conversationId, timeoutMs) {
  try {
    const response = await client.request(
      "getConversationSummary",
      { conversationId },
      timeoutMs
    );
    return response && response.summary ? response.summary : null;
  } catch {
    return null;
  }
}

function toJobEventFromAppServerNotification(notification) {
  const event = {
    type: notification && typeof notification.method === "string"
      ? notification.method
      : "app-server-notification"
  };
  const conversationId = getAppServerConversationId(notification);
  if (conversationId) {
    event.thread_id = conversationId;
    event.conversation_id = conversationId;
  }

  const params =
    notification && notification.params && typeof notification.params === "object"
      ? notification.params
      : {};
  if (params.turn && typeof params.turn.id === "string") {
    event.turn_id = params.turn.id;
  }
  if (typeof params.turn_id === "string" && params.turn_id) {
    event.turn_id = params.turn_id;
  }
  if (params.turn && typeof params.turn.status === "string") {
    event.status = params.turn.status;
  }
  if (typeof params.status === "string" && params.status) {
    event.status = params.status;
  }
  if (typeof params.message === "string" && params.message) {
    event.message = params.message;
  }

  return event;
}

function getAppServerConversationId(notification) {
  if (!notification || typeof notification !== "object") {
    return null;
  }

  const params =
    notification.params && typeof notification.params === "object"
      ? notification.params
      : {};
  if (typeof params.threadId === "string" && params.threadId) {
    return params.threadId;
  }
  if (typeof params.thread_id === "string" && params.thread_id) {
    return params.thread_id;
  }
  if (params.thread && typeof params.thread.id === "string" && params.thread.id) {
    return params.thread.id;
  }
  if (
    params.conversationId &&
    typeof params.conversationId === "string" &&
    params.conversationId
  ) {
    return params.conversationId;
  }
  if (
    params.conversation_id &&
    typeof params.conversation_id === "string" &&
    params.conversation_id
  ) {
    return params.conversation_id;
  }
  return null;
}

function buildConversationUri(conversationId) {
  return vscode.Uri.from({
    scheme: CODEX_SCHEME,
    authority: CODEX_AUTHORITY,
    path: `/local/${conversationId}`
  });
}

function parseConversationTab(tab) {
  if (!tab || !tab.input || !tab.input.uri) {
    return null;
  }

  const uri = tab.input.uri;
  if (uri.scheme !== CODEX_SCHEME || uri.authority !== CODEX_AUTHORITY) {
    return null;
  }

  const segments = uri.path.replace(/^\/+/, "").split("/");
  if (segments.length < 2 || (segments[0] !== "local" && segments[0] !== "remote")) {
    return null;
  }

  return { conversationId: segments[1], uri };
}

function getActiveTab() {
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  return activeGroup ? activeGroup.activeTab : null;
}

function getCodexPipePath() {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\codex-ipc";
  }

  const directory = path.join(os.tmpdir(), "codex-ipc");
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return path.join(directory, uid ? `ipc-${uid}.sock` : "ipc.sock");
}

function getIpcMethodVersion(method) {
  return IPC_METHOD_VERSIONS[method] || 0;
}

async function ensureCommandExists(commandId) {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(commandId)) {
    throw new Error(
      `Required VS Code command "${commandId}" is not available. Make sure the OpenAI ChatGPT/Codex extension is installed and enabled.`
    );
  }
}

function shouldRetryCodexError(error) {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("no-client-found") ||
    message.includes("request-timeout") ||
    message.includes("thread-role-timeout") ||
    message.includes("thread-follower-start-turn-timeout") ||
    message.includes("connection-closed") ||
    message.includes("not-connected") ||
    message.includes("not-initialized") ||
    message.includes("connect") ||
    message.includes("enoent") ||
    message.includes("econnrefused")
  );
}

function resolveCodexCwd(body) {
  const requested = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const workspaceRoot = getPrimaryWorkspaceRoot();
  const base = workspaceRoot || process.cwd();
  const candidate = requested
    ? path.resolve(base, requested)
    : base;

  let stats;
  try {
    stats = fs.statSync(candidate);
  } catch (error) {
    throw new Error(
      `Codex working directory does not exist: ${candidate} (${formatError(error)})`
    );
  }

  if (!stats.isDirectory()) {
    throw new Error(`Codex working directory is not a directory: ${candidate}`);
  }

  return candidate;
}

function getPrimaryWorkspaceRoot() {
  const folders = Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders
    : [];
  const folder = folders.find(
    (item) => item && item.uri && item.uri.scheme === "file" && item.uri.fsPath
  );
  return folder ? folder.uri.fsPath : null;
}

function buildNewConversationCliArgs(body, cwd) {
  const args = buildCliPreludeArgs(body, cwd);
  args.push("exec", "--json", "--skip-git-repo-check");
  appendExecOnlyCliArgs(args, body, cwd);
  args.push(requireNonEmptyString(body.message, "message"));
  return args;
}

function buildResumeConversationCliArgs(conversationId, body, cwd) {
  const args = buildCliPreludeArgs(body, cwd);
  args.push("exec", "resume", "--json", "--all", "--skip-git-repo-check");
  appendResumeOnlyCliArgs(args, body, cwd);
  args.push(requireNonEmptyString(conversationId, "conversationId"));
  args.push(requireNonEmptyString(body.message, "message"));
  return args;
}

function buildCliPreludeArgs(body, cwd) {
  const args = [];

  if (cwd) {
    args.push("-C", cwd);
  }

  if (body.fullAuto) {
    args.push("--full-auto");
  }

  const approvalPolicy = normalizeCliApprovalPolicy(body.approvalPolicy);
  if (approvalPolicy) {
    args.push("-a", approvalPolicy);
  }

  const sandboxMode = normalizeCliSandboxMode(body.sandbox);
  if (sandboxMode) {
    args.push("-s", sandboxMode);
  }

  const model = getOptionalString(body.model);
  if (model) {
    args.push("-m", model);
  }

  const profile = getOptionalString(body.profile);
  if (profile) {
    args.push("-p", profile);
  }

  if (body.search) {
    args.push("--search");
  }

  if (body.oss) {
    args.push("--oss");
  }

  const localProvider = getOptionalString(body.localProvider);
  if (localProvider) {
    args.push("--local-provider", localProvider);
  }

  appendConfigArgs(args, body.config);
  appendFeatureArgs(args, "--enable", body.enableFeatures);
  appendFeatureArgs(args, "--disable", body.disableFeatures);

  return args;
}

function appendExecOnlyCliArgs(args, body, cwd) {
  if (body.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (body.ephemeral) {
    args.push("--ephemeral");
  }

  if (body.progressCursor) {
    args.push("--progress-cursor");
  }

  appendPathArgs(args, "--image", body.images, cwd);
  appendPathArgs(args, "--add-dir", body.addDirs, cwd);

  const color = normalizeCliColor(body.color);
  if (color) {
    args.push("--color", color);
  }

  const outputSchemaPath = getResolvedOptionalPath(body.outputSchemaPath, cwd);
  if (outputSchemaPath) {
    args.push("--output-schema", outputSchemaPath);
  }

  const outputLastMessagePath = getResolvedOptionalPath(
    body.outputLastMessagePath,
    cwd
  );
  if (outputLastMessagePath) {
    args.push("-o", outputLastMessagePath);
  }
}

function appendResumeOnlyCliArgs(args, body, cwd) {
  if (body.dangerouslyBypassApprovalsAndSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  if (body.ephemeral) {
    args.push("--ephemeral");
  }

  appendPathArgs(args, "--image", body.images, cwd);

  const outputLastMessagePath = getResolvedOptionalPath(
    body.outputLastMessagePath,
    cwd
  );
  if (outputLastMessagePath) {
    args.push("-o", outputLastMessagePath);
  }
}

function appendConfigArgs(args, configOverrides) {
  if (!configOverrides) {
    return;
  }

  if (Array.isArray(configOverrides)) {
    configOverrides
      .map((item) => getOptionalString(item))
      .filter(Boolean)
      .forEach((item) => {
        args.push("-c", item);
      });
    return;
  }

  if (typeof configOverrides === "object") {
    Object.entries(configOverrides).forEach(([key, value]) => {
      if (!key || value === undefined) {
        return;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        throw new Error(
          `Unsupported config override for "${key}". Use string array entries like "foo.bar=123" for object values.`
        );
      }
      args.push("-c", `${key}=${serializeCliConfigValue(value)}`);
    });
    return;
  }

  throw new Error('"config" must be an array of "key=value" strings or an object.');
}

function appendFeatureArgs(args, flag, values) {
  normalizeStringArray(values).forEach((value) => {
    args.push(flag, value);
  });
}

function appendPathArgs(args, flag, values, cwd) {
  normalizeStringArray(values).forEach((value) => {
    args.push(flag, resolveUserPath(value, cwd));
  });
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function getOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getResolvedOptionalPath(value, cwd) {
  const text = getOptionalString(value);
  return text ? resolveUserPath(text, cwd) : null;
}

function resolveUserPath(value, cwd) {
  return path.resolve(cwd || process.cwd(), value);
}

function serializeCliConfigValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (value == null) {
    return "null";
  }
  throw new Error(
    `Unsupported config override value type: ${typeof value}`
  );
}

function normalizeCliApprovalPolicy(value) {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return null;
  }

  switch (normalized.toLowerCase()) {
    case "untrusted":
      return "untrusted";
    case "on-failure":
    case "onfailure":
      return "on-failure";
    case "on-request":
    case "onrequest":
      return "on-request";
    case "never":
      return "never";
    default:
      throw new Error(
        `Unsupported approvalPolicy "${value}". Expected one of: untrusted, on-failure, on-request, never.`
      );
  }
}

function normalizeCliSandboxMode(value) {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return null;
  }

  switch (normalized.toLowerCase()) {
    case "read-only":
    case "readonly":
      return "read-only";
    case "workspace-write":
    case "workspace":
      return "workspace-write";
    case "danger-full-access":
    case "danger":
    case "full-access":
      return "danger-full-access";
    default:
      throw new Error(
        `Unsupported sandbox "${value}". Expected one of: read-only, workspace-write, danger-full-access.`
      );
  }
}

function normalizeCliColor(value) {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return null;
  }

  switch (normalized.toLowerCase()) {
    case "always":
    case "never":
    case "auto":
      return normalized.toLowerCase();
    default:
      throw new Error(
        `Unsupported color "${value}". Expected one of: auto, always, never.`
      );
  }
}

function getCodexExecutablePath() {
  const configured = getConfiguredCliExecutablePath();
  if (configured) {
    return configured;
  }

  const extensionPath = getOpenAiChatGptExtensionPath();
  if (extensionPath) {
    const bundled = findBundledCodexExecutable(extensionPath);
    if (bundled) {
      return bundled;
    }
  }

  const fallback = findBundledCodexExecutableInUserExtensions();
  if (fallback) {
    return fallback;
  }

  throw new Error(
    'Unable to locate the bundled Codex CLI. Install or enable the "openai.chatgpt" VS Code extension, or set the ChatGPT "cliExecutable" setting.'
  );
}

function getConfiguredCliExecutablePath() {
  const configured = getOptionalString(
    vscode.workspace.getConfiguration("chatgpt").get("cliExecutable", null)
  );
  if (!configured) {
    return null;
  }

  const resolved = path.resolve(configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Configured ChatGPT CLI executable does not exist: ${resolved}`
    );
  }

  return resolved;
}

function getOpenAiChatGptExtensionPath() {
  if (
    vscode.extensions &&
    typeof vscode.extensions.getExtension === "function"
  ) {
    const extension = vscode.extensions.getExtension("openai.chatgpt");
    if (extension && extension.extensionPath) {
      return extension.extensionPath;
    }
  }

  if (vscode.extensions && Array.isArray(vscode.extensions.all)) {
    const extension = vscode.extensions.all.find(
      (item) => item && item.id === "openai.chatgpt" && item.extensionPath
    );
    if (extension) {
      return extension.extensionPath;
    }
  }

  return null;
}

function findBundledCodexExecutableInUserExtensions() {
  const extensionsRoot = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return null;
  }

  const candidates = fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
    .map((entry) => path.join(extensionsRoot, entry.name))
    .sort((left, right) => {
      const leftMtime = safeStatMtime(left);
      const rightMtime = safeStatMtime(right);
      return rightMtime - leftMtime;
    });

  for (const candidate of candidates) {
    const executable = findBundledCodexExecutable(candidate);
    if (executable) {
      return executable;
    }
  }

  return null;
}

function safeStatMtime(targetPath) {
  try {
    return fs.statSync(targetPath).mtimeMs;
  } catch {
    return 0;
  }
}

function findBundledCodexExecutable(extensionPath) {
  const binRoot = path.join(extensionPath, "bin");
  if (!fs.existsSync(binRoot)) {
    return null;
  }

  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const stack = [binRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === executableName) {
        return fullPath;
      }
    }
  }

  return null;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function startablePid(child) {
  return child && typeof child.pid === "number" ? child.pid : null;
}

function summarizeJobEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const summary = {};
  [
    "type",
    "thread_id",
    "conversation_id",
    "turn_id",
    "status",
    "event"
  ].forEach((key) => {
    if (typeof event[key] === "string" && event[key]) {
      summary[key] = truncateString(event[key], 500);
    }
  });

  if (typeof event.message === "string" && event.message) {
    summary.message = truncateString(event.message, 500);
  }

  if (typeof event.delta === "string" && event.delta) {
    summary.delta = truncateString(event.delta, 160);
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

function cloneJob(job) {
  return job ? JSON.parse(JSON.stringify(job)) : null;
}

function truncateString(value, maxLength) {
  if (typeof value !== "string" || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isAuthorized(req, authToken) {
  if (!authToken) {
    return true;
  }

  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  if (authorization === `Bearer ${authToken}`) {
    return true;
  }

  const tokenHeader = req.headers["x-codex-bridge-token"];
  const directToken = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  return directToken === authToken;
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON body: ${formatError(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object.");
  }

  return parsed;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  res.end(body);
}

function normalizeTimeout(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return fallback;
  }
  return Math.floor(numberValue);
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${name}" must be a non-empty string.`);
  }
  return value.trim();
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(factory, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await factory();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

module.exports = { activate, deactivate };
