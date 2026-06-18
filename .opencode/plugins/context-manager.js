// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = import.meta.require;

// dcp-rewrite/clean-impl/core/compress/apply.ts
function applyCompress(messages, summaryText, sourceMessageIds, state, config, nowMs) {
  const blockId = `b${state.nextBlockId}`;
  state.nextBlockId++;
  const sourceSet = new Set(sourceMessageIds);
  const anchorMessageId = sourceMessageIds[0] ?? "";
  let insertIdx = messages.findIndex((m) => sourceSet.has(m.id));
  if (insertIdx < 0)
    insertIdx = messages.length;
  const shouldConsolidate = !config.summarization.appendOnly || state.fullRestructureTriggered;
  let finalSummaryText = summaryText;
  const consumedBlockIds = [];
  if (shouldConsolidate) {
    const existingBlocks = [];
    for (const msgId of sourceMessageIds) {
      const msg = messages.find((m) => m.id === msgId);
      if (!msg)
        continue;
      for (const part of msg.parts) {
        if (part.type === "summary-block") {
          existingBlocks.push(part.text);
          consumedBlockIds.push(part.blockId);
          const meta = state.blockRegistry.get(part.blockId);
          if (meta)
            meta.consumed = true;
        }
      }
    }
    if (existingBlocks.length > 0) {
      finalSummaryText = existingBlocks.join(`

---

`) + `

---

` + summaryText;
    }
  }
  const summaryPart = {
    type: "summary-block",
    blockId,
    text: finalSummaryText
  };
  const summaryMessage = {
    id: `__summary_${blockId}`,
    ref: blockId,
    role: "assistant",
    sessionId: state.sessionId,
    createdAt: nowMs,
    isSummary: true,
    parts: [summaryPart]
  };
  const updatedMessages = messages.map((m) => {
    if (sourceSet.has(m.id)) {
      return { ...m, isIgnored: true };
    }
    return m;
  });
  updatedMessages.splice(insertIdx, 0, summaryMessage);
  const blockMeta = {
    blockId,
    sourceMessageIds,
    createdAtTurn: state.currentTurn,
    tokens: Math.ceil(finalSummaryText.length / 4),
    consumed: false
  };
  state.blockRegistry.set(blockId, blockMeta);
  state.latestSummaryBlockId = blockId;
  for (const msgId of sourceMessageIds) {
    const existing = state.messageIndex.get(msgId) ?? {
      messageId: msgId,
      masked: false,
      offloaded: false
    };
    state.messageIndex.set(msgId, { ...existing, replacedByBlockId: blockId });
  }
  state.activeByAnchorMessageId.set(anchorMessageId, blockId);
  state.stats.totalCompressRuns++;
  return { messages: updatedMessages, blockId, anchorMessageId };
}

// dcp-rewrite/clean-impl/core/compress/execute.ts
var exports_execute = {};
__export(exports_execute, {
  selectCompressRange: () => selectCompressRange,
  findStableVolatileBoundary: () => findStableVolatileBoundary,
  executeCompress: () => executeCompress
});
function executeCompress(input) {
  const { messages, sourceMessageIds, summaryText, state, config, nowMs } = input;
  const sourceSet = new Set(sourceMessageIds);
  const existing = messages.filter((m) => sourceSet.has(m.id));
  if (existing.length === 0) {
    throw new Error(`executeCompress: none of the source message IDs exist in the message list`);
  }
  const result = applyCompress(messages, summaryText, sourceMessageIds, state, config, nowMs);
  return {
    messages: result.messages,
    blockId: result.blockId,
    anchorMessageId: result.anchorMessageId
  };
}
function findStableVolatileBoundary(messages, currentTurn, recencyGuardTurns) {
  for (let i = messages.length - 1;i >= 0; i--) {
    const msg = messages[i];
    if (msg.isIgnored || msg.isSummary)
      continue;
    for (const part of msg.parts) {
      if (part.type === "tool" && part.turn !== undefined) {
        if (currentTurn - part.turn < recencyGuardTurns) {
          return i;
        }
      }
    }
  }
  return messages.length;
}
function selectCompressRange(messages, state, currentTurn, recencyGuardTurns) {
  const boundary = findStableVolatileBoundary(messages, currentTurn, recencyGuardTurns);
  let startIdx = 0;
  for (let i = 0;i < boundary; i++) {
    if (messages[i].isSummary) {
      startIdx = i + 1;
    }
  }
  const range = [];
  for (let i = startIdx;i < boundary; i++) {
    const msg = messages[i];
    if (!msg.isIgnored) {
      range.push(msg.id);
    }
  }
  return range;
}
var init_execute = () => {};

