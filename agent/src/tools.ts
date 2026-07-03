import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { tool } from "@openai/agents";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(
  process.env.TERRAFORM_WORKSPACE_ROOT ?? process.cwd(),
);
const outputRoot = assertWithin(
  workspaceRoot,
  process.env.TERRAFORM_OUTPUT_ROOT ??
    resolve(workspaceRoot, "generated", "domain-connect"),
);

function assertWithin(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`path escapes allowed root: ${candidate}`);
  }
  return absolute;
}

function terraformDirectory(relativeDirectory: string): string {
  return assertWithin(workspaceRoot, relativeDirectory || ".");
}

export const fetchDomainConnectTemplate = tool({
  name: "fetch_domain_connect_template",
  description:
    "Fetch and parse a Domain Connect template from the official GitHub template repository.",
  parameters: z.object({
    providerId: z.string().regex(/^[A-Za-z0-9._-]+$/),
    serviceId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  }),
  async execute({ providerId, serviceId }) {
    const filename = `${providerId}.${serviceId}.json`;
    const base =
      process.env.DOMAIN_CONNECT_TEMPLATE_BASE_URL ??
      "https://raw.githubusercontent.com/Domain-Connect/Templates/master";
    const url = `${base.replace(/\/$/, "")}/${encodeURIComponent(filename)}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`template fetch failed: HTTP ${response.status} for ${url}`);
    }
    const text = await response.text();
    const template = JSON.parse(text) as Record<string, unknown>;
    if (
      template.providerId !== providerId ||
      template.serviceId !== serviceId ||
      !Array.isArray(template.records)
    ) {
      throw new Error("fetched JSON does not match the requested template identity");
    }
    return JSON.stringify({ url, template });
  },
});

async function collectTerraformFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".terraform" || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectTerraformFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".tf") {
      result.push(path);
    }
  }
  return result.sort();
}

export const readTerraformFiles = tool({
  name: "read_terraform_files",
  description:
    "Read existing .tf files under a configured Terraform workspace to follow local conventions and detect ownership conflicts.",
  parameters: z.object({
    workingDirectory: z.string().default("."),
  }),
  async execute({ workingDirectory }) {
    const directory = terraformDirectory(workingDirectory);
    const files = await collectTerraformFiles(directory);
    const documents = await Promise.all(
      files.map(async (path) => ({
        path: relative(workspaceRoot, path),
        content: redactTerraform(await readFile(path, "utf8")),
      })),
    );
    return JSON.stringify(documents);
  },
});

export const writeTerraformFile = tool({
  name: "write_terraform_file",
  description:
    "Atomically write one generated .tf file under the configured generated-output directory.",
  parameters: z.object({
    path: z.string().min(1),
    content: z.string().min(1),
  }),
  async execute({ path, content }) {
    if (extname(path) !== ".tf") {
      throw new Error("generated output must use a .tf extension");
    }
    const destination = assertWithin(outputRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o644 });
    await rename(temporary, destination);
    return JSON.stringify({ path: relative(workspaceRoot, destination) });
  },
});

export const inspectInstalledProviderSchema = tool({
  name: "inspect_installed_provider_schema",
  description:
    "Read one resource schema from the exact Terraform/OpenTofu provider installed in the target workspace.",
  parameters: z.object({
    workingDirectory: z.string().default("."),
    providerSource: z.string().min(3),
    resourceType: z.string().min(1),
  }),
  async execute({ workingDirectory, providerSource, resourceType }) {
    const { stdout } = await runCLI(
      ["providers", "schema", "-json"],
      terraformDirectory(workingDirectory),
      64 * 1024 * 1024,
    );
    const document = JSON.parse(stdout) as {
      provider_schemas?: Record<
        string,
        { resource_schemas?: Record<string, unknown> }
      >;
    };
    const match = Object.entries(document.provider_schemas ?? {}).find(
      ([address]) => address === providerSource || address.endsWith(`/${providerSource}`),
    );
    const resource = match?.[1].resource_schemas?.[resourceType];
    if (!resource) {
      throw new Error(
        `resource ${resourceType} was not found for installed provider ${providerSource}`,
      );
    }
    return JSON.stringify({ providerAddress: match?.[0], resourceType, schema: resource });
  },
});

export const runTerraformCLI = tool({
  name: "run_terraform_cli",
  description:
    "Run an allow-listed, non-apply Terraform/OpenTofu command: fmt, validate, or plan.",
  parameters: z.object({
    workingDirectory: z.string().default("."),
    command: z.enum(["fmt", "validate", "plan"]),
  }),
  async execute({ workingDirectory, command }) {
    const argsByCommand: Record<string, string[]> = {
      fmt: ["fmt", "-recursive"],
      validate: ["validate", "-no-color"],
      plan: ["plan", "-no-color", "-input=false", "-lock=false"],
    };
    try {
      const result = await runCLI(
        argsByCommand[command] ?? [],
        command === "fmt" ? outputRoot : terraformDirectory(workingDirectory),
        16 * 1024 * 1024,
      );
      return JSON.stringify({ success: true, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      return JSON.stringify({
        success: false,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? String(error),
      });
    }
  },
});

function redactTerraform(content: string): string {
  return content.replace(
    /^(\s*[A-Za-z0-9_]*(?:token|secret|password|api_key)[A-Za-z0-9_]*\s*=\s*)"[^"]*"/gim,
    '$1"<redacted>"',
  );
}

function runCLI(args: string[], cwd: string, maxBuffer: number) {
  const executable = process.env.TERRAFORM_BINARY ?? "tofu";
  return execFileAsync(executable, args, {
    cwd,
    maxBuffer,
    timeout: 5 * 60 * 1000,
  });
}
