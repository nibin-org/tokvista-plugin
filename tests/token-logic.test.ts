import { describe, expect, it } from "vitest";

import {
  buildPublishChangeLog,
  importSingleCollectionTokens,
  parseAliasReference,
  resolveAliasSourceVariable,
  type VariableCollectionLike,
  type VariableLike,
  type VariablesApiLike
} from "../src/token-logic";

class MockCollection implements VariableCollectionLike {
  id: string;
  name: string;
  defaultModeId: string;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.defaultModeId = `${id}:mode`;
  }
}

class MockVariable implements VariableLike {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  values = new Map<string, unknown>();
  pluginData = new Map<string, string>();
  removed = false;
  private removeImpl: () => void;

  constructor(id: string, name: string, resolvedType: string, collectionId: string, removeImpl: () => void) {
    this.id = id;
    this.name = name;
    this.resolvedType = resolvedType;
    this.variableCollectionId = collectionId;
    this.removeImpl = removeImpl;
  }

  setValueForMode(modeId: string, value: unknown): void {
    this.values.set(modeId, value);
  }

  setPluginData(key: string, value: string): void {
    this.pluginData.set(key, value);
  }

  remove(): void {
    this.removed = true;
    this.removeImpl();
  }
}

function createMockVariablesApi(seed?: { collections?: MockCollection[]; variables?: MockVariable[] }): {
  api: VariablesApiLike<MockCollection, MockVariable>;
  collections: MockCollection[];
  variables: MockVariable[];
} {
  const collections = seed?.collections ? [...seed.collections] : [];
  const variables = seed?.variables ? [...seed.variables] : [];
  let collectionIndex = collections.length;
  let variableIndex = variables.length;

  const removeVariable = (variable: MockVariable) => {
    const index = variables.indexOf(variable);
    if (index >= 0) {
      variables.splice(index, 1);
    }
  };

  const api: VariablesApiLike<MockCollection, MockVariable> = {
    async getLocalVariableCollectionsAsync() {
      return collections;
    },
    async getLocalVariablesAsync() {
      return variables;
    },
    createVariable(name, collection, resolvedType) {
      variableIndex += 1;
      const variable = new MockVariable(`var-${variableIndex}`, name, resolvedType, collection.id, () => {
        removeVariable(variable);
      });
      variables.push(variable);
      return variable;
    },
    createVariableCollection(name) {
      collectionIndex += 1;
      const collection = new MockCollection(`col-${collectionIndex}`, name);
      collections.push(collection);
      return collection;
    },
    createVariableAlias(variable) {
      return { type: "VARIABLE_ALIAS", id: variable.id };
    }
  };

  return { api, collections, variables };
}

describe("parseAliasReference", () => {
  it("parses dot-separated aliases and sanitizes segments", () => {
    expect(parseAliasReference("{ Foundation.color.brand.primary }")).toEqual({
      path: ["Foundation", "color", "brand", "primary"],
      rawReference: "{ Foundation.color.brand.primary }",
      innerReference: "Foundation/color/brand/primary"
    });
  });

  it("parses slash-separated aliases and removes empty segments", () => {
    expect(parseAliasReference("{Semantic//button / primary }")).toEqual({
      path: ["Semantic", "button", "primary"],
      rawReference: "{Semantic//button / primary }",
      innerReference: "Semantic/button/primary"
    });
  });
});

describe("buildPublishChangeLog", () => {
  it("creates an initial baseline summary", () => {
    const currentPayload = {
      tokens: {
        color: {
          brand: {
            primary: { type: "color", value: "#ff0000" }
          }
        }
      }
    };

    expect(buildPublishChangeLog(null, currentPayload)).toEqual({
      summary: "Initial publish baseline created (1 tokens).",
      lines: ["+ color/brand/primary"],
      added: 1,
      changed: 0,
      removed: 0
    });
  });

  it("detects added, changed, and removed tokens", () => {
    const previousPayload = {
      tokens: {
        color: {
          brand: {
            primary: { type: "color", value: "#ff0000" },
            secondary: { type: "color", value: "#00ff00" }
          }
        }
      }
    };
    const currentPayload = {
      tokens: {
        color: {
          brand: {
            primary: { type: "color", value: "#0000ff" }
          }
        },
        spacing: {
          md: { type: "number", value: 16 }
        }
      }
    };

    const changeLog = buildPublishChangeLog(previousPayload, currentPayload);
    expect(changeLog.summary).toBe("Changes: +1 / ~1 / -1");
    expect(changeLog.added).toBe(1);
    expect(changeLog.changed).toBe(1);
    expect(changeLog.removed).toBe(1);
    expect(changeLog.lines).toEqual([
      "+ spacing/md",
      "~ color/brand/primary\t#ff0000\t#0000ff",
      "- color/brand/secondary"
    ]);
  });
});

describe("resolveAliasSourceVariable", () => {
  it("resolves cross-collection aliases by scoped name", () => {
    const foundationCollection = new MockCollection("foundation", "Foundation");
    const semanticCollection = new MockCollection("semantic", "Semantic");
    const sourceVariable = new MockVariable(
      "var-source",
      "color/brand/primary",
      "COLOR",
      foundationCollection.id,
      () => {}
    );

    const resolved = resolveAliasSourceVariable(
      ["Foundation", "color", "brand", "primary"],
      "Foundation/color/brand/primary",
      semanticCollection,
      new Map(),
      new Map([["Foundation/color/brand/primary", sourceVariable]]),
      new Map([
        ["Foundation", foundationCollection],
        ["Semantic", semanticCollection]
      ])
    );

    expect(resolved).toBe(sourceVariable);
  });
});

describe("importSingleCollectionTokens", () => {
  it("imports alias tokens against another local collection", async () => {
    const foundationCollection = new MockCollection("col-1", "Foundation");
    const semanticCollection = new MockCollection("col-2", "Semantic");
    const seedVariable = new MockVariable(
      "var-1",
      "color/brand/primary",
      "COLOR",
      foundationCollection.id,
      () => {}
    );
    seedVariable.setValueForMode(foundationCollection.defaultModeId, { r: 1, g: 0, b: 0, a: 1 });

    const { api, variables } = createMockVariablesApi({
      collections: [foundationCollection, semanticCollection],
      variables: [seedVariable]
    });

    const result = await importSingleCollectionTokens(
      {
        collection: "Semantic",
        tokens: {
          button: {
            background: {
              type: "color",
              value: "{Foundation.color.brand.primary}"
            }
          }
        }
      },
      api
    );

    expect(result).toMatchObject({
      collection: "Semantic",
      imported: 1,
      created: 1,
      updated: 0,
      replaced: 0,
      skipped: 0,
      createdNames: ["button/background"],
      updatedNames: [],
      replacedNames: [],
      skippedNames: [],
      createdRefs: ["Semantic::button/background"],
      updatedRefs: [],
      replacedRefs: [],
      skippedRefs: []
    });

    const importedVariable = variables.find(
      (variable) => variable.variableCollectionId === semanticCollection.id && variable.name === "button/background"
    );
    expect(importedVariable).toBeTruthy();
    expect(importedVariable?.values.get(semanticCollection.defaultModeId)).toEqual({
      type: "VARIABLE_ALIAS",
      id: "var-1"
    });
  });
});
