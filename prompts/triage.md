Triage these {{COUNT}} new idea(s). For each one call update_idea once with: status "triaged" (or "rejected"
with a note if it is a duplicate or clearly out of scope), area (one of: {{AREAS}}), kind
(feature | bug | polish | tuning | content | tech), task_type (the kind of work building it takes, one of:
{{TASK_TYPES}}), owner_role (who builds it — one of the roles listed below, never yourself), priority
(1 high – 3 low), needs_spec (true only for features that touch several systems or need design decisions),
parent_id (the high-level idea it serves: list_ideas level "idea"; bugs and small cleanups go under "Bug fixes and polish"), and
approval_reason (one line) if it is a brand-new feature nobody asked for.

Approval rule (owner's): ideas from the owner, bugs, polish, tuning, and anything serving an owner idea go ahead.
A brand-new feature an agent invented (a new mode, system or major content with no owner parent) waits for the
owner. Classify honestly: a new mode or system is kind "feature" even if it needs tech work. The Factory handles
the waiting automatically when you set status "triaged"; do not try to work around it.

Roles:
- {{ROLES}}

{{IDEAS}}

Do not start any work on the ideas. Finish with one line per idea: id → owner_role, task_type, status.
