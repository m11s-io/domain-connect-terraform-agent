# domain-connect-terraform-agent

An agent that converts a Domain Connect template into reviewable Terraform or
OpenTofu DNS configuration.

## Workflow

Given `providerId`, `serviceId`, a domain, variables, and a target Terraform DNS
provider, the agent:

1. fetches the template from the official Domain Connect GitHub repository;
2. reads the JSON and existing Terraform configuration;
3. asks Terraform MCP for the correct provider resource documentation;
4. verifies the exact installed resource with `providers schema -json`;
5. writes a generated `.tf` file;
6. runs `fmt`, `validate`, and `plan`;
7. returns the plan result for review.

The agent cannot run `apply`. Ambiguous operations such as SPFM merging,
redirects, apex aliases, registrar operations, and existing-record conflicts
stop the workflow instead of producing partial configuration.

See [agent/README.md](agent/README.md) for setup and usage.
