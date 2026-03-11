const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const { PassThrough } = require("node:stream");

const workspaceDir = process.cwd();
const testAssetsDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-bridge-smoke-")
);
const fakeExtensionDir = path.join(
  testAssetsDir,
  "openai.chatgpt-26.304.20706-win32-x64"
);
const fakeCliDir = path.join(fakeExtensionDir, "bin", "windows-x86_64");
const fakeCliPath = path.join(fakeCliDir, "codex.exe");

fs.mkdirSync(fakeCliDir, { recursive: true });
if (!fs.existsSync(fakeCliPath)) {
  fs.writeFileSync(fakeCliPath, "");
}

const config = {
  "codexBridge.autoStart": false,
  "codexBridge.host": "127.0.0.1",
  "codexBridge.port": 18765,
  "codexBridge.authToken": "",
  "codexBridge.requestTimeoutMs": 2000,
  "codexBridge.tabTimeoutMs": 2000,
  "chatgpt.cliExecutable": null
};

const infos = [];
const spawnCalls = [];
const activeTabGroup = { viewColumn: 1, tabs: [], activeTab: null };
let conversationCounter = 0;
let turnCounter = 0;
let nextPid = 1000;

function makeUri({ scheme, authority, path: uriPath, fsPath }) {
  return {
    scheme,
    authority,
    path: uriPath,
    fsPath,
    toString() {
      return `${scheme}://${authority}${uriPath}`;
    }
  };
}

function tabIdentity(tab) {
  if (!tab || !tab.input) {
    return "";
  }
  if (tab.input.uri && typeof tab.input.uri.toString === "function") {
    return tab.input.uri.toString();
  }
  return `draft:${tab.label}`;
}

function openConversationTab(uri, label = "Codex Task") {
  const identity = uri.toString();
  let tab = activeTabGroup.tabs.find(
    (candidate) => tabIdentity(candidate) === identity
  );

  if (!tab) {
    tab = {
      label,
      input: { uri }
    };
    activeTabGroup.tabs.push(tab);
  }

  activeTabGroup.activeTab = tab;
  return tab;
}

function openDraftTab() {
  const tab = {
    label: "New Codex Draft",
    input: {}
  };
  activeTabGroup.tabs.push(tab);
  activeTabGroup.activeTab = tab;
  return tab;
}

const fakeThreads = new Map();
let activeAppServerUrl = null;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function buildThreadRecord({
  id,
  source,
  preview,
  cwd = workspaceDir,
  createdAt = nowSeconds(),
  updatedAt = createdAt,
  turns = []
}) {
  return {
    id,
    preview,
    ephemeral: false,
    modelProvider: "openai",
    createdAt,
    updatedAt,
    status: { type: "idle" },
    path: path.join(testAssetsDir, `${id}.jsonl`),
    cwd,
    cliVersion: "0.108.0-alpha.12",
    source,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns
  };
}

function createThread({ source, preview, cwd, turns }) {
  conversationCounter += 1;
  const thread = buildThreadRecord({
    id: `thread-${conversationCounter}`,
    source,
    preview,
    cwd,
    turns
  });
  fakeThreads.set(thread.id, thread);
  return thread;
}

fakeThreads.set(
  "existing-123",
  buildThreadRecord({
    id: "existing-123",
    source: "exec",
    preview: "existing preview",
    cwd: workspaceDir
  })
);

class MockAppServerChild extends EventEmitter {
  constructor(executable, args, options) {
    super();
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = nextPid++;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    activeAppServerUrl = args[args.indexOf("--listen") + 1];
  }

  kill() {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }

  unref() {}
}

class MockCliChild extends EventEmitter {
  constructor(executable, args, options) {
    super();
    this.executable = executable;
    this.args = args;
    this.options = options;
    this.pid = nextPid++;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill() {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }

  unref() {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();

    setTimeout(() => {
      if (url !== activeAppServerUrl) {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("error", { type: "error" });
        this.emit("close", { type: "close" });
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", { type: "open" });
    }, 0);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }
    handlers.delete(handler);
  }

  send(payload) {
    const request = JSON.parse(payload);
    handleAppServerRequest(this, request);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => {
      this.emit("close", { type: "close" });
    }, 0);
  }

  emit(type, event) {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return;
    }
    handlers.forEach((handler) => {
      handler(event);
    });
  }
}

const mockChildProcess = {
  spawn(executable, args, options) {
    spawnCalls.push({
      executable,
      args: [...args],
      cwd: options.cwd
    });

    let child;
    if (args[0] === "app-server") {
      child = new MockAppServerChild(executable, args, options);
    } else {
      child = new MockCliChild(executable, args, options);
    }
    return child;
  }
};

