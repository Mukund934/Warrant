import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROTECTED_PATHS } from "../src/app.js";

const specText = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");

const declaredPaths = [...specText.matchAll(/^ {2}(\/[A-Za-z{}/-]*):$/gm)]
  .map((match) => match[1]!)
  .filter((path) => path !== "/v1");

const routeDirectory = new URL("../src/routes/", import.meta.url);
const routeFiles = await readdir(routeDirectory);
const implementedPaths = [
  ...new Set(
    (
      await Promise.all(
        routeFiles.map(async (file) => {
          const source = await readFile(new URL(file, routeDirectory), "utf8");
          return [...source.matchAll(/router\.(get|post)\("([^"]+)"/g)].map((match) =>
            match[2]!.replace(/:(\w+)/g, "{$1}"),
          );
        }),
      )
    ).flat(),
  ),
];

describe("the published API spec", () => {
  it("documents every route the service actually serves", () => {
    const undocumented = implementedPaths.filter((path) => !declaredPaths.includes(path));
    expect(undocumented).toEqual([]);
  });

  it("does not describe routes that do not exist", () => {
    const phantom = declaredPaths.filter((path) => !implementedPaths.includes(path));
    expect(phantom).toEqual([]);
  });

  it("separates the API version from the signed format versions", () => {
    expect(specText).toMatch(/pin the format, not the endpoint/);
  });

  it("describes both authentication modes rather than assuming one", () => {
    expect(specText).toMatch(/`open` mode there is no authentication/);
    expect(specText).toMatch(/`required` mode the authority endpoints need a bearer token/);
  });

  it("says plainly that authentication does not move the verdict", () => {
    expect(specText).toMatch(/Authentication decides who may call, never what the answer is/);
  });

  it("marks exactly the operations the code puts behind the guard", () => {
    const boundary = /\n {2}\/[a-z{}/-]*:/;

    const guarded = declaredPaths.filter((path) => {
      const section = specText.slice(specText.indexOf(`\n  ${path}:`) + 1);
      const next = section.slice(1).search(boundary);
      const operation = next === -1 ? section : section.slice(0, next + 1);
      return /security: \[\{ bearerAuth/.test(operation);
    });

    const expected = declaredPaths.filter((path) =>
      PROTECTED_PATHS.some((prefix) => {
        const withoutVersion = prefix.replace(/^\/v1/, "");
        return path === withoutVersion || path.startsWith(`${withoutVersion}/`);
      }),
    );

    expect(guarded.sort()).toEqual(expected.sort());
  });

  it("records that a refused action is a successful decision, not an error", () => {
    expect(specText).toMatch(/a BLOCK is a successful decision and valid evidence/);
  });
});
