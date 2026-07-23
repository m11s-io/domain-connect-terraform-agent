import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, before, describe, test } from "node:test";

// The tools module resolves workspaceRoot/outputRoot from env vars at import
// time, so the sandbox must exist before the first (dynamic) import.
const workspaceRoot = await mkdtemp(join(tmpdir(), "dc-agent-workspace-"));
const outputRoot = join(workspaceRoot, "generated", "domain-connect");
process.env.TERRAFORM_WORKSPACE_ROOT = workspaceRoot;
process.env.TERRAFORM_OUTPUT_ROOT = outputRoot;
process.env.TERRAFORM_BINARY = join(workspaceRoot, "fake-tofu.sh");

const {
  fetchDomainConnectTemplate,
  readTerraformFiles,
  writeTerraformFile,
  runTerraformCLI,
} = await import("./tools.js");

const fakeRunContext = {} as never;

async function invoke(tool: { invoke: (ctx: never, input: string) => Promise<unknown> }, input: unknown) {
  return tool.invoke(fakeRunContext, JSON.stringify(input));
}

// The @openai/agents tool wrapper never lets invoke() reject: by default it
// catches execute()/schema-validation errors and returns them as a string
// ("An error occurred while running the tool... Error: <details>") so the
// model can see the failure. Assert against that string instead of rejects().
async function invokeExpectingFailure(
  tool: { invoke: (ctx: never, input: string) => Promise<unknown> },
  input: unknown,
  pattern: RegExp,
) {
  const result = await invoke(tool, input);
  assert.equal(typeof result, "string");
  assert.match(result as string, pattern);
}

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("fetch_domain_connect_template", () => {
  const originalFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the template when the identity matches", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ providerId: "framer.com", serviceId: "domain", records: [] }),
        { status: 200 },
      )) as typeof fetch;

    const result = JSON.parse(
      (await invoke(fetchDomainConnectTemplate, {
        providerId: "framer.com",
        serviceId: "domain",
      })) as string,
    );
    assert.equal(result.template.providerId, "framer.com");
  });

  test("rejects a template whose identity does not match the request", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ providerId: "someone-else.com", serviceId: "domain", records: [] }),
        { status: 200 },
      )) as typeof fetch;

    await invokeExpectingFailure(
      fetchDomainConnectTemplate,
      { providerId: "framer.com", serviceId: "domain" },
      /does not match the requested template identity/,
    );
  });

  test("rejects a non-2xx HTTP response", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;

    await invokeExpectingFailure(
      fetchDomainConnectTemplate,
      { providerId: "framer.com", serviceId: "domain" },
      /HTTP 404/,
    );
  });
});

describe("filesystem boundaries", () => {
  before(async () => {
    await mkdir(workspaceRoot, { recursive: true });
  });

  test("write_terraform_file rejects a non-.tf extension", async () => {
    await invokeExpectingFailure(
      writeTerraformFile,
      { path: "records.txt", content: "resource {}" },
      /must use a \.tf extension/,
    );
  });

  test("write_terraform_file rejects a path that escapes the output root", async () => {
    await invokeExpectingFailure(
      writeTerraformFile,
      { path: "../../escape.tf", content: "resource {}" },
      /path escapes allowed root/,
    );
  });

  test("write_terraform_file writes atomically inside the output root", async () => {
    const result = JSON.parse(
      (await invoke(writeTerraformFile, {
        path: "framer.tf",
        content: 'resource "cloudflare_record" "framer" {}',
      })) as string,
    );
    assert.equal(result.path, `generated${sep}domain-connect${sep}framer.tf`);
    const written = await readFile(join(outputRoot, "framer.tf"), "utf8");
    assert.match(written, /cloudflare_record/);
  });

  test("read_terraform_files rejects a working directory that escapes the workspace root", async () => {
    await invokeExpectingFailure(
      readTerraformFiles,
      { workingDirectory: "../outside" },
      /path escapes allowed root/,
    );
  });
});

describe("secret redaction", () => {
  test("read_terraform_files redacts token/secret/password/api_key values", async () => {
    const directory = join(workspaceRoot, "existing");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "provider.tf"),
      [
        'provider "cloudflare" {',
        '  api_token = "supersecretvalue"',
        '  password  = "hunter2"',
        '}',
        'resource "cloudflare_record" "keep" {',
        '  name = "www"',
        '}',
      ].join("\n"),
    );

    const documents = JSON.parse((await invoke(readTerraformFiles, { workingDirectory: "existing" })) as string) as Array<{
      path: string;
      content: string;
    }>;
    const provider = documents.find((doc) => doc.path.endsWith("provider.tf"));
    assert.ok(provider);
    assert.doesNotMatch(provider.content, /supersecretvalue/);
    assert.doesNotMatch(provider.content, /hunter2/);
    assert.match(provider.content, /api_token = "<redacted>"/);
    assert.match(provider.content, /password  = "<redacted>"/);
    assert.match(provider.content, /name = "www"/);
  });
});

describe("run_terraform_cli allow-listing", () => {
  before(async () => {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(
      process.env.TERRAFORM_BINARY as string,
      "#!/bin/sh\necho \"$@\"\n",
      { mode: 0o755 },
    );
  });

  test("rejects commands outside the fmt/validate/plan allow-list", async () => {
    await invokeExpectingFailure(runTerraformCLI, { command: "apply" }, /invalid|enum|apply/i);
  });

  for (const command of ["fmt", "validate", "plan"] as const) {
    test(`runs the allow-listed "${command}" command`, async () => {
      const result = JSON.parse((await invoke(runTerraformCLI, { command })) as string);
      assert.equal(result.success, true);
      assert.match(result.stdout, new RegExp(command));
    });
  }
});
