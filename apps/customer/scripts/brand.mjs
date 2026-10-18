#!/usr/bin/env node
// Everything per-brand goes through here, so the dashboard's "Mobile app"
// onboarding can drive the same commands a person types:
//
//   npm run brand -- list
//   npm run brand -- init    <slug>                     create the brand's EAS project
//   npm run brand -- build   <slug> <ios|android|all> [profile] [-- extra eas args]
//   npm run brand -- submit  <slug> <ios|android>      [-- extra eas args]
//   npm run brand -- update  <slug> <channel> "<message>"
//
// iOS goes on the CLIENT's Apple account (guideline 4.2.6). Their App Store
// Connect API key lives outside git in secrets/asc/<slug>/:
//   AuthKey.p8   the key file Apple let them download once
//   key.json     { "keyId": "ABC123DEFG", "issuerId": "uuid" }
// EAS CLI picks those up from EXPO_ASC_* env vars, for both build credentials
// and submission, so nothing secret is ever written to eas.json.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBrand, listBrands, ROOT } = require("../brands/load.js");

const EAS = ["--yes", "eas-cli@latest"];

function run(args, env, { capture = false } = {}) {
  const res = spawnSync("npx", [...EAS, ...args], {
    cwd: ROOT,
    // Upload this folder only. Without these EAS archives from the git root,
    // i.e. the whole monorepo (~39 MB instead of ~3 MB), and the upload
    // stalls on slow links. .gitignore still keeps ios/, android/ and
    // node_modules out.
    env: { EAS_NO_VCS: "1", EAS_PROJECT_ROOT: ROOT, ...process.env, ...env },
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (capture) {
    process.stdout.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
  }
  return res;
}

function brandEnv(brand) {
  const env = { BRAND: brand.slug };
  if (brand.ios.appleTeamId) env.EXPO_APPLE_TEAM_ID = brand.ios.appleTeamId;
  const keyDir = path.join(ROOT, "secrets", "asc", brand.slug);
  const keyJson = path.join(keyDir, "key.json");
  const keyP8 = path.join(keyDir, "AuthKey.p8");
  if (fs.existsSync(keyJson) && fs.existsSync(keyP8)) {
    const { keyId, issuerId } = JSON.parse(fs.readFileSync(keyJson, "utf8"));
    Object.assign(env, {
      EXPO_ASC_API_KEY_PATH: keyP8,
      EXPO_ASC_KEY_ID: keyId,
      EXPO_ASC_ISSUER_ID: issuerId,
    });
  }
  return env;
}

function needProject(brand) {
  if (!brand.easProjectId) {
    console.error(`${brand.slug} has no easProjectId yet — run: npm run brand -- init ${brand.slug}`);
    process.exit(1);
  }
}

function writeProjectId(slug, id) {
  const file = path.join(ROOT, "brands", `${slug}.json`);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.easProjectId = id;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

const [cmd, slug, ...rest] = process.argv.slice(2);
const passthrough = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : [];
const positional = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;

switch (cmd) {
  case "list": {
    for (const s of listBrands()) {
      const b = loadBrand(s);
      console.log(`${s.padEnd(20)} ${b.name.padEnd(24)} ${b.ios.bundleId}  eas:${b.easProjectId ?? "—"}`);
    }
    break;
  }

  case "init": {
    const brand = loadBrand(slug);
    let id = brand.easProjectId;
    if (!id) {
      // eas init can't edit a dynamic app.config.ts, so it creates the project
      // and prints the id instead — take it from there.
      const res = run(["init", "--non-interactive", "--force"], { BRAND: slug }, { capture: true });
      id = `${res.stdout}${res.stderr}`.match(/"projectId":\s*"([0-9a-f-]{36})"/)?.[1] ?? null;
      if (!id) {
        console.error("Couldn't read the new project id from eas init's output.");
        process.exit(1);
      }
      writeProjectId(slug, id);
      console.log(`\n✔ brands/${slug}.json → easProjectId ${id}`);
    }
    // The build server never sees this shell, so it learns which brand it is
    // building from the project's own environment variables.
    const env = run(
      [
        "env:set",
        "--name", "BRAND",
        "--value", slug,
        "--environment", "production",
        "--environment", "preview",
        "--environment", "development",
        "--visibility", "plaintext",
        "--scope", "project",
        "--non-interactive",
      ],
      { BRAND: slug },
    );
    process.exit(env.status ?? 1);
  }

  case "build": {
    const brand = loadBrand(slug);
    needProject(brand);
    const [platform = "all", profile = "production"] = positional;
    const res = run(["build", "--platform", platform, "--profile", profile, ...passthrough], brandEnv(brand));
    process.exit(res.status ?? 1);
  }

  case "submit": {
    const brand = loadBrand(slug);
    needProject(brand);
    const [platform] = positional;
    if (platform !== "ios" && platform !== "android") {
      console.error("submit needs a platform: ios or android");
      process.exit(1);
    }
    const res = run(["submit", "--platform", platform, "--profile", "production", "--latest", ...passthrough], brandEnv(brand));
    process.exit(res.status ?? 1);
  }

  case "update": {
    const brand = loadBrand(slug);
    needProject(brand);
    const [channel = "production", message = "Update"] = positional;
    const environment = ["production", "preview", "development"].includes(channel) ? channel : "production";
    const res = run(
      ["update", "--channel", channel, "--environment", environment, "--message", message, ...passthrough],
      { BRAND: slug },
    );
    process.exit(res.status ?? 1);
  }

  default:
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 9).join("\n").replace(/^\/\/ ?/gm, ""));
    process.exit(cmd ? 1 : 0);
}
