const DEFAULT_UI_WIDTH = 460;
const DEFAULT_UI_HEIGHT = 740;
const FULLSCREEN_UI_WIDTH = 960;
const FULLSCREEN_UI_HEIGHT = 860;

figma.showUI(__html__, {
  width: DEFAULT_UI_WIDTH,
  height: DEFAULT_UI_HEIGHT,
  title: "Tokvista"
});

const DEFAULT_COLLECTION_NAME = "Tokvista";
const SCHEMA_VERSION = "1.0.0";
const EXPORT_FORMAT = "tokvista-plugin-v1";
const REM_BASE_PX = 16;
const RAW_TYPE_PLUGIN_KEY = "tokvista_raw_type";
const COMPLEX_JSON_PLUGIN_KEY = "tokvista_complex_json";
const RELAY_SETTINGS_KEY = "tokvista_relay_settings";
const LAST_PUBLISHED_PAYLOAD_KEY = "tokvista_last_published_payload";
const LAST_PUBLISHED_LINKS_KEY = "tokvista_last_published_links";
const PUBLISH_HISTORY_KEY = "tokvista_publish_history";
const DEFAULT_RELAY_URL = "https://tokvista-plugin.vercel.app/api";
const DEFAULT_RELAY_ENVIRONMENT = "dev";
const DEFAULT_TOKVISTA_PREVIEW_BASE_URL = "https://tokvista-plugin.vercel.app/preview";
const DEFAULT_GITHUB_BRANCH = "main";
const DEFAULT_GITHUB_PATH = "tokens.json";
const ALLOWED_RELAY_URL_ORIGINS = new Set<string>(["https://tokvista-plugin.vercel.app"]);
const ALLOWED_IMPORT_URL_ORIGINS = new Set<string>([
  "https://raw.githubusercontent.com",
  "https://tokvista-plugin.vercel.app"
]);

type UiMessage =
  | { type: "import-tokens"; payload: unknown }
  | { type: "import-tokens-from-url"; payload: { url: string } }
  | { type: "export-tokens" }
  | { type: "load-relay-settings" }
  | { type: "load-publish-history" }
  | { type: "preview-publish-changes" }
  | { type: "resolve-preview-link" }
  | { type: "toggle-fullscreen" }
  | { type: "save-relay-settings"; payload: unknown }
  | { type: "set-active-sync-profile"; payload: unknown }
  | { type: "delete-sync-profile"; payload: unknown }
  | { type: "reset-publish-baseline" }
  | { type: "publish-tokvista"; payload: unknown }
  | { type: "open-external-url"; payload: { url: string } };

type ObjectLike = Record<string, unknown>;
type TokenValueType = "COLOR" | "FLOAT" | "STRING";

type ParsedToken = {
  path: string[];
  name: string;
  rawType?: string;
  value: unknown;
};

type PendingAliasToken = ParsedToken & {
  referencePath: string[];
  rawReference: string;
  referenceInner: string;
};

type ImportResult = {
  collection: string;
  imported: number;
  created: number;
  updated: number;
  replaced: number;
  skipped: number;
  warnings: string[];
};

type RelaySettings = {
  provider: "relay" | "github";
  relayUrl: string;
  projectId: string;
  publishKey: string;
  environment: string;
  githubToken: string;
  rememberGithubToken: boolean;
  githubRepo: string;
  githubBranch: string;
  githubPath: string;
};

type RelaySettingsProfile = RelaySettings & {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type RelaySettingsStore = {
  version: 2;
  activeProfileId: string;
  profiles: RelaySettingsProfile[];
};

type RelayPublishResult = {
  versionId: string;
  message: string;
  commitMessage?: string;
  referenceUrl?: string;
  rawUrl?: string;
  previewUrl?: string;
  snapshotPreviewUrl?: string;
  changed?: boolean;
};

type PublishedLinks = {
  versionId?: string;
  referenceUrl?: string;
  rawUrl?: string;
  previewUrl?: string;
  snapshotPreviewUrl?: string;
};

type PublishHistoryEntry = {
  id: string;
  publishedAt: string;
  summary: string;
  added: number;
  changed: number;
  removed: number;
  lines: string[];
  versionId?: string;
  referenceUrl?: string;
  rawUrl?: string;
  previewUrl?: string;
  snapshotPreviewUrl?: string;
};

type PublishChangeLog = {
  summary: string;
  lines: string[];
  added: number;
  changed: number;
  removed: number;
};

type ExportTokensOptions = {
  allowEmpty?: boolean;
  modeName?: string;
};

const MAX_CHANGE_LOG_LINES = 40;
const MAX_PUBLISH_HISTORY_ITEMS = 80;
const DEFAULT_STORAGE_SCOPE_ID = "default";
let isFullscreen = false;

function buildScopedStorageKey(baseKey: string, scopeId: string): string {
  const normalizedScopeId = scopeId.trim();
  return `${baseKey}:${normalizedScopeId || DEFAULT_STORAGE_SCOPE_ID}`;
}

async function getActiveStorageScopeId(): Promise<string> {
  const store = await getStoredRelaySettingsStore();
  return store.activeProfileId || DEFAULT_STORAGE_SCOPE_ID;
}

function isObjectLike(value: unknown): value is ObjectLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenLeaf(value: ObjectLike): boolean {
  return "$value" in value || "value" in value;
}

function extractLeafValue(value: ObjectLike): { rawType?: string; value: unknown } {
  const rawType =
    typeof value.$type === "string"
      ? value.$type
      : typeof value.type === "string"
        ? value.type
        : undefined;
  const leafValue = "$value" in value ? value.$value : value.value;
  return { rawType, value: leafValue };
}

function collectTokens(node: unknown, path: string[] = [], out: ParsedToken[] = []): ParsedToken[] {
  if (!isObjectLike(node)) {
    return out;
  }

  if (isTokenLeaf(node) && path.length > 0) {
    const { rawType, value } = extractLeafValue(node);
    out.push({
      path,
      name: path.join("/"),
      rawType,
      value
    });
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      key.startsWith("$") ||
      key === "type" ||
      key === "$type" ||
      key === "value" ||
      key === "$value" ||
      key === "description"
    ) {
      continue;
    }
    collectTokens(value, [...path, key], out);
  }

  return out;
}

function parseTokens(payload: unknown): ParsedToken[] {
  if (!isObjectLike(payload)) {
    throw new Error("Invalid tokens payload: expected a JSON object.");
  }
  const tokensRoot = isObjectLike(payload.tokens) ? payload.tokens : payload;
  return collectTokens(tokensRoot);
}

function normalizeSyncProvider(input: unknown): "relay" | "github" {
  return input === "github" ? "github" : "relay";
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function formatAllowedOrigins(origins: Set<string>): string {
  return [...origins].sort().join(", ");
}

function assertAllowedOrigin(urlValue: string, allowedOrigins: Set<string>, fieldName: string): void {
  const parsed = parseHttpsUrl(urlValue);
  if (!parsed) {
    throw new Error(`${fieldName} must be a valid https URL.`);
  }
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `${fieldName} host is not allowed in this build. Allowed origins: ${formatAllowedOrigins(allowedOrigins)}`
    );
  }
}

function normalizeRelaySettings(input: unknown, existingSettings: RelaySettings | null): RelaySettings {
  if (!isObjectLike(input)) {
    throw new Error("Invalid publish settings payload.");
  }

  const provider = normalizeSyncProvider(input.provider);
  const relayUrlInput = typeof input.relayUrl === "string" ? input.relayUrl.trim() : "";
  const projectIdInput = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const environmentInput = typeof input.environment === "string" ? input.environment.trim() : "";
  const publishKeyInput = typeof input.publishKey === "string" ? input.publishKey.trim() : "";
  const clearPublishKey = input.clearPublishKey === true;
  const githubTokenInput = typeof input.githubToken === "string" ? input.githubToken.trim() : "";
  const clearGithubToken = input.clearGithubToken === true;
  const rememberGithubTokenInput =
    typeof input.rememberGithubToken === "boolean" ? input.rememberGithubToken : undefined;
  const githubRepoInput = typeof input.githubRepo === "string" ? input.githubRepo.trim() : "";
  const githubBranchInput = typeof input.githubBranch === "string" ? input.githubBranch.trim() : "";
  const githubPathInput = typeof input.githubPath === "string" ? input.githubPath.trim() : "";

  const existingPublishKey =
    existingSettings && existingSettings.provider === "relay" ? existingSettings.publishKey : "";
  const publishKey =
    clearPublishKey ? "" : publishKeyInput || existingPublishKey;
  const existingGithubToken =
    existingSettings && existingSettings.provider === "github" ? existingSettings.githubToken : "";
  const rememberGithubToken =
    provider === "github"
      ? clearGithubToken
        ? false
        : rememberGithubTokenInput !== undefined
        ? rememberGithubTokenInput
        : existingSettings && existingSettings.provider === "github"
          ? existingSettings.rememberGithubToken
          : Boolean(githubTokenInput)
      : false;
  const githubToken = clearGithubToken ? "" : githubTokenInput || (rememberGithubToken ? existingGithubToken : "");
  const normalizedEnvironment = environmentInput || DEFAULT_RELAY_ENVIRONMENT;
  const normalizedRelayUrl = relayUrlInput ? normalizeRelayUrl(relayUrlInput) : "";
  const normalizedGitHubBranch = githubBranchInput || DEFAULT_GITHUB_BRANCH;
  const normalizedGitHubPath = githubPathInput || DEFAULT_GITHUB_PATH;

  if (provider === "relay") {
    if (!relayUrlInput) {
      throw new Error("Relay URL is required.");
    }
    assertAllowedOrigin(normalizedRelayUrl, ALLOWED_RELAY_URL_ORIGINS, "Relay URL");
    if (!projectIdInput) {
      throw new Error("Project ID is required.");
    }
  }
  if (provider === "github") {
    if (!githubRepoInput || !/^[^/\s]+\/[^/\s]+$/.test(githubRepoInput)) {
      throw new Error("Repository must be in owner/repo format.");
    }
  }

  return {
    provider,
    relayUrl: normalizedRelayUrl,
    projectId: projectIdInput,
    publishKey,
    environment: normalizedEnvironment,
    githubToken,
    rememberGithubToken,
    githubRepo: githubRepoInput,
    githubBranch: normalizedGitHubBranch,
    githubPath: normalizedGitHubPath
  };
}

function createSyncProfileId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `sync_${Date.now().toString(36)}_${random}`;
}

function deriveSyncProfileName(settings: RelaySettings): string {
  if (settings.provider === "github") {
    return settings.githubRepo || "GitHub profile";
  }
  if (settings.projectId) {
    return settings.projectId;
  }
  if (settings.relayUrl) {
    return settings.relayUrl.replace(/^https?:\/\//i, "");
  }
  return "Relay profile";
}

function normalizeProfileName(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }
  const trimmed = input.trim();
  return trimmed || fallback;
}

