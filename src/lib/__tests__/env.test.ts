import { describe, expect, it } from "vitest";
import {
  interpolate,
  migrateBaseUrl,
  newEnvironment,
  unresolved,
  variableMap,
  withBaseUrl,
  withNewEnvironment,
  withVariable,
} from "../env";
import type { Environment, EnvironmentFile } from "../env";

describe("variables", () => {
  const env: Environment = {
    id: "e1",
    name: "Staging",
    variables: [
      { name: "baseUrl", value: "https://api-staging.example.com", secret: false },
      { name: "token", value: "sk_test_123", secret: true },
    ],
  };

  it("interpolates into any string", () => {
    const vars = variableMap(env);
    expect(interpolate("{{baseUrl}}/orders", vars)).toBe("https://api-staging.example.com/orders");
    expect(interpolate("Bearer {{token}}", vars)).toBe("Bearer sk_test_123");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(interpolate("{{ baseUrl }}", variableMap(env))).toBe("https://api-staging.example.com");
  });

  it("leaves an unknown name verbatim rather than blanking it", () => {
    // Substituting "" would produce a URL that looks plausible and fails oddly;
    // leaving the token visible makes the cause obvious in the address bar.
    expect(interpolate("{{nope}}/x", variableMap(env))).toBe("{{nope}}/x");
    expect(unresolved("{{nope}}/{{baseUrl}}", variableMap(env))).toEqual(["nope"]);
  });

  it("returns no variables for no environment", () => {
    expect(variableMap(null)).toEqual({});
  });
});

describe("withVariable", () => {
  it("adds a variable that isn't there", () => {
    const env = withVariable(newEnvironment("Local"), "baseUrl", "http://localhost:8080");
    expect(env.variables).toEqual([
      { name: "baseUrl", value: "http://localhost:8080", secret: false },
    ]);
  });

  it("replaces in place rather than duplicating", () => {
    const once = withVariable(newEnvironment("Local"), "baseUrl", "http://a");
    const twice = withVariable(once, "baseUrl", "http://b");
    expect(twice.variables).toHaveLength(1);
    expect(twice.variables[0].value).toBe("http://b");
  });

  it("leaves an existing variable's secret flag alone", () => {
    const env: Environment = {
      id: "e",
      name: "n",
      variables: [{ name: "token", value: "old", secret: true }],
    };
    expect(withVariable(env, "token", "new").variables[0]).toEqual({
      name: "token",
      value: "new",
      secret: true,
    });
  });
});

describe("migrating away from the baseUrl field", () => {
  it("folds a legacy baseUrl into a variable rather than dropping it", () => {
    // The one outcome this change isn't allowed to cause is losing a URL the
    // user had set, so the migration is asserted rather than assumed.
    const migrated = migrateBaseUrl({
      id: "e",
      name: "Staging",
      baseUrl: "https://api-staging.example.com",
      variables: [{ name: "token", value: "t", secret: true }],
    });
    expect(migrated.variables).toContainEqual({
      name: "baseUrl",
      value: "https://api-staging.example.com",
      secret: false,
    });
    expect("baseUrl" in migrated).toBe(false);
  });

  it("is idempotent — a second load doesn't duplicate the variable", () => {
    const once = migrateBaseUrl({ id: "e", name: "n", baseUrl: "http://a", variables: [] });
    const twice = migrateBaseUrl(once as never);
    expect(twice.variables.filter((v) => v.name === "baseUrl")).toHaveLength(1);
  });

  it("does not clobber a baseUrl variable the user already set", () => {
    const migrated = migrateBaseUrl({
      id: "e",
      name: "n",
      baseUrl: "http://from-the-old-field",
      variables: [{ name: "baseUrl", value: "http://the-users-own", secret: false }],
    });
    expect(migrated.variables).toHaveLength(1);
    expect(migrated.variables[0].value).toBe("http://the-users-own");
  });

  it("leaves an environment with no legacy field untouched", () => {
    const env = { id: "e", name: "n", variables: [{ name: "a", value: "1", secret: false }] };
    expect(migrateBaseUrl(env)).toEqual(env);
  });
});

describe("withBaseUrl", () => {
  it("creates and activates a Local environment when none is active", () => {
    const next = withBaseUrl({ environments: [], activeId: null }, "https://api.example.com");
    expect(next.environments).toHaveLength(1);
    expect(next.environments[0].name).toBe("Local");
    expect(next.activeId).toBe(next.environments[0].id);
    expect(next.environments[0].variables).toEqual([
      { name: "baseUrl", value: "https://api.example.com", secret: false },
    ]);
  });

  it("writes into the active environment, replacing an old baseUrl", () => {
    const staging = withVariable({ ...newEnvironment("Staging"), id: "s" }, "baseUrl", "https://old");
    const other = { ...newEnvironment("Other"), id: "o" };
    const file: EnvironmentFile = { environments: [staging, other], activeId: "s" };
    const next = withBaseUrl(file, "https://new");
    expect(next.activeId).toBe("s");
    expect(next.environments.map((e) => e.id)).toEqual(["s", "o"]);
    expect(next.environments[0].variables).toEqual([{ name: "baseUrl", value: "https://new", secret: false }]);
    expect(next.environments[1]).toBe(other);
  });
});

describe("withNewEnvironment", () => {
  it("adds the environment, makes it active, and keeps names distinct", () => {
    const first = withNewEnvironment({ environments: [], activeId: null }, {
      name: "Checkout flow",
      variables: [{ name: "token", value: "t", secret: true }],
    });
    expect(first.environments).toHaveLength(1);
    expect(first.activeId).toBe(first.environments[0].id);
    expect(first.environments[0].variables).toEqual([{ name: "token", value: "t", secret: true }]);
    const second = withNewEnvironment(first, { name: "Checkout flow", variables: [] });
    expect(second.environments.map((e) => e.name)).toEqual(["Checkout flow", "Checkout flow 2"]);
    expect(second.activeId).toBe(second.environments[1].id);
    expect(second.environments[0].id).not.toBe(second.environments[1].id);
  });
});
