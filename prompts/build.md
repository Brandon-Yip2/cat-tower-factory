Build this idea end to end.

{{IDEA}}

Steps: get_idea for the full history; claim_files for what you will edit; make the change following your agent
definition and the repo rules (LF line endings, push your scripts into Studio with tools/push-server.mjs when the
change is in place/, run node tools/verify.mjs). Commit only your own files. Then update_idea with status "qa",
a note telling QA exactly what to check, and a one-paragraph summary.

If Roblox Studio is busy (another agent holds it), that is not a blocker: do every part that doesn't need Studio, then
end your turn with a one-line status. The Factory resumes you when Studio frees up. Use status "on_hold" only for a
blocker that needs the owner, together with ask_owner.

Before you finish, add follow-up work you noticed for the other roles with add_task (one call each, specific, under
the idea it serves; bugs and cleanups under "Bug fixes and polish"). A brand-new feature goes to propose_idea as a
suggestion for the Game Manager. Check list_backlog first so you don't
suggest what is already queued.