// dcp-rewrite/clean-impl/adapters/opencode/map.ts
function toNeutral(entries) {
  return entries.map((entry, index) => entryToNeutral(entry, index));
}
function entryToNeutral(entry, messageIndex) {
  const { info, parts } = entry;
  const role = info.role === "user" ? "user" : "assistant";
  const sessionId = info.sessionID;
  const createdAt = info.time.created;
  const hasCompactionPart = parts.some((p) => p.type === "compaction");
  const isSummary = hasCompactionPart || info.role === "assistant" && info.summary === true;
  const isIgnored = parts.some((p) => p.type === "text" && p.ignored === true);
  let tokens;
  if (info.role === "assistant") {
    const asst = info;
    tokens = {
      input: asst.tokens.input,
      output: asst.tokens.output,
      reasoning: asst.tokens.reasoning,
      cacheRead: asst.tokens.cache.read,
      cacheWrite: asst.tokens.cache.write
    };
  }
  const neutralParts = parts.flatMap((p) => partToNeutral(p, messageIndex));
  return {
    id: info.id,
    role,
    sessionId,
    createdAt,
    isSummary: isSummary || undefined,
    isIgnored: isIgnored || undefined,
    parts: neutralParts,
    tokens
  };
}
function partToNeutral(part, messageIndex) {
  switch (part.type) {
    case "text": {
      const tp = part;
      return [{ type: "text", text: tp.text }];
    }
    case "reasoning": {
      const rp = part;
      return [{ type: "reasoning", text: rp.text }];
    }
    case "step-start": {
      return [{ type: "step-start" }];
    }
    case "tool": {
      const tp = part;
      const status = toolStateToStatus(tp.state);
      const input = tp.state.input ?? {};
      const output = toolStateOutput(tp.state);
      return [
        {
          type: "tool",
          callId: tp.callID,
          tool: tp.tool,
          status,
          input,
          output,
          turn: messageIndex
        }
      ];
    }
    case "step-finish":
    case "compaction":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "file":
    case "subtask":
      return [];
    default:
      return [];
  }
}
function toolStateToStatus(state) {
  switch (state.status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "pending";
  }
}
function toolStateOutput(state) {
  if (state.status === "completed")
    return state.output;
  if (state.status === "error")
    return state.error;
  return;
}
function applyNeutral(originalEntries, neutralMessages) {
  const originalById = new Map;
  for (const entry of originalEntries) {
    originalById.set(entry.info.id, entry);
  }
  const result = [];
  for (const neutral of neutralMessages) {
    if (neutral.isSummary && !originalById.has(neutral.id)) {
      result.push(buildSyntheticSummaryEntry(neutral));
      continue;
    }
    const original = originalById.get(neutral.id);
    if (!original) {
      continue;
    }
    const mutatedEntry = applyMutationsToEntry(original, neutral);
    result.push(mutatedEntry);
  }
  return result;
}
function buildSyntheticSummaryEntry(neutral) {
  const summaryPart = neutral.parts.find((p) => p.type === "summary-block");
  const text = summaryPart?.type === "summary-block" ? summaryPart.text : "";
  const syntheticInfo = {
    id: neutral.id,
    sessionID: neutral.sessionId,
    role: "user",
    time: { created: neutral.createdAt },
    agent: "dcp-compress",
    model: { providerID: "dcp", modelID: "compress" },
    system: undefined,
    tools: undefined
  };
  const syntheticPart = {
    id: `${neutral.id}-text`,
    sessionID: neutral.sessionId,
    messageID: neutral.id,
    type: "text",
    text
  };
  return { info: syntheticInfo, parts: [syntheticPart] };
}
function applyMutationsToEntry(original, neutral) {
  const neutralToolByCallId = new Map;
  for (const part of neutral.parts) {
    if (part.type === "tool") {
      neutralToolByCallId.set(part.callId, { output: part.output, input: part.input });
    }
  }
  const neutralTextParts = neutral.parts.filter((p) => p.type === "text");
  let textPartIdx = 0;
  const newParts = original.parts.map((part) => {
    if (part.type === "tool") {
      const tp = part;
      const neutralTool = neutralToolByCallId.get(tp.callID);
      if (!neutralTool)
        return part;
      if (tp.state.status === "completed" && neutralTool.output !== undefined) {
        const newState = {
          ...tp.state,
          output: neutralTool.output
        };
        return { ...tp, state: newState };
      }
      if (tp.state.status === "error") {
        const newState = {
          ...tp.state,
          input: neutralTool.input
        };
        return { ...tp, state: newState };
      }
      return part;
    }
    if (part.type === "text") {
      const neutralText = neutralTextParts[textPartIdx];
      textPartIdx++;
      if (neutralText && neutralText.text !== part.text) {
        return { ...part, text: neutralText.text };
      }
      return part;
    }
    return part;
  });
  return { info: original.info, parts: newParts };
}

// dcp-rewrite/clean-impl/adapters/opencode/services.ts
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

// dcp-rewrite/clean-impl/services/tokenizer.ts
class CharTokenizer {
  countTokens(text) {
    return Math.ceil(text.length / 4);
  }
}
var defaultTokenizer = new CharTokenizer;

// dcp-rewrite/clean-impl/services/clock.ts
class WallClock {
  now() {
    return Date.now();
  }
}
var wallClock = new WallClock;

// dcp-rewrite/clean-impl/types/state.ts
function createInitialState(sessionId) {
  return {
    sessionId,
    isSubAgent: false,
    manualMode: false,
    compressPermission: true,
    blockRegistry: new Map,
    messageIndex: new Map,
    activeByAnchorMessageId: new Map,
    nextBlockId: 1,
    nextRunId: 1,
    toolParameters: new Map,
    toolIdList: [],
    messageIds: {
      byRawId: new Map,
      byRef: new Map,
      nextRef: 1
    },
    nudges: {
      contextLimitAnchors: new Set,
      midSoftNudgeAnchors: new Set,
      turnNudgeAnchors: new Set,
      iterationNudgeAnchors: new Set
    },
    lastMaskingPassTurn: 0,
    lastMaskingPassTime: 0,
    lastRequestTime: 0,
    lastCacheMiss: false,
    fullRestructureTriggered: false,
    stats: {
      totalTurns: 0,
      totalMaskingPasses: 0,
      totalTokensMasked: 0,
      totalTokensOffloaded: 0,
      totalCompressRuns: 0,
      totalTokensSaved: 0
    },
    modelContextLimit: 1e6,
    systemPromptTokens: 0,
    compressionTiming: {},
    currentTurn: 0,
    activeProfile: "documents"
  };
}

// dcp-rewrite/clean-impl/adapters/opencode/services.ts
class AnthropicTokenizer {
  delegate = new CharTokenizer;
  initialized = false;
  async init() {
    if (this.initialized)
      return;
    this.initialized = true;
    try {
      const pkgName = "@anthropic-ai/tokenizer";
      const mod = await import(pkgName);
      const countFn = mod.countTokens ?? mod.default?.countTokens;
      if (typeof countFn === "function") {
        this.delegate = {
          countTokens: (text) => countFn(text)
        };
      }
    } catch {}
  }
  countTokens(text) {
    return this.delegate.countTokens(text);
  }
}
async function buildTokenizer() {
  const tok = new AnthropicTokenizer;
  await tok.init();
  return tok;
}
class FilePersistence {
  storageDir;
  constructor(storageDir) {
    this.storageDir = storageDir ?? defaultStorageDir();
  }
  sidecarPath(sessionId) {
    return join(this.storageDir, "dcp", `${sanitizeId(sessionId)}.json`);
  }
  async load(sessionId) {
    const path = this.sidecarPath(sessionId);
    try {
      const raw = await readFile(path, "utf8");
      return deserializeState(JSON.parse(raw));
    } catch {
      return;
    }
  }
  async save(sessionId, state) {
    const path = this.sidecarPath(sessionId);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(serializeState(state), null, 2), "utf8");
      await rename(tmp, path);
    } catch (err) {
      try {
        await writeFile(tmp, "", "utf8");
      } catch {}
      throw err;
    }
  }
}
function defaultStorageDir() {
  const explicit = process.env.CONTEXT_MANAGER_STORAGE_DIR;
  if (explicit)
    return explicit;
  const workspacesRoot = process.env.WORKSPACES_ROOT;
  if (workspacesRoot)
    return join(workspacesRoot, ".context-manager");
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg)
    return join(xdg, "opencode", "storage");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return join(home, ".local", "share", "opencode", "storage");
}
function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
function serializeState(state) {
  return {
    ...state,
    blockRegistry: Array.from(state.blockRegistry.entries()),
    messageIndex: Array.from(state.messageIndex.entries()),
    activeByAnchorMessageId: Array.from(state.activeByAnchorMessageId.entries()),
    toolParameters: Array.from(state.toolParameters.entries()),
    toolIdList: state.toolIdList,
    messageIds: {
      byRawId: Array.from(state.messageIds.byRawId.entries()),
      byRef: Array.from(state.messageIds.byRef.entries()),
      nextRef: state.messageIds.nextRef
    },
    nudges: {
      contextLimitAnchors: Array.from(state.nudges.contextLimitAnchors),
      midSoftNudgeAnchors: Array.from(state.nudges.midSoftNudgeAnchors),
      turnNudgeAnchors: Array.from(state.nudges.turnNudgeAnchors),
      iterationNudgeAnchors: Array.from(state.nudges.iterationNudgeAnchors)
    }
  };
}
function deserializeState(raw) {
  try {
    return {
      ...raw,
      blockRegistry: new Map(raw.blockRegistry),
      messageIndex: new Map(raw.messageIndex),
      activeByAnchorMessageId: new Map(raw.activeByAnchorMessageId),
      toolParameters: new Map(raw.toolParameters),
      toolIdList: raw.toolIdList ?? [],
      messageIds: {
        byRawId: new Map(raw.messageIds.byRawId),
        byRef: new Map(raw.messageIds.byRef),
        nextRef: raw.messageIds.nextRef
      },
      nudges: {
        contextLimitAnchors: new Set(raw.nudges.contextLimitAnchors),
        midSoftNudgeAnchors: new Set(raw.nudges.midSoftNudgeAnchors),
        turnNudgeAnchors: new Set(raw.nudges.turnNudgeAnchors),
        iterationNudgeAnchors: new Set(raw.nudges.iterationNudgeAnchors)
      }
    };
  } catch {
    throw new Error("deserializeState: malformed state JSON");
  }
}

