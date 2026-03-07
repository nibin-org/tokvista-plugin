export type ObjectLike = Record<string, unknown>;
export type TokenValueType = "COLOR" | "FLOAT" | "STRING";

export type ParsedToken = {
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

export type ImportResult = {
  collection: string;
  imported: number;
  created: number;
  updated: number;
  replaced: number;
  skipped: number;
  warnings: string[];
};

type CollectionImportPayload = {
  collection: string;
  tokens: ObjectLike;
};

export type PublishChangeLog = {
  summary: string;
  lines: string[];
  added: number;
  changed: number;
  removed: number;
};

export type AliasReference = {
  path: string[];
  rawReference: string;
  innerReference: string;
};

export type VariableCollectionLike = {
  id: string;
  name: string;
  defaultModeId: string;
};

export type VariableLike = {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  setValueForMode(modeId: string, value: unknown): void;
  setPluginData(key: string, value: string): void;
  remove(): void;
};

export type VariablesApiLike<
  CollectionT extends VariableCollectionLike = VariableCollectionLike,
  VariableT extends VariableLike = VariableLike
> = {
  getLocalVariableCollectionsAsync(): Promise<CollectionT[]>;
  getLocalVariablesAsync(): Promise<VariableT[]>;
  createVariable(name: string, collection: CollectionT, resolvedType: TokenValueType): VariableT;
  createVariableCollection(name: string): CollectionT;
  createVariableAlias(variable: VariableT): unknown;
};

type TokenImportOptions = {
  defaultCollectionName?: string;
  remBasePx?: number;
  rawTypePluginKey?: string;
  complexJsonPluginKey?: string;
};

type RgbaValue = {
  r: number;
  g: number;
  b: number;
  a: number;
};

const DEFAULT_COLLECTION_NAME = "Tokvista";
const DEFAULT_REM_BASE_PX = 16;
const RAW_TYPE_PLUGIN_KEY = "tokvista_raw_type";
const COMPLEX_JSON_PLUGIN_KEY = "tokvista_complex_json";
const MAX_CHANGE_LOG_LINES = 40;

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

function sanitizeVariablePathSegment(segment: string): string {
  return segment
    .trim()
    .replace(/['"`]/g, "")
    .replace(/&/g, "and")
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-./\s]+|[-./\s]+$/g, "") || "token";
}

export function sanitizeVariablePath(path: string[]): string[] {
  const cleaned = path
    .map((segment) => sanitizeVariablePathSegment(String(segment || "")))
    .filter((segment) => segment.length > 0);
  return cleaned.length ? cleaned : ["token"];
}

function collectTokens(node: unknown, path: string[] = [], out: ParsedToken[] = []): ParsedToken[] {
  if (!isObjectLike(node)) {
    return out;
  }

  if (isTokenLeaf(node) && path.length > 0) {
    const { rawType, value } = extractLeafValue(node);
    const sanitizedPath = sanitizeVariablePath(path);
    out.push({
      path: sanitizedPath,
      name: sanitizedPath.join("/"),
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

export function parseTokens(payload: unknown): ParsedToken[] {
  if (!isObjectLike(payload)) {
    throw new Error("Invalid tokens payload: expected a JSON object.");
  }
  const tokensRoot = isObjectLike(payload.tokens) ? payload.tokens : payload;
  return collectTokens(tokensRoot);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (isObjectLike(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toReadableChangeValue(serializedValue: string): string {
  if (!serializedValue) {
    return "";
  }
  try {
    const parsed = JSON.parse(serializedValue);
    if (typeof parsed === "string") {
      return parsed;
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

export function buildPublishChangeLog(previousPayload: ObjectLike | null, currentPayload: ObjectLike): PublishChangeLog {
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

function readCollectionImportPayloads(payload: unknown): CollectionImportPayload[] {
  if (!isObjectLike(payload) || !Array.isArray(payload.collections)) {
    return [];
  }
  const entries = payload
    .collections
    .map((entry) => {
      if (!isObjectLike(entry)) {
        return null;
      }
      const collection = typeof entry.collection === "string" ? entry.collection.trim() : "";
      const tokens = entry.tokens;
      if (!collection || !isObjectLike(tokens)) {
        return null;
      }
      return { collection, tokens };
    });
  return entries.filter((entry): entry is CollectionImportPayload => entry !== null);
}

export function parseAliasReference(value: unknown): AliasReference | null {
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

  const sanitizedPath = sanitizeVariablePath(path);
  return {
    path: sanitizedPath,
    rawReference: trimmed,
    innerReference: sanitizedPath.join("/")
  };
}

function toScopedVariableKey(collectionName: string, variableName: string): string {
  return `${collectionName}/${variableName}`;
}

export function resolveAliasSourceVariable<
  VariableT extends VariableLike,
  CollectionT extends VariableCollectionLike
>(
  referencePath: string[],
  referenceInner: string,
  targetCollection: CollectionT,
  variableByNameInTarget: Map<string, VariableT>,
  variableByScopedName: Map<string, VariableT>,
  collectionByName: Map<string, CollectionT>
): VariableT | null {
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
    let uniqueMatch: VariableT | null = null;
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

function variableTypeToTokenValueType(resolvedType: string): TokenValueType | null {
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

function parseColor(input: string): RgbaValue | null {
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

function parseNumberString(input: string, remBasePx: number): number | null {
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
      return amount * remBasePx;
    }
    return amount / 100;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function inferTokenValueType(rawType: string | undefined, value: unknown, remBasePx: number): TokenValueType | null {
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
  if (typeof value === "string" && parseNumberString(value, remBasePx) !== null) {
    return "FLOAT";
  }
  if (typeof value === "string") {
    return "STRING";
  }
  return null;
}

function normalizeRawType(rawType: string | undefined): string {
  if (typeof rawType !== "string") {
    return "";
  }
  return rawType.trim();
}

function setVariableTokenMetadata(variable: VariableLike, rawType: string, isComplexJson: boolean, options: Required<TokenImportOptions>): void {
  variable.setPluginData(options.rawTypePluginKey, rawType);
  variable.setPluginData(options.complexJsonPluginKey, isComplexJson ? "1" : "0");
}

function replaceVariableWithType<
  CollectionT extends VariableCollectionLike,
  VariableT extends VariableLike
>(
  variablesApi: VariablesApiLike<CollectionT, VariableT>,
  existing: VariableT,
  collection: CollectionT,
  resolvedType: TokenValueType
): VariableT {
  const name = existing.name;
  existing.remove();
  return variablesApi.createVariable(name, collection, resolvedType);
}

async function getOrCreateCollection<
  CollectionT extends VariableCollectionLike,
  VariableT extends VariableLike
>(
  variablesApi: VariablesApiLike<CollectionT, VariableT>,
  name: string
): Promise<CollectionT> {
  const existing = (await variablesApi.getLocalVariableCollectionsAsync()).find(
    (collection) => collection.name === name
  );
  if (existing) {
    return existing;
  }
  return variablesApi.createVariableCollection(name);
}

async function ensureCollectionForPayload<
  CollectionT extends VariableCollectionLike,
  VariableT extends VariableLike
>(
  variablesApi: VariablesApiLike<CollectionT, VariableT>,
  payload: unknown,
  options: Required<TokenImportOptions>
): Promise<CollectionT> {
  if (isObjectLike(payload) && typeof payload.collection === "string" && payload.collection.trim()) {
    return getOrCreateCollection(variablesApi, payload.collection.trim());
  }
  return getOrCreateCollection(variablesApi, options.defaultCollectionName);
}

function withImportOptions(options?: TokenImportOptions): Required<TokenImportOptions> {
  return {
    defaultCollectionName: options?.defaultCollectionName || DEFAULT_COLLECTION_NAME,
    remBasePx: options?.remBasePx ?? DEFAULT_REM_BASE_PX,
    rawTypePluginKey: options?.rawTypePluginKey || RAW_TYPE_PLUGIN_KEY,
    complexJsonPluginKey: options?.complexJsonPluginKey || COMPLEX_JSON_PLUGIN_KEY
  };
}

export async function importSingleCollectionTokens<
  CollectionT extends VariableCollectionLike,
  VariableT extends VariableLike
>(
  payload: unknown,
  variablesApi: VariablesApiLike<CollectionT, VariableT>,
  options?: TokenImportOptions
): Promise<ImportResult> {
  const resolvedOptions = withImportOptions(options);
  const collection = await ensureCollectionForPayload(variablesApi, payload, resolvedOptions);
  const modeId = collection.defaultModeId;
  const tokens = parseTokens(payload);

  const localCollections = await variablesApi.getLocalVariableCollectionsAsync();
  const collectionById = new Map(localCollections.map((item) => [item.id, item]));
  const collectionByName = new Map(localCollections.map((item) => [item.name, item]));
  const allLocalVariables = await variablesApi.getLocalVariablesAsync();

  const variableByNameInTarget = new Map<string, VariableT>();
  const variableByScopedName = new Map<string, VariableT>();

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

    const resolvedType = inferTokenValueType(token.rawType, token.value, resolvedOptions.remBasePx);
    if (!resolvedType) {
      skipped += 1;
      const unsupportedType = token.rawType === undefined ? "unknown" : token.rawType;
      warnings.push(`Skipped ${token.name}: unsupported type "${unsupportedType}".`);
      continue;
    }

    const tokenRawType = normalizeRawType(token.rawType);
    let nextValue: unknown;
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
        numericValue = parseNumberString(token.value, resolvedOptions.remBasePx);
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
          const replacedVariable = replaceVariableWithType(variablesApi, existing, collection, resolvedType);
          replacedVariable.setValueForMode(modeId, nextValue);
          setVariableTokenMetadata(
            replacedVariable,
            tokenRawType || (resolvedType === "STRING" ? "string" : ""),
            resolvedType === "STRING" && isComplexJsonValue,
            resolvedOptions
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
        resolvedType === "STRING" && isComplexJsonValue,
        resolvedOptions
      );
      updated += 1;
      continue;
    }

    const createdVariable = variablesApi.createVariable(token.name, collection, resolvedType);
    createdVariable.setValueForMode(modeId, nextValue);
    setVariableTokenMetadata(
      createdVariable,
      tokenRawType || (resolvedType === "STRING" ? "string" : ""),
      resolvedType === "STRING" && isComplexJsonValue,
      resolvedOptions
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
        targetVariable = variablesApi.createVariable(token.name, collection, targetType);
        variableByNameInTarget.set(token.name, targetVariable);
        variableByScopedName.set(toScopedVariableKey(collection.name, token.name), targetVariable);
        createdInThisStep = true;
      } else if (targetVariable.resolvedType !== targetType) {
        const previousType = targetVariable.resolvedType;
        try {
          const replacedVariable = replaceVariableWithType(variablesApi, targetVariable, collection, targetType);
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
        targetVariable.setValueForMode(modeId, variablesApi.createVariableAlias(sourceVariable));
        setVariableTokenMetadata(
          targetVariable,
          normalizeRawType(token.rawType) || (targetType === "STRING" ? "string" : ""),
          false,
          resolvedOptions
        );
        if (createdInThisStep) {
          created += 1;
        } else if (!replacedInThisStep) {
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

export async function importTokens<
  CollectionT extends VariableCollectionLike,
  VariableT extends VariableLike
>(
  payload: unknown,
  variablesApi: VariablesApiLike<CollectionT, VariableT>,
  options?: TokenImportOptions
): Promise<ImportResult> {
  const collectionPayloads = readCollectionImportPayloads(payload);
  if (!collectionPayloads.length) {
    return importSingleCollectionTokens(payload, variablesApi, options);
  }

  let imported = 0;
  let created = 0;
  let updated = 0;
  let replaced = 0;
  let skipped = 0;
  const warnings: string[] = [];
  const importedCollections: string[] = [];

  for (const entry of collectionPayloads) {
    const result = await importSingleCollectionTokens(entry, variablesApi, options);
    imported += result.imported;
    created += result.created;
    updated += result.updated;
    replaced += result.replaced;
    skipped += result.skipped;
    warnings.push(...result.warnings);
    importedCollections.push(result.collection);
  }

  return {
    collection: importedCollections.join(", "),
    imported,
    created,
    updated,
    replaced,
    skipped,
    warnings
  };
}
