### Changed

- Owned deployments now use the upstream Linux Signal, coturn and ACME stack instead of a Cloudflare Signal Container and Realtime TURN. The account service and website stay on Cloudflare; native desktop storage and ODIC-funded host controls are unchanged. **Configure and approve the owned Linux Signal host before deploying this update.**
- Signal supports an exact website origin separate from the account service. An explicit origin list takes precedence; an empty list keeps browser connections disabled.

### Fixed

- TURN certificate reload and graceful drain no longer make the container entrypoint exit while active allocations remain.

### Security

- The live WebRTC smoke command now requires an explicit owned Signal endpoint instead of sending tickets to an upstream default.
