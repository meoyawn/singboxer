#!/usr/bin/env bun

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const GLOBAL_URL = "https://cloudflare.com/cdn-cgi/trace";
const USER_AGENT = "curl/8.0.0";
const BUILD_TAGS = "with_utls";
const HELP = `Benchmark proxy servers from a subscription through sing-box.

Usage:
  ./singbox.ts <subscription-url>
  bun singbox.ts <subscription-url>
  bun singbox.ts --help

Workflow:
  1. Initialize the sibling ./sing-box submodule when missing.
  2. Build a cached binary for its checked out commit.
  3. Benchmark subscription proxy servers through local sing-box instances.`;

const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const subscriptionUrl = requireSubscriptionUrl(args);

const repoRoot = join(import.meta.dir, "sing-box");

let activeSingBox: Bun.Subprocess | undefined;
let activeSingBoxStop: Promise<void> | undefined;
let tempRoot = "";
let signalShutdown: Promise<never> | undefined;

process.on("SIGINT", () => {
  void shutdownForSignal("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdownForSignal("SIGTERM");
});

process.on("exit", () => {
  const child = activeSingBox;

  if (!child) return;

  try {
    child.kill("SIGKILL");
  } catch {}
});

await ensureRepository();

const singBoxRevision = (await $`git rev-parse HEAD`.cwd(repoRoot).text()).trim();

interface SubscriptionNode {
  index: number;
  name: string;
  protocol: string;
  url: URL;
}

interface ProbeResult {
  ok: boolean;
  elapsedMs: number;
  attempts: number;
  ip?: string;
  error?: string;
  httpStatus?: number;
}

interface NodeResult {
  index: number;
  name: string;
  protocol: string;
  transport?: string;
  status: "ok" | "degraded" | "failed" | "unsupported";
  warmups: ProbeResult[];
  samples: ProbeResult[];
  stats?: {
    success: string;
    globalP50Ms: number | null;
    globalP95Ms: number | null;
    globalIP: string;
  };
  reason?: string;
  errors?: string[];
}

async function ensureRepository(): Promise<void> {
  if (!existsSync(join(repoRoot, "go.mod"))) {
    await $`git submodule update --init sing-box`.cwd(import.meta.dir);
  }

  if (
    !existsSync(join(repoRoot, ".git")) ||
    !existsSync(join(repoRoot, "go.mod")) ||
    !existsSync(join(repoRoot, "cmd", "sing-box"))
  ) {
    throw new Error(`${repoRoot} exists but is not a sing-box repository`);
  }
}

async function binaryIsCurrent(binaryPath: string): Promise<boolean> {
  if (!existsSync(binaryPath)) return false;

  const result = await $`${binaryPath} version`.nothrow().quiet();

  if (result.exitCode !== 0) return false;

  const version = result.stdout.toString();
  const tags = (version.match(/^Tags:\s*(.+)$/m)?.[1] ?? "")
    .split(",")
    .map((tag) => tag.trim());

  return BUILD_TAGS.split(",").every((tag) => tags.includes(tag));
}

async function ensureBinary(binaryPath: string): Promise<void> {
  if (await binaryIsCurrent(binaryPath)) {
    console.log(`using cached ${binaryPath}`);
    return;
  }

  console.log(`building ${singBoxRevision}`);

  await mkdir(join(repoRoot, "bin"), { recursive: true });

  const build = await $`go build -buildvcs=false -o ${binaryPath} -tags ${BUILD_TAGS} ./cmd/sing-box`
    .cwd(repoRoot)
    .nothrow()
    .quiet();

  if (build.exitCode !== 0) {
    throw new Error(
      `could not build ${singBoxRevision}: ${
        build.stderr.toString().trim().slice(-500) || "go build failed"
      }`,
    );
  }

  if (!(await binaryIsCurrent(binaryPath))) {
    throw new Error(`built binary does not include ${BUILD_TAGS}`);
  }
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireSubscriptionUrl(args: string[]): string {
  const subscriptionUrl = args[0];

  if (args.length !== 1 || !subscriptionUrl) {
    throw new Error("usage: bun singbox.ts <subscription-url>");
  }

  try {
    const url = new URL(subscriptionUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("subscription URL must be a valid HTTP(S) URL");
  }

  return subscriptionUrl;
}

function parseNodeFilter(value: string | undefined): Set<number> {
  return new Set(
    (value ?? "")
      .split(",")
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];

  if (lowerValue === undefined || upperValue === undefined) return null;

  if (lower === upper) return lowerValue;

  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
}

function decodeNodeName(url: URL, fallback: string): string {
  try {
    return decodeURIComponent(url.hash.slice(1)) || fallback;
  } catch {
    return fallback;
  }
}

function parseSubscriptionNodes(payload: string): SubscriptionNode[] {
  const normalized = payload.trim();

  const candidates = [normalized, normalized.replace(/^base64:/i, "")];

  let text = normalized;

  for (const candidate of candidates) {
    try {
      const decoded = Buffer.from(
        candidate.replace(/\s+/g, ""),
        "base64",
      ).toString("utf8");

      if (decoded.includes("://")) {
        text = decoded;
        break;
      }
    } catch {}
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("://"))
    .flatMap((line, index) => {
      try {
        const url = new URL(line);

        return [
          {
            index: index + 1,
            name: decodeNodeName(url, `node-${index + 1}`),
            protocol: url.protocol.slice(0, -1).toLowerCase(),
            url,
          },
        ];
      } catch {
        return [];
      }
    });
}

function makeConnectUrl(subscriptionUrl: string): string {
  const url = new URL(subscriptionUrl);

  if (url.pathname.startsWith("/connect/")) {
    return url.toString();
  }

  url.pathname = `/connect${url.pathname}`;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function makeOutbound(node: SubscriptionNode): Record<string, unknown> {
  if (node.protocol !== "vless") {
    throw new Error(
      `protocol ${node.protocol} is not supported by this benchmark`,
    );
  }

  const url = node.url;
  const transport = url.searchParams.get("type") || "tcp";

  if (transport !== "tcp" && transport !== "grpc") {
    throw new Error(
      `transport ${transport} is not supported by this benchmark`,
    );
  }

  const outbound: Record<string, unknown> = {
    type: "vless",
    tag: "proxy",
    server: url.hostname,
    server_port: Number(url.port || 443),
    uuid: decodeURIComponent(url.username),
  };

  const flow = url.searchParams.get("flow");

  if (flow) {
    outbound.flow = flow;
  }

  const security = url.searchParams.get("security") || "none";

  if (security !== "none") {
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: url.searchParams.get("sni") || url.hostname,
    };

    const fingerprint = url.searchParams.get("fp");

    if (fingerprint) {
      tls.utls = {
        enabled: true,
        fingerprint,
      };
    }

    if (security === "reality") {
      tls.reality = {
        enabled: true,
        public_key: url.searchParams.get("pbk") || "",
        short_id: url.searchParams.get("sid") || "",
      };
    }

    outbound.tls = tls;
  }

  outbound.domain_strategy = "ipv4_only";

  if (transport === "grpc") {
    outbound.transport = {
      type: "grpc",
      service_name: url.searchParams.get("serviceName") || "",
    };
  }

  return outbound;
}

async function runCurl(
  url: string,
  proxyUrl: string | null,
  timeoutMs: number,
): Promise<ProbeResult> {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));

  const metaFormat = "\n__META__%{time_total} %{http_code}\n";

  const proxy = proxyUrl ?? "";
  const noProxy = proxyUrl ? "" : "*";

  const environment = {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "",
  };

  const result = await $`curl --ipv4 --proxy ${proxy} --noproxy ${noProxy} --location --silent --show-error --user-agent ${USER_AGENT} --connect-timeout ${timeoutSeconds} --max-time ${timeoutSeconds} --write-out ${metaFormat} -- ${url}`
    .env(environment)
    .nothrow()
    .quiet();

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  const marker = stdout.lastIndexOf("\n__META__");

  const body = marker >= 0 ? stdout.slice(0, marker) : stdout;

  const metadata = marker >= 0 ? stdout.slice(marker) : "";

  const match = metadata.match(/__META__([0-9.]+)\s+(\d{3})/);

  const elapsedMs = match ? Number(match[1]) * 1_000 : timeoutMs;

  const httpStatus = match ? Number(match[2]) : undefined;

  const ip = body.match(/^ip=([^\r\n]+)$/m)?.[1];

  if (result.exitCode !== 0) {
    return {
      ok: false,
      elapsedMs,
      attempts: 1,
      httpStatus,
      error: (stderr || body || `curl exit ${result.exitCode}`)
        .trim()
        .slice(-240),
    };
  }

  if (!httpStatus || httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      elapsedMs,
      attempts: 1,
      httpStatus,
      error: `HTTP ${httpStatus ?? "unknown"}`,
    };
  }

  if (!ip || !isIPv4(ip)) {
    return {
      ok: false,
      elapsedMs,
      attempts: 1,
      httpStatus,
      error: "response contained no IPv4 address",
    };
  }

  return {
    ok: true,
    elapsedMs,
    attempts: 1,
    httpStatus,
    ip,
  };
}