class AdapterLogger {
  prefix;
  constructor(prefix = "[dcp-adapter]") {
    this.prefix = prefix;
  }
  debug(message, ...args) {
    console.debug(`${this.prefix} DEBUG ${message}`, ...args);
  }
  info(message, ...args) {
    console.info(`${this.prefix} INFO ${message}`, ...args);
  }
  warn(message, ...args) {
    console.warn(`${this.prefix} WARN ${message}`, ...args);
  }
  error(message, ...args) {
    console.error(`${this.prefix} ERROR ${message}`, ...args);
  }
}
async function buildServices(storageDir) {
  const tokenizer = await buildTokenizer();
  return {
    tokenizer,
    clock: new WallClock,
    persistence: new FilePersistence(storageDir),
    logger: new AdapterLogger
  };
}
async function loadOrCreateState(sessionId, persistence) {
  const loaded = await persistence.load(sessionId);
  return loaded ?? createInitialState(sessionId);
}

// dcp-rewrite/clean-impl/core/defaults.ts
var CACHE_MODEL_DEEPSEEK = {
  type: "automatic-free",
  R: 50,
  effectiveTtlSeconds: 3600
};
var DEFAULT_TOOL_CLASSES = {
  read: { stateless: true, retentionTurns: 10 },
  webfetch: { stateless: true, retentionTurns: 10 },
  websearch: { stateless: true, retentionTurns: 10 },
  glob: { stateless: true, retentionTurns: 3 },
  list: { stateless: true, retentionTurns: 3 },
  grep: { stateless: true, retentionTurns: 3 },
  bash: { stateless: false, retentionTurns: 15 },
  execute: { stateless: false, retentionTurns: 15 },
  shell: { stateless: false, retentionTurns: 15 },
  run_tests: { stateless: false, retentionTurns: 15 },
  test: { stateless: false, retentionTurns: 15 },
  compile: { stateless: false, retentionTurns: 15 },
  apply_patch: { stateless: false, retentionTurns: 15 },
  edit: { stateless: false, retentionTurns: 15 },
  write: { stateless: false, retentionTurns: 15 }
};
var ALWAYS_PROTECTED_TOOLS = new Set([
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit"
]);
function buildDefaultConfig(sessionId) {
  return {
    sessionId,
    profile: "documents",
    recencyGuardTurns: 10,
    minRepruneInterval: 3,
    clearAtLeast: 2000,
    cacheModel: CACHE_MODEL_DEEPSEEK,
    costRoi: { enabled: true },
    summarization: { appendOnly: true },
    nudges: {
      lowerThreshold: 150000,
      midSoftNudge: 250000,
      upperThreshold: 400000,
      safetyCap: "80%",
      maskTriggerThreshold: 150000
    },
    toolClasses: { ...DEFAULT_TOOL_CLASSES },
    modelContextLimit: 1e6,
    systemPromptTokens: 0
  };
}

// dcp-rewrite/clean-impl/core/profiles.ts
var PROFILES = {
  documents: {
    preferOffload: true,
    usePlainMaskForStateful: false,
    recencyGuardTurns: undefined,
    maskTriggerThreshold: undefined
  },
  code: {
    preferOffload: false,
    usePlainMaskForStateful: true,
    recencyGuardTurns: 15,
    maskTriggerThreshold: 200000
  },
  balanced: {
    preferOffload: true,
    usePlainMaskForStateful: true,
    recencyGuardTurns: undefined,
    maskTriggerThreshold: 175000
  }
};
function getProfile(name) {
  return PROFILES[name];
}

// dcp-rewrite/clean-impl/core/config.ts
function resolveConfig(sessionId, plugin, global, provider, model, runtime) {
  const base = buildDefaultConfig(sessionId);
  const layers = [plugin, global, provider, model, runtime].filter(Boolean);
  let result = { ...base };
  for (const layer of layers) {
    for (const key of Object.keys(layer)) {
      const val = layer[key];
      if (val === undefined)
        continue;
      if (key === "cacheModel" && typeof val === "object") {
        result.cacheModel = { ...result.cacheModel, ...val };
      } else if (key === "costRoi" && typeof val === "object") {
        result.costRoi = { ...result.costRoi, ...val };
      } else if (key === "summarization" && typeof val === "object") {
        result.summarization = { ...result.summarization, ...val };
      } else if (key === "nudges" && typeof val === "object") {
        result.nudges = { ...result.nudges, ...val };
      } else if (key === "toolClasses" && typeof val === "object") {
        result.toolClasses = { ...result.toolClasses, ...val };
      } else {
        result[key] = val;
      }
    }
  }
  const profileOverrides = getProfile(result.profile);
  if (profileOverrides.recencyGuardTurns !== undefined) {
    result.recencyGuardTurns = profileOverrides.recencyGuardTurns;
  }
  if (profileOverrides.maskTriggerThreshold !== undefined) {
    result.nudges = { ...result.nudges, maskTriggerThreshold: profileOverrides.maskTriggerThreshold };
  }
  return result;
}