function defaultRelaySettings(): RelaySettings {
  return {
    provider: "relay",
    relayUrl: DEFAULT_RELAY_URL,
    projectId: "",
    publishKey: "",
    environment: DEFAULT_RELAY_ENVIRONMENT,
    githubToken: "",
    rememberGithubToken: false,
    githubRepo: "",
    githubBranch: DEFAULT_GITHUB_BRANCH,
    githubPath: DEFAULT_GITHUB_PATH
  };
}

function createProfileFromSettings(
  settings: RelaySettings,
  profileId?: string,
  profileName?: string,
  createdAt?: string
): RelaySettingsProfile {
  const now = new Date().toISOString();
  return {
    ...settings,
    id: profileId && profileId.trim() ? profileId.trim() : createSyncProfileId(),
    name: normalizeProfileName(profileName, deriveSyncProfileName(settings)),
    createdAt: createdAt && createdAt.trim() ? createdAt : now,
    updatedAt: now
  };
}

function normalizeStoredProfile(input: unknown): RelaySettingsProfile | null {
  if (!isObjectLike(input)) {
    return null;
  }
  try {
    const settings = normalizeRelaySettings(input, null);
    const id = typeof input.id === "string" ? input.id : "";
    const name = typeof input.name === "string" ? input.name : "";
    const createdAt = typeof input.createdAt === "string" ? input.createdAt : "";
    const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : "";
    return {
      ...createProfileFromSettings(settings, id, name, createdAt),
      updatedAt: updatedAt && updatedAt.trim() ? updatedAt : new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function buildDefaultRelaySettingsStore(): RelaySettingsStore {
  const profile = createProfileFromSettings(defaultRelaySettings());
  return {
    version: 2,
    activeProfileId: profile.id,
    profiles: [profile]
  };
}

function normalizeRelaySettingsStore(input: unknown): RelaySettingsStore {
  if (isObjectLike(input) && Array.isArray(input.profiles)) {
    const profiles = input.profiles
      .map((profile) => normalizeStoredProfile(profile))
      .filter((profile): profile is RelaySettingsProfile => Boolean(profile));
    if (!profiles.length) {
      return buildDefaultRelaySettingsStore();
    }
    const activeRaw = typeof input.activeProfileId === "string" ? input.activeProfileId.trim() : "";
    const activeProfileId = profiles.some((profile) => profile.id === activeRaw) ? activeRaw : profiles[0].id;
    return {
      version: 2,
      activeProfileId,
      profiles
    };
  }

  try {
    const legacy = normalizeRelaySettings(input, null);
    const migrated = createProfileFromSettings(legacy);
    return {
      version: 2,
      activeProfileId: migrated.id,
      profiles: [migrated]
    };
  } catch {
    return buildDefaultRelaySettingsStore();
  }
}

function resolveActiveProfile(store: RelaySettingsStore): RelaySettingsProfile {
  return store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0];
}

function normalizeRelayUrl(relayUrlInput: string): string {
  const relayUrl = relayUrlInput.replace(/\/+$/, "");
  if (/^https:\/\/[^/]+\.vercel\.app$/i.test(relayUrl)) {
    return `${relayUrl}/api`;
  }
  return relayUrl;
}

function truncateRelayMessage(message: string): string {
  return message.length > 240 ? `${message.slice(0, 240)}...` : message;
}

function extractCommitMessage(input: unknown): string | undefined {
  if (!isObjectLike(input) || typeof input.commitMessage !== "string") {
    return undefined;
  }
  const singleLine = input.commitMessage.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return undefined;
  }
  return singleLine.slice(0, 120);
}

function buildRelayHttpErrorMessage(statusCode: number, backendMessage: string, endpoint: string): string {
  const lowered = backendMessage.toLowerCase();
  if (statusCode === 401 || statusCode === 403 || lowered.includes("unauthorized")) {
    return "Publish failed: unauthorized. Check project ID and publish key.";
  }
  if (statusCode === 404) {
    return `Publish failed: relay endpoint not found (404) at ${endpoint}. For Vercel, use Relay URL ending with /api.`;
  }
  if (statusCode >= 500) {
    return `Publish failed: relay server error (${statusCode}). ${truncateRelayMessage(backendMessage)}`;
  }
  return `Publish failed (${statusCode}): ${truncateRelayMessage(backendMessage)}`;
}

function stripVolatilePublishFields(payload: ObjectLike): ObjectLike {
  const nextPayload: ObjectLike = { ...payload };
  delete nextPayload.$exportedAt;
  return nextPayload;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableJson(item));
  }
  if (isObjectLike(value)) {
    const sortedKeys = Object.keys(value).sort();
    const out: ObjectLike = {};
    for (const key of sortedKeys) {
      out[key] = normalizeForStableJson(value[key]);
    }
    return out;
  }
  return value;
}

function stableSerialize(value: unknown): string {
  try {
    return JSON.stringify(normalizeForStableJson(value));
  } catch {
    return String(value);
  }
}

function toReadableChangeValue(serializedValue: string): string {
  try {
    const parsed = JSON.parse(serializedValue);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (typeof parsed === "number" || typeof parsed === "boolean") {
      return String(parsed);
    }
    if (parsed === null) {
      return "null";
    }
    return JSON.stringify(parsed);
  } catch {
    return serializedValue;
  }
}

function compactChangeValue(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/\t/g, " ").trim();
  if (cleaned.length <= 72) {
    return cleaned;
  }
  return `${cleaned.slice(0, 72)}...`;
}

function getSnapshotType(rawType: string | undefined): string {
  if (typeof rawType === "string" && rawType.trim()) {
    return rawType.trim();
  }
  return "unknown";
}

function createTokenSnapshotMap(payload: ObjectLike | null): Map<string, { type: string; valueSerialized: string }> {
  const map = new Map<string, { type: string; valueSerialized: string }>();
  if (!payload) {
    return map;
  }

  let tokens: ParsedToken[];
  try {
    tokens = parseTokens(payload);
  } catch {
    return map;
  }

  for (const token of tokens) {
    const path = token.path.join("/");
    map.set(path, {
      type: getSnapshotType(token.rawType),
      valueSerialized: stableSerialize(token.value)
    });
  }
  return map;
}

function buildPublishChangeLog(previousPayload: ObjectLike | null, currentPayload: ObjectLike): PublishChangeLog {
  const previousMap = createTokenSnapshotMap(previousPayload);
  const currentMap = createTokenSnapshotMap(currentPayload);

  if (!previousPayload) {
    const currentPaths = [...currentMap.keys()].sort();
    const lines = currentPaths.slice(0, MAX_CHANGE_LOG_LINES).map((path) => `+ ${path}`);
    if (currentPaths.length > MAX_CHANGE_LOG_LINES) {
      lines.push(`...and ${currentPaths.length - MAX_CHANGE_LOG_LINES} more`);
    }
    return {
      summary: `Initial publish baseline created (${currentMap.size} tokens).`,
      lines,
      added: currentPaths.length,
      changed: 0,
      removed: 0
    };
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const allPaths = new Set<string>([...previousMap.keys(), ...currentMap.keys()]);

  for (const path of [...allPaths].sort()) {
    const previous = previousMap.get(path);
    const current = currentMap.get(path);
    if (!previous && current) {
      added.push(path);
      continue;
    }
    if (previous && !current) {
      removed.push(path);
      continue;
    }
    if (!previous || !current) {
      continue;
    }
    if (previous.type !== current.type) {
      changed.push(`${path}\ttype:${previous.type}\ttype:${current.type}`);
      continue;
    }
    if (previous.valueSerialized !== current.valueSerialized) {
      const previousValue = compactChangeValue(toReadableChangeValue(previous.valueSerialized));
      const currentValue = compactChangeValue(toReadableChangeValue(current.valueSerialized));
      changed.push(`${path}\t${previousValue}\t${currentValue}`);
    }
  }

  const totalChanges = added.length + removed.length + changed.length;
  if (totalChanges === 0) {
    return {
      summary: "No token changes detected.",
      lines: [],
      added: 0,
      changed: 0,
      removed: 0
    };
  }

  const lines = [
    ...added.map((path) => `+ ${path}`),
    ...changed.map((path) => `~ ${path}`),
    ...removed.map((path) => `- ${path}`)
  ];
  const cappedLines = lines.slice(0, MAX_CHANGE_LOG_LINES);
  if (lines.length > MAX_CHANGE_LOG_LINES) {
    cappedLines.push(`...and ${lines.length - MAX_CHANGE_LOG_LINES} more`);
  }

  return {
    summary: `Changes: +${added.length} / ~${changed.length} / -${removed.length}`,
    lines: cappedLines,
    added: added.length,
    changed: changed.length,
    removed: removed.length
  };
}

async function getLastPublishedPayload(): Promise<ObjectLike | null> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_PAYLOAD_KEY, scopeId);
  const scopedRaw = await figma.clientStorage.getAsync(scopedKey);
  if (isObjectLike(scopedRaw)) {
    return scopedRaw;
  }
  const legacyRaw = await figma.clientStorage.getAsync(LAST_PUBLISHED_PAYLOAD_KEY);
  if (isObjectLike(legacyRaw)) {
    await figma.clientStorage.setAsync(scopedKey, legacyRaw);
    return legacyRaw;
  }
  return null;
}

async function setLastPublishedPayload(payload: ObjectLike): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_PAYLOAD_KEY, scopeId);
  await figma.clientStorage.setAsync(scopedKey, payload);
  await figma.clientStorage.deleteAsync(LAST_PUBLISHED_PAYLOAD_KEY);
}

async function clearLastPublishedPayload(): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_PAYLOAD_KEY, scopeId);
  await figma.clientStorage.deleteAsync(scopedKey);
  await figma.clientStorage.deleteAsync(LAST_PUBLISHED_PAYLOAD_KEY);
}

function createEmptyExportPayload(collections: string[] = []): ObjectLike {
  return {
    $schemaVersion: SCHEMA_VERSION,
    $format: EXPORT_FORMAT,
    $source: "figma",
    $exportedAt: new Date().toISOString(),
    meta: {
      exportScope: "all-local-collections",
      collections
    },
    summary: {
      exportedCount: 0,
      exportedAliasCount: 0,
      skippedCount: 0
    },
    tokens: {}
  };
}

function normalizeModeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function resolveModeIdForCollection(collection: VariableCollection, preferredModeName?: string): string {
  if (!preferredModeName) {
    return collection.defaultModeId;
  }
  const normalizedPreferred = normalizeModeLabel(preferredModeName);
  if (!normalizedPreferred) {
    return collection.defaultModeId;
  }
  const byName = collection.modes.find((mode) => normalizeModeLabel(mode.name) === normalizedPreferred);
  if (byName) {
    return byName.modeId;
  }
  const byId = collection.modes.find((mode) => normalizeModeLabel(mode.modeId) === normalizedPreferred);
  if (byId) {
    return byId.modeId;
  }
  return collection.defaultModeId;
}