function sendSocketMessage(socket, message) {
  setTimeout(() => {
    socket.emit("message", { data: JSON.stringify(message) });
  }, 0);
}

function cloneThread(thread) {
  return JSON.parse(JSON.stringify(thread));
}

function buildSummary(thread) {
  return {
    conversationId: thread.id,
    path: thread.path,
    preview: thread.preview,
    timestamp: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    modelProvider: thread.modelProvider,
    cwd: thread.cwd,
    cliVersion: thread.cliVersion,
    source: thread.source,
    gitInfo: null
  };
}

function buildThreadStartResult(thread, params) {
  return {
    thread: cloneThread(thread),
    model: params.model || "gpt-5.4",
    modelProvider: thread.modelProvider,
    serviceTier: params.serviceTier || null,
    cwd: thread.cwd,
    approvalPolicy: params.approvalPolicy || "never",
    sandbox:
      params.sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : params.sandbox === "workspace-write"
          ? {
              type: "workspaceWrite",
              writableRoots: [thread.cwd],
              readOnlyAccess: { type: "fullAccess" },
              networkAccess: false
            }
          : { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
    reasoningEffort: "xhigh"
  };
}

function threadListData(sourceKinds) {
  const values = Array.from(fakeThreads.values());
  const allowedSources =
    !Array.isArray(sourceKinds) || sourceKinds.length === 0
      ? new Set(["vscode", "cli", "appServer"])
      : new Set(sourceKinds);
  return values
    .filter((thread) => allowedSources.has(thread.source))
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((thread) => cloneThread(thread));
}

function queueTurnNotifications(socket, thread, turn, promptText) {
  setTimeout(() => {
    sendSocketMessage(socket, {
      method: "codex/event/task_started",
      params: { threadId: thread.id }
    });
    sendSocketMessage(socket, {
      method: "turn/started",
      params: {
        threadId: thread.id,
        turn: {
          id: turn.id,
          items: [],
          status: "inProgress",
          error: null
        }
      }
    });
    sendSocketMessage(socket, {
      method: "codex/event/agent_message",
      params: {
        threadId: thread.id,
        message: `final: ${promptText}`,
        phase: "final_answer"
      }
    });
  }, 5);

  setTimeout(() => {
    thread.updatedAt = nowSeconds();
    if (!thread.preview) {
      thread.preview = promptText;
    }
    thread.turns = thread.turns || [];
    thread.turns.push({
      id: turn.id,
      items: [],
      status: "completed",
      error: null
    });
    sendSocketMessage(socket, {
      method: "codex/event/task_complete",
      params: { threadId: thread.id }
    });
    sendSocketMessage(socket, {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: turn.id,
          items: [],
          status: "completed",
          error: null
        }
      }
    });
  }, 25);
}

function handleAppServerRequest(socket, request) {
  const params = request.params || {};

  switch (request.method) {
    case "initialize":
      sendSocketMessage(socket, {
        id: request.id,
        result: {
          userAgent: "fake-codex-app-server"
        }
      });
      return;
    case "thread/start": {
      const thread = createThread({
        source: "vscode",
        preview: "",
        cwd: params.cwd || workspaceDir
      });
      sendSocketMessage(socket, {
        id: request.id,
        result: buildThreadStartResult(thread, params)
      });
      sendSocketMessage(socket, {
        method: "thread/started",
        params: { thread: cloneThread(thread) }
      });
      return;
    }
    case "thread/resume": {
      const thread = fakeThreads.get(params.threadId);
      if (!thread) {
        sendSocketMessage(socket, {
          id: request.id,
          error: { message: `missing thread ${params.threadId}` }
        });
        return;
      }
      sendSocketMessage(socket, {
        id: request.id,
        result: buildThreadStartResult(thread, params)
      });
      return;
    }
    case "thread/fork": {
      const sourceThread = fakeThreads.get(params.threadId);
      if (!sourceThread) {
        sendSocketMessage(socket, {
          id: request.id,
          error: { message: `missing thread ${params.threadId}` }
        });
        return;
      }
      const thread = createThread({
        source: "vscode",
        preview: sourceThread.preview,
        cwd: params.cwd || workspaceDir,
        turns: sourceThread.turns || []
      });
      sendSocketMessage(socket, {
        id: request.id,
        result: buildThreadStartResult(thread, params)
      });
      sendSocketMessage(socket, {
        method: "thread/started",
        params: { thread: cloneThread(thread) }
      });
      return;
    }
    case "turn/start": {
      const thread = fakeThreads.get(params.threadId);
      if (!thread) {
        sendSocketMessage(socket, {
          id: request.id,
          error: { message: `missing thread ${params.threadId}` }
        });
        return;
      }
      const turnId = `turn-${++turnCounter}`;
      const promptText =
        Array.isArray(params.input) && params.input[0] && params.input[0].text
          ? params.input[0].text
          : "";
      sendSocketMessage(socket, {
        id: request.id,
        result: {
          turn: {
            id: turnId,
            items: [],
            status: "inProgress",
            error: null
          }
        }
      });
      queueTurnNotifications(socket, thread, { id: turnId }, promptText);
      return;
    }
    case "getConversationSummary": {
      const thread = fakeThreads.get(params.conversationId);
      if (!thread) {
        sendSocketMessage(socket, {
          id: request.id,
          error: { message: `missing thread ${params.conversationId}` }
        });
        return;
      }
      sendSocketMessage(socket, {
        id: request.id,
        result: {
          summary: buildSummary(thread)
        }
      });
      return;
    }
    case "thread/list":
      sendSocketMessage(socket, {
        id: request.id,
        result: {
          data: threadListData(params.sourceKinds),
          nextCursor: null
        }
      });
      return;
    default:
      sendSocketMessage(socket, {
        id: request.id,
        error: { message: `unsupported method ${request.method}` }
      });
  }
}

