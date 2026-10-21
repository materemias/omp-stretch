import { expect, test } from "bun:test";
import catalog from "./.omp-plugin/marketplace.json";
import pkg from "./package.json";

test("the marketplace entry installs this repo and matches package.json and the Tern plugin", async () => {
  expect(catalog.name).toBe(pkg.name);
  expect(catalog.plugins).toHaveLength(1);
  const [plugin] = catalog.plugins;
  expect(plugin).toMatchObject({
    name: pkg.name,
    source: "./",
    version: pkg.version,
    description: pkg.description,
  });
  expect(pkg.omp.extensions).toEqual(["./stretch.ts"]);
  const ternPlugin = await Bun.file(`${import.meta.dir}/tern-plugin/plugin.toml`).text();
  expect(ternPlugin).toContain(`version = "${pkg.version}"`);
});
