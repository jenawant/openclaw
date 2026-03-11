#!/usr/bin/env bash
set -euo pipefail

echo "[merge-guard] 1/3 TypeScript checks"
pnpm tsgo

echo "[merge-guard] 2/3 UI role-guard tests"
pnpm --dir ui exec vitest run --config vitest.node.config.ts src/ui/navigation.role-guard.node.test.ts

echo "[merge-guard] 3/3 Gateway user-authz tests"
pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/user-authz.test.ts

echo "[merge-guard] done"