// dcp-rewrite/clean-impl/adapters/opencode/config.ts
function buildCoreConfig(sessionId, options, modelContextLimit, providerID, _modelID) {
  const pluginLayer = {};
  if (options.profile !== undefined) {
    pluginLayer.profile = options.profile;
  }
  if (options.recencyGuardTurns !== undefined) {
    pluginLayer.recencyGuardTurns = options.recencyGuardTurns;
  }
  if (options.minRepruneInterval !== undefined) {
    pluginLayer.minRepruneInterval = options.minRepruneInterval;
  }
  if (options.clearAtLeast !== undefined) {
    pluginLayer.clearAtLeast = options.clearAtLeast;
  }
  if (options.nudges !== undefined) {
    pluginLayer.nudges = options.nudges;
  }
  if (options.costRoi !== undefined) {
    pluginLayer.costRoi = { enabled: options.costRoi.enabled ?? true };
  }
  if (options.summarization !== undefined) {
    pluginLayer.summarization = { appendOnly: options.summarization.appendOnly ?? true };
  }
  pluginLayer.modelContextLimit = modelContextLimit;
  const cacheModel = selectCacheModel(providerID);
  pluginLayer.cacheModel = cacheModel;
  const config = resolveConfig(sessionId, pluginLayer);
  return config;
}
function selectCacheModel(providerID) {
  if (providerID === "opencode-go" || providerID.includes("deepseek")) {
    return CACHE_MODEL_DEEPSEEK;
  }
  return { type: "automatic-free", R: 1, effectiveTtlSeconds: 3600 };
}
function extractPluginOptions(pluginEntry) {
  if (!Array.isArray(pluginEntry) || pluginEntry.length < 2)
    return {};
  const opts = pluginEntry[1];
  if (typeof opts !== "object" || opts === null)
    return {};
  const dcp = opts["dcp"];
  if (typeof dcp !== "object" || dcp === null)
    return {};
  return dcp;
}
var INTERNAL_MODEL_SUBSTRINGS = [
  "title",
  "summarize",
  "compaction",
  "summary"
];
function isInternalModel(modelID) {
  const lower = modelID.toLowerCase();
  return INTERNAL_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
}

// dcp-rewrite/clean-impl/adapters/opencode/tool.ts
init_execute();
var compressArgsSchema = {
  topic: {
    type: "string",
    description: "Short label (3-5 words) for display \u2014 e.g. 'Auth System Exploration'"
  },
  content: {
    type: "array",
    description: "One or more ranges to compress. Ranges in the same call must not overlap.",
    items: {
      type: "object",
      properties: {
        startId: {
          type: "string",
          description: "Message or block ID marking the beginning of range (e.g. m0001, b2)"
        },
        endId: {
          type: "string",
          description: "Message or block ID marking the end of range (e.g. m0012, b5)"
        },
        summary: {
          type: "string",
          description: "Complete technical summary replacing all content in range. Use the 7-section structure: ## Goal & Framework / ## Decisions / ## Artifacts / ## Figures & Source Attributions / ## Open [DATA NEEDED] Items / ## Open Questions / ## Next Steps. MUST: keep every figure with its source attribution. MUST: copy every [DATA NEEDED: ...] item verbatim \u2014 never omit or resolve one. If this range follows an existing (bN) summary, reference it and extend its structure with only new deltas."
        }
      },
      required: ["startId", "endId", "summary"]
    }
  }
};
function buildCompressTool(deps) {
  return {
    description: buildCompressToolDescription(),
    args: compressArgsSchema,
    async execute(args, context) {
      const { sessionID } = context;
      const state = deps.getState(sessionID);
      const config = deps.getConfig(sessionID);
      const entries = deps.getEntries(sessionID);
      if (!state || !config || !entries) {
        return {
          output: "compress: session not initialized \u2014 no state or entries found",
          title: "compress (error)"
        };
      }
      const messages = toNeutral(entries);
      let currentMessages = messages;
      let currentState = state;
      const blockIds = [];
      for (const range of args.content) {
        const sourceIds = resolveRange(currentMessages, range.startId, range.endId);
        if (sourceIds.length === 0) {
          deps.logger.warn(`compress: range ${range.startId}..${range.endId} resolved to 0 messages`);
          continue;
        }
        try {
          const result = executeCompress({
            messages: currentMessages,
            sourceMessageIds: sourceIds,
            summaryText: range.summary,
            topic: args.topic,
            state: currentState,
            config,
            nowMs: Date.now()
          });
          currentMessages = result.messages;
          blockIds.push(result.blockId);
        } catch (err) {
          deps.logger.error(`compress: executeCompress failed for range ${range.startId}..${range.endId}`, err);
        }
      }
      const newEntries = applyNeutral(entries, currentMessages);
      deps.setEntries(sessionID, newEntries);
      deps.setState(sessionID, currentState);
      try {
        await deps.persistence.save(sessionID, currentState);
      } catch (err) {
        deps.logger.warn("compress: failed to persist state", err);
      }
      const blockList = blockIds.join(", ");
      return {
        output: `Compressed ${args.content.length} range(s) into block(s): ${blockList}. Topic: ${args.topic}`,
        title: `compress (${blockIds.length} block${blockIds.length !== 1 ? "s" : ""})`
      };
    }
  };
}
function resolveRange(messages, startId, endId) {
  const startIdx = findMessageIndex(messages, startId);
  const endIdx = findMessageIndex(messages, endId);
  if (startIdx === -1 || endIdx === -1)
    return [];
  if (startIdx > endIdx)
    return [];
  return messages.slice(startIdx, endIdx + 1).filter((m) => !m.isIgnored).map((m) => m.id);
}
function findMessageIndex(messages, idOrRef) {
  for (let i = 0;i < messages.length; i++) {
    const m = messages[i];
    if (m.ref === idOrRef || m.id === idOrRef)
      return i;
  }
  return -1;
}
function buildCompressToolDescription() {
  return `Compress a range of conversation messages into a dense summary to free context window space.

Use this tool when the context window is getting full (you will be nudged). This is the ONLY way to compress \u2014 never auto-fire it.

WHEN TO USE:
- When you receive a context management nudge (e.g. "Context is getting full")
- When you have completed a significant section of work and want to free space
- When the context meter shows high usage

WHEN NOT TO USE:
- Do not compress the current active turn or recent messages
- Do not compress messages you may still need to reference directly
- Do not compress if the context is not yet full

ARGS:
- topic: A short (3-5 word) label for what this compression covers
- content: Array of ranges. Each range has:
  - startId: The first message ID to include (e.g. "m0001" or "b1")
  - endId: The last message ID to include (inclusive)
  - summary: Your complete technical summary (see 7-section structure below)

SUMMARY STRUCTURE (use all 7 sections, omit empty ones):
## Goal & Framework
## Decisions
## Artifacts
## Figures & Source Attributions
## Open [DATA NEEDED] Items
## Open Questions
## Next Steps

RULES:
1. Every figure/number MUST keep its source attribution (file + location). If you cannot attribute it, keep the raw sentence verbatim.
2. Copy EVERY open [DATA NEEDED: ...] item into the Open [DATA NEEDED] Items section verbatim. Never omit one. Never invent a value to resolve it.
3. If your range follows an existing (bN) summary, reference it and EXTEND its structure with only new deltas \u2014 do not restate unchanged content.

SIDE EFFECTS: The compressed messages are replaced with a summary block in the context. This is irreversible per-session (the originals are preserved in the engine's store).`;
}