async function postPublishChangePreview(): Promise<void> {
  try {
    const settings = await getStoredRelaySettings();
    const previousPayload = await getLastPublishedPayload();
    const exported = await exportTokens({
      allowEmpty: true,
      modeName: settings?.environment
    });
    const publishPayload = stripVolatilePublishFields(exported);
    const changeLog = buildPublishChangeLog(previousPayload, publishPayload);
    figma.ui.postMessage({
      type: "publish-change-preview",
      payload: {
        changeLog
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "publish-change-preview",
      payload: {
        error: toErrorMessage(error)
      }
    });
  }
}

async function getStoredRelaySettingsStore(): Promise<RelaySettingsStore> {
  const raw = await figma.clientStorage.getAsync(RELAY_SETTINGS_KEY);
  return normalizeRelaySettingsStore(raw);
}

async function setStoredRelaySettingsStore(store: RelaySettingsStore): Promise<void> {
  await figma.clientStorage.setAsync(RELAY_SETTINGS_KEY, store);
}

async function getStoredRelaySettings(): Promise<RelaySettingsProfile | null> {
  const store = await getStoredRelaySettingsStore();
  if (!store.profiles.length) {
    return null;
  }
  return resolveActiveProfile(store);
}

function normalizeProfileId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function saveRelaySettings(input: unknown): Promise<RelaySettingsProfile> {
  const store = await getStoredRelaySettingsStore();
  const payload = isObjectLike(input) ? input : {};
  const hasProfileIdField = Object.prototype.hasOwnProperty.call(payload, "profileId");
  const requestedProfileId = normalizeProfileId(payload.profileId);
  const shouldCreateNewProfile = hasProfileIdField && !requestedProfileId;
  const existingProfile = shouldCreateNewProfile
    ? null
    : requestedProfileId
      ? store.profiles.find((profile) => profile.id === requestedProfileId) || null
      : resolveActiveProfile(store);
  const normalized = normalizeRelaySettings(payload, existingProfile);
  const profileId = shouldCreateNewProfile
    ? createSyncProfileId()
    : requestedProfileId || existingProfile?.id || createSyncProfileId();
  const nextProfile = createProfileFromSettings(
    normalized,
    profileId,
    normalizeProfileName(payload.profileName, existingProfile?.name || deriveSyncProfileName(normalized)),
    existingProfile?.createdAt
  );
  const storedProfile =
    nextProfile.provider === "github" && !nextProfile.rememberGithubToken
      ? {
          ...nextProfile,
          githubToken: ""
        }
      : nextProfile;
  const nextProfiles = store.profiles.filter((profile) => profile.id !== profileId);
  nextProfiles.unshift(storedProfile);
  const nextStore: RelaySettingsStore = {
    version: 2,
    activeProfileId: profileId,
    profiles: nextProfiles
  };
  await setStoredRelaySettingsStore(nextStore);
  return nextProfile;
}

async function setActiveRelaySettingsProfile(input: unknown): Promise<RelaySettingsStore> {
  const profileId = normalizeProfileId(isObjectLike(input) ? input.profileId : "");
  const store = await getStoredRelaySettingsStore();
  if (store.profiles.some((profile) => profile.id === profileId)) {
    const nextStore: RelaySettingsStore = {
      version: 2,
      activeProfileId: profileId,
      profiles: store.profiles
    };
    await setStoredRelaySettingsStore(nextStore);
    return nextStore;
  }
  return store;
}

async function deleteRelaySettingsProfile(input: unknown): Promise<RelaySettingsStore> {
  const profileId = normalizeProfileId(isObjectLike(input) ? input.profileId : "");
  const store = await getStoredRelaySettingsStore();
  const remaining = store.profiles.filter((profile) => profile.id !== profileId);
  if (!remaining.length) {
    const fallback = buildDefaultRelaySettingsStore();
    await setStoredRelaySettingsStore(fallback);
    return fallback;
  }
  const nextStore: RelaySettingsStore = {
    version: 2,
    activeProfileId:
      store.activeProfileId === profileId
        ? remaining[0].id
        : remaining.some((profile) => profile.id === store.activeProfileId)
          ? store.activeProfileId
          : remaining[0].id,
    profiles: remaining
  };
  await setStoredRelaySettingsStore(nextStore);
  return nextStore;
}

function buildRelaySettingsUiPayload(store: RelaySettingsStore): ObjectLike {
  const active = resolveActiveProfile(store);
  const profiles = store.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name || deriveSyncProfileName(profile),
    provider: profile.provider,
    label: profile.provider === "github" ? profile.githubRepo || "GitHub profile" : profile.projectId || "Relay profile",
    isActive: profile.id === store.activeProfileId
  }));
  return {
    activeProfileId: store.activeProfileId,
    profiles,
    provider: active.provider,
    profileId: active.id,
    profileName: active.name,
    relayUrl: active.relayUrl,
    projectId: active.projectId,
    environment: active.environment,
    publishKeySaved: Boolean(active.publishKey),
    rememberGithubToken: active.rememberGithubToken,
    githubRepo: active.githubRepo,
    githubBranch: active.githubBranch,
    githubPath: active.githubPath,
    githubTokenSaved: Boolean(active.githubToken),
    githubTokenLength: active.githubToken ? active.githubToken.length : 0
  };
}

function postRelaySettingsToUi(store: RelaySettingsStore): void {
  figma.ui.postMessage({
    type: "relay-settings",
    payload: buildRelaySettingsUiPayload(store)
  });
}

