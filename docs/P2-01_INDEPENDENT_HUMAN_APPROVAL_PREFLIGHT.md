# P2-01 — Independent human approval preflight (dormant)

The standalone adapter checks the PostgreSQL source audit for a named **different** approving editor before a proposed host grant, and requires a currently approved source on the requested host. Invalid identifiers, query ambiguity and failures refuse admission. Synthetic API unit tests validate SQL parameters and fail-closed results.

**Critical limitation:** This is an advisory, unmounted **preflight**, not proof of two-person control. It is vulnerable to time-of-check/time-of-use changes and depends on SQL read privileges. The real host-grant function must atomically enforce the distinct approver under the same transaction/row locks as the host mutation, and the named personal login must be tied to an independently authenticated actor and separately scoped database roles. Do not enable production access or treat this preflight as sufficient for #16. No VPS, key, feed, scheduler, or paid service changes.