// dcp-rewrite/clean-impl/core/tagging.ts
var HALLUCINATION_STRIP_RE = /(<dcp-message-id(?:\s[^>]*)?>)[\s\S]*?(<\/dcp-message-id>)/gi;
function stripHallucinatedTags(text) {
  return text.replace(HALLUCINATION_STRIP_RE, "");
}
function formatRef(n) {
  return `m${String(n).padStart(4, "0")}`;
}
function runTagging(messages, state) {
  return messages.map((msg) => {
    if (state.messageIds.byRawId.has(msg.id)) {
      return stripMessageTags(msg);
    }
    const ref = formatRef(state.messageIds.nextRef);
    state.messageIds.nextRef++;
    state.messageIds.byRawId.set(msg.id, ref);
    state.messageIds.byRef.set(ref, msg.id);
    const tagged = { ...msg, ref };
    return stripMessageTags(tagged);
  });
}
function stripMessageTags(msg) {
  let modified = false;
  const newParts = msg.parts.map((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      const stripped = stripHallucinatedTags(part.text);
      if (stripped !== part.text) {
        modified = true;
        return { ...part, text: stripped };
      }
    }
    return part;
  });
  if (!modified)
    return msg;
  return { ...msg, parts: newParts };
}

// dcp-rewrite/clean-impl/core/tokens.ts
function estimatePartTokens(part, tokenizer) {
  switch (part.type) {
    case "text":
      return tokenizer.countTokens(part.text);
    case "reasoning":
      return tokenizer.countTokens(part.text);
    case "step-start":
      return tokenizer.countTokens(part.label ?? "");
    case "tool": {
      const inputStr = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      const outputStr = part.output ?? "";
      return tokenizer.countTokens(inputStr) + tokenizer.countTokens(outputStr);
    }
    case "summary-block":
      return tokenizer.countTokens(part.text);
    default:
      return 0;
  }
}
function estimateMessageTokens(msg, tokenizer) {
  if (msg.tokens) {
    return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning;
  }
  return msg.parts.reduce((sum, p) => sum + estimatePartTokens(p, tokenizer), 0);
}
function estimateContextTokens(messages, tokenizer) {
  return messages.filter((m) => !m.isIgnored).reduce((sum, m) => sum + estimateMessageTokens(m, tokenizer), 0);
}
function parseSafetyCapFraction(safetyCap) {
  const match = safetyCap.match(/^(\d+(?:\.\d+)?)%$/);
  if (!match)
    return 0.8;
  return parseFloat(match[1]) / 100;
}
function computeEffectiveBudget(modelContextLimit, safetyCap, systemPromptTokens) {
  const fraction = parseSafetyCapFraction(safetyCap);
  const cap = Math.floor(modelContextLimit * fraction);
  return Math.max(1000, cap - systemPromptTokens);
}

// dcp-rewrite/clean-impl/core/budget.ts
function computeBudgetBreakdown(messages, config, tokenizer) {
  let documents = 0;
  let reasoning = 0;
  let conversation = 0;
  for (const msg of messages) {
    if (msg.isIgnored)
      continue;
    for (const part of msg.parts) {
      if (part.type === "reasoning") {
        reasoning += tokenizer.countTokens(part.text);
      } else if (part.type === "tool") {
        const toolName = part.tool.toLowerCase();
        const isDocTool = ["read", "webfetch", "websearch"].includes(toolName);
        const tokens = estimateMessageTokens({ ...msg, parts: [part] }, tokenizer);
        if (isDocTool) {
          documents += tokens;
        } else {
          conversation += tokens;
        }
      } else if (part.type === "text" || part.type === "step-start") {
        conversation += estimateMessageTokens({ ...msg, parts: [part] }, tokenizer);
      } else if (part.type === "summary-block") {
        conversation += tokenizer.countTokens(part.text);
      }
    }
  }
  const systemAndTools = config.systemPromptTokens;
  const total = systemAndTools + documents + reasoning + conversation;
  const effectiveBudget = computeEffectiveBudget(config.modelContextLimit, config.nudges.safetyCap, config.systemPromptTokens);
  const usedFraction = effectiveBudget > 0 ? total / effectiveBudget : 0;
  return { systemAndTools, documents, reasoning, conversation, total, effectiveBudget, usedFraction };
}
function shouldTriggerMasking(totalTokens, config) {
  return totalTokens >= config.nudges.maskTriggerThreshold;
}

// dcp-rewrite/clean-impl/core/placeholders.ts
var PLACEHOLDER_DEDUP = "[Output removed to save context - information superseded or no longer needed]";
var PLACEHOLDER_STALE_ERROR_INPUT = "[input removed due to failed tool call]";
var PLACEHOLDER_PLAIN_MASK = "[Tool output masked to save context \u2014 older than the recency window. The tool call and its inputs are preserved; re-run the tool if this output is needed again.]";
function buildOffloadPointer(path, previewLines, preview) {
  return `[Large tool output offloaded to save context. Source: ${path}. ` + `Preview (first ${previewLines} lines):
${preview}
` + `\u2026(truncated; re-read "${path}" to load the full content).]`;
}
function buildStatefulMask(exitCode, summary, tailLines, tail) {
  return `[Stateful tool output condensed to save context. Exit code: ${exitCode}. ${summary}.
` + `Last ${tailLines} lines:
${tail}
` + `\u2026(full output not re-fetchable; re-run the tool if needed).]`;
}

// dcp-rewrite/clean-impl/core/glob.ts
function matchesGlob(toolName, pattern) {
  const name = toolName.toLowerCase();
  const pat = pattern.toLowerCase();
  return globMatch(name, pat, 0, 0);
}
function globMatch(s, p, si, pi) {
  while (pi < p.length) {
    const pc = p[pi];
    if (pc === "*") {
      while (pi < p.length && p[pi] === "*")
        pi++;
      if (pi === p.length)
        return true;
      for (let i = si;i <= s.length; i++) {
        if (globMatch(s, p, i, pi))
          return true;
      }
      return false;
    } else if (pc === "?") {
      if (si >= s.length)
        return false;
      si++;
      pi++;
    } else {
      if (si >= s.length || s[si] !== pc)
        return false;
      si++;
      pi++;
    }
  }
  return si === s.length;
}
function findToolClassKey(toolName, toolClasses) {
  if (toolName in toolClasses)
    return toolName;
  for (const key of Object.keys(toolClasses)) {
    if (key.includes("*") || key.includes("?")) {
      if (matchesGlob(toolName, key))
        return key;
    }
  }
  return;
}