function normalizeUrlField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function encodePathForRawUrl(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function buildGitHubRawUrl(owner: string, repo: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/${encodeURIComponent(ref)}/${encodePathForRawUrl(path)}`;
}

function buildPreviewUrlFromRawUrl(rawUrl: string): string {
  const base = DEFAULT_TOKVISTA_PREVIEW_BASE_URL;
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}?source=${encodeURIComponent(rawUrl)}`;
}

function parseGitHubCommitReferenceUrl(referenceUrl: string): { owner: string; repo: string; sha: string } | null {
  const match = referenceUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]{7,40})(?:[/?#].*)?$/i);
  if (!match) {
    return null;
  }
  const owner = match[1];
  const repo = match[2];
  const sha = match[3];
  if (!owner || !repo || !sha) {
    return null;
  }
  return { owner, repo, sha };
}

async function resolvePreviewLinksFromReference(
  referenceUrl: string
): Promise<{ rawUrl?: string; previewUrl?: string }> {
  const parsed = parseGitHubCommitReferenceUrl(referenceUrl);
  if (!parsed) {
    return {};
  }
  try {
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
      parsed.repo
    )}/commits/${encodeURIComponent(parsed.sha)}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok) {
      return {};
    }
    const payload = (await response.json()) as ObjectLike;
    const filesRaw = Array.isArray(payload.files) ? payload.files : [];
    const files = filesRaw.filter(isObjectLike);
    if (!files.length) {
      return {};
    }
    const preferred =
      files.find((file) => {
        const filename = typeof file.filename === "string" ? file.filename.toLowerCase() : "";
        return filename.endsWith(".json") && filename.includes("token");
      }) ||
      files.find((file) => {
        const filename = typeof file.filename === "string" ? file.filename.toLowerCase() : "";
        return filename.endsWith(".json");
      });
    if (!preferred || typeof preferred.filename !== "string") {
      return {};
    }
    const encodedPath = encodePathForRawUrl(preferred.filename);
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(
      parsed.repo
    )}/${encodeURIComponent(parsed.sha)}/${encodedPath}`;
    return {
      rawUrl,
      previewUrl: buildPreviewUrlFromRawUrl(rawUrl)
    };
  } catch {
    return {};
  }
}

function normalizePublishedLinks(input: unknown): PublishedLinks | null {
  if (!isObjectLike(input)) {
    return null;
  }
  const normalized: PublishedLinks = {
    versionId: normalizeUrlField(input.versionId),
    referenceUrl: normalizeUrlField(input.referenceUrl),
    rawUrl: normalizeUrlField(input.rawUrl),
    previewUrl: normalizeUrlField(input.previewUrl),
    snapshotPreviewUrl: normalizeUrlField(input.snapshotPreviewUrl)
  };
  if (
    !normalized.versionId &&
    !normalized.referenceUrl &&
    !normalized.rawUrl &&
    !normalized.previewUrl &&
    !normalized.snapshotPreviewUrl
  ) {
    return null;
  }
  return normalized;
}

function toNonNegativeInteger(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return Math.max(0, Math.floor(input));
  }
  return 0;
}

function normalizePublishHistoryEntry(input: unknown): PublishHistoryEntry | null {
  if (!isObjectLike(input)) {
    return null;
  }
  const publishedAt =
    typeof input.publishedAt === "string" && input.publishedAt.trim()
      ? input.publishedAt.trim()
      : new Date().toISOString();
  const versionId = normalizeUrlField(input.versionId);
  const idRaw =
    typeof input.id === "string" && input.id.trim()
      ? input.id.trim()
      : `${publishedAt}:${versionId || "unversioned"}`;
  const summary =
    typeof input.summary === "string" && input.summary.trim() ? input.summary.trim() : "Publish record";
  const linesRaw = Array.isArray(input.lines) ? input.lines : [];
  const lines = linesRaw
    .filter((line): line is string => typeof line === "string" && Boolean(line.trim()))
    .slice(0, MAX_CHANGE_LOG_LINES);
  const normalized: PublishHistoryEntry = {
    id: idRaw,
    publishedAt,
    summary,
    added: toNonNegativeInteger(input.added),
    changed: toNonNegativeInteger(input.changed),
    removed: toNonNegativeInteger(input.removed),
    lines,
    versionId,
    referenceUrl: normalizeUrlField(input.referenceUrl),
    rawUrl: normalizeUrlField(input.rawUrl),
    previewUrl: normalizeUrlField(input.previewUrl),
    snapshotPreviewUrl: normalizeUrlField(input.snapshotPreviewUrl)
  };
  return normalized;
}

function normalizePublishHistory(input: unknown): PublishHistoryEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: PublishHistoryEntry[] = [];
  for (const item of input) {
    const normalized = normalizePublishHistoryEntry(item);
    if (normalized) {
      out.push(normalized);
    }
  }
  return out.slice(0, MAX_PUBLISH_HISTORY_ITEMS);
}

async function getStoredPublishHistory(): Promise<PublishHistoryEntry[]> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(PUBLISH_HISTORY_KEY, scopeId);
  const scopedRaw = await figma.clientStorage.getAsync(scopedKey);
  if (Array.isArray(scopedRaw)) {
    return normalizePublishHistory(scopedRaw);
  }
  const legacyRaw = await figma.clientStorage.getAsync(PUBLISH_HISTORY_KEY);
  if (Array.isArray(legacyRaw)) {
    const migrated = normalizePublishHistory(legacyRaw);
    await figma.clientStorage.setAsync(scopedKey, migrated);
    return migrated;
  }
  return [];
}

async function setStoredPublishHistory(history: PublishHistoryEntry[]): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(PUBLISH_HISTORY_KEY, scopeId);
  const normalized = normalizePublishHistory(history);
  await figma.clientStorage.setAsync(scopedKey, normalized);
  await figma.clientStorage.deleteAsync(PUBLISH_HISTORY_KEY);
}

async function clearStoredPublishHistory(): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(PUBLISH_HISTORY_KEY, scopeId);
  await figma.clientStorage.deleteAsync(scopedKey);
  await figma.clientStorage.deleteAsync(PUBLISH_HISTORY_KEY);
}

function postPublishHistoryToUi(history: PublishHistoryEntry[]): void {
  figma.ui.postMessage({
    type: "publish-history",
    payload: history
  });
}

async function appendPublishHistoryEntry(entry: PublishHistoryEntry): Promise<PublishHistoryEntry[]> {
  const existing = await getStoredPublishHistory();
  const deduped = existing.filter((item) => item.id !== entry.id);
  const next = [entry, ...deduped].slice(0, MAX_PUBLISH_HISTORY_ITEMS);
  await setStoredPublishHistory(next);
  return next;
}

async function getStoredPublishedLinks(): Promise<PublishedLinks | null> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_LINKS_KEY, scopeId);
  const scopedRaw = await figma.clientStorage.getAsync(scopedKey);
  if (scopedRaw !== undefined) {
    return normalizePublishedLinks(scopedRaw);
  }
  const legacyRaw = await figma.clientStorage.getAsync(LAST_PUBLISHED_LINKS_KEY);
  const normalizedLegacy = normalizePublishedLinks(legacyRaw);
  if (normalizedLegacy) {
    await figma.clientStorage.setAsync(scopedKey, normalizedLegacy);
  }
  return normalizedLegacy;
}

async function setStoredPublishedLinks(links: PublishedLinks): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_LINKS_KEY, scopeId);
  const normalized = normalizePublishedLinks(links);
  if (!normalized) {
    await figma.clientStorage.deleteAsync(scopedKey);
    await figma.clientStorage.deleteAsync(LAST_PUBLISHED_LINKS_KEY);
    return;
  }
  await figma.clientStorage.setAsync(scopedKey, normalized);
  await figma.clientStorage.deleteAsync(LAST_PUBLISHED_LINKS_KEY);
}

async function clearStoredPublishedLinks(): Promise<void> {
  const scopeId = await getActiveStorageScopeId();
  const scopedKey = buildScopedStorageKey(LAST_PUBLISHED_LINKS_KEY, scopeId);
  await figma.clientStorage.deleteAsync(scopedKey);
  await figma.clientStorage.deleteAsync(LAST_PUBLISHED_LINKS_KEY);
}

function postPublishedLinksToUi(links: PublishedLinks | null): void {
  figma.ui.postMessage({
    type: "developer-preview-link",
    payload: links || {}
  });
}

async function loadAndPostPublishedLinks(): Promise<void> {
  let links = await getStoredPublishedLinks();
  if (links && !links.snapshotPreviewUrl && links.rawUrl) {
    links = {
      ...links,
      snapshotPreviewUrl: buildPreviewUrlFromRawUrl(links.rawUrl)
    };
    await setStoredPublishedLinks(links);
  }
  if (links && !links.previewUrl && links.referenceUrl) {
    const resolved = await resolvePreviewLinksFromReference(links.referenceUrl);
    if (resolved.previewUrl || resolved.rawUrl) {
      links = {
        ...links,
        rawUrl: links.rawUrl || resolved.rawUrl,
        previewUrl: links.previewUrl || resolved.previewUrl,
        snapshotPreviewUrl: links.snapshotPreviewUrl || resolved.previewUrl
      };
      await setStoredPublishedLinks(links);
    }
  }
  if (!links || !links.previewUrl) {
    const settings = await getStoredRelaySettings();
    if (settings && settings.provider === "relay" && settings.projectId && settings.publishKey) {
      const resolved = await fetchPreviewLinkFromRelay(settings);
      if (resolved.previewUrl || resolved.rawUrl) {
        links = normalizePublishedLinks({
          ...(links || {}),
          rawUrl: links?.rawUrl || resolved.rawUrl,
          previewUrl: links?.previewUrl || resolved.previewUrl,
          snapshotPreviewUrl:
            links?.snapshotPreviewUrl ||
            (links?.rawUrl ? buildPreviewUrlFromRawUrl(links.rawUrl) : undefined) ||
            (resolved.rawUrl ? buildPreviewUrlFromRawUrl(resolved.rawUrl) : undefined)
        });
        if (links) {
          await setStoredPublishedLinks(links);
        }
      }
    }
    if (settings && settings.provider === "github" && settings.githubRepo && settings.githubPath) {
      const githubRepo = parseGitHubRepo(settings.githubRepo);
      if (githubRepo) {
        const rawUrl = buildGitHubRawUrl(githubRepo.owner, githubRepo.repo, settings.githubBranch, settings.githubPath);
        links = normalizePublishedLinks({
          ...(links || {}),
          rawUrl: links?.rawUrl || rawUrl,
          previewUrl: links?.previewUrl || buildPreviewUrlFromRawUrl(rawUrl),
          snapshotPreviewUrl: links?.snapshotPreviewUrl || buildPreviewUrlFromRawUrl(rawUrl)
        });
        if (links) {
          await setStoredPublishedLinks(links);
        }
      }
    }
  }
  postPublishedLinksToUi(links);
}

async function loadAndPostPublishHistory(): Promise<void> {
  const history = await getStoredPublishHistory();
  postPublishHistoryToUi(history);
}

async function refreshPublishUiState(): Promise<void> {
  await loadAndPostPublishedLinks();
  await loadAndPostPublishHistory();
  await postPublishChangePreview();
}

async function fetchPreviewLinkFromRelay(
  settings: RelaySettings
): Promise<{ rawUrl?: string; previewUrl?: string; snapshotPreviewUrl?: string }> {
  if (settings.provider !== "relay" || !settings.projectId || !settings.publishKey || !settings.relayUrl) {
    return {};
  }
  const endpoint = `${settings.relayUrl}/preview-link`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        projectId: settings.projectId,
        publishKey: settings.publishKey,
        environment: settings.environment
      })
    });
    if (!response.ok) {
      return {};
    }
    const rawText = await response.text();
    if (!rawText) {
      return {};
    }
    let data: ObjectLike = {};
    try {
      data = JSON.parse(rawText) as ObjectLike;
    } catch {
      data = {};
    }
    return {
      rawUrl: typeof data.rawUrl === "string" ? data.rawUrl : undefined,
      previewUrl: typeof data.previewUrl === "string" ? data.previewUrl : undefined,
      snapshotPreviewUrl: typeof data.snapshotPreviewUrl === "string" ? data.snapshotPreviewUrl : undefined
    };
  } catch {
    return {};
  }
}

async function publishToRelay(
  settings: RelaySettings,
  exportPayload: ObjectLike,
  requestedCommitMessage?: string
): Promise<RelayPublishResult> {
  const endpoint = `${settings.relayUrl}/publish-tokens`;
  const publishPayload = stripVolatilePublishFields(exportPayload);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        projectId: settings.projectId,
        publishKey: settings.publishKey,
        environment: settings.environment,
        commitMessage: requestedCommitMessage,
        source: "figma",
        fileKey: figma.fileKey || null,
        payload: publishPayload
      })
    });
  } catch (error) {
    const reason = toErrorMessage(error);
    throw new Error(
      `Publish failed: could not reach relay at ${endpoint}. Check Relay URL and network access. (${truncateRelayMessage(
        reason
      )})`
    );
  }

  const rawText = await response.text();
  let data: ObjectLike = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText) as ObjectLike;
    } catch {
      data = {};
    }
  }

  if (!response.ok) {
    const backendMessage =
      typeof data.error === "string"
        ? data.error
        : rawText || `Relay request failed (${response.status}).`;
    throw new Error(buildRelayHttpErrorMessage(response.status, backendMessage, endpoint));
  }

  const versionId = typeof data.versionId === "string" ? data.versionId : "";
  const message = typeof data.message === "string" ? data.message : "Published successfully.";
  const commitMessage = typeof data.commitMessage === "string" ? data.commitMessage : undefined;
  const referenceUrl = typeof data.referenceUrl === "string" ? data.referenceUrl : undefined;
  let rawUrl = typeof data.rawUrl === "string" ? data.rawUrl : undefined;
  let previewUrl = typeof data.previewUrl === "string" ? data.previewUrl : undefined;
  let snapshotPreviewUrl = typeof data.snapshotPreviewUrl === "string" ? data.snapshotPreviewUrl : undefined;
  if ((!rawUrl || !previewUrl) && referenceUrl) {
    const resolved = await resolvePreviewLinksFromReference(referenceUrl);
    rawUrl = rawUrl || resolved.rawUrl;
    previewUrl = previewUrl || resolved.previewUrl;
    snapshotPreviewUrl = snapshotPreviewUrl || resolved.previewUrl;
  }
  if (!previewUrl) {
    const resolved = await fetchPreviewLinkFromRelay(settings);
    rawUrl = rawUrl || resolved.rawUrl;
    previewUrl = previewUrl || resolved.previewUrl;
    snapshotPreviewUrl = snapshotPreviewUrl || resolved.snapshotPreviewUrl;
  }
  if (!snapshotPreviewUrl && rawUrl) {
    snapshotPreviewUrl = buildPreviewUrlFromRawUrl(rawUrl);
  }
  const changed = typeof data.changed === "boolean" ? data.changed : undefined;
  return {
    versionId,
    message,
    commitMessage,
    referenceUrl,
    rawUrl,
    previewUrl,
    snapshotPreviewUrl,
    changed
  };
}

function createLocalVersionId(): string {
  return `v${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Record<string, number> = BASE64_ALPHABET.split("").reduce((map, char, index) => {
  map[char] = index;
  return map;
}, {} as Record<string, number>);

function utf8ToBytes(input: string): number[] {
  const encoded = encodeURIComponent(input);
  const out: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index];
    if (char === "%" && index + 2 < encoded.length) {
      const hex = encoded.slice(index + 1, index + 3);
      out.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    out.push(char.charCodeAt(0));
  }
  return out;
}

function bytesToUtf8(bytes: number[]): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const hex = bytes[index].toString(16);
    encoded += `%${hex.length === 1 ? `0${hex}` : hex}`;
  }
  return decodeURIComponent(encoded);
}

function utf8ToBase64(input: string): string {
  const bytes = utf8ToBytes(input);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b1 = bytes[index];
    const b2 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b3 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (b1 << 16) | (b2 << 8) | b3;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return out;
}

function base64ToUtf8(input: string): string {
  const clean = input.replace(/\s+/g, "");
  if (!clean || clean.length % 4 !== 0) {
    throw new Error("Invalid base64 input.");
  }
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const c1 = clean[index];
    const c2 = clean[index + 1];
    const c3 = clean[index + 2];
    const c4 = clean[index + 3];
    const v1 = BASE64_LOOKUP[c1];
    const v2 = BASE64_LOOKUP[c2];
    const v3 = c3 === "=" ? 0 : BASE64_LOOKUP[c3];
    const v4 = c4 === "=" ? 0 : BASE64_LOOKUP[c4];
    if (
      typeof v1 !== "number" ||
      typeof v2 !== "number" ||
      (c3 !== "=" && typeof v3 !== "number") ||
      (c4 !== "=" && typeof v4 !== "number")
    ) {
      throw new Error("Invalid base64 characters.");
    }
    const triple = (v1 << 18) | (v2 << 12) | (v3 << 6) | v4;
    bytes.push((triple >> 16) & 255);
    if (c3 !== "=") {
      bytes.push((triple >> 8) & 255);
    }
    if (c4 !== "=") {
      bytes.push(triple & 255);
    }
  }
  return bytesToUtf8(bytes);
}

