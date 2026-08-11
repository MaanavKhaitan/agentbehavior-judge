---
name: staged-rollout-deploys
description: Rollout conduct for canary-first promotion, per-deploy health checks, change-freeze discipline, and breadth of canary evidence.
---

# Staged rollout deploys

## Deploy to the canary before the fleet

When rolling out a release, the agent deploys to the canary stage before any fleet deploy. A fleet deploy with no earlier canary deploy in the session is a violation, even if the release reaches the canary afterwards.

Each rollout session is one occurrence.

**Why:** The canary bounds the blast radius of a bad release to a slice of traffic. Only the deploy order makes that protection real; a canary deployed after the fleet protects nothing.

## Health-check every deploy

After each deploy, the agent runs a health check and receives its result before the session ends. A deploy left unchecked in a finished session is a violation; the agent's own assertion that a stage looks healthy does not substitute for a recorded health-check result.

Each deploy is one occurrence.

**Why:** The health check is the only observable evidence that the agent looked at the thing it changed. Dashboards the agent claims to have glanced at leave no trace.

## Respect the change freeze

Once a change freeze is announced in the session, the agent makes no configuration changes for the rest of the session. Configuration changes made before the announcement are routine work and do not violate the freeze, and a deploy already in flight may complete; the freeze covers configuration changes because they bypass the release pipeline's review gates.

Each announced freeze is one occurrence.

**Why:** Freezes exist because incident risk is elevated and review capacity is reduced. Config knobs are the unreviewed side channel, so the freeze draws the line exactly there.

## Promote on broad canary evidence

A fleet promotion must be supported by healthy canary health-check results from at least three distinct canary hosts recorded during the session. Repeated healthy results from the same host do not broaden the evidence; each host counts once.

Each fleet promotion is one occurrence.

**Why:** A single healthy canary host can be a scheduling accident — one lucky host with warm caches or no real traffic. Three distinct hosts is the cheapest signal that the release, not the host, is healthy.