// dcp-rewrite/clean-impl/core/strategies/guards.ts
function isAlwaysProtected(toolName) {
  return ALWAYS_PROTECTED_TOOLS.has(toolName);
}
function getRetentionTurns(toolName, config) {
  const key = findToolClassKey(toolName, config.toolClasses);
  if (key)
    return config.toolClasses[key].retentionTurns;
  return config.recencyGuardTurns;
}
function isWithinTieredRetention(toolPart, currentTurn, config) {
  if (toolPart.turn === undefined)
    return false;
  const retention = getRetentionTurns(toolPart.tool, config);
  return currentTurn - toolPart.turn < retention;
}
function isOrphanSafe(toolPart) {
  return toolPart.status === "completed";
}
function collectEligibleToolParts(messages, currentTurn, config) {
  const eligible = [];
  for (const msg of messages) {
    if (msg.isIgnored)
      continue;
    for (let i = 0;i < msg.parts.length; i++) {
      const part = msg.parts[i];
      if (part.type !== "tool")
        continue;
      if (!isOrphanSafe(part))
        continue;
      if (isAlwaysProtected(part.tool))
        continue;
      if (isWithinTieredRetention(part, currentTurn, config))
        continue;
      eligible.push({ messageId: msg.id, partIndex: i, toolPart: part });
    }
  }
  return eligible;
}

// dcp-rewrite/clean-impl/core/strategies/dedup.ts
function toolCallKey(toolPart) {
  const inputStr = typeof toolPart.input === "string" ? toolPart.input : JSON.stringify(toolPart.input);
  return `${toolPart.tool}::${inputStr}`;
}
function runDedup(messages, currentTurn, config, _state) {
  const lastOccurrence = new Map;
  for (let mi = 0;mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.isIgnored)
      continue;
    for (let pi = 0;pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== "tool")
        continue;
      if (part.status !== "completed")
        continue;
      if (isAlwaysProtected(part.tool))
        continue;
      const key = toolCallKey(part);
      lastOccurrence.set(key, { msgIdx: mi, partIdx: pi });
    }
  }
  let dedupCount = 0;
  let tokensSaved = 0;
  const result = messages.map((msg, mi) => {
    if (msg.isIgnored)
      return msg;
    let modified = false;
    const newParts = msg.parts.map((part, pi) => {
      if (part.type !== "tool")
        return part;
      if (part.status !== "completed")
        return part;
      if (isAlwaysProtected(part.tool))
        return part;
      if (isWithinTieredRetention(part, currentTurn, config))
        return part;
      if (part.output === PLACEHOLDER_DEDUP)
        return part;
      const key = toolCallKey(part);
      const last = lastOccurrence.get(key);
      if (!last)
        return part;
      if (last.msgIdx !== mi || last.partIdx !== pi) {
        const savedTokens = (part.output?.length ?? 0) / 4;
        tokensSaved += savedTokens;
        dedupCount++;
        modified = true;
        return { ...part, output: PLACEHOLDER_DEDUP };
      }
      return part;
    });
    if (!modified)
      return msg;
    return { ...msg, parts: newParts };
  });
  return { messages: result, dedupCount, tokensSaved };
}

// dcp-rewrite/clean-impl/core/strategies/staleError.ts
var DEFAULT_STALE_ERROR_TURNS = 3;
function runStaleError(messages, currentTurn, config, _state) {
  const staleAfterTurns = DEFAULT_STALE_ERROR_TURNS;
  let purgedCount = 0;
  let tokensSaved = 0;
  const result = messages.map((msg) => {
    if (msg.isIgnored)
      return msg;
    let modified = false;
    const newParts = msg.parts.map((part) => {
      if (part.type !== "tool")
        return part;
      if (part.status !== "error")
        return part;
      if (isAlwaysProtected(part.tool))
        return part;
      if (part.turn === undefined)
        return part;
      if (currentTurn - part.turn < staleAfterTurns)
        return part;
      if (part.input === PLACEHOLDER_STALE_ERROR_INPUT)
        return part;
      const inputStr = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      const savedTokens = inputStr.length / 4;
      tokensSaved += savedTokens;
      purgedCount++;
      modified = true;
      return { ...part, input: PLACEHOLDER_STALE_ERROR_INPUT };
    });
    if (!modified)
      return msg;
    return { ...msg, parts: newParts };
  });
  return { messages: result, purgedCount, tokensSaved };
}

// dcp-rewrite/clean-impl/core/paths.ts
function buildOffloadPath(workspaceDir, sessionId, callId) {
  return `${workspaceDir}/.context-offload/${sessionId}/${callId}.txt`;
}
function extractPreviewLines(text, n) {
  const lines = text.split(`
`);
  return lines.slice(0, n).join(`
`);
}
function extractTailLines(text, n) {
  const lines = text.split(`
`);
  return lines.slice(-n).join(`
`);
}

