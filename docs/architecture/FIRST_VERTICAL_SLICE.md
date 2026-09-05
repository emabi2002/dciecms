# First Vertical Slice - R0/R1

1. Authenticate user and resolve effective role/court scope.
2. Configure courts and case types.
3. Create/search party within scope.
4. Create filing draft.
5. Upload document through quarantine/validation path.
6. Submit filing with idempotency key.
7. Registry queue displays submitted filing only to authorized registry scope.
8. Registry opens filing review.
9. Audit records authentication, filing create/submit, document access and registry review actions.

## Minimum negative tests
- Registry Court A cannot see Court B filing.
- ICT administrator cannot read filing content solely by admin role.
- Duplicate submit with same idempotency key creates one filing transition.
- Unauthorized direct document identifier fails.
