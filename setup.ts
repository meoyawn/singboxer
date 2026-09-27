#!/usr/bin/env bun

import { $ } from "bun";

const root = import.meta.dir;

await $`bun install`.cwd(root);
await $`git submodule update --init --remote --checkout sing-box`.cwd(root);