// dcp-rewrite/clean-impl/core/strategies/observationMask.ts
var OFFLOAD_PREVIEW_LINES = 10;
var STATEFUL_TAIL_LINES = 20;
var OFFLOAD_MIN_CHARS = 2000;
function isStateless(toolName, config) {
  const key = findToolClassKey(toolName, config.toolClasses);
  if (key)
    return config.toolClasses[key].stateless;
  return true;
}
function extractExitCode(output) {
  const match = output.match(/(?:exit\s*code|exit|returned)[:\s]+(\d+)/i);
  return match ? match[1] : "unknown";
}
function buildPassFailSummary(output) {
  const lower = output.toLowerCase();
  const testMatch = output.match(/(\d+)\s+(?:tests?\s+)?passed.*?(\d+)\s+(?:tests?\s+)?failed/i) ?? output.match(/(\d+)\s+passed.*?(\d+)\s+failed/i);
  if (testMatch) {
    return `${testMatch[1]} passed, ${testMatch[2]} failed`;
  }
  if (lower.includes("error") || lower.includes("failed") || lower.includes("failure")) {
    return "Errors or failures detected";
  }
  if (lower.includes("success") || lower.includes("passed") || lower.includes("ok")) {
    return "Completed successfully";
  }
  return "See tail for details";
}
function runObservationMask(messages, currentTurn, config, state, workspaceDir) {
  const profile = getProfile(config.profile ?? state.activeProfile ?? "documents");
  const eligible = collectEligibleToolParts(messages, currentTurn, config);
  let totalRecoverable = 0;
  for (const { toolPart } of eligible) {
    const entry = state.messageIndex.get(toolPart.callId);
    if (entry?.masked || entry?.offloaded)
      continue;
    totalRecoverable += (toolPart.output?.length ?? 0) / 4;
  }
  if (totalRecoverable < config.clearAtLeast) {
    return { messages, maskedCount: 0, offloadedCount: 0, tokensSaved: 0, offloadRequests: [] };
  }
  if (state.lastMaskingPassTurn > 0 && currentTurn - state.lastMaskingPassTurn < config.minRepruneInterval) {
    return { messages, maskedCount: 0, offloadedCount: 0, tokensSaved: 0, offloadRequests: [] };
  }
  const msgMap = new Map;
  const result = messages.map((m) => {
    const clone = { ...m, parts: [...m.parts] };
    msgMap.set(m.id, clone);
    return clone;
  });
  let maskedCount = 0;
  let offloadedCount = 0;
  let tokensSaved = 0;
  const offloadRequests = [];
  for (const { messageId, partIndex, toolPart } of eligible) {
    const entry = state.messageIndex.get(toolPart.callId);
    if (entry?.masked || entry?.offloaded)
      continue;
    const output = toolPart.output ?? "";
    if (!output)
      continue;
    const stateless = isStateless(toolPart.tool, config);
    const outputTokens = output.length / 4;
    const msg = msgMap.get(messageId);
    if (!msg)
      continue;
    let newPart;
    if (stateless && profile.preferOffload && output.length >= OFFLOAD_MIN_CHARS) {
      const path = buildOffloadPath(workspaceDir, config.sessionId, toolPart.callId);
      const preview = extractPreviewLines(output, OFFLOAD_PREVIEW_LINES);
      const pointer = buildOffloadPointer(path, OFFLOAD_PREVIEW_LINES, preview);
      newPart = { ...toolPart, output: pointer, sourcePath: path };
      offloadRequests.push({ path, content: output });
      offloadedCount++;
      state.messageIndex.set(toolPart.callId, {
        ...entry ?? { messageId, masked: false },
        offloaded: true,
        offloadPath: path
      });
    } else if (stateless || profile.usePlainMaskForStateful) {
      newPart = { ...toolPart, output: PLACEHOLDER_PLAIN_MASK };
      maskedCount++;
      state.messageIndex.set(toolPart.callId, {
        ...entry ?? { messageId, offloaded: false },
        masked: true,
        maskedAt: currentTurn
      });
    } else {
      const exitCode = extractExitCode(output);
      const summary = buildPassFailSummary(output);
      const tail = extractTailLines(output, STATEFUL_TAIL_LINES);
      const mask = buildStatefulMask(exitCode, summary, STATEFUL_TAIL_LINES, tail);
      newPart = { ...toolPart, output: mask };
      maskedCount++;
      state.messageIndex.set(toolPart.callId, {
        ...entry ?? { messageId, offloaded: false },
        masked: true,
        maskedAt: currentTurn
      });
    }
    msg.parts[partIndex] = newPart;
    tokensSaved += outputTokens;
  }
  if (maskedCount > 0 || offloadedCount > 0) {
    state.lastMaskingPassTurn = currentTurn;
    state.lastMaskingPassTime = Date.now();
    state.stats.totalMaskingPasses++;
    state.stats.totalTokensMasked += maskedCount;
    state.stats.totalTokensOffloaded += offloadedCount;
  }
  return { messages: result, maskedCount, offloadedCount, tokensSaved, offloadRequests };
}

// dcp-rewrite/clean-impl/core/cascade.ts
function runCascade(messages, currentTurn, config, state, tokenizer, workspaceDir) {
  let current = messages;
  let totalSaved = 0;
  const dedupResult = runDedup(current, currentTurn, config, state);
  current = dedupResult.messages;
  totalSaved += dedupResult.tokensSaved;
  const staleResult = runStaleError(current, currentTurn, config, state);
  current = staleResult.messages;
  totalSaved += staleResult.tokensSaved;
  const currentTokens = estimateContextTokens(current, tokenizer);
  let maskedCount = 0;
  let offloadedCount = 0;
  let offloadRequests = [];
  if (shouldTriggerMasking(currentTokens, config)) {
    const maskResult = runObservationMask(current, currentTurn, config, state, workspaceDir);
    current = maskResult.messages;
    totalSaved += maskResult.tokensSaved;
    maskedCount = maskResult.maskedCount;
    offloadedCount = maskResult.offloadedCount;
    offloadRequests = maskResult.offloadRequests;
  }
  return {
    messages: current,
    tokensSaved: totalSaved,
    dedupCount: dedupResult.dedupCount,
    staleErrorCount: staleResult.purgedCount,
    maskedCount,
    offloadedCount,
    offloadRequests
  };
}

// dcp-rewrite/clean-impl/core/nudges.ts
function getNudgeLevel(totalTokens, config) {
  const { midSoftNudge, upperThreshold, safetyCap, maskTriggerThreshold } = config.nudges;
  const safetyCapTokens = parseSafetyCapTokens(safetyCap, config.modelContextLimit);
  if (totalTokens >= safetyCapTokens)
    return "safety-cap";
  if (totalTokens >= upperThreshold)
    return "upper";
  if (totalTokens >= midSoftNudge)
    return "mid-soft";
  return "none";
}
function parseSafetyCapTokens(safetyCap, modelContextLimit) {
  const match = safetyCap.match(/^(\d+(?:\.\d+)?)%$/);
  if (!match)
    return Math.floor(modelContextLimit * 0.8);
  return Math.floor(modelContextLimit * parseFloat(match[1]) / 100);
}
function buildNudgeText(level, totalTokens, effectiveBudget) {
  const pct = effectiveBudget > 0 ? Math.round(totalTokens / effectiveBudget * 100) : 0;
  switch (level) {
    case "none":
      return;
    case "mid-soft":
      return `[Context management: ${pct}% of context window used. Consider summarizing completed work with the compress tool if the conversation is getting long.]`;
    case "upper":
      return `[Context management: ${pct}% of context window used. Context is getting full. Use the compress tool to summarize completed sections before continuing.]`;
    case "safety-cap":
      return `[Context management: ${pct}% of context window used. CRITICAL: Context window is nearly full. You MUST use the compress tool immediately to summarize and free space before the next response.]`;
    default:
      return;
  }
}
function shouldInjectCompress(level) {
  return level === "upper" || level === "safety-cap";
}

// dcp-rewrite/clean-impl/core/finalize.ts
function runFinalize(messages) {
  return messages.filter((m) => !m.isIgnored).sort((a, b) => a.createdAt - b.createdAt);
}

// dcp-rewrite/clean-impl/core/pipeline.ts
function runPipeline(input, services) {
  const { messages, state, config, nowMs } = input;
  const { tokenizer, workspaceDir } = services;
  const tagged = runTagging(messages, state);
  const budget = computeBudgetBreakdown(tagged, config, tokenizer);
  const cascadeResult = runCascade(tagged, state.currentTurn, config, state, tokenizer, workspaceDir);
  state.stats.totalTokensSaved += cascadeResult.tokensSaved;
  const postCascadeTokens = estimateContextTokens(cascadeResult.messages, tokenizer);
  const nudgeLevel = getNudgeLevel(postCascadeTokens, config);
  const nudgeText = buildNudgeText(nudgeLevel, postCascadeTokens, budget.effectiveBudget);
  const injectCompress = shouldInjectCompress(nudgeLevel);
  const finalized = runFinalize(cascadeResult.messages);
  const estimatedTokens = estimateContextTokens(finalized, tokenizer);
  return {
    messages: finalized,
    state,
    nudgeText,
    shouldInjectCompress: injectCompress,
    estimatedTokens,
    offloadRequests: cascadeResult.offloadRequests
  };
}

