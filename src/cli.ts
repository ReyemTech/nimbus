#!/usr/bin/env node

/**
 * Nimbus CLI — helper for managing cloud provider dependencies and scaffolding projects.
 *
 * Usage:
 *   npx @reyemtech/nimbus new my-infra aws    → scaffold a new project from a template
 *   npx @reyemtech/nimbus install aws         → npm install @pulumi/aws
 *   npx @reyemtech/nimbus install azure       → npm install @pulumi/azure-native
 *   npx @reyemtech/nimbus install aws azure   → npm install @pulumi/aws @pulumi/azure-native
 *   npx @reyemtech/nimbus check               → reports which providers are installed/missing
 *   npx @reyemtech/nimbus migrate [version]   → read-only pre-flight checks before upgrading
 *
 * @module cli
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  TEMPLATE_NAMES,
  TEMPLATES,
  generatePulumiYaml,
  generatePackageJson,
  PROJECT_TSCONFIG,
} from "./cli/templates.js";
import type { TemplateName, ITemplateOptions } from "./cli/templates.js";
import { requiresAzurePrompts, promptForAzureOptions } from "./cli/azure-prompts.js";
import { runMigrateChecks } from "./cli/migrate.js";

const PROVIDER_PACKAGES: Readonly<Record<string, ReadonlyArray<string>>> = {
  aws: ["@pulumi/aws"],
  azure: ["@pulumi/azure-native"],
  gcp: ["@pulumi/gcp"],
  kubernetes: ["@pulumi/kubernetes"],
};

const ALL_PROVIDERS = Object.keys(PROVIDER_PACKAGES);

function install(providers: string[]): void {
  const packages: string[] = [];

  for (const provider of providers) {
    const pkgs = PROVIDER_PACKAGES[provider];
    if (!pkgs) {
      console.error(`Unknown provider: "${provider}". Available: ${ALL_PROVIDERS.join(", ")}`);
      process.exit(1);
    }
    packages.push(...pkgs);
  }

  if (packages.length === 0) {
    console.error("Usage: nimbus install <provider> [provider...]");
    console.error(`Available providers: ${ALL_PROVIDERS.join(", ")}`);
    process.exit(1);
  }

  const cmd = `npm install ${packages.join(" ")}`;
  console.log(`Installing: ${packages.join(", ")}`);
  console.log(`Running: ${cmd}\n`);

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${detail}`);
    process.exit(1);
  }
}

async function check(): Promise<void> {
  console.log("Checking cloud provider availability:\n");

  for (const [provider, packages] of Object.entries(PROVIDER_PACKAGES)) {
    const pkg = packages[0] ?? provider;
    try {
      await import(pkg);
      console.log(`  ${provider}: installed`);
    } catch {
      console.log(`  ${provider}: not installed (${pkg})`);
    }
  }

  console.log("\nInstall missing providers with: nimbus install <provider>");
}

/**
 * Print template list for help output.
 */
function printTemplateList(): void {
  for (const [name, info] of Object.entries(TEMPLATES)) {
    console.log(`  ${name.padEnd(16)} ${info.description}`);
  }
}

/**
 * Run a shell command inside a directory, streaming output.
 *
 * @param cmd - Command to run
 * @param cwd - Working directory
 */
function run(cmd: string, cwd: string): void {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

/**
 * Scaffold a new project from a template.
 *
 * Generates Pulumi.yaml, package.json, tsconfig.json, index.ts, and README.md,
 * then runs npm install to set up dependencies. For Azure templates, prompts
 * for region, resource group, and tenant ID, then configures Pulumi stack.
 *
 * @param args - CLI arguments after "new" (name, template)
 */
async function newProject(args: string[]): Promise<void> {
  const name = args[0];
  const templateArg = args[1];

  if (!name || !templateArg) {
    console.log("Usage: nimbus new <name> <template>\n");
    console.log("Templates:");
    printTemplateList();
    console.log("\nExamples:");
    console.log("  nimbus new my-infra aws");
    console.log("  nimbus new vault-poc minimal-aws");
    console.log("  nimbus new scratch empty");
    process.exit(name ? 1 : 0);
    return;
  }

  if (!TEMPLATE_NAMES.includes(templateArg as TemplateName)) {
    console.error(`Unknown template: "${templateArg}"`);
    console.error(`Available templates: ${TEMPLATE_NAMES.join(", ")}`);
    process.exit(1);
  }

  const template = templateArg as TemplateName;
  const templateInfo = TEMPLATES[template];
  const dir = join(process.cwd(), name);

  if (existsSync(dir)) {
    console.error(`Directory already exists: ${dir}`);
    process.exit(1);
  }

  // Prompt for Azure options if this template needs them
  let templateOptions: ITemplateOptions | undefined;
  if (requiresAzurePrompts(template)) {
    const azureOptions = await promptForAzureOptions(name);
    templateOptions = { azure: azureOptions };
  }

  console.log(`\nScaffolding "${name}" from template "${template}"...\n`);

  // 1. Create project directory and files
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Pulumi.yaml"), generatePulumiYaml(name));
  writeFileSync(join(dir, "package.json"), generatePackageJson(name));
  writeFileSync(join(dir, "tsconfig.json"), PROJECT_TSCONFIG);

  const files = templateInfo.generate(name, templateOptions);
  writeFileSync(join(dir, "index.ts"), files.indexTs);
  writeFileSync(join(dir, "README.md"), files.readmeMd);

  // 2. Install nimbus (all provider SDKs are bundled as dependencies)
  try {
    run("npm install @reyemtech/nimbus", dir);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`\nFailed to install dependencies: ${detail}`);
    process.exit(1);
  }

  // 3. Configure Pulumi stack for Azure templates
  if (templateOptions?.azure) {
    const region = templateOptions.azure.region;
    try {
      run("pulumi stack init dev", dir);
      run(`pulumi config set azure-native:location ${region}`, dir);
    } catch {
      console.log(`\nNote: Could not configure Pulumi stack automatically.`);
      console.log(`Run these commands manually in your project directory:`);
      console.log(`  pulumi stack init dev`);
      console.log(`  pulumi config set azure-native:location ${region}`);
    }
  }

  console.log(`\nDone! Project "${name}" is ready.\n`);
  console.log(`  cd ${name}`);
  console.log(`  pulumi up`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "new":
      await newProject(args.slice(1));
      break;
    case "install":
      install(args.slice(1));
      break;
    case "check":
      await check();
      break;
    case "migrate":
      process.exit(runMigrateChecks(args[1] ?? "v3"));
      break;
    default:
      console.log("@reyemtech/nimbus CLI\n");
      console.log("Commands:");
      console.log("  new <name> <template>            Scaffold a new project from a template");
      console.log("  install <provider> [provider...]  Install cloud provider packages");
      console.log("  check                             Check which providers are installed");
      console.log(
        "  migrate [version]                 Read-only pre-flight checks before upgrading"
      );
      console.log(`\nAvailable providers: ${ALL_PROVIDERS.join(", ")}`);
      console.log(`Available templates: ${TEMPLATE_NAMES.join(", ")}`);
      if (command && command !== "help" && command !== "--help" && command !== "-h") {
        process.exit(1);
      }
  }
}

void main();