async function githubRequest(url: string, token: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const inputHeaders = options.headers;
  if (inputHeaders && typeof inputHeaders === "object" && !Array.isArray(inputHeaders)) {
    const source = inputHeaders as Record<string, unknown>;
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const value = source[key];
        if (typeof value === "string") {
          headers[key] = value;
        }
      }
    }
  }
  headers.Authorization = `Bearer ${token}`;
  headers.Accept = "application/vnd.github+json";
  headers["X-GitHub-Api-Version"] = "2022-11-28";
  if (options.method && options.method !== "GET") {
    headers["Content-Type"] = "application/json";
  }
  return fetch(url, { ...options, headers });
}

function responseStatus(response: unknown): number {
  if (!isObjectLike(response)) {
    return 0;
  }
  const status = (response as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  const statusCode = (response as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    return statusCode;
  }
  return 0;
}

function responseOk(response: unknown, status: number): boolean {
  if (isObjectLike(response) && typeof (response as { ok?: unknown }).ok === "boolean") {
    return (response as { ok: boolean }).ok;
  }
  return status >= 200 && status < 300;
}

async function readResponseTextSafe(response: unknown): Promise<string> {
  if (!isObjectLike(response)) {
    return "";
  }
  const textFn = (response as { text?: unknown }).text;
  if (typeof textFn === "function") {
    const value = await (textFn as () => Promise<unknown>).call(response);
    return typeof value === "string" ? value : String(value ?? "");
  }
  const jsonFn = (response as { json?: unknown }).json;
  if (typeof jsonFn === "function") {
    try {
      const value = await (jsonFn as () => Promise<unknown>).call(response);
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return "";
    }
  }
  const body = (response as { body?: unknown }).body;
  return typeof body === "string" ? body : "";
}

async function readResponseJsonSafe(response: unknown): Promise<ObjectLike> {
  if (!isObjectLike(response)) {
    return {};
  }
  const jsonFn = (response as { json?: unknown }).json;
  if (typeof jsonFn === "function") {
    const value = await (jsonFn as () => Promise<unknown>).call(response);
    return isObjectLike(value) ? value : {};
  }
  const text = await readResponseTextSafe(response);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return isObjectLike(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildGitHubContentsApiUrl(owner: string, repo: string, path: string, ref?: string): string {
  const encodedPath = encodePathForRawUrl(path);
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  if (!ref) {
    return base;
  }
  return `${base}?ref=${encodeURIComponent(ref)}`;
}

function normalizePublishMessage(input: string | undefined, fallback: string): string {
  const base = typeof input === "string" ? input : "";
  const singleLine = base.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return fallback;
  }
  return singleLine.slice(0, 120);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isGitHubShaConflict(status: number, message: string): boolean {
  const text = (message || "").toLowerCase();
  if (status !== 409 && status !== 422) {
    return false;
  }
  return text.includes("does not match") || text.includes("sha");
}

async function publishToGitHub(
  settings: RelaySettings,
  exportPayload: ObjectLike,
  requestedCommitMessage?: string
): Promise<RelayPublishResult> {
  if (settings.provider !== "github") {
    throw new Error("GitHub publish settings are not configured.");
  }
  const repoParsed = parseGitHubRepo(settings.githubRepo);
  if (!repoParsed) {
    throw new Error("Repository must be in owner/repo format.");
  }
  if (!settings.githubToken) {
    throw new Error("GitHub Personal Access Token is required.");
  }
  const branch = settings.githubBranch || DEFAULT_GITHUB_BRANCH;
  const path = settings.githubPath || DEFAULT_GITHUB_PATH;

  const publishPayload = stripVolatilePublishFields(exportPayload);
  const content = JSON.stringify(publishPayload, null, 2);
  const versionId = createLocalVersionId();
  const fallbackMessage = `chore(tokens): ${settings.githubRepo} ${settings.environment} ${versionId}`;
  const commitMessage = normalizePublishMessage(requestedCommitMessage, fallbackMessage);

  const readUrl = buildGitHubContentsApiUrl(repoParsed.owner, repoParsed.repo, path, branch);
  const writeUrl = buildGitHubContentsApiUrl(repoParsed.owner, repoParsed.repo, path);

  async function readExistingFileState(): Promise<{ sha?: string; comparable: string }> {
    const bust = Date.now().toString(36);
    const uncachedReadUrl = `${readUrl}${readUrl.includes("?") ? "&" : "?"}_ts=${encodeURIComponent(bust)}`;
    const readResponse = await githubRequest(uncachedReadUrl, settings.githubToken, { method: "GET" });
    const readStatus = responseStatus(readResponse);
    const readOk = responseOk(readResponse, readStatus);
    if (readStatus === 404) {
      return { sha: undefined, comparable: "" };
    }
    if (!readOk) {
      const text = await readResponseTextSafe(readResponse);
      throw new Error(`GitHub read failed (${readStatus || 0}): ${truncateRelayMessage(text)}`);
    }
    const payload = await readResponseJsonSafe(readResponse);
    const sha = typeof payload.sha === "string" ? payload.sha : undefined;
    const encoded = typeof payload.content === "string" ? payload.content.replace(/\n/g, "") : "";
    const decoded = encoded ? base64ToUtf8(encoded) : "";
    let comparable = "";
    try {
      comparable = stableSerialize(JSON.parse(decoded));
    } catch {
      comparable = decoded;
    }
    return { sha, comparable };
  }

  let existingSha: string | undefined;
  let existingComparable = "";
  try {
    const state = await readExistingFileState();
    existingSha = state.sha;
    existingComparable = state.comparable;
  } catch (error) {
    throw new Error(`GitHub publish failed while reading existing file. ${toErrorMessage(error)}`);
  }

  const nextComparable = stableSerialize(publishPayload);
  const branchRawUrl = buildGitHubRawUrl(repoParsed.owner, repoParsed.repo, branch, path);
  const branchPreviewUrl = buildPreviewUrlFromRawUrl(branchRawUrl);
  if (existingComparable && existingComparable === nextComparable) {
    return {
      versionId: "",
      message: "No changes to publish.",
      commitMessage,
      rawUrl: branchRawUrl,
      previewUrl: branchPreviewUrl,
      snapshotPreviewUrl: branchPreviewUrl,
      changed: false
    };
  }

  const requestBody: Record<string, unknown> = {
    message: commitMessage,
    content: utf8ToBase64(content),
    branch
  };
  if (existingSha) {
    requestBody.sha = existingSha;
  }

  let writePayload: ObjectLike = {};
  try {
    async function writeWithBody(body: Record<string, unknown>): Promise<{
      ok: boolean;
      status: number;
      text: string;
      payload: ObjectLike;
    }> {
      const writeResponse = await githubRequest(writeUrl, settings.githubToken, {
        method: "PUT",
        body: JSON.stringify(body)
      });
      const status = responseStatus(writeResponse);
      if (!responseOk(writeResponse, status)) {
        const text = await readResponseTextSafe(writeResponse);
        return { ok: false, status, text: truncateRelayMessage(text), payload: {} };
      }
      const payload = await readResponseJsonSafe(writeResponse);
      return { ok: true, status, text: "", payload };
    }

    const maxAttempts = 3;
    let currentSha = existingSha;
    let writeResult: { ok: boolean; status: number; text: string; payload: ObjectLike } = {
      ok: false,
      status: 0,
      text: "",
      payload: {}
    };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body: Record<string, unknown> = {
        message: commitMessage,
        content: utf8ToBase64(content),
        branch
      };
      if (currentSha) {
        body.sha = currentSha;
      }
      writeResult = await writeWithBody(body);
      if (writeResult.ok) {
        break;
      }
      if (!isGitHubShaConflict(writeResult.status, writeResult.text) || attempt === maxAttempts) {
        break;
      }
      if (attempt > 1) {
        await sleep(200 * attempt);
      }
      const latest = await readExistingFileState();
      if (latest.comparable && latest.comparable === nextComparable) {
        return {
          versionId: "",
          message: "No changes to publish.",
          commitMessage,
          rawUrl: branchRawUrl,
          previewUrl: branchPreviewUrl,
          snapshotPreviewUrl: branchPreviewUrl,
          changed: false
        };
      }
      currentSha = latest.sha;
    }
    if (!writeResult.ok) {
      throw new Error(`GitHub write failed (${writeResult.status || 0}): ${writeResult.text}`);
    }
    writePayload = writeResult.payload;
  } catch (error) {
    throw new Error(`GitHub publish failed while writing file. ${toErrorMessage(error)}`);
  }

  const commit = isObjectLike(writePayload.commit) ? (writePayload.commit as ObjectLike) : {};
  const commitSha = typeof commit.sha === "string" ? commit.sha : "";
  const referenceUrl = typeof commit.html_url === "string" ? commit.html_url : undefined;
  const rawUrl = commitSha ? buildGitHubRawUrl(repoParsed.owner, repoParsed.repo, commitSha, path) : branchRawUrl;
  const previewUrl = buildPreviewUrlFromRawUrl(rawUrl);

  return {
    versionId,
    message: "Published successfully.",
    commitMessage,
    referenceUrl,
    rawUrl,
    previewUrl,
    snapshotPreviewUrl: previewUrl,
    changed: true
  };
}

function parseColor(input: string): RGBA | null {
  const value = input.trim();
  if (value.toLowerCase() === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16) / 255;
      const g = parseInt(h[1] + h[1], 16) / 255;
      const b = parseInt(h[2] + h[2], 16) / 255;
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  const rgb = value.match(/^rgba?\((.+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(",").map((part) => part.trim());
    if (parts.length === 3 || parts.length === 4) {
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      const a = parts.length === 4 ? Number(parts[3]) : 1;
      if ([r, g, b, a].some((part) => Number.isNaN(part))) {
        return null;
      }
      return {
        r: Math.max(0, Math.min(1, r / 255)),
        g: Math.max(0, Math.min(1, g / 255)),
        b: Math.max(0, Math.min(1, b / 255)),
        a: Math.max(0, Math.min(1, a))
      };
    }
  }

  return null;
}

function inferTokenTypeFromRawType(rawType: string | undefined): TokenValueType | null {
  const normalized = typeof rawType === "string" ? rawType.toLowerCase() : undefined;
  if (normalized === "color") {
    return "COLOR";
  }
  if (
    normalized === "number" ||
    normalized === "dimension" ||
    normalized === "spacing" ||
    normalized === "sizing" ||
    normalized === "borderradius" ||
    normalized === "borderwidth" ||
    normalized === "opacity"
  ) {
    return "FLOAT";
  }
  if (
    normalized === "string" ||
    normalized === "fontfamily" ||
    normalized === "fontfamilies" ||
    normalized === "fontweight" ||
    normalized === "fontweights" ||
    normalized === "textcase" ||
    normalized === "textdecoration" ||
    normalized === "strokestyle" ||
    normalized === "borderstyle" ||
    normalized === "duration" ||
    normalized === "cubicbezier" ||
    normalized === "typography" ||
    normalized === "boxshadow" ||
    normalized === "shadow" ||
    normalized === "border" ||
    normalized === "composition"
  ) {
    return "STRING";
  }
  return null;
}

function inferTokenValueType(rawType: string | undefined, value: unknown): TokenValueType | null {
  const inferredFromRawType = inferTokenTypeFromRawType(rawType);
  if (inferredFromRawType) {
    return inferredFromRawType;
  }
  if (typeof value === "number") {
    return "FLOAT";
  }
  if (typeof value === "string" && parseColor(value)) {
    return "COLOR";
  }
  if (typeof value === "string" && parseNumberString(value) !== null) {
    return "FLOAT";
  }
  if (typeof value === "string") {
    return "STRING";
  }
  return null;
}

function parseNumberString(input: string): number | null {
  const value = input.trim().toLowerCase();
  const unitMatch = value.match(/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%)$/);
  if (unitMatch) {
    const amount = Number(unitMatch[1]);
    const unit = unitMatch[2];
    if (Number.isNaN(amount)) {
      return null;
    }
    if (unit === "px") {
      return amount;
    }
    if (unit === "rem" || unit === "em") {
      return amount * REM_BASE_PX;
    }
    return amount / 100;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function normalizeRawType(rawType: string | undefined): string {
  if (typeof rawType !== "string") {
    return "";
  }
  return rawType.trim();
}

function isComplexTokenType(rawType: string): boolean {
  const normalized = rawType.toLowerCase();
  return (
    normalized === "typography" ||
    normalized === "boxshadow" ||
    normalized === "shadow" ||
    normalized === "border" ||
    normalized === "composition"
  );
}

function setVariableTokenMetadata(variable: Variable, rawType: string, isComplexJson: boolean): void {
  if (rawType) {
    variable.setPluginData(RAW_TYPE_PLUGIN_KEY, rawType);
  } else {
    variable.setPluginData(RAW_TYPE_PLUGIN_KEY, "");
  }
  variable.setPluginData(COMPLEX_JSON_PLUGIN_KEY, isComplexJson ? "1" : "0");
}

function getVariableRawType(variable: Variable): string {
  return variable.getPluginData(RAW_TYPE_PLUGIN_KEY).trim();
}

function replaceVariableWithType(
  existing: Variable,
  collection: VariableCollection,
  resolvedType: TokenValueType
): Variable {
  const name = existing.name;
  existing.remove();
  return figma.variables.createVariable(name, collection, resolvedType);
}

async function getOrCreateCollection(name: string): Promise<VariableCollection> {
  const existing = (await figma.variables.getLocalVariableCollectionsAsync()).find(
    (collection) => collection.name === name
  );
  if (existing) {
    return existing;
  }
  return figma.variables.createVariableCollection(name);
}

async function ensureCollectionForPayload(payload: unknown): Promise<VariableCollection> {
  if (isObjectLike(payload) && typeof payload.collection === "string" && payload.collection.trim()) {
    return await getOrCreateCollection(payload.collection.trim());
  }
  return await getOrCreateCollection(DEFAULT_COLLECTION_NAME);
}

function parseAliasReference(
  value: unknown
): { path: string[]; rawReference: string; innerReference: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^\{(.+)\}$/);
  if (!match) {
    return null;
  }
  const inner = match[1].trim();
  if (!inner) {
    return null;
  }

  const separator = inner.includes("/") ? "/" : ".";
  const path = inner
    .split(separator)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (path.length === 0) {
    return null;
  }

  return { path, rawReference: trimmed, innerReference: inner };
}

function toScopedVariableKey(collectionName: string, variableName: string): string {
  return `${collectionName}/${variableName}`;
}

function resolveAliasSourceVariable(
  referencePath: string[],
  referenceInner: string,
  targetCollection: VariableCollection,
  variableByNameInTarget: Map<string, Variable>,
  variableByScopedName: Map<string, Variable>,
  collectionByName: Map<string, VariableCollection>
): Variable | null {
  const candidateNames: string[] = [];
  const addCandidate = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || candidateNames.includes(trimmed)) {
      return;
    }
    candidateNames.push(trimmed);
  };

  addCandidate(referenceInner);
  addCandidate(referencePath.join("/"));
  addCandidate(referencePath.join("."));

  for (const candidate of candidateNames) {
    const directMatch = variableByNameInTarget.get(candidate);
    if (directMatch) {
      return directMatch;
    }
  }

  const sameCollectionPrefixDot = `${targetCollection.name}.`;
  const sameCollectionPrefixSlash = `${targetCollection.name}/`;
  if (referenceInner.startsWith(sameCollectionPrefixDot)) {
    addCandidate(referenceInner.slice(sameCollectionPrefixDot.length));
  }
  if (referenceInner.startsWith(sameCollectionPrefixSlash)) {
    addCandidate(referenceInner.slice(sameCollectionPrefixSlash.length));
  }
  if (referencePath.length > 1 && referencePath[0] === targetCollection.name) {
    addCandidate(referencePath.slice(1).join("/"));
    addCandidate(referencePath.slice(1).join("."));
  }

  for (const candidate of candidateNames) {
    const sameCollectionMatch = variableByNameInTarget.get(candidate);
    if (sameCollectionMatch) {
      return sameCollectionMatch;
    }
  }

  const scopedCandidates = new Set<string>();

  const addScopedCandidates = (collectionName: string, variableName: string): void => {
    const trimmed = variableName.trim();
    if (!trimmed) {
      return;
    }
    scopedCandidates.add(toScopedVariableKey(collectionName, trimmed));
  };

  if (referencePath.length > 1) {
    const firstSegmentCollection = collectionByName.get(referencePath[0]);
    if (firstSegmentCollection) {
      addScopedCandidates(firstSegmentCollection.name, referencePath.slice(1).join("/"));
      addScopedCandidates(firstSegmentCollection.name, referencePath.slice(1).join("."));
    }
  }

  for (const [collectionName] of collectionByName) {
    const dotPrefix = `${collectionName}.`;
    if (referenceInner.startsWith(dotPrefix)) {
      addScopedCandidates(collectionName, referenceInner.slice(dotPrefix.length));
    }
    const slashPrefix = `${collectionName}/`;
    if (referenceInner.startsWith(slashPrefix)) {
      addScopedCandidates(collectionName, referenceInner.slice(slashPrefix.length));
    }
  }

  for (const scopedCandidate of scopedCandidates) {
    const scopedMatch = variableByScopedName.get(scopedCandidate);
    if (scopedMatch) {
      return scopedMatch;
    }
  }

  for (const candidate of candidateNames) {
    const uniqueSuffix = `/${candidate}`;
    let uniqueMatch: Variable | null = null;
    for (const [scopedName, variable] of variableByScopedName) {
      if (!scopedName.endsWith(uniqueSuffix)) {
        continue;
      }
      if (uniqueMatch) {
        uniqueMatch = null;
        break;
      }
      uniqueMatch = variable;
    }
    if (uniqueMatch) {
      return uniqueMatch;
    }
  }

  return null;
}

function variableTypeToTokenValueType(resolvedType: VariableResolvedDataType): TokenValueType | null {
  if (resolvedType === "COLOR") {
    return "COLOR";
  }
  if (resolvedType === "FLOAT") {
    return "FLOAT";
  }
  if (resolvedType === "STRING") {
    return "STRING";
  }
  return null;
}

async function importTokens(payload: unknown): Promise<ImportResult> {
  const collection = await ensureCollectionForPayload(payload);
  const modeId = collection.defaultModeId;
  const tokens = parseTokens(payload);

  const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionById = new Map(localCollections.map((item) => [item.id, item]));
  const collectionByName = new Map(localCollections.map((item) => [item.name, item]));
  const allLocalVariables = await figma.variables.getLocalVariablesAsync();

  const variableByNameInTarget = new Map<string, Variable>();
  const variableByScopedName = new Map<string, Variable>();

  for (const variable of allLocalVariables) {
    const variableCollection = collectionById.get(variable.variableCollectionId);
    if (!variableCollection) {
      continue;
    }
    variableByScopedName.set(toScopedVariableKey(variableCollection.name, variable.name), variable);
    if (variableCollection.id === collection.id) {
      variableByNameInTarget.set(variable.name, variable);
    }
  }

  const warnings: string[] = [];
  const pendingAliases: PendingAliasToken[] = [];
  let created = 0;
  let updated = 0;
  let replaced = 0;
  let skipped = 0;

  for (const token of tokens) {
    const aliasReference = parseAliasReference(token.value);
    if (aliasReference) {
      pendingAliases.push({
        ...token,
        referencePath: aliasReference.path,
        rawReference: aliasReference.rawReference,
        referenceInner: aliasReference.innerReference
      });
      continue;
    }

    const resolvedType = inferTokenValueType(token.rawType, token.value);
    if (!resolvedType) {
      skipped += 1;
      const unsupportedType = token.rawType === undefined ? "unknown" : token.rawType;
      warnings.push(`Skipped ${token.name}: unsupported type "${unsupportedType}".`);
      continue;
    }

    const tokenRawType = normalizeRawType(token.rawType);
    let nextValue: VariableValue;
    let isComplexJsonValue = false;
    if (resolvedType === "COLOR") {
      if (typeof token.value !== "string") {
        skipped += 1;
        warnings.push(`Skipped ${token.name}: color value must be a string.`);
        continue;
      }
      const color = parseColor(token.value);
      if (!color) {
        skipped += 1;
        warnings.push(`Skipped ${token.name}: could not parse color "${token.value}".`);
        continue;
      }
      nextValue = color;
    } else if (resolvedType === "FLOAT") {
      let numericValue: number | null = null;
      if (typeof token.value === "number") {
        numericValue = token.value;
      } else if (typeof token.value === "string") {
        numericValue = parseNumberString(token.value);
      }
      if (numericValue === null) {
        skipped += 1;
        warnings.push(
          `Skipped ${token.name}: number value must be numeric (e.g. 8, "8", "8px", "0.5rem").`
        );
        continue;
      }
      nextValue = numericValue;
    } else {
      if (typeof token.value === "string") {
        nextValue = token.value;
      } else if (typeof token.value === "number" || typeof token.value === "boolean") {
        nextValue = String(token.value);
      } else if (token.value === null) {
        nextValue = "null";
      } else {
        try {
          nextValue = JSON.stringify(token.value);
          isComplexJsonValue = true;
        } catch (error) {
          skipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Skipped ${token.name}: could not serialize complex value. ${message}`);
          continue;
        }
      }
    }

    const existing = variableByNameInTarget.get(token.name);
    if (existing) {
      if (existing.resolvedType !== resolvedType) {
        try {
          const replacedVariable = replaceVariableWithType(existing, collection, resolvedType);
          replacedVariable.setValueForMode(modeId, nextValue);
          setVariableTokenMetadata(
            replacedVariable,
            tokenRawType || (resolvedType === "STRING" ? "string" : ""),
            resolvedType === "STRING" && isComplexJsonValue
          );
          variableByNameInTarget.set(token.name, replacedVariable);
          variableByScopedName.set(toScopedVariableKey(collection.name, token.name), replacedVariable);
          replaced += 1;
          warnings.push(
            `Replaced ${token.name}: variable type changed from ${existing.resolvedType} to ${resolvedType}.`
          );
          continue;
        } catch (error) {
          skipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Skipped ${token.name}: type mismatch (${existing.resolvedType} vs ${resolvedType}) and replacement failed. ${message}`
          );
          continue;
        }
      }
      existing.setValueForMode(modeId, nextValue);
      setVariableTokenMetadata(
        existing,
        tokenRawType || (resolvedType === "STRING" ? "string" : ""),
        resolvedType === "STRING" && isComplexJsonValue
      );
      updated += 1;
      continue;
    }

    const createdVariable = figma.variables.createVariable(token.name, collection, resolvedType);
    createdVariable.setValueForMode(modeId, nextValue);
    setVariableTokenMetadata(
      createdVariable,
      tokenRawType || (resolvedType === "STRING" ? "string" : ""),
      resolvedType === "STRING" && isComplexJsonValue
    );
    variableByNameInTarget.set(token.name, createdVariable);
    variableByScopedName.set(toScopedVariableKey(collection.name, token.name), createdVariable);
    created += 1;
  }

  let unresolvedAliases = pendingAliases;
  let madeProgress = true;

  while (unresolvedAliases.length > 0 && madeProgress) {
    madeProgress = false;
    const nextUnresolved: PendingAliasToken[] = [];

    for (const token of unresolvedAliases) {
      const sourceVariable = resolveAliasSourceVariable(
        token.referencePath,
        token.referenceInner,
        collection,
        variableByNameInTarget,
        variableByScopedName,
        collectionByName
      );

      if (!sourceVariable) {
        nextUnresolved.push(token);
        continue;
      }

      const sourceType = variableTypeToTokenValueType(sourceVariable.resolvedType);
      if (!sourceType) {
        skipped += 1;
        warnings.push(
          `Skipped ${token.name}: alias source "${token.rawReference}" has unsupported variable type ${sourceVariable.resolvedType}.`
        );
        continue;
      }

      const explicitType = inferTokenTypeFromRawType(token.rawType);
      if (explicitType && explicitType !== sourceType) {
        skipped += 1;
        warnings.push(
          `Skipped ${token.name}: alias type "${explicitType}" does not match source type "${sourceType}".`
        );
        continue;
      }

      let targetVariable = variableByNameInTarget.get(token.name);
      const targetType = explicitType || sourceType;
      let createdInThisStep = false;
      let replacedInThisStep = false;

      if (!targetVariable) {
        targetVariable = figma.variables.createVariable(token.name, collection, targetType);
        variableByNameInTarget.set(token.name, targetVariable);
        variableByScopedName.set(toScopedVariableKey(collection.name, token.name), targetVariable);
        createdInThisStep = true;
      } else if (targetVariable.resolvedType !== targetType) {
        const previousType = targetVariable.resolvedType;
        try {
          const replacedVariable = replaceVariableWithType(targetVariable, collection, targetType);
          targetVariable = replacedVariable;
          variableByNameInTarget.set(token.name, targetVariable);
          variableByScopedName.set(toScopedVariableKey(collection.name, token.name), targetVariable);
          replacedInThisStep = true;
          replaced += 1;
          warnings.push(
            `Replaced ${token.name}: variable type changed from ${previousType} to ${targetType} for alias import.`
          );
        } catch (error) {
          skipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(
            `Skipped ${token.name}: existing variable type ${previousType} does not match alias type ${targetType}. Replacement failed. ${message}`
          );
          continue;
        }
      }

      try {
        if (targetVariable.id === sourceVariable.id) {
          skipped += 1;
          warnings.push(`Skipped ${token.name}: alias cannot reference itself (${token.rawReference}).`);
          continue;
        }
        targetVariable.setValueForMode(modeId, figma.variables.createVariableAlias(sourceVariable));
        setVariableTokenMetadata(
          targetVariable,
          normalizeRawType(token.rawType) || (targetType === "STRING" ? "string" : ""),
          false
        );
        if (createdInThisStep) {
          created += 1;
        } else if (replacedInThisStep) {
          // Counted in replaced.
        } else {
          updated += 1;
        }
        madeProgress = true;
      } catch (error) {
        skipped += 1;
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Skipped ${token.name}: failed to set alias ${token.rawReference}. ${message}`);
      }
    }

    unresolvedAliases = nextUnresolved;
  }

  for (const token of unresolvedAliases) {
    skipped += 1;
    warnings.push(`Skipped ${token.name}: unresolved alias reference ${token.rawReference}.`);
  }

  return {
    collection: collection.name,
    imported: created + updated + replaced,
    created,
    updated,
    replaced,
    skipped,
    warnings
  };
}

function toHexColor(color: RGBA): string {
  const toHex = (value: number): string => {
    const scaled = Math.round(Math.max(0, Math.min(1, value)) * 255);
    return scaled.toString(16).padStart(2, "0");
  };
  const r = toHex(color.r);
  const g = toHex(color.g);
  const b = toHex(color.b);
  const a = toHex(color.a);
  return a === "ff" ? `#${r}${g}${b}` : `#${r}${g}${b}${a}`;
}

function isRgbaValue(value: VariableValue): value is RGBA {
  return (
    typeof value === "object" &&
    value !== null &&
    "r" in value &&
    "g" in value &&
    "b" in value &&
    "a" in value
  );
}

function isAliasValue(value: VariableValue): value is VariableAlias {
  return typeof value === "object" && value !== null && "type" in value && value.type === "VARIABLE_ALIAS";
}

function setNestedTokenValue(target: ObjectLike, path: string[], token: ObjectLike): void {
  let cursor: ObjectLike = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const existing = cursor[key];
    if (!isObjectLike(existing)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as ObjectLike;
  }
  cursor[path[path.length - 1]] = token;
}

function toTokenTypeForExport(variable: Variable): string | null {
  const rawType = getVariableRawType(variable);
  if (rawType) {
    return rawType;
  }
  if (variable.resolvedType === "COLOR") {
    return "color";
  }
  if (variable.resolvedType === "FLOAT") {
    return "number";
  }
  if (variable.resolvedType === "STRING") {
    return "string";
  }
  return null;
}

function toTokenValueForExport(variable: Variable, value: string): unknown {
  const rawType = getVariableRawType(variable);
  const isComplexJson = variable.getPluginData(COMPLEX_JSON_PLUGIN_KEY) === "1";
  if (isComplexJson || isComplexTokenType(rawType)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function exportTokens(options: ExportTokensOptions = {}): Promise<ObjectLike> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  if (collections.length === 0) {
    if (options.allowEmpty) {
      return createEmptyExportPayload();
    }
    throw new Error("No local variable collections found.");
  }

  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const variables = await figma.variables.getLocalVariablesAsync();
  const sortedVariables = [...variables].sort((left, right) => {
    const leftCollection = collectionById.get(left.variableCollectionId)?.name || "";
    const rightCollection = collectionById.get(right.variableCollectionId)?.name || "";
    if (leftCollection !== rightCollection) {
      return leftCollection.localeCompare(rightCollection);
    }
    return left.name.localeCompare(right.name);
  });
  const variableById = new Map(variables.map((variable) => [variable.id, variable]));
  const tokens: ObjectLike = {};
  const exportedCollectionNames = new Set<string>();
  let exportedCount = 0;
  let exportedAliasCount = 0;
  let skippedCount = 0;

  for (const variable of sortedVariables) {
    const collection = collectionById.get(variable.variableCollectionId);
    if (!collection) {
      continue;
    }
    exportedCollectionNames.add(collection.name);
    const modeId = resolveModeIdForCollection(collection, options.modeName);
    const value = variable.valuesByMode[modeId] ?? variable.valuesByMode[collection.defaultModeId];
    const segments = [collection.name, ...variable.name.split("/").filter(Boolean)];

    if (segments.length < 2) {
      continue;
    }

    if (isAliasValue(value)) {
      const sourceVariable = variableById.get(value.id);
      if (!sourceVariable) {
        skippedCount += 1;
        continue;
      }
      const sourceCollection = collectionById.get(sourceVariable.variableCollectionId);
      if (!sourceCollection) {
        skippedCount += 1;
        continue;
      }
      const exportType = toTokenTypeForExport(variable);
      if (!exportType) {
        skippedCount += 1;
        continue;
      }

      const sourcePath = [sourceCollection.name, ...sourceVariable.name.split("/").filter(Boolean)];
      setNestedTokenValue(tokens, segments, {
        type: exportType,
        value: `{${sourcePath.join(".")}}`
      });
      exportedCount += 1;
      exportedAliasCount += 1;
      continue;
    }

    if (variable.resolvedType === "COLOR" && isRgbaValue(value)) {
      setNestedTokenValue(tokens, segments, {
        type: toTokenTypeForExport(variable) || "color",
        value: toHexColor(value)
      });
      exportedCount += 1;
    } else if (variable.resolvedType === "FLOAT" && typeof value === "number") {
      setNestedTokenValue(tokens, segments, {
        type: toTokenTypeForExport(variable) || "number",
        value
      });
      exportedCount += 1;
    } else if (variable.resolvedType === "STRING" && typeof value === "string") {
      setNestedTokenValue(tokens, segments, {
        type: toTokenTypeForExport(variable) || "string",
        value: toTokenValueForExport(variable, value)
      });
      exportedCount += 1;
    } else {
      skippedCount += 1;
    }
  }

  if (exportedCount === 0) {
    if (options.allowEmpty) {
      return createEmptyExportPayload([...exportedCollectionNames]);
    }
    throw new Error("No exportable local variables found in selected mode.");
  }

  return {
    $schemaVersion: SCHEMA_VERSION,
    $format: EXPORT_FORMAT,
    $source: "figma",
    $exportedAt: new Date().toISOString(),
    meta: {
      exportScope: "all-local-collections",
      collections: [...exportedCollectionNames]
    },
    summary: {
      exportedCount,
      exportedAliasCount,
      skippedCount
    },
    tokens
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }
  return String(error);
}

function normalizeHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return "";
  }
  if (/\s/.test(trimmed)) {
    return "";
  }
  const parsed = parseHttpsUrl(trimmed);
  if (!parsed) {
    return "";
  }
  return parsed.toString();
}

async function importTokensFromUrl(urlValue: unknown): Promise<ImportResult> {
  const url = normalizeHttpUrl(urlValue);
  if (!url) {
    throw new Error("Invalid URL. Use a valid https tokens.json URL.");
  }
  assertAllowedOrigin(url, ALLOWED_IMPORT_URL_ORIGINS, "Import URL");
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to fetch tokens from URL (${response.status}).`);
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error("URL returned an empty response.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("URL did not return valid JSON.");
  }
  return importTokens(payload);
}

async function loadAndPostRelaySettings(): Promise<void> {
  const store = await getStoredRelaySettingsStore();
  postRelaySettingsToUi(store);
}

function postFullscreenState(): void {
  figma.ui.postMessage({
    type: "fullscreen-state",
    payload: {
      enabled: isFullscreen
    }
  });
}

async function initializeUiState(): Promise<void> {
  await loadAndPostRelaySettings();
  await loadAndPostPublishedLinks();
  await loadAndPostPublishHistory();
  await postPublishChangePreview();
  postFullscreenState();
}

void initializeUiState();

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === "import-tokens") {
    try {
      const result = await importTokens(msg.payload);
      await postPublishChangePreview();
      figma.ui.postMessage({
        type: "import-result",
        payload: result
      });
      figma.notify(
        `Import complete: ${result.imported} applied (${result.created} created, ${result.updated} updated, ${result.replaced} replaced), ${result.skipped} skipped in "${result.collection}".`
      );
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Import failed: ${message}`);
    }
    return;
  }

  if (msg.type === "export-tokens") {
    try {
      const settings = await getStoredRelaySettings();
      const payload = await exportTokens({
        allowEmpty: true,
        modeName: settings?.environment
      });
      figma.ui.postMessage({
        type: "export-result",
        payload
      });
      figma.notify("Export complete.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Export failed: ${message}`);
    }
    return;
  }

  if (msg.type === "load-relay-settings") {
    try {
      await loadAndPostRelaySettings();
      await loadAndPostPublishedLinks();
      await loadAndPostPublishHistory();
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
    }
    return;
  }

  if (msg.type === "import-tokens-from-url") {
    try {
      const importUrl =
        isObjectLike(msg.payload) && typeof msg.payload.url === "string" ? msg.payload.url : "";
      const result = await importTokensFromUrl(importUrl);
      await postPublishChangePreview();
      figma.ui.postMessage({
        type: "import-result",
        payload: result
      });
      figma.notify(
        `Import complete: ${result.imported} applied (${result.created} created, ${result.updated} updated, ${result.replaced} replaced), ${result.skipped} skipped in "${result.collection}".`
      );
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Import failed: ${message}`);
    }
    return;
  }

  if (msg.type === "load-publish-history") {
    await loadAndPostPublishHistory();
    return;
  }

  if (msg.type === "preview-publish-changes") {
    await postPublishChangePreview();
    return;
  }

  if (msg.type === "resolve-preview-link") {
    try {
      const existingLinks = await getStoredPublishedLinks();
      if (existingLinks?.previewUrl) {
        postPublishedLinksToUi(existingLinks);
        return;
      }
      const settings = await getStoredRelaySettings();
      if (!settings) {
        figma.ui.postMessage({
          type: "error",
          payload: "Preview link unavailable. Configure sync provider settings first."
        });
        return;
      }
      if (settings.provider === "github") {
        const repo = parseGitHubRepo(settings.githubRepo);
        if (!repo || !settings.githubPath) {
          figma.ui.postMessage({
            type: "error",
            payload: "Preview link unavailable. Configure GitHub repository and token file path."
          });
          return;
        }
        const rawUrl = buildGitHubRawUrl(repo.owner, repo.repo, settings.githubBranch, settings.githubPath);
        const previewUrl = buildPreviewUrlFromRawUrl(rawUrl);
        const merged = normalizePublishedLinks({
          ...(existingLinks || {}),
          rawUrl: existingLinks?.rawUrl || rawUrl,
          previewUrl: existingLinks?.previewUrl || previewUrl,
          snapshotPreviewUrl: existingLinks?.snapshotPreviewUrl || previewUrl
        });
        if (merged) {
          await setStoredPublishedLinks(merged);
        }
        postPublishedLinksToUi(merged);
        return;
      }
      if (!settings.projectId || !settings.publishKey) {
        figma.ui.postMessage({
          type: "error",
          payload: "Preview link unavailable. Configure Project ID and Publish key in Settings."
        });
        return;
      }
      const resolved = await fetchPreviewLinkFromRelay(settings);
      if (!resolved.previewUrl && !resolved.rawUrl) {
        figma.ui.postMessage({
          type: "error",
          payload: "Preview link unavailable from relay. Redeploy backend with /preview-link support."
        });
        return;
      }
      const merged = normalizePublishedLinks({
        ...(existingLinks || {}),
        rawUrl: existingLinks?.rawUrl || resolved.rawUrl,
        previewUrl: existingLinks?.previewUrl || resolved.previewUrl,
        snapshotPreviewUrl:
          existingLinks?.snapshotPreviewUrl ||
          resolved.snapshotPreviewUrl ||
          (resolved.rawUrl ? buildPreviewUrlFromRawUrl(resolved.rawUrl) : undefined)
      });
      if (merged) {
        await setStoredPublishedLinks(merged);
      }
      postPublishedLinksToUi(merged);
    } catch (error) {
      figma.ui.postMessage({ type: "error", payload: toErrorMessage(error) });
    }
    return;
  }

  if (msg.type === "toggle-fullscreen") {
    isFullscreen = !isFullscreen;
    figma.ui.resize(
      isFullscreen ? FULLSCREEN_UI_WIDTH : DEFAULT_UI_WIDTH,
      isFullscreen ? FULLSCREEN_UI_HEIGHT : DEFAULT_UI_HEIGHT
    );
    postFullscreenState();
    return;
  }

  if (msg.type === "save-relay-settings") {
    try {
      await saveRelaySettings(msg.payload);
      const store = await getStoredRelaySettingsStore();
      postRelaySettingsToUi(store);
      figma.ui.postMessage({
        type: "relay-settings-saved",
        payload: buildRelaySettingsUiPayload(store)
      });
      await refreshPublishUiState();
      figma.notify("Tokvista publish settings saved.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Save failed: ${message}`);
    }
    return;
  }

  if (msg.type === "set-active-sync-profile") {
    try {
      const store = await setActiveRelaySettingsProfile(msg.payload);
      postRelaySettingsToUi(store);
      figma.ui.postMessage({
        type: "relay-settings-saved",
        payload: buildRelaySettingsUiPayload(store)
      });
      await refreshPublishUiState();
      figma.notify("Active sync profile updated.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Update failed: ${message}`);
    }
    return;
  }

  if (msg.type === "delete-sync-profile") {
    try {
      const store = await deleteRelaySettingsProfile(msg.payload);
      postRelaySettingsToUi(store);
      figma.ui.postMessage({
        type: "relay-settings-saved",
        payload: buildRelaySettingsUiPayload(store)
      });
      await refreshPublishUiState();
      figma.notify("Sync profile deleted.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Delete failed: ${message}`);
    }
    return;
  }

  if (msg.type === "reset-publish-baseline") {
    try {
      await clearLastPublishedPayload();
      await clearStoredPublishHistory();
      await clearStoredPublishedLinks();
      await refreshPublishUiState();
      figma.notify("Publish baseline reset.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Reset failed: ${message}`);
    }
    return;
  }

  if (msg.type === "publish-tokvista") {
    try {
      const saved = await saveRelaySettings(msg.payload);
      const commitMessage = extractCommitMessage(msg.payload);
      const exported = await exportTokens({
        modeName: saved.environment
      });
      const publishPayload = stripVolatilePublishFields(exported);
      const previousPayload = await getLastPublishedPayload();
      let changeLog = buildPublishChangeLog(previousPayload, publishPayload);
      const publishResult =
        saved.provider === "github"
          ? await publishToGitHub(saved, exported, commitMessage)
          : await publishToRelay(saved, exported, commitMessage);
      if (publishResult.changed === false && changeLog.summary !== "No token changes detected.") {
        changeLog = {
          summary: "No token changes detected.",
          lines: [],
          added: 0,
          changed: 0,
          removed: 0
        };
      }
      await setLastPublishedPayload(publishPayload);
      const existingLinks = await getStoredPublishedLinks();
      const mergedLinks = normalizePublishedLinks({
        versionId: publishResult.versionId || existingLinks?.versionId,
        referenceUrl: publishResult.referenceUrl || existingLinks?.referenceUrl,
        rawUrl: publishResult.rawUrl || existingLinks?.rawUrl,
        previewUrl: publishResult.previewUrl || existingLinks?.previewUrl,
        snapshotPreviewUrl:
          publishResult.snapshotPreviewUrl ||
          existingLinks?.snapshotPreviewUrl ||
          (publishResult.rawUrl ? buildPreviewUrlFromRawUrl(publishResult.rawUrl) : undefined)
      });
      if (mergedLinks) {
        await setStoredPublishedLinks(mergedLinks);
      }
      postPublishedLinksToUi(mergedLinks);
      const publishTarget = saved.provider === "github" ? saved.githubRepo : saved.projectId;
      const historyEntry = normalizePublishHistoryEntry({
        id: `${publishResult.versionId || new Date().toISOString()}:${publishTarget}:${saved.environment}`,
        publishedAt: new Date().toISOString(),
        summary: changeLog.summary,
        added: changeLog.added,
        changed: changeLog.changed,
        removed: changeLog.removed,
        lines: changeLog.lines,
        versionId: publishResult.versionId || mergedLinks?.versionId,
        referenceUrl: publishResult.referenceUrl || mergedLinks?.referenceUrl,
        rawUrl: publishResult.rawUrl || mergedLinks?.rawUrl,
        previewUrl: publishResult.previewUrl || mergedLinks?.previewUrl,
        snapshotPreviewUrl:
          publishResult.snapshotPreviewUrl ||
          mergedLinks?.snapshotPreviewUrl ||
          (publishResult.rawUrl ? buildPreviewUrlFromRawUrl(publishResult.rawUrl) : undefined)
      });
      if (historyEntry) {
        const history = await appendPublishHistoryEntry(historyEntry);
        postPublishHistoryToUi(history);
      }
      figma.ui.postMessage({
        type: "publish-result",
        payload: {
          versionId: publishResult.versionId,
          message: publishResult.message,
          commitMessage: publishResult.commitMessage,
          referenceUrl: publishResult.referenceUrl,
          rawUrl: publishResult.rawUrl,
          previewUrl: publishResult.previewUrl,
          snapshotPreviewUrl: publishResult.snapshotPreviewUrl,
          changed: publishResult.changed,
          changeLog
        }
      });
      figma.ui.postMessage({
        type: "export-result",
        payload: exported
      });
      figma.notify("Publish complete.");
    } catch (error) {
      const message = toErrorMessage(error);
      figma.ui.postMessage({ type: "error", payload: message });
      figma.notify(`Publish failed: ${message}`);
    }
    return;
  }

  if (msg.type === "open-external-url") {
    const url = isObjectLike(msg.payload) && typeof msg.payload.url === "string" ? msg.payload.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) {
      return;
    }
    figma.openExternal(url);
  }
};
