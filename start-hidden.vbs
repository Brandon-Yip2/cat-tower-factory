' Starts the Cat Tower Factory daemon with no console window (used by the Startup shortcut).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(dir)
sh.Run "cmd /c node """ & dir & "\server.mjs"" >> """ & dir & "\data\daemon-console.log"" 2>&1", 0, False
