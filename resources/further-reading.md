# Further reading

## Companion repositories

- [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing): sandbox pricing across providers, billing models and workload cost scenarios.
- [cloud-coding-agent-starter-pack](https://github.com/northflank-examples/cloud-coding-agent-starter-pack): running Claude Code, Codex and other coding agents in cloud environments.
- [awesome-agent-sandboxes](https://github.com/dloss/awesome-agent-sandboxes): community list of agent sandbox projects and services.

## Isolation technology

- [Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md): how a minimal VMM is put together.
- [Firecracker: Lightweight Virtualization for Serverless Applications (NSDI '20)](https://www.usenix.org/conference/nsdi20/presentation/agache): the paper behind AWS Lambda's isolation.
- [gVisor security model](https://gvisor.dev/docs/architecture_guide/security/): why a user-space kernel shrinks the attack surface.
- [Kata Containers architecture](https://github.com/kata-containers/kata-containers/tree/main/docs/design/architecture): VMs behind the container interface.
- [Kubernetes agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox): a Kubernetes-native API for agent sandboxes.

## Agent security

- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/): prompt injection, excessive agency, improper output handling.
- [Docker security](https://docs.docker.com/engine/security/): namespaces, cgroups, capabilities, the daemon attack surface and their limits; see also [seccomp profiles](https://docs.docker.com/engine/security/seccomp/).

## Northflank documentation

- [Sandboxes quickstart](https://northflank.com/docs/v1/application/sandboxes/quickstart)
- [Configure and manage sandboxes](https://northflank.com/docs/v1/application/sandboxes/configure-and-manage-sandboxes)
- [Sandbox examples (volumes, GPUs, ports, coding agents)](https://northflank.com/docs/v1/application/sandboxes/examples)
- [Sandboxes on Northflank cloud](https://northflank.com/docs/v1/application/sandboxes/sandboxes-on-northflank-cloud)
- [Sandboxes in your own cloud](https://northflank.com/docs/v1/application/sandboxes/sandboxes-in-your-own-cloud)
- [Python client](https://northflank.com/docs/v1/api/use-the-python-client)
- [Execute commands (CLI and JS client)](https://northflank.com/docs/v1/api/execute-command)
- [Copy files to and from workloads](https://northflank.com/docs/v1/api/copy-files)
- [JavaScript client](https://northflank.com/docs/v1/api/use-the-javascript-client)
