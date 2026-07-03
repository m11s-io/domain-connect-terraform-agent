# Domain Connect Terraform agent

The agent has five capabilities:

- fetch a Domain Connect template from GitHub;
- query Terraform Registry through Terraform MCP;
- inspect the exact locally installed provider schema;
- read existing Terraform and write only to a generated directory;
- run `fmt`, `validate`, and `plan` through an allow-listed CLI tool.

It has no shell tool and cannot run `apply`.

The current implementation supports the locally installed Terraform MCP server
0.2.3, whose default toolset is Registry discovery. When upgrading the server,
keep its exposed tools restricted to provider search and provider details.

```sh
npm install
export OPENAI_API_KEY=...
export TERRAFORM_WORKSPACE_ROOT=/path/to/terraform/root
export TERRAFORM_OUTPUT_ROOT=/path/to/terraform/root/generated/domain-connect

npm run generate -- \
  --provider-id framer.com \
  --service-id domain \
  --domain example.com \
  --provider cloudflare/cloudflare \
  --variables '{"ip1":"192.0.2.10","ip2":"192.0.2.11","prefix":"customer"}'
```

Set `TERRAFORM_BINARY=terraform` when Terraform should be used instead of the
default `tofu` executable.
