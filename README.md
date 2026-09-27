# singboxer

Benchmark VLESS nodes from a subscription with local [sing-box](https://github.com/SagerNet/sing-box) instances. The tool measures requests to Cloudflare over IPv4, compares each node with a direct connection, and ranks successful nodes by median latency.

The benchmark currently supports VLESS over TCP or gRPC. It builds a sing-box binary from the included submodule and caches it for that revision.

## Requirements

- [Bun](https://bun.sh/), Go, Git, curl, and GitHub SSH access for the submodule
- Network access to your subscription provider and Cloudflare

## Setup

```sh
git clone git@github.com:meoyawn/singboxer.git
cd singboxer
bun run setup
```

## Run

```sh
bun singbox.ts 'https://example.com/subscription'
```

Replace the example URL with your subscription URL. Do not commit subscription URLs, local configs, or benchmark results. To save results under the Git-ignored `.private/` directory:

```sh
mkdir -p .private
BENCHMARK_OUTPUT=.private/results.json bun singbox.ts 'https://example.com/subscription'
```

The result file includes node labels, public IP addresses, and probe errors. Run `bun singbox.ts --help` for the command summary. Settings such as `BENCHMARK_SAMPLES`, `BENCHMARK_WARMUPS`, and `BENCHMARK_TIMEOUT_MS` can be set through environment variables.

## License

This repository's code is licensed under GPL-3.0-only. See [LICENSE](LICENSE). The sing-box submodule is maintained separately upstream.