const mockVscode = {
  commands: {
    _registered: new Map(),
    registerCommand(id, handler) {
      this._registered.set(id, handler);
      return {
        dispose: () => {
          this._registered.delete(id);
        }
      };
    },
    async executeCommand(id, ...args) {
      if (id === "chatgpt.newCodexPanel") {
        openDraftTab();
        return;
      }

      if (id === "vscode.openWith" || id === "vscode.open") {
        openConversationTab(args[0], "Opened Codex Task");
        return;
      }

      const handler = this._registered.get(id);
      if (!handler) {
        throw new Error(`Unknown command: ${id}`);
      }
      return handler(...args);
    },
    async getCommands() {
      return [
        ...this._registered.keys(),
        "chatgpt.newCodexPanel",
        "vscode.open",
        "vscode.openWith"
      ];
    }
  },
  workspace: {
    workspaceFolders: [
      {
        uri: {
          scheme: "file",
          fsPath: workspaceDir
        }
      }
    ],
    getConfiguration(section) {
      return {
        get(key, fallback) {
          return config[`${section}.${key}`] ?? fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
    }
  },
  window: {
    createOutputChannel() {
      return {
        appendLine() {},
        dispose() {}
      };
    },
    showInformationMessage(message) {
      infos.push(message);
      return Promise.resolve(message);
    },
    tabGroups: {
      all: [activeTabGroup],
      activeTabGroup
    }
  },
  extensions: {
    all: [
      {
        id: "openai.chatgpt",
        extensionPath: fakeExtensionDir
      }
    ],
    getExtension(id) {
      return this.all.find((item) => item.id === id) || null;
    }
  },
  Uri: {
    from: makeUri
  }
};

const originalLoad = Module._load;
global.WebSocket = FakeWebSocket;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return mockVscode;
  }
  if (request === "node:child_process") {
    return mockChildProcess;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require("./extension.js");
const context = { subscriptions: [] };

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: config["codexBridge.port"],
        method,
        path: pathname,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length
            }
          : undefined
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForJobStatus(jobId, expectedStatus) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const response = await request("GET", `/jobs/${jobId}`);
    if (response.statusCode === 200 && response.body.job.status === expectedStatus) {
      return response.body.job;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expectedStatus}.`);
}

async function main() {
  extension.activate(context);
  await mockVscode.commands.executeCommand("codexBridge.startServer");

  const health = await request("GET", "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);
  assert.deepEqual(health.body.openConversations, []);
  assert.deepEqual(health.body.status.jobs, {
    total: 0,
    starting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    latestJobId: null
  });

  const createDraft = await request("POST", "/conversations", {});
  assert.equal(createDraft.statusCode, 200);
  assert.equal(createDraft.body.ok, true);
  assert.equal(createDraft.body.sent, false);
  assert.equal(createDraft.body.draft, true);
  assert.equal(createDraft.body.conversationId, null);
  assert.equal(createDraft.body.opened, true);

  const createAndSend = await request("POST", "/conversations", {
    message: "first prompt",
    cwd: workspaceDir,
    approvalPolicy: "never",
    sandbox: "workspace-write"
  });
  assert.equal(createAndSend.statusCode, 200);
  assert.equal(createAndSend.body.ok, true);
  assert.equal(createAndSend.body.sent, true);
  assert.equal(createAndSend.body.conversationId, "thread-1");
  assert.equal(createAndSend.body.turn.transport, "app-server");
  assert.equal(createAndSend.body.turn.eventType, "thread/started");
  assert.equal(createAndSend.body.turn.jobId, createAndSend.body.job.jobId);
  assert.equal(createAndSend.body.job.operation, "create_conversation");
  assert.equal(createAndSend.body.job.conversationId, "thread-1");
  assert.equal(createAndSend.body.jobUrl, `/jobs/${createAndSend.body.job.jobId}`);
  assert.equal(createAndSend.body.opened, true);
  assert.equal(createAndSend.body.openError, null);
  assert.equal(createAndSend.body.conversation.conversationId, "thread-1");
  const createJob = await waitForJobStatus(createAndSend.body.job.jobId, "completed");
  assert.equal(createJob.lastEventType, "turn/completed");

  const current = await request("GET", "/conversations/current");
  assert.equal(current.statusCode, 200);
  assert.equal(current.body.ok, true);
  assert.equal(current.body.conversation.conversationId, "thread-1");

  const continueCurrent = await request(
    "POST",
    "/conversations/current/messages",
    { message: "follow up current" }
  );
  assert.equal(continueCurrent.statusCode, 200);
  assert.equal(continueCurrent.body.ok, true);
  assert.equal(continueCurrent.body.conversationId, "thread-1");
  assert.equal(continueCurrent.body.turn.transport, "app-server");
  assert.equal(continueCurrent.body.turn.eventType, "turn/started");
  assert.equal(continueCurrent.body.turn.jobId, continueCurrent.body.job.jobId);
  assert.equal(continueCurrent.body.job.operation, "resume_conversation");
  assert.equal(continueCurrent.body.opened, true);
  assert.equal(continueCurrent.body.openError, null);
  const continueCurrentJob = await waitForJobStatus(
    continueCurrent.body.job.jobId,
    "completed"
  );
  assert.equal(continueCurrentJob.lastEventType, "turn/completed");

  const continueExisting = await request(
    "POST",
    "/conversations/existing-123/messages",
    { message: "follow up existing" }
  );
  assert.equal(continueExisting.statusCode, 200);
  assert.equal(continueExisting.body.ok, true);
  assert.equal(continueExisting.body.conversationId, "thread-2");
  assert.equal(continueExisting.body.requestedConversationId, "existing-123");
  assert.equal(continueExisting.body.upgradedFromConversationId, "existing-123");
  assert.equal(continueExisting.body.turn.transport, "app-server");
  assert.equal(continueExisting.body.turn.eventType, "thread/started");
  assert.equal(continueExisting.body.turn.jobId, continueExisting.body.job.jobId);
  assert.equal(continueExisting.body.job.operation, "resume_conversation");
  assert.equal(continueExisting.body.opened, true);
  assert.equal(continueExisting.body.openError, null);
  assert.equal(
    continueExisting.body.conversation.conversationId,
    "thread-2"
  );
  const continueExistingJob = await waitForJobStatus(
    continueExisting.body.job.jobId,
    "completed"
  );
  assert.equal(continueExistingJob.lastEventType, "turn/completed");

  const openConversations = await request("GET", "/conversations/open");
  assert.equal(openConversations.statusCode, 200);
  assert.equal(openConversations.body.ok, true);
  assert.equal(
    openConversations.body.conversations.some(
      (item) => item.conversationId === "thread-1"
    ),
    true
  );
  assert.equal(
    openConversations.body.conversations.some(
      (item) => item.conversationId === "thread-2"
    ),
    true
  );

  const jobs = await request("GET", "/jobs");
  assert.equal(jobs.statusCode, 200);
  assert.equal(jobs.body.ok, true);
  assert.equal(jobs.body.jobs.length, 3);
  assert.deepEqual(
    jobs.body.jobs.map((item) => item.jobId),
    [
      continueExisting.body.job.jobId,
      continueCurrent.body.job.jobId,
      createAndSend.body.job.jobId
    ]
  );

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].executable, fakeCliPath);
  assert.equal(spawnCalls[0].args[0], "app-server");
  assert.equal(spawnCalls[0].args[1], "--listen");
  assert.equal(spawnCalls[0].args[2].startsWith("ws://127.0.0.1:"), true);
  assert.equal(spawnCalls[0].cwd, undefined);

  await extension.deactivate();
  fs.rmSync(testAssetsDir, { recursive: true, force: true });
  console.log("smoke-test ok");
}

main().catch(async (error) => {
  try {
    await extension.deactivate();
  } catch {}
  try {
    fs.rmSync(testAssetsDir, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exitCode = 1;
});
