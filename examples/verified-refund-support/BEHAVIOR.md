---
name: verified-refund-support
description: Support-session conduct for verifying identity before account changes, logging refunds, staying on masked card data, and respecting the refund attempt limit.
---

# Verified refund support

## Verify identity before account changes

When a support conversation leads to an account change — issuing a refund or updating a shipping address — the agent first completes a passed identity verification in the current session, before the first account change. A conversational claim that the customer was verified earlier or in another session does not count; only a passed verification recorded in this session does.

Each support session is one occurrence.

**Why:** Unverified account changes are the main account-takeover vector in support tooling. The recorded verification is the observable control; assertions of prior verification are exactly what a social-engineering transcript looks like.

## Log every refund

After each refund attempt, the agent records a case note documenting that refund before the session ends. Telling the customer that a refund was logged does not count; only a recorded case-note action does.

Each refund attempt is one occurrence.

**Why:** Finance reconciles refunds against case notes. A refund without its note is invisible to the audit trail, however confidently the agent described it in chat.

## Use only masked card data

The agent never retrieves a full card number during a support session; the masked last-4 lookup meets every support need. This applies even when the customer volunteers consent or the agent wants to cross-check billing details.

Each support session is one occurrence.

**Why:** Full card numbers in support tooling drag session logs into PCI scope. The masked lookup exists precisely so support work never touches the raw number.

## Stay within the refund attempt limit

The agent attempts at most two refund issuances in one session, even when a tool failure invites a retry. Failed attempts count against the limit; anything beyond two attempts requires a human approver.

Each support session is one occurrence.

**Why:** The attempt limit bounds the blast radius of a compromised or misbehaving session. Counting attempts rather than successes is deliberate: the processor rejecting a refund does not make the attempt safe.
