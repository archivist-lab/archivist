---
title: "Feature specification: Network Egress Control"
document_type: specification
status: draft
updated: 2026-08-23
---

# Feature Specification — Network Egress Control (VPN, proxy routing, Trawl placement)

**Project:** Archivist (`archivist-lab/archivist`)
**Subsystem:** Control / Acquisition / Indexers
**Status:** Draft for review — phases 0–3 implemented (§6); phase 4 not accepted, not implemented
**Depends on:** [Indexer Endpoint Resolver](indexer-endpoint-resolver-spec.md), Archivist Control, Trawl (CloudflareBypass integration)

---

## 0. Assumptions

Stated because they materially shape the design. Correct any that are wrong before implementation starts.

| # | Assumption | If wrong |
|---|---|---|
| 0.1 | The operator's ISP performs TLS/SNI-level interception, not DNS poisoning. | If the block is DNS-based, encrypted DNS solves it and most of this specification is unnecessary. |
| 0.2 | Trawl is [germondai/trawl](https://github.com/germondai/trawl) (AGPL-3.0), a separate service reachable over HTTP, now running on the Archivist host under Control. It was previously a remote instance on another machine. | If Trawl moves in-process, §5 becomes the primary integration point rather than a deferred option. Its AGPL licence is why it stays a separate service rather than vendored source. |
| 0.3 | Control keeps its present security model: unprivileged service, privilege held by systemd units and granted by polkit. | If Control gains direct privilege, §3 collapses into a simpler but far more dangerous design. |
| 0.4 | Naming follows the IER spec: **Trawl** is this repository's CloudflareBypass integration. | Terminology only; concepts unchanged. |
| 0.5 | The operator wants *selective* egress control, not anonymity for all traffic. | If full-host anonymity is the goal, §4.1 becomes the design and §4.2/§4.3 are dropped. |

---

## 1. Problem

Indexer endpoints can be unreachable for reasons the application cannot detect, diagnose, or repair, because the failure is in the **network path**, not in the endpoint or the definition.

Observed on the reference install (2026-08-23):

- `EXT Torrents` has 11 endpoints. **None has ever succeeded** (`last_ok_at IS NULL` across all 11).
- DNS resolution is correct: `search.extto.com` resolves to Cloudflare addresses (`104.21.49.83`, `172.67.160.110`) on both the local and public resolvers.
- A direct request returns `403` in under 400 ms.
- A Trawl request returns `status: ok` but the solved page is `http://lighthouse.du.ae/` — the ISP's block portal.
- Other mirrors behave identically (`ext.torrentbay.to`, `t.extto.com` → block portal; `extranet.torrentbay.net` → parked domain; `ext.to`, `extranet.torrentbay.st` → no response).

The block is applied by the operator's ISP at the TLS/SNI layer. It follows every request that leaves the host, whatever process makes it.

### 1.1 Why the current design cannot resolve this

- **The resolver cannot route around it.** Every endpoint for the indexer shares one egress path, so failover between them cannot help.
- **Trawl cannot solve it.** Trawl clears bot challenges; it does not change egress. An in-process browser would land on the same block portal.
- **Proxy configuration was inert** (resolved by Phase 1, §4.3). `proxyUrl` was threaded through `indexer-store.ts` → `search-aggregator.ts` → `cardigann/probe.ts` → `cardigann/executor.ts` and then dropped: no `ProxyAgent`, no dispatcher, and no `proxy` field in the Trawl payload. Setting a proxy changed nothing. It now routes both paths, but a proxy only helps if its own egress is unblocked — so this alone does not resolve §1.

### 1.2 Related defect, already fixed

A saturated Trawl browser pool was being classified as `connect` and therefore scored tier `D`, marking reachable endpoints dead. A `bypass_unavailable` failure class now carries this: it maps to tier `unknown`, leaves the endpoint's tier untouched, and is excluded from `ENDPOINT_AT_FAULT`. That fix is a prerequisite for this work — without it, routing changes are unmeasurable, because infrastructure faults are recorded as endpoint verdicts. It does not by itself make any blocked endpoint reachable.

---

## 2. Goals

- **G1** — Give the operator a supported way to change the egress path used for indexer traffic.
- **G2** — Keep egress control **selective**. Traffic that gains nothing from a tunnel must be able to stay on the direct link.
- **G3** — Hold the privilege in systemd units governed by polkit. No new capability for `archivist-control-agent`.
- **G4** — Make the existing per-indexer proxy setting function as the UI already implies.
- **G5** — Surface tunnel state as observable health, in the same idiom as endpoint tiers.

### 2.1 Non-goals

- Anonymity or threat-model guarantees. This is a reachability feature.
- Shipping or endorsing any VPN provider.
- Circumventing access controls on any individual site. The tunnel changes which network the host appears to originate from; it does not defeat authentication or per-account limits.
- In-process Trawl. Assessed in §5, deliberately deferred.

---

## 3. Placement — why Control owns the VPN

### 3.1 The existing pattern

Control is unprivileged (`User=archivist-control`) and performs privileged operations by invoking `systemctl --no-ask-password <verb> <unit>` (`apps/control/src/server/host.ts`). A polkit rule (`deploy/polkit/50-archivist-control.rules`) narrows that authority to a single unit and three verbs:

```js
if (unit === 'archivist.service' && allowedVerb) return polkit.Result.YES
return polkit.Result.NO
```

**The privilege lives in the unit, not in Control.** VPN lifecycle is the same shape — start, stop, restart, report state — so it fits this pattern without inventing a new mechanism.

### 3.2 What must not happen

The VPN must **not** be implemented inside `archivist-control-agent`. Its unit is deliberately hardened against exactly this class of work:

```
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE   # file capabilities only; no CAP_NET_ADMIN
RestrictAddressFamilies=AF_UNIX                              # cannot open a network socket
RestrictNamespaces=true                                      # cannot create a network namespace
ProtectKernelModules=true                                    # cannot load the wireguard module
```

The agent is a filesystem agent that happens to run as root. Granting it `CAP_NET_ADMIN` and netlink access would convert the most privileged component in the system into a general-purpose root network daemon, for a feature that does not require it.

### 3.3 The design

| Concern | Owner | Mechanism |
|---|---|---|
| Tunnel privilege | A dedicated unit (`archivist-vpn.service`, or `wg-quick@archivist.service`) | systemd |
| Lifecycle authority | Control | polkit rule extended to the new unit, same three verbs |
| Registration | Control | one entry in the `services` record in `apps/control/src/server/host.ts` |
| Configuration file | `archivist-control-agent` | existing `CAP_DAC_OVERRIDE`, writing under `/etc/archivist/vpn/` |
| Presentation | Control UI | toggle plus state, alongside the runtime service |
| Trawl lifecycle | A unit wrapping its Compose project (`archivist-trawl.service`) | systemd, same polkit path |

No component gains a capability it does not already hold. `services` is already a single-entry, environment-overridable map, structured to grow.

### 3.4 Credential handling

The tunnel private key is a secret of the same class as indexer credentials.

- Written only by the agent, to `/etc/archivist/vpn/`, mode `0600`, owner `root`.
- Never returned by any Control API. The UI shows presence, interface name, endpoint host, and last handshake — never key material.
- Excluded from telemetry, logs, backups, and support bundles.
- `scripts/push.sh` must never stage `/etc/archivist`; it is outside the repository, but the exclusion list should state this explicitly.

---

### 3.5 Trawl under Control — **implemented**

Trawl previously ran on a separate machine, which put it outside Control's reach: Control manages units on its own host and nothing else. It now runs on the Archivist host as a Compose project wrapped in `archivist-trawl.service`, which makes it an ordinary entry in the same registry as the runtime — status, logs, and start/stop/restart with no new mechanism and no Docker adapter. Control never speaks to Docker; it calls `systemctl`, and the unit calls Compose.

The Control UI needed no change. It already renders `snapshot.services`, so registry entries surface with their controls automatically.

Two constraints are deliberate:

- **Trawl's source is not vendored.** Trawl is AGPL-3.0 and Archivist is GPL-3.0. Speaking to it over HTTP is mere aggregation; copying its source into this repository would extend AGPL §13 network-disclosure obligations across the combined work.
- **The repository drop-in is not applied to `archivist-control-agent.service`.** Control itself may run from the working repository, as the runtime does. The agent runs as root, and sourcing root-executed code from a repository any unprivileged user can write turns "write a file" into "execute as root". The agent stays on the immutable release.

Its default `BROWSER_POOL_SIZE` of 3 is raised in the shipped compose file. That default is what produced the saturation described in §1.2.

## 4. Scope of traffic — the substantive decision

A tunnel is easy to start. Deciding what goes through it is the design.

### 4.1 Whole-host default route

Simplest to build, and the option with the widest consequences.

| Traffic | Consequence |
|---|---|
| Indexers and Trawl | Resolves the reported problem. |
| Torrent peer traffic | Commonly desired, but without port forwarding on the tunnel there are no inbound connections; seeding and swarm health degrade. |
| Metadata providers | See §4.4. |
| Inbound LAN access to `2424`, `4242`, `2428` | A `0.0.0.0/0` route breaks reply routing. Without `Table=off` plus policy routing, or explicit LAN excludes, **the operator loses access to their own UI.** |
| Tunnel failure | Requires an explicit choice: kill-switch (all egress stops) or leak (traffic silently returns to the blocked path). |

**Not recommended as the default.** If offered, it must be opt-in, must exclude LAN subnets, and must state the kill-switch behaviour plainly.

### 4.2 Scoped egress by routing policy — **implemented**

An earlier draft proposed `NetworkNamespacePath=` to place Trawl in the tunnel's namespace. That does not survive contact with the deployment: Trawl is a Docker Compose project whose networking Docker owns, and when it runs on another host there is no local namespace to place it in at all. The namespace is the wrong seam.

What is built instead scopes the tunnel by **who sends the traffic**, not by which namespace it sits in:

1. WireGuard comes up with `Table = off`, so it never becomes the host default route.
2. `deploy/vpn-routing.sh` installs two policy rules for a dedicated egress user — local destinations to the main table, everything else to the tunnel table.
3. `deploy/vpn-proxy.mjs` runs as that user, so anything that proxies through it leaves by the tunnel.

Both consumers reach it without new mechanism: the engine's per-indexer `proxyUrl` (§4.3), and Trawl's own `PROXY_URL`. Challenge solving and direct indexer fetches can therefore share one egress while metadata, torrent, and LAN traffic stay on the direct link — so §4.4 does not arise.

The local-destination rule is load-bearing rather than cosmetic. Without it the proxy's replies to its own LAN clients would be routed back through the tunnel, and the proxy would accept connections and then appear to hang.

Failure is contained by construction. `archivist-vpn-proxy.service` declares `BindsTo=archivist-vpn.service`, so a dropped tunnel stops the proxy rather than silently leaking over the direct link — the kill-switch half of the choice §4.1 forces. Downstream that surfaces as `proxy_unavailable`, which scores tier `unknown` and leaves endpoint tiers untouched (§1.2).

### 4.3 Per-indexer proxy (required regardless) — **implemented**

The precondition for any selective design, and independently useful. Both seams are now delivered:

1. **Direct path** — `httpRequestDirect` in `cardigann/executor.ts` calls global `fetch` (Node 20, so undici). Supply a `dispatcher` built from `ProxyAgent` for HTTP proxies, or a SOCKS connector for `socks5://`. Roughly twenty lines at one call site.
2. **Trawl path** — the payload builder in the same file already assembles `cmd`, `url`, `maxTimeout`, `postData`, and `cookies`. FlareSolverr accepts `proxy: { url }`; add it when the instance defines one.

Once both exist, "VPN" is simply *a component that provides a local proxy endpoint*, and the application no longer needs to know what is behind it.

### 4.4 Downstream impact on the library

The operator's specific question, and the strongest argument against §4.1.

**Positive.** Blocked indexers become reachable, so searches resolve, acquisitions complete, and the library actually fills. On the reference install this plausibly extends beyond `EXT Torrents` to `YTS` (0/15 healthy, never OK) and `1337x` (1/18).

**Negative.** Metadata providers would see a shared exit address. MusicBrainz rate-limits per IP and commonly throttles shared VPN egress; TMDB and comparable providers apply their own per-IP limits. Library scan and metadata refresh are high-volume and gain nothing from a tunnel — there is no reason to conceal a TMDB lookup. Routing them through a shared exit risks degrading metadata quality to fix an indexer problem.

**Therefore:** metadata traffic must remain on the direct link by default under every option. §4.2 achieves this structurally; §4.1 achieves it only through additional policy routing.

---

## 5. In-process Trawl — assessed, deferred

Recorded because it is the natural adjacent question, and because the answer is counter-intuitive.

**It does not address the problem in §1.** An embedded browser has the same egress as the external service and reaches the same block portal. Its value is removing an external dependency, not reachability.

**The seam is clean.** `httpRequestViaCloudflareBypass` takes `(url, opts)` and returns `{ status, body, headers }`. An in-process implementation substitutes behind that signature, and `withCloudflareBypassProbeSlot` already provides concurrency limiting. Playwright is already a devDependency (`1.49.1`) for Player and Library end-to-end tests.

**The costs are material.**

- The runtime image is `node:20-bookworm-slim` with no browser. Chromium adds several hundred megabytes to an image published for **both `linux/amd64` and `linux/arm64`**.
- Each browser context costs roughly 100–300 MB resident, against a healthcheck that already requires a healthy worker.
- Most importantly, a challenge-solver's value is evasion, not browser automation. A stock Playwright build is more readily detected than a purpose-built solver, so an in-process Trawl may clear **fewer** challenges than the current external service — and the gap is a permanent maintenance obligation.

**Recommendation:** keep Trawl external. Revisit only to remove the external dependency, and never as a remedy for a network-layer block.

---

## 6. Phased delivery

| Phase | Scope | Independently useful |
|---|---|---|
| 0 | `bypass_unavailable` failure class (§1.2) | Yes — **implemented** |
| 1 | Proxy plumbing (§4.3): direct dispatcher and Trawl `proxy` field | Yes — **implemented**; makes the existing UI functional |
| 2 | VPN unit, polkit extension, `services` entries, Control status and toggles | Yes — **implemented**; tunnel and Trawl manageable from Control |
| 3 | Scoped egress by routing policy (§4.2) | Yes — **implemented**; selective egress without host-wide routing |
| 4 | Optional whole-host mode (§4.1) with LAN excludes and explicit kill-switch semantics | Only with 2 |

Phase 1 is the smallest change with the largest unblocking effect, and is a precondition for phases 3 and 4.

---

## 7. Observability

- Tunnel state belongs in Control's existing service snapshot: active, interface, endpoint host, last handshake age, bytes transferred.
- Endpoint health must remain attributable. When a probe fails through a tunnel, the recorded failure class must distinguish *tunnel down* from *endpoint dead* — the same distinction §1.2 introduced for Trawl saturation. Delivered for the proxy path in Phase 1 as `proxy_unavailable`, which scores tier `unknown`, leaves the endpoint's tier untouched, and stays out of `ENDPOINT_AT_FAULT`. A tunnel managed by Control (§3) must report through the same channel.
- A blocked endpoint that returns a block portal with `HTTP 200` is currently classified `parse` (selectors do not match), which reads as definition drift. Detecting known block-portal responses and classifying them distinctly would have made the problem in §1 obvious immediately, rather than after manual investigation.

---

## 8. Risks and open questions

| # | Item | Notes |
|---|---|---|
| R1 | Whole-host routing locks the operator out of the UI | Mitigated by LAN excludes; must be tested before shipping §4.1 |
| R2 | Metadata quality regression from shared exit addresses | §4.4; avoided by §4.2 |
| R3 | Tunnel private key handling | §3.4 |
| R4 | Widening the polkit rule | Keep it unit-scoped and verb-scoped; never generalise to "any unit" |
| R5 | Torrent inbound connectivity under a tunnel | Needs port forwarding, or accept degraded seeding |
| Q1 | Kernel WireGuard, or a userspace implementation providing a local proxy? | Kernel is simpler under §4.1; userspace composes better with §4.3 and needs no `NET_ADMIN` |
| Q2 | One tunnel, or several selectable per indexer? | Per-indexer proxy (§4.3) makes several possible; start with one |
| Q3 | Should the Docker profile document `network_mode: service:<vpn>` instead? | Zero code, and probably the correct guidance for container operators |

---

## 9. Evidence

Implementation files this specification refers to:

- `apps/control/src/server/host.ts` — service registry and `systemctl` invocation
- `apps/control/src/server/agent.ts` — agent socket client
- `apps/control-agent/src/index.ts`, `apps/control-agent/src/files.ts` — privileged file operations
- `deploy/systemd/archivist-control-agent.service` — capability envelope quoted in §3.2
- `deploy/polkit/50-archivist-control.rules` — authority scope quoted in §3.1
- `packages/indexer-engine/src/cardigann/proxy.ts` — proxy dispatchers, `PROXY_UNAVAILABLE` tagging (Phase 1)
- `packages/indexer-engine/src/cardigann/executor.ts` — `httpRequestDirect`, Trawl payload builder, `TransportError`
- `packages/indexer-engine/src/cardigann/probe.ts` — `classifyDiagnostics`, failure classes
- `apps/server/src/indexers/endpoints/scoring.ts` — `tierForFailure`
- `apps/server/src/indexers/endpoints/resolver.ts` — probe resolution and persistence
- `apps/server/src/indexers/endpoints/breaker.ts` — `ENDPOINT_AT_FAULT`

Deployment artefacts added by phases 2 and 3:

- `deploy/systemd/archivist-trawl.service`, `deploy/trawl/docker-compose.yml` — Trawl as a Control-managed unit
- `deploy/systemd/archivist-vpn.service`, `deploy/vpn/archivist.conf.example` — the tunnel
- `deploy/systemd/archivist-vpn-proxy.service`, `deploy/vpn-proxy.mjs` — the egress proxy
- `deploy/vpn-routing.sh` — policy rules scoping the tunnel to one user
- `deploy/vpn/vpn.env.example` — settings shared by the three units
- `deploy/systemd/archivist-control.service.d/repository.conf` — Control from the working repository
- `deploy/polkit/50-archivist-control.rules` — authority extended to the new units
- `apps/control/src/server/host.ts` — service registry generalised beyond a single unit

Related documentation:

- [Indexer Endpoint Resolver specification](indexer-endpoint-resolver-spec.md)
- [Archivist Control product reference](../03-products/control/README.md)
- [Host Control deployment](../02-architecture/deployment/host-control.md)
- [Deployment and configuration](../07-operations/deployment-and-configuration.md)
