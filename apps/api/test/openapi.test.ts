import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const specText = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");

const declaredPaths = [...specText.matchAll(/^ {2}(\/[a-z{}/-]*):$/gm)]
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

  it("states that this deployment has no authentication", () => {
    expect(specText).toMatch(/no authentication/);
  });

  it("records that a refused action is a successful decision, not an error", () => {
    expect(specText).toMatch(/a BLOCK is a successful decision and valid evidence/);
  });
});