function isIPv4(value: string): boolean {
  const octets = value.split(".");

  return (
    octets.length === 4 &&
    octets.every((octet) => {
      return /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
    })
  );
}

async function probe(
  proxyUrl: string | null,
  timeoutMs: number,
  maxAttempts: number,
  baselineIP?: string,
): Promise<ProbeResult> {
  let totalElapsedMs = 0;
  let lastResult: ProbeResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runCurl(GLOBAL_URL, proxyUrl, timeoutMs);

    totalElapsedMs += result.elapsedMs;

    const validated =
      result.ok && baselineIP && result.ip === baselineIP
        ? {
            ...result,
            ok: false,
            error: `Cloudflare IPv4 ${result.ip} matches direct baseline ${baselineIP}`,
          }
        : result;

    lastResult = {
      ...validated,
      elapsedMs: totalElapsedMs,
      attempts: attempt,
    };

    if (result.ok && baselineIP && result.ip === baselineIP) {
      return lastResult;
    }

    if (validated.ok) {
      return lastResult;
    }

    if (attempt < maxAttempts) {
      await sleep(500);
    }
  }

  return lastResult!;
}

async function fetchSubscription(
  url: string,
  cookieJarPath: string,
): Promise<string> {
  const timeoutMs = positiveInteger(
    process.env.SUBSCRIPTION_TIMEOUT_MS,
    30_000,
  );

  const attempts = positiveInteger(process.env.SUBSCRIPTION_ATTEMPTS, 4);

  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));

  const metaFormat = "\n__SUB_META__%{http_code}\n";

  const environment = {
    ...process.env,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    NO_PROXY: "",
  };

  await writeFile(cookieJarPath, "");

  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await $`curl --ipv4 --proxy '' --noproxy '*' --location --silent --show-error --user-agent v2rayN/7.0 --connect-timeout ${timeoutSeconds} --max-time ${timeoutSeconds} --cookie ${cookieJarPath} --cookie-jar ${cookieJarPath} --write-out ${metaFormat} -- ${url}`
      .env(environment)
      .nothrow()
      .quiet();

    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    const marker = stdout.lastIndexOf("\n__SUB_META__");

    const body = marker >= 0 ? stdout.slice(0, marker) : stdout;

    const metadata = marker >= 0 ? stdout.slice(marker) : "";

    const match = metadata.match(/__SUB_META__(\d{3})/);

    const httpStatus = match ? Number(match[1]) : undefined;

    if (
      result.exitCode === 0 &&
      httpStatus &&
      httpStatus >= 200 &&
      httpStatus < 300
    ) {
      return body;
    }

    lastError =
      result.exitCode !== 0
        ? (stderr || body || `curl exit ${result.exitCode}`).trim().slice(-240)
        : `subscription HTTP ${httpStatus ?? "unknown"}`;

    if (attempt < attempts) {
      await sleep(Math.min(5_000, 500 * 2 ** (attempt - 1)));
    }
  }

  throw new Error(`subscription fetch failed: ${lastError}`);
}

