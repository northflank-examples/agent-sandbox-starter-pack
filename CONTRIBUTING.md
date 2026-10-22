# Contributing

Thanks for helping make this a better resource. This repository is maintained by [Northflank](https://northflank.com), and contributions from anyone, including other sandbox vendors, are welcome.

## What's welcome

- **Corrections.** A wrong fact, a broken link, an outdated limit or SDK. Please link to the vendor's own documentation as the source.
- **Provider updates.** Changes to [`resources/sandbox-providers.md`](resources/sandbox-providers.md). Every claim must link to the provider's docs; we don't publish unsourced or comparative marketing claims.
- **Examples for other providers.** Ports of the TypeScript or Python examples to another sandbox SDK, under `examples/<language>/<provider>/`, with the same behaviour (create, exec with timeout, destroy in `finally`).
- **New tutorials**, for example snapshots, GPU sandboxes, or browser automation in a sandbox.
- **Security improvements** to the guides or examples.

Pricing changes belong in [agent-sandbox-pricing](https://github.com/northflank-examples/agent-sandbox-pricing), not here.

## Guidelines

- Keep it vendor-neutral outside the Northflank-specific sections and examples. Explain concepts so they apply to any provider.
- Don't claim a sandbox is "secure" in general; say which control reduces which risk.
- Examples must clean up after themselves and default to the smallest practical resources.
- Never commit tokens or `.env` files.
- Run checks before opening a PR:

```bash
cd examples/typescript && npm install && npm run typecheck
python3 -m py_compile examples/python/*.py
```

## Reporting security issues

If you find a security problem in the examples, please report it privately through GitHub's **Security → Report a vulnerability** tab rather than opening a public issue.
