### Added

- Organization-funded managed hosts on DigitalOcean with separately retained native volumes, bounded bootstrap claims, provider reconciliation, funding revocation/reactivation and existing membership/entitlement enforcement. Production use still requires native cloud, real relay and integrated UI acceptance.
- Managed native-volume startup guards for state identity, single-writer ownership, pinned fork images and downgrade prevention.
- Owned Cloudflare account deployment and Signal/Realtime TURN integration with exact browser origins, explicit deployment controls and bounded credential revocation.

### Fixed

- Show organization funding and real host resources without Stripe purchase or renewal controls; prevent wake while funding is revoked.
- Use funding-neutral billing text and the correct server heading. Do not report missing Stripe billing for an organization-only fleet.
- Wrap host status and recovery instructions so administrator-managed stops remain readable at narrow widths.
- Use fork-owned installation, update and download targets; remove retired Boat provisioning, upstream secret-loading deployment paths and automatic upstream publication.
- Preserve separate direct API and browser-proxy origins, run Wrangler on Node, and use the compatibility date supported by the pinned Worker runtime.