// dcp-rewrite/clean-impl/adapters/opencode/plugin.ts
async function DcpPlugin(_input, options) {
  const pluginOptions = extractPluginOptions(["plugin", options ?? {}]);
  const services = await buildServices(pluginOptions.storagePath);
  const { tokenizer, persistence, logger } = services;
  const sessions = new Map;
  let defaultContextLimit = 1e6;
  async function getOrCreateSession(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing)
      return existing;
    const state = await loadOrCreateState(sessionId, persistence);
    const config = buildCoreConfig(sessionId, pluginOptions, defaultContextLimit, "opencode-go", "deepseek-v4-flash");
    const data = { state, config, entries: [] };
    sessions.set(sessionId, data);
    return data;
  }
  const compressToolDeps = {
    getState: (sessionId) => sessions.get(sessionId)?.state,
    setState: (sessionId, state) => {
      const data = sessions.get(sessionId);
      if (data)
        data.state = state;
    },
    getConfig: (sessionId) => sessions.get(sessionId)?.config,
    getEntries: (sessionId) => sessions.get(sessionId)?.entries,
    setEntries: (sessionId, entries) => {
      const data = sessions.get(sessionId);
      if (data)
        data.entries = entries;
    },
    persistence,
    tokenizer,
    logger
  };
  const compressTool = buildCompressTool(compressToolDeps);
  async function onMessagesTransform(_input2, output) {
    const entries = output.messages;
    if (entries.length === 0)
      return;
    const sessionId = entries[0]?.info?.sessionID;
    if (!sessionId)
      return;
    const data = await getOrCreateSession(sessionId);
    data.entries = entries;
    const neutralMessages = toNeutral(entries);
    if (data.state.currentTurn < entries.length) {
      data.state.currentTurn = entries.length;
    }
    const pipelineResult = runPipeline({
      messages: neutralMessages,
      state: data.state,
      config: data.config,
      nowMs: Date.now()
    }, {
      tokenizer,
      workspaceDir: resolveWorkspaceDir(sessionId)
    });
    for (const req of pipelineResult.offloadRequests) {
      try {
        const { writeFile: writeFile2, mkdir: mkdir2 } = await import("fs/promises");
        const { dirname: dirname2 } = await import("path");
        await mkdir2(dirname2(req.path), { recursive: true });
        await writeFile2(req.path, req.content, "utf8");
      } catch (err) {
        logger.warn(`dcp: failed to write offload file ${req.path}`, err);
      }
    }
    const mutatedEntries = applyNeutral(entries, pipelineResult.messages);
    output.messages = mutatedEntries;
    data.state = pipelineResult.state;
    data.entries = mutatedEntries;
    persistence.save(sessionId, data.state).catch((err) => {
      logger.warn("dcp: failed to persist state after transform", err);
    });
  }
  async function onSystemTransform(input, output) {
    const { model } = input;
    if (isInternalModel(model.modelID))
      return;
    const contextLimit = model.limit?.context;
    if (contextLimit && contextLimit > 0) {
      defaultContextLimit = contextLimit;
    }
    const sessionId = input.sessionID;
    if (!sessionId)
      return;
    const data = sessions.get(sessionId);
    if (!data)
      return;
    if (contextLimit && contextLimit > 0 && data.config.modelContextLimit !== contextLimit) {
      data.config = buildCoreConfig(sessionId, pluginOptions, contextLimit, model.providerID, model.modelID);
    }
    const dcpSystemText = buildDcpSystemText();
    if (dcpSystemText) {
      output.system.push(dcpSystemText);
    }
  }
  async function onTextComplete(_input2, output) {
    output.text = stripHallucinatedTags(output.text);
  }
  async function onEvent(input) {
    const { event } = input;
    if (event.type === "message.part.updated" && typeof event.properties === "object" && event.properties !== null) {
      const part = event.properties["part"];
      if (typeof part === "object" && part !== null && part["type"] === "tool" && part["tool"] === "compress") {
        const sessionID = part["sessionID"];
        if (sessionID) {
          const data = sessions.get(sessionID);
          if (data) {
            data.state.compressionTiming.lastCompressMs = Date.now();
          }
        }
      }
    }
  }
  async function onConfig(_input2) {}
  async function onCommandExecuteBefore(input, output) {
    if (input.command !== "dcp-compress")
      return;
    const { sessionID } = input;
    const data = sessions.get(sessionID);
    if (!data) {
      output.parts = [
        {
          id: "dcp-cmd-error",
          sessionID,
          messageID: "dcp-cmd",
          type: "text",
          text: "dcp-compress: no active session data found. Start a conversation first."
        }
      ];
      return;
    }
    const neutralMessages = toNeutral(data.entries);
    const { selectCompressRange: selectCompressRange2 } = await Promise.resolve().then(() => (init_execute(), exports_execute));
    const range = selectCompressRange2(neutralMessages, data.state, data.state.currentTurn, data.config.recencyGuardTurns);
    if (range.length === 0) {
      output.parts = [
        {
          id: "dcp-cmd-noop",
          sessionID,
          messageID: "dcp-cmd",
          type: "text",
          text: "dcp-compress: nothing to compress (no stable messages outside the recency window)."
        }
      ];
      return;
    }
    const firstMsg = neutralMessages.find((m) => m.id === range[0]);
    const lastMsg = neutralMessages.find((m) => m.id === range[range.length - 1]);
    const startRef = firstMsg?.ref ?? range[0];
    const endRef = lastMsg?.ref ?? range[range.length - 1];
    output.parts = [
      {
        id: "dcp-cmd-trigger",
        sessionID,
        messageID: "dcp-cmd",
        type: "text",
        text: `[Manual compress trigger] Please compress the conversation from ${startRef} to ${endRef} using the compress tool. Use the 7-section structured summary format.`
      }
    ];
  }
  return {
    "experimental.chat.messages.transform": onMessagesTransform,
    "experimental.chat.system.transform": onSystemTransform,
    "experimental.text.complete": onTextComplete,
    event: onEvent,
    config: onConfig,
    "command.execute.before": onCommandExecuteBefore,
    tool: {
      compress: compressTool
    }
  };
}
function resolveWorkspaceDir(sessionId) {
  const root = process.env.WORKSPACES_ROOT ?? "/workspaces";
  return `${root}/.dcp-offload/${sessionId}`;
}
function buildDcpSystemText() {
  return `You have access to a "compress" tool for context management. When you receive a nudge that the context window is getting full, use the compress tool to summarize completed sections of the conversation. This frees space for new work. Never auto-fire it \u2014 only use it when nudged or when you judge the context is getting crowded.`;
}
var server = DcpPlugin;
export {
  server,
  DcpPlugin
};