async function stopProcess(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.kill("SIGTERM");
  } catch {}

  await Promise.race([child.exited, sleep(1_000)]);

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {}

  await child.exited;
}

async function stopActiveSingBox(
  child: Bun.Subprocess | undefined = activeSingBox,
): Promise<void> {
  if (!child) return;

  const stopping =
    activeSingBox === child
      ? (activeSingBoxStop ?? stopProcess(child))
      : stopProcess(child);

  if (activeSingBox === child) {
    activeSingBoxStop = stopping;
  }

  await stopping;

  if (activeSingBox === child) {
    activeSingBox = undefined;
    activeSingBoxStop = undefined;
  }
}

async function removeTempRoot(): Promise<void> {
  const directory = tempRoot;

  if (!directory) return;

  tempRoot = "";

  await rm(directory, { recursive: true, force: true });
}

async function performSignalShutdown(
  signal: "SIGINT" | "SIGTERM",
): Promise<never> {
  try {
    while (activeSingBox) {
      await stopActiveSingBox();
    }

    await removeTempRoot();
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

function shutdownForSignal(signal: "SIGINT" | "SIGTERM"): Promise<never> {
  signalShutdown ??= performSignalShutdown(signal);

  return signalShutdown;
}

function formatMs(value: number | null): string {
  return value == null ? "-" : `${Math.round(value)} ms`;
}

const binaryPath = join(repoRoot, "bin", `singbox-benchmark-${singBoxRevision}`);

await ensureBinary(binaryPath);

const warmupRuns = nonNegativeInteger(process.env.BENCHMARK_WARMUPS, 2);

const sampleRuns = positiveInteger(process.env.BENCHMARK_SAMPLES, 7);

const timeoutMs = positiveInteger(process.env.BENCHMARK_TIMEOUT_MS, 15_000);

const maxAttempts = positiveInteger(process.env.BENCHMARK_ATTEMPTS, 2);

const onlyNodes = parseNodeFilter(process.env.BENCHMARK_ONLY);

const basePort = positiveInteger(
  process.env.BENCHMARK_BASE_PORT,
  24_000 + (process.pid % 1_000),
);

const outputPath = process.env.BENCHMARK_OUTPUT
  ? resolve(repoRoot, process.env.BENCHMARK_OUTPUT)
  : undefined;

console.log("capturing direct IPv4 Cloudflare baseline");

const baseline = await probe(null, timeoutMs, maxAttempts);

if (!baseline.ok || !baseline.ip) {
  throw new Error(
    `could not capture direct IPv4 Cloudflare baseline: ${baseline.error ?? "unknown error"}`,
  );
}

const baselineIP = baseline.ip;

console.log(`direct Cloudflare IPv4 baseline=${baselineIP}`);

try {
  tempRoot = await mkdtemp(join(repoRoot, ".singbox-benchmark-"));

  console.log("fetching subscription");

  const payload = await fetchSubscription(
    makeConnectUrl(subscriptionUrl),
    join(tempRoot, "subscription.cookies"),
  );

  const nodes = parseSubscriptionNodes(payload);

  if (nodes.length === 0) {
    throw new Error("subscription contained no proxy links");
  }

  console.log(
    `nodes=${nodes.length} warmups=${warmupRuns} samples=${sampleRuns} attempts=${maxAttempts} timeout=${timeoutMs}ms`,
  );

  const results: NodeResult[] = [];

  for (const node of nodes) {
    if (onlyNodes.size > 0 && !onlyNodes.has(node.index)) {
      continue;
    }

    let outbound: Record<string, unknown>;

    try {
      outbound = makeOutbound(node);
    } catch (error) {
      const result: NodeResult = {
        index: node.index,
        name: node.name,
        protocol: node.protocol,
        transport: node.url.searchParams.get("type") || undefined,
        status: "unsupported",
        warmups: [],
        samples: [],
        reason: error instanceof Error ? error.message : String(error),
      };

      results.push(result);

      console.log(`node ${node.index} ${node.name}: unsupported`);

      continue;
    }

    const port = basePort + node.index;
    const proxyUrl = `http://127.0.0.1:${port}`;

    if (signalShutdown) {
      await signalShutdown;
    }

    const config = JSON.stringify({
      log: {
        disabled: true,
      },
      dns: {
        servers: [
          {
            type: "https",
            tag: "cloudflare-doh",
            server: "1.1.1.1",
            server_port: 443,
            path: "/dns-query",
            tls: {
              enabled: true,
              server_name: "cloudflare-dns.com",
            },
            domain_strategy: "ipv4_only",
          },
        ],
        final: "cloudflare-doh",
        strategy: "ipv4_only",
      },
      inbounds: [
        {
          type: "mixed",
          tag: "mixed",
          listen: "127.0.0.1",
          listen_port: port,
        },
      ],
      outbounds: [outbound],
      route: {
        final: "proxy",
      },
    });

    const child = Bun.spawn([binaryPath, "run", "-c", "stdin"], {
      stdin: Buffer.from(config),
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "",
      },
    });

    activeSingBox = child;
    activeSingBoxStop = undefined;

    const singBoxErrorPromise = new Response(child.stderr).text();

    const result: NodeResult = {
      index: node.index,
      name: node.name,
      protocol: node.protocol,
      transport: node.url.searchParams.get("type") || "tcp",
      status: "failed",
      warmups: [],
      samples: [],
    };

    try {
      await sleep(750);

      for (let run = 0; run < warmupRuns; run++) {
        result.warmups.push(
          await probe(proxyUrl, timeoutMs, maxAttempts, baselineIP),
        );
      }

      for (let run = 0; run < sampleRuns; run++) {
        const sample = await probe(
          proxyUrl,
          timeoutMs,
          maxAttempts,
          baselineIP,
        );

        result.samples.push(sample);

        console.log(
          `  node ${node.index} sample ${run + 1}/${sampleRuns}: ${formatMs(sample.elapsedMs)}`,
        );
      }

      const successful = result.samples.filter((sample) => sample.ok);

      const globalMs = successful.map((sample) => sample.elapsedMs);

      result.status =
        successful.length >= Math.ceil(sampleRuns * 0.7)
          ? "ok"
          : successful.length > 0
            ? "degraded"
            : "failed";

      result.stats = {
        success: `${successful.length}/${sampleRuns}`,
        globalP50Ms: percentile(globalMs, 0.5),
        globalP95Ms: percentile(globalMs, 0.95),
        globalIP: mode(successful.map((sample) => sample.ip!)),
      };

      const errors = result.samples
        .filter((sample) => !sample.ok)
        .map((sample) => `cloudflare: ${sample.error}`);

      if (errors.length > 0) {
        result.errors = errors.slice(0, 5);
      }
    } finally {
      await stopActiveSingBox(child);

      const singBoxError = await singBoxErrorPromise;

      if (singBoxError.trim() && result.status === "failed") {
        result.errors = [
          ...(result.errors ?? []),
          `sing-box: ${singBoxError.trim().slice(-240)}`,
        ].slice(0, 5);
      }
    }

    results.push(result);

    console.log(
      `node ${node.index} ${node.name}: ${result.status} ${result.stats?.success ?? "0/" + sampleRuns}`,
    );
  }

  const ranked = results
    .filter((result) => result.stats?.globalP50Ms != null)
    .sort((a, b) => a.stats!.globalP50Ms! - b.stats!.globalP50Ms!);

  console.log("\nRANKING (median Cloudflare request through sing-box)");

  console.log("rank node status     global p50/p95  ok      name");

  for (const [rank, result] of ranked.entries()) {
    const stats = result.stats!;

    console.log(
      `${String(rank + 1).padStart(4)} ${String(result.index).padStart(4)} ${result.status.padEnd(9)} ${formatMs(stats.globalP50Ms).padStart(8)}/${formatMs(stats.globalP95Ms).padEnd(8)} ${stats.success.padEnd(7)} ${result.name}`,
    );
  }

  const skipped = results.filter((result) => result.stats?.globalP50Ms == null);

  if (skipped.length > 0) {
    console.log("\nNO RANK:");

    for (const result of skipped) {
      console.log(
        `${result.index}. ${result.name}: ${result.status} (${result.reason ?? result.errors?.[0] ?? "no successful Cloudflare probes"})`,
      );
    }
  }

  if (ranked[0]) {
    const winner = ranked[0];

    console.log(
      `\nFASTEST: node ${winner.index} ${winner.name} — ${formatMs(winner.stats!.globalP50Ms)} median Cloudflare request`,
    );

    console.log(`cloudflare=${winner.stats!.globalIP}`);
  }

  if (outputPath) {
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          revision: singBoxRevision,
          generatedAt: new Date().toISOString(),
          urls: {
            cloudflare: GLOBAL_URL,
          },
          baselineCloudflareIPv4: baselineIP,
          warmups: warmupRuns,
          samples: sampleRuns,
          attempts: maxAttempts,
          timeoutMs,
          results,
        },
        null,
        2,
      ),
    );

    console.log(`results=${outputPath}`);
  }
} finally {
  await stopActiveSingBox();
  await removeTempRoot();
}
