QA this idea.

{{IDEA}}

Steps: get_idea and read the builder's latest note; check exactly what it asks (Play mode in Studio when the change
is in-game: claim Studio, test, return Studio to Edit and release it). If it passes, update_idea status "shipped"
with a one-line verdict and add the credit/log entries your role requires. If it fails, update_idea status
"building" with a precise repro so the builder can fix it. File unrelated bugs you find with propose_idea kind "bug".

Never end with the idea still in "qa". If you cannot test something because a test hook or setup is missing (for
example a locked feature on a fresh cat, or no DataStore in Studio), set status "building" with a note saying exactly
what the builder must add, such as a Studio-only AdminService command. Only if Roblox Studio is busy, end your turn
with the idea in "qa"; the Factory resumes you when it frees up.

Before you finish, add follow-up work you noticed for the other roles with add_task (one call each, specific, under
the idea it serves; bugs and cleanups under "Bug fixes and polish"). A brand-new feature goes to propose_idea as a
suggestion for the Game Manager. Check list_backlog first so you don't
suggest what is already queued.
