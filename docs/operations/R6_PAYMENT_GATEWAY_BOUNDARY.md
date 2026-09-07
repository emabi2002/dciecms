# R6 Payment Gateway Boundary

This document records the operational boundary for the DCIECMS R6 secure payment-gateway integration workstream.

R6 introduces repository support for verified, replay-safe payment callbacks. It does not activate a production payment provider.

## Production prerequisites outside R6

Production activation requires separate approval and completion of all of the following:

- approved provider selection and commercial/merchant onboarding;
- callback authentication mechanism and provider security review;
- approved callback endpoint registration;
- TLS/WAF/reverse-proxy controls;
- production secret storage and rotation procedure;
- production-capable verifier implementation and review;
- controlled migration execution for `0014_payment_gateway_callbacks.sql`;
- production deployment approval;
- operational monitoring and incident response procedure;
- provider retry/replay behaviour validation in a non-production environment;
- finance/UAT approval.

## Prohibited assumptions

- A browser response is never sufficient evidence that a payment succeeded.
- Provider-looking fields submitted by an authenticated user are never equivalent to a verified provider callback.
- Development verifier fixtures must never be used in production.
- A successful repository implementation must not be represented as live provider activation.
