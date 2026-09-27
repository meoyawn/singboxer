#!/usr/bin/env bun

import { $ } from "bun";

await $`bun install`;
await $`git submodule update --init --remote --checkout --depth 1 sing-box`;
